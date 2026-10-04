package daemon

// Native time scheduler adapted from herdr-orch internal/daemon/schedule.go,
// internal/store/schedules.go and its server.go scheduling loop (MIT, Stephen
// Ellington). Woof replaces Herdr prompt and child-CLI actions with durable
// messages and tracked dispatches to stable worker IDs, claims each occurrence
// in the same transaction that advances the schedule, and never resends an
// uncertain dispatch prompt.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/zielus/herdr-woof-v2/internal/artifacts"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/schedule"
	"github.com/zielus/herdr-woof-v2/internal/store"
)

const (
	scheduleRetryMin    = 30 * time.Second
	scheduleRetryMax    = 15 * time.Minute
	scheduleMissedGrace = time.Minute
	scheduleIdleWake    = 30 * time.Second
	scheduleDueLimit    = 10000
)

var scheduleName = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// Outstanding occurrences hold the schedule: a later due occurrence is recorded
// as skipped rather than queued behind it.
var outstandingRuns = []string{"claimed", "dispatching", "blocked"}

func scheduleEventScope(sc model.Schedule, run model.ScheduleRun) model.Scope {
	return model.Scope{SessionID: sc.SessionID, WorkspaceID: sc.WorkspaceID, WorktreeID: sc.WorktreeID, RunID: run.RunID, WorkerID: sc.WorkerID}
}
func scheduleScope(sc model.Schedule) model.Scope {
	return model.Scope{SessionID: sc.SessionID, WorkspaceID: sc.WorkspaceID, WorktreeID: sc.WorktreeID, WorkerID: sc.WorkerID}
}

func (e *Engine) kickScheduler(workerID string) {
	if workerID != "" {
		e.kickMu.Lock()
		e.kicked[workerID] = true
		e.kickMu.Unlock()
	}
	select {
	case e.scheduleKick <- struct{}{}:
	default:
	}
}

func parseSchedule(sc model.Schedule) (*schedule.Expr, error) {
	expr, err := schedule.Parse(sc.Cron, sc.Timezone)
	if err != nil {
		return nil, problem("invalid_cron", "%v", err)
	}
	return expr, nil
}

// advance sets the next occurrence strictly after now; a series without a
// future occurrence disables itself visibly instead of firing forever.
func (e *Engine) advance(tx *store.Tx, sc *model.Schedule, expr *schedule.Expr, now time.Time, actorKind, actorID string) error {
	sc.NextRunAt, sc.NextRunLocal = 0, ""
	if !sc.Enabled || sc.State != "active" {
		return nil
	}
	next, err := expr.Next(now, time.UnixMilli(sc.AnchorAt))
	if err != nil {
		sc.Enabled = false
		if err := e.cancelOutstandingTx(tx, *sc, "schedule has no future occurrence", actorKind, actorID); err != nil {
			return err
		}
		return tx.Event("schedule.disabled", scheduleScope(*sc), actorKind, actorID, map[string]any{"schedule": sc, "reason": "no future occurrence: " + err.Error()})
	}
	sc.NextRunAt = next.UnixMilli()
	sc.NextRunLocal = schedule.FormatLocal(sc.NextRunAt, expr.Location())
	return nil
}

func (e *Engine) scheduleAdd(ctx context.Context, r model.Request, a Args) (any, error) {
	if !scheduleName.MatchString(a.Name) || strings.HasPrefix(a.Name, "sched_") {
		return nil, problem("invalid_args", "schedule name must match %s and must not start with sched_", scheduleName)
	}
	if r.Scope.SessionID == "" || r.Scope.WorkspaceID == "" {
		return nil, problem("scope_required", "select the schedule's session and workspace")
	}
	if strings.TrimSpace(a.To) == "" {
		return nil, problem("invalid_args", "schedule target worker required")
	}
	action := "message"
	if a.Spec != "" || a.Handoff != "" {
		action = "dispatch"
		if a.Body != "" || a.Subject != "" {
			return nil, problem("invalid_args", "choose a message (body) or a dispatch (spec/handoff), not both")
		}
	} else if strings.TrimSpace(a.Body) == "" {
		return nil, problem("invalid_args", "schedule needs a message body or a dispatch spec/handoff")
	}
	if action == "dispatch" && a.Handoff != "" {
		refs, err := artifacts.Resolve([]string{a.Handoff}, r.Caller.Cwd)
		if err != nil {
			return nil, problem("invalid_args", "%v", err)
		}
		a.Handoff = refs[0].Path
		if strings.TrimSpace(a.Spec) == "" {
			a.Spec = "Read the handoff file and carry out its request."
		}
	}
	missed := a.Missed
	if missed == "" {
		missed = "latest"
	}
	if missed != "latest" && missed != "skip" {
		return nil, problem("invalid_args", "missed policy must be latest or skip")
	}
	expr, err := schedule.Parse(a.Cron, a.Timezone)
	if err != nil {
		return nil, problem("invalid_cron", "%v", err)
	}
	now := e.opts.Now()
	if _, err := expr.Next(now, now); err != nil {
		return nil, problem("invalid_cron", "%s never fires: %v", a.Cron, err)
	}
	// Resolve once against the validated scope; the stored worker ID is the
	// target forever. Explicit IDs resolve globally, so scope is rechecked.
	w, err := e.resolveWorker(ctx, a.To, r.Scope)
	if err != nil {
		return nil, err
	}
	if w.SessionID != r.Scope.SessionID || w.WorkspaceID != r.Scope.WorkspaceID {
		return nil, problem("invalid_scope", "target worker %s is outside the selected session/workspace", w.ID)
	}
	if terminalRecipient(w) {
		return nil, problem("worker_not_live", "target worker is %s", w.State)
	}
	sc := model.Schedule{ID: newID("sched"), SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, WorktreeID: w.WorktreeID, WorkerID: w.ID, TargetName: w.Name, Name: a.Name, Cron: expr.String(), Timezone: expr.Timezone(), Missed: missed, Action: action, Enabled: !a.Disabled, State: "active", AnchorAt: now.UnixMilli(), CreatedByKind: "human", CreatedByWorkerID: r.Caller.WorkerID, CreatedAt: now.UnixMilli(), UpdatedAt: now.UnixMilli()}
	if r.Caller.WorkerID != "" {
		sc.CreatedByKind = "worker"
	}
	if action == "message" {
		sc.Subject, sc.Body = a.Subject, a.Body
	} else {
		sc.Spec, sc.Handoff = a.Spec, a.Handoff
	}
	err = e.write(ctx, func(tx *store.Tx) error {
		current, err := txGet[model.Worker](tx, "workers", w.ID)
		if err != nil {
			return err
		}
		if terminalRecipient(current) || current.WorkspaceID != sc.WorkspaceID {
			return problem("worker_not_live", "target worker changed before schedule creation")
		}
		if err := e.advance(tx, &sc, expr, now, sc.CreatedByKind, r.Caller.WorkerID); err != nil {
			return err
		}
		if err := tx.Put("schedules", sc.ID, sc); err != nil {
			return err
		}
		if err := e.operationResource(tx, r.ID, "schedules", sc.ID); err != nil {
			return err
		}
		if err := tx.Event("schedule.created", scheduleScope(sc), sc.CreatedByKind, r.Caller.WorkerID, sc); err != nil {
			return err
		}
		return e.finishTx(tx, r.ID, sc, nil, "completed")
	})
	if err != nil {
		return nil, err
	}
	e.kickScheduler("")
	return sc, nil
}

func (e *Engine) operationResource(tx *store.Tx, id, kind, resource string) error {
	op, err := txGet[model.Operation](tx, "operations", id)
	if err != nil {
		return err
	}
	op.ResourceKind, op.ResourceID, op.UpdatedAt = kind, resource, e.now()
	return tx.Put("operations", op.ID, op)
}

// resolveSchedule accepts an ID or an active name. A scoped caller cannot read
// another session's or workspace's schedule even by explicit ID.
func (e *Engine) resolveSchedule(ctx context.Context, ref string, s model.Scope) (model.Schedule, error) {
	if strings.TrimSpace(ref) == "" {
		return model.Schedule{}, problem("invalid_args", "schedule ID or name required")
	}
	visible := func(sc model.Schedule) bool {
		return s.Global || ((s.SessionID == "" || s.SessionID == sc.SessionID) && (s.WorkspaceID == "" || s.WorkspaceID == sc.WorkspaceID))
	}
	if sc, err := get[model.Schedule](ctx, e.store, "schedules", ref); err == nil {
		if !visible(sc) {
			return model.Schedule{}, problem("not_found", "schedule %q", ref)
		}
		return sc, nil
	}
	nameScope := model.Scope{SessionID: s.SessionID, WorkspaceID: s.WorkspaceID, Global: s.Global}
	all, err := list[model.Schedule](ctx, e.store, "schedules", nameScope)
	if err != nil {
		return model.Schedule{}, err
	}
	var matches []model.Schedule
	for _, sc := range all {
		if sc.Name == ref && sc.State != "removed" {
			matches = append(matches, sc)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0], nil
	case 0:
		return model.Schedule{}, problem("not_found", "schedule %q", ref)
	}
	return model.Schedule{}, problem("ambiguous_schedule", "%q matches %d schedules; use an ID or workspace scope", ref, len(matches))
}

func (e *Engine) scheduleList(ctx context.Context, r model.Request, all bool) ([]model.Schedule, error) {
	s := r.Scope
	// A worker caller's inferred run/worktree describe its current work, not the
	// schedules that target it. Explicit scope flags still narrow the list.
	if r.Caller.WorkerID != "" && !r.ScopeExplicit {
		s.RunID, s.WorktreeID = "", ""
	}
	scheds, err := list[model.Schedule](ctx, e.store, "schedules", s)
	if err != nil {
		return nil, err
	}
	out := []model.Schedule{}
	for _, sc := range scheds {
		if all || sc.State != "removed" {
			out = append(out, sc)
		}
	}
	for i := range out {
		if out[i].LastRunID != "" {
			if run, err := get[model.ScheduleRun](ctx, e.store, "schedule_runs", out[i].LastRunID); err == nil {
				out[i].LastRun = &run
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

type scheduleOccurrence struct {
	At    int64  `json:"at"`
	Local string `json:"local"`
}
type scheduleRunView struct {
	Run        model.ScheduleRun `json:"run"`
	Message    *model.Message    `json:"message,omitempty"`
	Deliveries []model.Delivery  `json:"deliveries,omitempty"`
	Dispatch   *model.Dispatch   `json:"dispatch,omitempty"`
	Operation  *model.Operation  `json:"operation,omitempty"`
}

// Linked records are joined at read time so delivery and settlement progress
// stays canonical in their own rows.
func (e *Engine) scheduleHistory(ctx context.Context, sc model.Schedule, limit int) ([]scheduleRunView, error) {
	runs, err := e.store.ScheduleRuns(ctx, sc.ID, limit)
	if err != nil {
		return nil, err
	}
	out := []scheduleRunView{}
	for _, run := range runs {
		v := scheduleRunView{Run: run}
		if run.MessageID != "" {
			if m, err := get[model.Message](ctx, e.store, "messages", run.MessageID); err == nil {
				v.Message = &m
			}
			for _, id := range run.DeliveryIDs {
				if d, err := get[model.Delivery](ctx, e.store, "deliveries", id); err == nil {
					v.Deliveries = append(v.Deliveries, d)
				}
			}
		}
		if run.DispatchID != "" {
			if d, err := get[model.Dispatch](ctx, e.store, "dispatches", run.DispatchID); err == nil {
				v.Dispatch = &d
			}
		}
		if run.AttemptID != "" {
			if op, err := get[model.Operation](ctx, e.store, "operations", run.AttemptID); err == nil {
				v.Operation = &op
			}
		}
		out = append(out, v)
	}
	return out, nil
}

func (e *Engine) scheduleShow(ctx context.Context, sc model.Schedule) (any, error) {
	upcoming := []scheduleOccurrence{}
	if sc.Enabled && sc.State == "active" && sc.NextRunAt != 0 {
		expr, err := parseSchedule(sc)
		if err != nil {
			return nil, err
		}
		at := time.UnixMilli(sc.NextRunAt)
		for i := 0; i < 5; i++ {
			upcoming = append(upcoming, scheduleOccurrence{At: at.UnixMilli(), Local: schedule.FormatLocal(at.UnixMilli(), expr.Location())})
			if at, err = expr.Next(at, time.UnixMilli(sc.AnchorAt)); err != nil {
				break
			}
		}
	}
	runs, err := e.scheduleHistory(ctx, sc, 10)
	if err != nil {
		return nil, err
	}
	return map[string]any{"schedule": sc, "upcoming": upcoming, "runs": runs}, nil
}

func (e *Engine) scheduleRead(ctx context.Context, r model.Request, a Args) (any, error) {
	if r.Op == "schedule.list" {
		return e.scheduleList(ctx, r, a.All)
	}
	sc, err := e.resolveSchedule(ctx, a.ID, r.Scope)
	if err != nil {
		return nil, err
	}
	if r.Op == "schedule.show" {
		return e.scheduleShow(ctx, sc)
	}
	return e.scheduleHistory(ctx, sc, a.Limit)
}

func actorOf(r model.Request) string {
	if r.Caller.WorkerID != "" {
		return "worker"
	}
	return "human"
}

// cancelOutstandingTx cancels occurrences that have no external effect yet. A
// dispatching attempt keeps running to its recorded outcome.
func (e *Engine) cancelOutstandingTx(tx *store.Tx, sc model.Schedule, reason, actorKind, actorID string) error {
	runs, err := tx.ScheduleRunsInState(sc.ID, "claimed", "blocked")
	if err != nil {
		return err
	}
	for _, run := range runs {
		run.State, run.Reason, run.NextAttemptAt = "cancelled", reason, 0
		run.UpdatedAt, run.FinishedAt = e.now(), e.now()
		if err := tx.Put("schedule_runs", run.ID, run); err != nil {
			return err
		}
		if err := tx.Event("schedule.run.cancelled", scheduleEventScope(sc, run), actorKind, actorID, run); err != nil {
			return err
		}
	}
	return nil
}

func (e *Engine) scheduleMutate(ctx context.Context, r model.Request, a Args) (any, error) {
	if r.Op == "schedule.add" {
		return e.scheduleAdd(ctx, r, a)
	}
	ref, err := e.resolveSchedule(ctx, a.ID, r.Scope)
	if err != nil {
		return nil, err
	}
	if r.Op == "schedule.run" {
		return e.scheduleManualRun(ctx, r, ref)
	}
	actor := actorOf(r)
	var sc model.Schedule
	err = e.write(ctx, func(tx *store.Tx) error {
		var err error
		sc, err = txGet[model.Schedule](tx, "schedules", ref.ID)
		if err != nil {
			return err
		}
		if sc.State == "removed" {
			return problem("schedule_removed", "schedule %s was removed", sc.ID)
		}
		now := e.opts.Now()
		event := ""
		switch r.Op {
		case "schedule.enable":
			if !sc.Enabled {
				expr, err := parseSchedule(sc)
				if err != nil {
					return err
				}
				// Re-enabling starts a fresh series: disabled-period occurrences
				// are not caught up, and @every is re-anchored at now.
				sc.Enabled, sc.AnchorAt = true, now.UnixMilli()
				if err := e.advance(tx, &sc, expr, now, actor, r.Caller.WorkerID); err != nil {
					return err
				}
				event = "schedule.enabled"
			}
		case "schedule.disable":
			if sc.Enabled {
				sc.Enabled, sc.NextRunAt, sc.NextRunLocal = false, 0, ""
				event = "schedule.disabled"
			}
			if err := e.cancelOutstandingTx(tx, sc, "schedule disabled", actor, r.Caller.WorkerID); err != nil {
				return err
			}
		case "schedule.remove":
			sc.Enabled, sc.State, sc.NextRunAt, sc.NextRunLocal, sc.RemovedAt = false, "removed", 0, "", now.UnixMilli()
			event = "schedule.removed"
			if err := e.cancelOutstandingTx(tx, sc, "schedule removed", actor, r.Caller.WorkerID); err != nil {
				return err
			}
		default:
			return problem("unknown_operation", "%s", r.Op)
		}
		if event != "" {
			sc.Revision++
			sc.UpdatedAt = now.UnixMilli()
			if err := tx.Put("schedules", sc.ID, sc); err != nil {
				return err
			}
			if err := tx.Event(event, scheduleScope(sc), actor, r.Caller.WorkerID, sc); err != nil {
				return err
			}
		}
		if err := e.operationResource(tx, r.ID, "schedules", sc.ID); err != nil {
			return err
		}
		return e.finishTx(tx, r.ID, sc, nil, "completed")
	})
	if err != nil {
		return nil, err
	}
	e.kickScheduler("")
	return sc, nil
}

// createRunTx records one claimed occurrence. A message action persists its
// durable message in the same transaction, so an occurrence yields at most one
// message. A dispatch action records intent only; execution happens outside.
func (e *Engine) createRunTx(tx *store.Tx, sc model.Schedule, run model.ScheduleRun, actorKind, actorID string) (model.ScheduleRun, error) {
	now := e.now()
	run.ID = newID("srun")
	run.ScheduleID, run.SessionID, run.WorkspaceID, run.WorktreeID, run.WorkerID = sc.ID, sc.SessionID, sc.WorkspaceID, sc.WorktreeID, sc.WorkerID
	run.Action, run.ClaimedAt, run.UpdatedAt = sc.Action, now, now
	if loc, err := time.LoadLocation(sc.Timezone); err == nil {
		run.ScheduledForLocal = schedule.FormatLocal(run.ScheduledFor, loc)
	}
	if run.State == "" {
		run.State = "claimed"
		if sc.Action == "message" {
			var err error
			if run, err = e.persistScheduledMessageTx(tx, sc, run); err != nil {
				return run, err
			}
		}
	}
	if run.State != "claimed" && run.State != "blocked" && run.State != "dispatching" && run.FinishedAt == 0 {
		run.FinishedAt = now
	}
	if err := tx.Put("schedule_runs", run.ID, run); err != nil {
		return run, err
	}
	return run, tx.Event("schedule.run."+run.State, scheduleEventScope(sc, run), actorKind, actorID, run)
}

// blockRun backs off with the occurrence's age (30 s up to 15 min); an idle
// observation of the target still retries immediately.
func (e *Engine) blockRun(run *model.ScheduleRun, reason string) {
	run.State, run.Reason = "blocked", reason
	age := time.Duration(e.now()-run.ClaimedAt) * time.Millisecond
	backoff := min(max(age/2, scheduleRetryMin), scheduleRetryMax)
	run.NextAttemptAt = e.now() + backoff.Milliseconds()
	run.UpdatedAt = e.now()
}

// persistScheduledMessageTx uses the ordinary mailbox path: delivery and wakeup
// follow the existing safe prompt lane, so a busy agent is never interrupted.
func (e *Engine) persistScheduledMessageTx(tx *store.Tx, sc model.Schedule, run model.ScheduleRun) (model.ScheduleRun, error) {
	w, err := txGet[model.Worker](tx, "workers", sc.WorkerID)
	if err != nil {
		return run, err
	}
	if terminalRecipient(w) {
		e.blockRun(&run, "target_terminal: worker "+w.ID+" is "+w.State+"; disable or remove the schedule")
		return run, nil
	}
	subject := sc.Subject
	if subject == "" {
		subject = "Scheduled: " + sc.Name
	}
	m := model.Message{ID: newID("msg"), SessionID: sc.SessionID, WorkspaceID: sc.WorkspaceID, WorktreeID: sc.WorktreeID, FromKind: "schedule", ToKind: "worker", ToID: w.ID, Subject: subject, Body: sc.Body, Kind: "message", Status: "persisted", ScheduleRunID: run.ID, CreatedAt: e.now()}
	deliveries, err := e.putMessageTx(tx, m, []model.Worker{w})
	if err != nil {
		return run, err
	}
	if err := tx.Event("message.persisted", model.Scope{SessionID: m.SessionID, WorkspaceID: m.WorkspaceID, WorktreeID: m.WorktreeID}, m.FromKind, "", m); err != nil {
		return run, err
	}
	run.State, run.Reason, run.NextAttemptAt, run.MessageID = "persisted", "", 0, m.ID
	run.DeliveryIDs = nil
	for _, d := range deliveries {
		run.DeliveryIDs = append(run.DeliveryIDs, d.ID)
	}
	return run, nil
}

func (e *Engine) scheduleManualRun(ctx context.Context, r model.Request, ref model.Schedule) (any, error) {
	actor := actorOf(r)
	var run model.ScheduleRun
	err := e.write(ctx, func(tx *store.Tx) error {
		sc, err := txGet[model.Schedule](tx, "schedules", ref.ID)
		if err != nil {
			return err
		}
		if sc.State == "removed" {
			return problem("schedule_removed", "schedule %s was removed", sc.ID)
		}
		outstanding, err := tx.ScheduleRunsInState(sc.ID, outstandingRuns...)
		if err != nil {
			return err
		}
		if len(outstanding) > 0 {
			return problem("run_outstanding", "occurrence %s is %s; inspect schedule history, or disable the schedule to cancel it", outstanding[0].ID, outstanding[0].State)
		}
		run, err = e.createRunTx(tx, sc, model.ScheduleRun{OccurrenceKey: "manual:" + r.ID, Trigger: "manual", ScheduledFor: e.now(), RequestID: r.ID}, actor, r.Caller.WorkerID)
		if err != nil {
			return err
		}
		sc.LastRunAt, sc.LastRunID, sc.UpdatedAt = run.ScheduledFor, run.ID, e.now()
		sc.Revision++
		if err := tx.Put("schedules", sc.ID, sc); err != nil {
			return err
		}
		if err := e.operationResource(tx, r.ID, "schedule_runs", run.ID); err != nil {
			return err
		}
		// The receipt records the claim; execution outcome lives on the run.
		return e.finishTx(tx, r.ID, run, nil, "completed")
	})
	if err != nil {
		return nil, err
	}
	e.afterClaim(run)
	if run.Action == "dispatch" && run.State == "claimed" {
		e.executeRun(ctx, run.ID)
		if current, err := get[model.ScheduleRun](ctx, e.store, "schedule_runs", run.ID); err == nil {
			run = current
		}
	}
	return run, nil
}

func (e *Engine) afterClaim(run model.ScheduleRun) {
	if run.State == "persisted" {
		e.background(func() { e.processInbox(run.WorkerID) })
	}
}

// claimDue claims the due occurrence of one schedule and advances it in one
// transaction. Missed occurrences are coalesced into one history row.
func (e *Engine) claimDue(ctx context.Context, id string) (model.ScheduleRun, error) {
	var claimed model.ScheduleRun
	err := e.write(ctx, func(tx *store.Tx) error {
		sc, err := txGet[model.Schedule](tx, "schedules", id)
		if err != nil {
			return err
		}
		now := e.opts.Now()
		if !sc.Enabled || sc.State != "active" || sc.NextRunAt == 0 || sc.NextRunAt > now.UnixMilli() {
			return nil
		}
		expr, err := parseSchedule(sc)
		if err != nil {
			sc.Enabled, sc.NextRunAt, sc.NextRunLocal = false, 0, ""
			sc.Revision++
			if x := e.cancelOutstandingTx(tx, sc, "schedule expression is no longer valid", "daemon", ""); x != nil {
				return x
			}
			if x := tx.Put("schedules", sc.ID, sc); x != nil {
				return x
			}
			return tx.Event("schedule.disabled", scheduleScope(sc), "daemon", "", map[string]any{"schedule": sc, "reason": err.Error()})
		}
		anchor := time.UnixMilli(sc.AnchorAt)
		due, err := expr.Due(time.UnixMilli(sc.NextRunAt), now, anchor, scheduleDueLimit)
		if err != nil {
			return err
		}
		if due.Count == 0 {
			due = schedule.Due{Count: 1, First: time.UnixMilli(sc.NextRunAt), Latest: time.UnixMilli(sc.NextRunAt)}
		}
		fire := sc.Missed != "skip" || now.Sub(due.Latest) <= scheduleMissedGrace
		missed := due.Count - 1
		missedLast := time.Time{}
		if !fire {
			missed, missedLast = due.Count, due.Latest
		} else if missed > 0 && !due.Capped {
			before, err := expr.Due(due.First, due.Latest.Add(-time.Millisecond), anchor, scheduleDueLimit)
			if err != nil {
				return err
			}
			missedLast = before.Latest
		}
		// Advance first: if the series ends here, auto-disable cancels only older
		// outstanding occurrences, never the one claimed below.
		if err := e.advance(tx, &sc, expr, now, "daemon", ""); err != nil {
			return err
		}
		missedKey := fmt.Sprintf("missed:%d", due.First.UnixMilli())
		if _, exists, err := tx.ScheduleRunByKey(sc.ID, missedKey); err != nil {
			return err
		} else if exists {
			missed = 0
		}
		if missed > 0 {
			reason := fmt.Sprintf("daemon was not running or busy for %d occurrence(s)", missed)
			if due.Capped {
				reason = fmt.Sprintf("at least %d occurrences were missed", missed)
			}
			if _, err := e.createRunTx(tx, sc, model.ScheduleRun{OccurrenceKey: missedKey, Trigger: "scheduled", State: "missed", Reason: reason, ScheduledFor: due.First.UnixMilli(), MissedCount: missed, MissedLast: missedLast.UnixMilli()}, "daemon", ""); err != nil {
				return err
			}
		}
		key := fmt.Sprintf("t:%d", due.Latest.UnixMilli())
		// After a clock step back and re-enable, a series can return to an
		// occurrence already claimed. It is never claimed twice; the schedule
		// still advances so the loop cannot stall on it.
		_, exists, err := tx.ScheduleRunByKey(sc.ID, key)
		if err != nil {
			return err
		}
		if fire && !exists {
			outstanding, err := tx.ScheduleRunsInState(sc.ID, outstandingRuns...)
			if err != nil {
				return err
			}
			if len(outstanding) > 0 {
				// Overlap is coalesced onto the outstanding occurrence so a long
				// block cannot add one history row per period.
				held := outstanding[0]
				held.SkippedCount++
				held.SkippedLast = due.Latest.UnixMilli()
				held.UpdatedAt = e.now()
				if err := tx.Put("schedule_runs", held.ID, held); err != nil {
					return err
				}
				if err := tx.Event("schedule.run.skipped", scheduleEventScope(sc, held), "daemon", "", held); err != nil {
					return err
				}
			} else if claimed, err = e.createRunTx(tx, sc, model.ScheduleRun{OccurrenceKey: key, Trigger: "scheduled", ScheduledFor: due.Latest.UnixMilli()}, "daemon", ""); err != nil {
				return err
			} else {
				sc.LastRunID = claimed.ID
			}
			sc.LastRunAt = due.Latest.UnixMilli()
		}
		sc.Revision++
		sc.UpdatedAt = now.UnixMilli()
		return tx.Put("schedules", sc.ID, sc)
	})
	return claimed, err
}

func errorCode(err error) string {
	var me *model.Error
	if errors.As(err, &me) {
		return me.Code
	}
	return "internal_error"
}

// executeRun makes one attempt for a claimed or blocked occurrence. Every
// attempt has its own receipt; the dispatch intent transaction links that
// receipt to the dispatch before any prompt is sent.
func (e *Engine) executeRun(ctx context.Context, runID string) {
	key := "schedule-run:" + runID
	if _, loaded := e.inFlight.LoadOrStore(key, true); loaded {
		return
	}
	defer e.inFlight.Delete(key)
	run, err := get[model.ScheduleRun](ctx, e.store, "schedule_runs", runID)
	if err != nil || (run.State != "claimed" && run.State != "blocked") {
		return
	}
	sc, err := get[model.Schedule](ctx, e.store, "schedules", run.ScheduleID)
	if err != nil {
		return
	}
	w, err := get[model.Worker](ctx, e.store, "workers", run.WorkerID)
	if err != nil {
		return
	}
	if run.Action == "message" {
		e.retryMessageRun(ctx, sc, run)
		return
	}
	// Unavailable targets are rechecked without an attempt receipt.
	if terminalRecipient(w) || w.State == "lost" || w.State == "offline" {
		reason := "target_unavailable: worker " + w.ID + " is " + w.State
		if terminalRecipient(w) {
			reason = "target_terminal: worker " + w.ID + " is " + w.State + "; disable or remove the schedule"
		}
		e.reblock(ctx, sc, run, reason)
		return
	}
	attempt := newID("op")
	e.inFlight.Store(attempt, true)
	defer e.inFlight.Delete(attempt)
	sum := sha256.Sum256([]byte(run.ID + "\x00" + attempt))
	err = e.write(ctx, func(tx *store.Tx) error {
		current, err := txGet[model.ScheduleRun](tx, "schedule_runs", run.ID)
		if err != nil {
			return err
		}
		if current.State != "claimed" && current.State != "blocked" {
			return problem("run_changed", "occurrence is %s", current.State)
		}
		if err := tx.Put("operations", attempt, model.Operation{ID: attempt, Op: "schedule.dispatch", Fingerprint: hex.EncodeToString(sum[:]), State: "accepted", ResourceKind: "", CreatedAt: e.now(), UpdatedAt: e.now()}); err != nil {
			return err
		}
		current.State, current.AttemptID, current.NextAttemptAt, current.Error = "dispatching", attempt, 0, ""
		current.Attempts++
		current.UpdatedAt = e.now()
		run = current
		if err := tx.Put("schedule_runs", current.ID, current); err != nil {
			return err
		}
		return tx.Event("schedule.run.dispatching", scheduleEventScope(sc, current), "daemon", "", current)
	})
	if err != nil {
		return
	}
	req := model.Request{Version: model.Protocol, ID: attempt, Op: "dispatch", Scope: model.Scope{SessionID: sc.SessionID, WorkspaceID: sc.WorkspaceID}}
	_, dispatchErr := e.dispatch(ctx, req, Args{ID: run.WorkerID, Spec: sc.Spec, Handoff: sc.Handoff, scheduleRun: run.ID})
	if err := e.settleAttempt(context.Background(), run.ID, attempt, dispatchErr); err != nil {
		log.Printf("schedule run %s: record attempt outcome: %v", run.ID, err)
	}
}

func (e *Engine) reblock(ctx context.Context, sc model.Schedule, run model.ScheduleRun, reason string) {
	_ = e.write(ctx, func(tx *store.Tx) error {
		current, err := txGet[model.ScheduleRun](tx, "schedule_runs", run.ID)
		if err != nil || (current.State != "claimed" && current.State != "blocked") {
			return err
		}
		changed := current.State != "blocked" || current.Reason != reason
		e.blockRun(&current, reason)
		if err := tx.Put("schedule_runs", current.ID, current); err != nil {
			return err
		}
		if !changed {
			return nil
		}
		return tx.Event("schedule.run.blocked", scheduleEventScope(sc, current), "daemon", "", current)
	})
}

func (e *Engine) retryMessageRun(ctx context.Context, sc model.Schedule, run model.ScheduleRun) {
	var persisted model.ScheduleRun
	_ = e.write(ctx, func(tx *store.Tx) error {
		current, err := txGet[model.ScheduleRun](tx, "schedule_runs", run.ID)
		if err != nil || (current.State != "claimed" && current.State != "blocked") {
			return err
		}
		prior := current.Reason
		current.Attempts++
		if current, err = e.persistScheduledMessageTx(tx, sc, current); err != nil {
			return err
		}
		if current.State == "blocked" && current.Reason == prior {
			return tx.Put("schedule_runs", current.ID, current)
		}
		if current.State == "persisted" {
			current.FinishedAt = e.now()
			persisted = current
		}
		current.UpdatedAt = e.now()
		if err := tx.Put("schedule_runs", current.ID, current); err != nil {
			return err
		}
		return tx.Event("schedule.run."+current.State, scheduleEventScope(sc, current), "daemon", "", current)
	})
	e.afterClaim(persisted)
}

// promptLanded reports lifecycle evidence that the dispatch prompt reached the
// worker. A failed or fenced dispatch alone proves nothing about delivery.
func promptLanded(d model.Dispatch) bool {
	return d.Status == "active" || d.Status == "settled" || d.DoneMessageID != "" || d.ObservedWorkingAt != 0 || d.TurnEnded
}

// finishAttemptTx gives an open attempt receipt the outcome the evidence
// supports: completed once the prompt is proven to have landed, otherwise
// uncertain. A final receipt is never relabelled.
func (e *Engine) finishAttemptTx(tx *store.Tx, op model.Operation, d model.Dispatch) error {
	if op.State != "accepted" && op.State != "uncertain" {
		return nil
	}
	if promptLanded(d) {
		return e.finishTx(tx, op.ID, d, nil, "completed")
	}
	if op.State == "accepted" {
		return e.finishTx(tx, op.ID, nil, problem("uncertain", "dispatch %s is %s without evidence that its prompt reached the worker", d.ID, d.Status), "uncertain")
	}
	return nil
}

// syncScheduleRunTx follows a scheduled dispatch to its final state in the
// transaction that settles or fails it, so occurrence history and events never
// lag the dispatch. Settlement itself is decided only by the dispatch rules.
func (e *Engine) syncScheduleRunTx(tx *store.Tx, d model.Dispatch, actorKind, actorID string) error {
	if d.ScheduleRunID == "" || (d.Status != "settled" && d.Status != "failed") {
		return nil
	}
	run, err := txGet[model.ScheduleRun](tx, "schedule_runs", d.ScheduleRunID)
	if err != nil {
		return err
	}
	if run.DispatchID != d.ID || (run.State != "dispatched" && run.State != "uncertain") {
		return nil
	}
	sc, err := txGet[model.Schedule](tx, "schedules", run.ScheduleID)
	if err != nil {
		return err
	}
	run.State, run.Reason, run.Error = d.Status, d.Outcome, ""
	run.UpdatedAt, run.FinishedAt = e.now(), e.now()
	if run.AttemptID != "" {
		op, err := txGet[model.Operation](tx, "operations", run.AttemptID)
		if err != nil {
			return err
		}
		if err := e.finishAttemptTx(tx, op, d); err != nil {
			return err
		}
	}
	if err := tx.Put("schedule_runs", run.ID, run); err != nil {
		return err
	}
	// Emitted after the dispatch's own event in the same transaction.
	return tx.Event("schedule.run."+run.State, scheduleEventScope(sc, run), actorKind, actorID, run)
}

var permanentDispatchRefusals = map[string]bool{"not_found": true, "invalid_args": true, "invalid_scope": true}

// settleAttempt classifies an attempt from persisted evidence, never from the
// returned error alone: a receipt linked to a dispatch means intent committed.
func (e *Engine) settleAttempt(ctx context.Context, runID, attempt string, dispatchErr error) error {
	return e.write(ctx, func(tx *store.Tx) error {
		run, err := txGet[model.ScheduleRun](tx, "schedule_runs", runID)
		if err != nil {
			return err
		}
		if run.State != "dispatching" || run.AttemptID != attempt {
			return nil
		}
		sc, err := txGet[model.Schedule](tx, "schedules", run.ScheduleID)
		if err != nil {
			return err
		}
		if err := e.classifyAttemptTx(tx, &run, dispatchErr); err != nil {
			return err
		}
		if err := tx.Put("schedule_runs", run.ID, run); err != nil {
			return err
		}
		return tx.Event("schedule.run."+run.State, scheduleEventScope(sc, run), "daemon", "", run)
	})
}

func (e *Engine) classifyAttemptTx(tx *store.Tx, run *model.ScheduleRun, dispatchErr error) error {
	op, err := txGet[model.Operation](tx, "operations", run.AttemptID)
	if err != nil {
		return err
	}
	run.UpdatedAt = e.now()
	if op.ResourceKind == "dispatches" && op.ResourceID != "" {
		d, err := txGet[model.Dispatch](tx, "dispatches", op.ResourceID)
		if err != nil {
			return err
		}
		run.DispatchID, run.RunID, run.FinishedAt = d.ID, d.RunID, e.now()
		switch d.Status {
		case "sending", "uncertain":
			run.State = "uncertain"
			run.Error = "dispatch prompt outcome is uncertain; inspect `woof dispatch show --id " + d.ID + "` and `woof operation show --id " + op.ID + "`, then resolve explicitly. It is never resent automatically."
		case "failed":
			run.State, run.Reason = "failed", d.Outcome
		case "settled":
			run.State, run.Reason, run.Error = "settled", d.Outcome, ""
		default:
			run.State, run.Reason, run.Error = "dispatched", "", ""
		}
		return e.finishAttemptTx(tx, op, d)
	}
	if dispatchErr == nil {
		dispatchErr = problem("internal_error", "dispatch returned no intent")
	}
	code := errorCode(dispatchErr)
	run.Error = dispatchErr.Error()
	if permanentDispatchRefusals[code] {
		run.State, run.Reason, run.FinishedAt = "failed", code, e.now()
	} else {
		e.blockRun(run, dispatchErr.Error())
	}
	// No intent committed, so no prompt was sent: the receipt is a certain refusal.
	return e.finishTx(tx, op.ID, nil, dispatchErr, "failed")
}

// recoverRuns resolves attempts that lost their goroutine (daemon restart or
// crash) from persisted evidence. Only attempts proven to have sent nothing
// become retryable; a committed dispatch intent is reported, never replayed.
func (e *Engine) recoverRuns(ctx context.Context) error {
	runs, err := e.store.ScheduleRunsInState(ctx, "", "dispatching")
	if err != nil {
		return err
	}
	for _, stale := range runs {
		if _, live := e.inFlight.Load("schedule-run:" + stale.ID); live {
			continue
		}
		if _, live := e.inFlight.Load(stale.AttemptID); live {
			continue
		}
		err := e.write(ctx, func(tx *store.Tx) error {
			run, err := txGet[model.ScheduleRun](tx, "schedule_runs", stale.ID)
			if err != nil || run.State != "dispatching" || run.AttemptID != stale.AttemptID {
				return err
			}
			if _, live := e.inFlight.Load(run.AttemptID); live {
				return nil
			}
			sc, err := txGet[model.Schedule](tx, "schedules", run.ScheduleID)
			if err != nil {
				return err
			}
			if err := e.classifyAttemptTx(tx, &run, problem("attempt_interrupted", "attempt ended before its outcome was recorded; no dispatch intent was committed")); err != nil {
				return err
			}
			if run.State == "blocked" {
				// Proven to have sent nothing: retry promptly.
				run.NextAttemptAt = e.now()
			}
			if err := tx.Put("schedule_runs", run.ID, run); err != nil {
				return err
			}
			return tx.Event("schedule.run."+run.State, scheduleEventScope(sc, run), "daemon", "", run)
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// scheduleOnce claims due occurrences, recovers interrupted attempts and starts
// eligible retries. It returns how long the loop may sleep.
func (e *Engine) scheduleOnce(ctx context.Context) time.Duration {
	if err := e.recoverRuns(ctx); err != nil {
		log.Printf("scheduler recovery: %v", err)
	}
	scheds, err := list[model.Schedule](ctx, e.store, "schedules", model.Scope{Global: true})
	if err != nil {
		log.Printf("scheduler: %v", err)
		return scheduleIdleWake
	}
	failed := map[string]bool{}
	for _, sc := range scheds {
		if !sc.Enabled || sc.State != "active" || sc.NextRunAt == 0 || sc.NextRunAt > e.now() {
			continue
		}
		run, err := e.claimDue(ctx, sc.ID)
		if err != nil {
			failed[sc.ID] = true
			log.Printf("schedule %s: claim: %v", sc.ID, err)
			continue
		}
		e.afterClaim(run)
	}
	e.kickMu.Lock()
	kicked := e.kicked
	e.kicked = map[string]bool{}
	e.kickMu.Unlock()
	pending, err := e.store.ScheduleRunsInState(ctx, "", "claimed", "blocked")
	if err != nil {
		log.Printf("scheduler: %v", err)
		return scheduleIdleWake
	}
	wake := scheduleIdleWake
	now := e.now()
	for _, run := range pending {
		if run.State == "claimed" || run.NextAttemptAt <= now || kicked[run.WorkerID] {
			e.background(func() { e.executeRun(e.ctx, run.ID) })
			continue
		}
		wake = min(wake, time.Duration(run.NextAttemptAt-now)*time.Millisecond)
	}
	scheds, err = list[model.Schedule](ctx, e.store, "schedules", model.Scope{Global: true})
	if err == nil {
		for _, sc := range scheds {
			if failed[sc.ID] {
				// A failing claim backs off instead of spinning on a past due time.
				wake = min(wake, scheduleRetryMin)
			} else if sc.Enabled && sc.State == "active" && sc.NextRunAt != 0 {
				wake = min(wake, time.Duration(sc.NextRunAt-e.now())*time.Millisecond)
			}
		}
	}
	return max(wake, 10*time.Millisecond)
}

// scheduler sleeps until the earliest due time or retry. Mutations and worker
// lifecycle observations wake it early; the cap bounds wall-clock jumps.
func (e *Engine) scheduler() {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-e.ctx.Done():
			return
		case <-timer.C:
		case <-e.scheduleKick:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		}
		timer.Reset(e.scheduleOnce(e.ctx))
	}
}
