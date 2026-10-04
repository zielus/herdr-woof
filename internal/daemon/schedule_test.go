package daemon

// Scheduler cases. TestScheduleManualRunHistoryAndInvalidCron adapts
// herdr-orch's TestScheduleHorchAction (MIT) to Woof's durable message action;
// the remaining cases are Woof-specific claim, recovery and target checks.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zielus/herdr-woof/internal/model"
	"github.com/zielus/herdr-woof/internal/store"
)

var scopeA = model.Scope{SessionID: "s_a", WorkspaceID: "ws_a"}

func schedClock(e *Engine, start time.Time) *atomic.Int64 {
	now := &atomic.Int64{}
	now.Store(start.UnixMilli())
	e.opts.Now = func() time.Time { return time.UnixMilli(now.Load()) }
	return now
}

func schedReq(t *testing.T, e *Engine, op string, scope model.Scope, a Args) (any, error) {
	t.Helper()
	raw, _ := json.Marshal(a)
	return e.Handle(context.Background(), model.Request{Version: model.Protocol, ID: newID("op"), Op: op, Scope: scope, ScopeExplicit: true, Args: raw, Caller: model.Caller{Cwd: "/tmp"}})
}

func addSchedule(t *testing.T, e *Engine, a Args) model.Schedule {
	t.Helper()
	v, err := schedReq(t, e, "schedule.add", scopeA, a)
	if err != nil {
		t.Fatal(err)
	}
	return v.(model.Schedule)
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var me *model.Error
	if !errors.As(err, &me) || me.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}

func runsOf(t *testing.T, e *Engine, id string) []model.ScheduleRun {
	t.Helper()
	runs, err := e.store.ScheduleRuns(context.Background(), id, 1000)
	if err != nil {
		t.Fatal(err)
	}
	return runs
}

func runsIn(t *testing.T, e *Engine, id, state string) []model.ScheduleRun {
	t.Helper()
	var out []model.ScheduleRun
	for _, r := range runsOf(t, e, id) {
		if r.State == state {
			out = append(out, r)
		}
	}
	return out
}

func waitRun(t *testing.T, e *Engine, id string, states ...string) model.ScheduleRun {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	var run model.ScheduleRun
	for time.Now().Before(deadline) {
		run, _ = get[model.ScheduleRun](context.Background(), e.store, "schedule_runs", id)
		for _, s := range states {
			if run.State == s {
				return run
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("run did not reach %v: %+v", states, run)
	return run
}

func promptCount(f *fakeAgent) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.prompts)
}

func reload(t *testing.T, e *Engine, id string) model.Schedule {
	t.Helper()
	sc, err := get[model.Schedule](context.Background(), e.store, "schedules", id)
	if err != nil {
		t.Fatal(err)
	}
	return sc
}

func setWorkerState(t *testing.T, e *Engine, id, state string) {
	t.Helper()
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		w, err := txGet[model.Worker](tx, "workers", id)
		if err != nil {
			return err
		}
		w.State = state
		return tx.Put("workers", id, w)
	}); err != nil {
		t.Fatal(err)
	}
}

func TestScheduleManualRunHistoryAndInvalidCron(t *testing.T) {
	e, _, w := fixture(t)
	sc := addSchedule(t, e, Args{Name: "hello", To: "alice", Cron: "@every 1m", Body: "hello"})
	if sc.WorkerID != w.ID || sc.TargetName != "alice" || sc.Action != "message" || sc.Timezone == "" || sc.NextRunAt == 0 {
		t.Fatalf("schedule %+v", sc)
	}
	v, err := schedReq(t, e, "schedule.run", scopeA, Args{ID: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	run := v.(model.ScheduleRun)
	if run.State != "persisted" || run.Trigger != "manual" || run.MessageID == "" || len(run.DeliveryIDs) != 1 {
		t.Fatalf("run %+v", run)
	}
	m, err := get[model.Message](context.Background(), e.store, "messages", run.MessageID)
	if err != nil || m.ScheduleRunID != run.ID || m.ToID != w.ID || m.Body != "hello" || m.FromKind != "schedule" {
		t.Fatalf("message %+v %v", m, err)
	}
	h, err := schedReq(t, e, "schedule.history", scopeA, Args{ID: sc.ID})
	if err != nil {
		t.Fatal(err)
	}
	hist := h.([]scheduleRunView)
	if len(hist) != 1 || hist[0].Message == nil || len(hist[0].Deliveries) != 1 {
		t.Fatalf("history %+v", hist)
	}
	for _, bad := range []string{"nope", "0 0 30 2 *", "TZ=UTC", "61 * * * *", "@every 10ms"} {
		_, err := schedReq(t, e, "schedule.add", scopeA, Args{Name: "bad", To: "alice", Cron: bad, Body: "x"})
		wantCode(t, err, "invalid_cron")
	}
	_, err = schedReq(t, e, "schedule.add", scopeA, Args{Name: "bad", To: "alice", Cron: "@hourly", Body: "x", Timezone: "Mars/Olympus"})
	wantCode(t, err, "invalid_cron")
	_, err = schedReq(t, e, "schedule.add", scopeA, Args{Name: "hello", To: "alice", Cron: "@hourly", Body: "dup"})
	wantCode(t, err, "name_conflict")
	_, err = schedReq(t, e, "schedule.add", model.Scope{SessionID: "s_a"}, Args{Name: "noscope", To: "alice", Cron: "@hourly", Body: "x"})
	if err == nil {
		t.Fatal("schedule without workspace scope accepted")
	}
	_, err = schedReq(t, e, "schedule.add", scopeA, Args{Name: "both", To: "alice", Cron: "@hourly", Body: "x", Spec: "y"})
	wantCode(t, err, "invalid_args")
}

func TestScheduleDueAndNotDueWithDeterministicClock(t *testing.T) {
	e, _, _ := fixture(t)
	warsaw, _ := time.LoadLocation("Europe/Warsaw")
	clock := schedClock(e, time.Date(2026, 1, 5, 8, 59, 30, 0, warsaw))
	sc := addSchedule(t, e, Args{Name: "brief", To: "alice", Cron: "0 9 * * *", Timezone: "Europe/Warsaw", Body: "morning brief"})
	nine := time.Date(2026, 1, 5, 9, 0, 0, 0, warsaw)
	if sc.NextRunAt != nine.UnixMilli() || !strings.HasSuffix(sc.NextRunLocal, "+01:00") {
		t.Fatalf("next %d %s", sc.NextRunAt, sc.NextRunLocal)
	}
	e.scheduleOnce(context.Background())
	if n := len(runsOf(t, e, sc.ID)); n != 0 {
		t.Fatalf("fired early: %d", n)
	}
	clock.Store(nine.UnixMilli() - 1)
	e.scheduleOnce(context.Background())
	if n := len(runsOf(t, e, sc.ID)); n != 0 {
		t.Fatalf("fired 1ms early: %d", n)
	}
	clock.Store(nine.UnixMilli())
	e.scheduleOnce(context.Background())
	e.scheduleOnce(context.Background())
	runs := runsOf(t, e, sc.ID)
	if len(runs) != 1 || runs[0].State != "persisted" || runs[0].ScheduledFor != nine.UnixMilli() || runs[0].OccurrenceKey != "t:"+itoa(nine.UnixMilli()) {
		t.Fatalf("runs %+v", runs)
	}
	got := reload(t, e, sc.ID)
	if got.NextRunAt != nine.AddDate(0, 0, 1).UnixMilli() || got.LastRunID != runs[0].ID {
		t.Fatalf("not advanced %+v", got)
	}
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

func TestScheduleEnableDisableRemove(t *testing.T) {
	e, _, _ := fixture(t)
	start := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)
	clock := schedClock(e, start)
	sc := addSchedule(t, e, Args{Name: "tick", To: "alice", Cron: "@every 1h", Timezone: "UTC", Body: "tick", Disabled: true})
	if sc.Enabled || sc.NextRunAt != 0 {
		t.Fatalf("disabled schedule armed %+v", sc)
	}
	clock.Store(start.Add(3 * time.Hour).UnixMilli())
	e.scheduleOnce(context.Background())
	if len(runsOf(t, e, sc.ID)) != 0 {
		t.Fatal("disabled schedule fired")
	}
	v, err := schedReq(t, e, "schedule.enable", scopeA, Args{ID: "tick"})
	if err != nil {
		t.Fatal(err)
	}
	sc = v.(model.Schedule)
	if !sc.Enabled || sc.NextRunAt != start.Add(4*time.Hour).UnixMilli() {
		t.Fatalf("enable did not re-anchor: %+v", sc)
	}
	if len(runsOf(t, e, sc.ID)) != 0 {
		t.Fatal("enable caught up disabled period")
	}
	if _, err = schedReq(t, e, "schedule.disable", scopeA, Args{ID: sc.ID}); err != nil {
		t.Fatal(err)
	}
	// A disabled schedule may still be run explicitly.
	v, err = schedReq(t, e, "schedule.run", scopeA, Args{ID: sc.ID})
	if err != nil || v.(model.ScheduleRun).State != "persisted" {
		t.Fatalf("manual run on disabled: %+v %v", v, err)
	}
	if _, err = schedReq(t, e, "schedule.remove", scopeA, Args{ID: "tick"}); err != nil {
		t.Fatal(err)
	}
	l, _ := schedReq(t, e, "schedule.list", scopeA, Args{})
	all, _ := schedReq(t, e, "schedule.list", scopeA, Args{All: true})
	if len(l.([]model.Schedule)) != 0 || len(all.([]model.Schedule)) != 1 {
		t.Fatalf("list %v all %v", l, all)
	}
	_, err = schedReq(t, e, "schedule.enable", scopeA, Args{ID: sc.ID})
	wantCode(t, err, "schedule_removed")
	_, err = schedReq(t, e, "schedule.run", scopeA, Args{ID: sc.ID})
	wantCode(t, err, "schedule_removed")
	_, err = schedReq(t, e, "schedule.show", scopeA, Args{ID: "tick"})
	wantCode(t, err, "not_found")
	if h, err := schedReq(t, e, "schedule.history", scopeA, Args{ID: sc.ID}); err != nil || len(h.([]scheduleRunView)) != 1 {
		t.Fatalf("history after remove: %v %v", h, err)
	}
	again := addSchedule(t, e, Args{Name: "tick", To: "alice", Cron: "@hourly", Body: "new"})
	if again.ID == sc.ID {
		t.Fatal("removed ID reused")
	}
}

func TestScheduleDispatchSettlesOnlyWithReportAndTurnEnd(t *testing.T) {
	e, f, w := fixture(t)
	sc := addSchedule(t, e, Args{Name: "review", To: w.ID, Cron: "@daily", Spec: "review open PRs"})
	v, err := schedReq(t, e, "schedule.run", scopeA, Args{ID: sc.ID})
	if err != nil {
		t.Fatal(err)
	}
	run := v.(model.ScheduleRun)
	if run.State != "dispatched" || run.DispatchID == "" || run.RunID == "" || promptCount(f) != 1 {
		t.Fatalf("run %+v prompts %d", run, promptCount(f))
	}
	d, _ := get[model.Dispatch](context.Background(), e.store, "dispatches", run.DispatchID)
	if d.ScheduleRunID != run.ID || d.Spec != "review open PRs" || d.Status != "active" {
		t.Fatalf("dispatch %+v", d)
	}
	op, _ := get[model.Operation](context.Background(), e.store, "operations", run.AttemptID)
	if op.State != "completed" || op.ResourceID != d.ID {
		t.Fatalf("attempt receipt %+v", op)
	}
	if _, err := call(t, e, "done", Args{Dispatch: d.ID, Attachment: w.AttachmentID, Body: "done"}); err != nil {
		t.Fatal(err)
	}
	if d, _ = get[model.Dispatch](context.Background(), e.store, "dispatches", d.ID); d.Status == "settled" {
		t.Fatal("report alone settled scheduled dispatch")
	}
	setObservation(t, e, f, w, "working", 3, w.CompletionSeq)
	seq := uint64(4)
	setObservation(t, e, f, w, "idle", 4, &seq)
	if d, _ = get[model.Dispatch](context.Background(), e.store, "dispatches", d.ID); d.Status != "settled" {
		t.Fatalf("not settled %+v", d)
	}
	h, _ := schedReq(t, e, "schedule.history", scopeA, Args{ID: sc.ID})
	if hist := h.([]scheduleRunView); hist[0].Dispatch == nil || hist[0].Dispatch.Status != "settled" {
		t.Fatalf("history does not join live dispatch %+v", hist)
	}
}

func TestScheduleBusyWorkerBlocksThenRetriesWithoutInterrupting(t *testing.T) {
	e, f, w := fixture(t)
	clock := schedClock(e, time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC))
	setObservation(t, e, f, w, "working", 3, w.CompletionSeq)
	sc := addSchedule(t, e, Args{Name: "build", To: "alice", Cron: "*/5 * * * *", Timezone: "UTC", Spec: "run the build"})
	clock.Add(5 * time.Minute.Milliseconds())
	e.scheduleOnce(context.Background())
	runs := runsOf(t, e, sc.ID)
	if len(runs) != 1 {
		t.Fatalf("runs %+v", runs)
	}
	run := waitRun(t, e, runs[0].ID, "blocked")
	if !strings.HasPrefix(run.Reason, "worker_busy") || run.NextAttemptAt == 0 || promptCount(f) != 0 {
		t.Fatalf("busy run %+v prompts %d", run, promptCount(f))
	}
	op, _ := get[model.Operation](context.Background(), e.store, "operations", run.AttemptID)
	if op.State != "failed" || op.ErrorCode != "worker_busy" || op.ResourceKind != "" {
		t.Fatalf("pre-intent receipt %+v", op)
	}
	// Due occurrences while the first is blocked are coalesced onto it, not queued.
	for i := 0; i < 3; i++ {
		clock.Add(5 * time.Minute.Milliseconds())
		e.scheduleOnce(context.Background())
	}
	held := runsOf(t, e, sc.ID)
	if len(held) != 1 || held[0].SkippedCount != 3 || held[0].SkippedLast != clock.Load() {
		t.Fatalf("overlap not coalesced: %+v", held)
	}
	evs, _ := e.store.Events(context.Background(), 0, model.Scope{Global: true}, []string{"schedule.run.skipped"}, 0)
	if len(evs) != 3 {
		t.Fatalf("skip events %d", len(evs))
	}
	// Lifecycle evidence (busy -> idle) wakes the scheduler for this worker.
	seq := uint64(4)
	setObservation(t, e, f, w, "idle", 4, &seq)
	e.scheduleOnce(context.Background())
	run = waitRun(t, e, run.ID, "dispatched")
	if run.Attempts < 2 || promptCount(f) != 1 {
		t.Fatalf("retry %+v prompts %d", run, promptCount(f))
	}
}

func TestScheduledMessageToBusyWorkerQueuesWithoutPrompt(t *testing.T) {
	e, f, w := fixture(t)
	setObservation(t, e, f, w, "working", 3, w.CompletionSeq)
	sc := addSchedule(t, e, Args{Name: "note", To: "alice", Cron: "@hourly", Body: "standup"})
	v, err := schedReq(t, e, "schedule.run", scopeA, Args{ID: sc.ID})
	if err != nil {
		t.Fatal(err)
	}
	run := v.(model.ScheduleRun)
	time.Sleep(50 * time.Millisecond)
	if run.State != "persisted" || promptCount(f) != 0 {
		t.Fatalf("busy message %+v prompts %d", run, promptCount(f))
	}
	d, _ := get[model.Delivery](context.Background(), e.store, "deliveries", run.DeliveryIDs[0])
	if d.WakeStatus != "queued" || d.Status != "pending" {
		t.Fatalf("delivery %+v", d)
	}
	seq := uint64(4)
	setObservation(t, e, f, w, "idle", 4, &seq)
	waitInboxState(t, e, d.ID, "sent")
	if promptCount(f) != 1 {
		t.Fatalf("prompts %d", promptCount(f))
	}
	// Delivery is not completion: the run stays persisted, the delivery advances.
	if got, _ := get[model.ScheduleRun](context.Background(), e.store, "schedule_runs", run.ID); got.State != "persisted" {
		t.Fatalf("run %+v", got)
	}
}

func TestScheduleMissedRunsCoalesceAndPolicy(t *testing.T) {
	e, _, _ := fixture(t)
	start := time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)
	clock := schedClock(e, start)
	latest := addSchedule(t, e, Args{Name: "latest", To: "alice", Cron: "@every 1h", Body: "l"})
	skip := addSchedule(t, e, Args{Name: "skip", To: "alice", Cron: "@every 1h", Body: "s", Missed: "skip"})
	graced := addSchedule(t, e, Args{Name: "graced", To: "alice", Cron: "@every 1h", Body: "g", Missed: "skip"})
	// The daemon was down from 00:30 to 05:20: 01:00..05:00 were due.
	clock.Store(start.Add(5*time.Hour + 20*time.Minute).UnixMilli())
	for _, id := range []string{latest.ID, skip.ID} {
		if _, err := e.claimDue(context.Background(), id); err != nil {
			t.Fatal(err)
		}
	}
	lr := runsOf(t, e, latest.ID)
	missed := runsIn(t, e, latest.ID, "missed")
	fired := runsIn(t, e, latest.ID, "persisted")
	if len(lr) != 2 || len(missed) != 1 || len(fired) != 1 || missed[0].MissedCount != 4 || missed[0].ScheduledFor != start.Add(time.Hour).UnixMilli() || missed[0].MissedLast != start.Add(4*time.Hour).UnixMilli() || fired[0].ScheduledFor != start.Add(5*time.Hour).UnixMilli() {
		t.Fatalf("latest policy %+v", lr)
	}
	sr := runsOf(t, e, skip.ID)
	if len(sr) != 1 || sr[0].State != "missed" || sr[0].MissedCount != 5 || sr[0].MissedLast != start.Add(5*time.Hour).UnixMilli() {
		t.Fatalf("skip policy %+v", sr)
	}
	for _, id := range []string{latest.ID, skip.ID} {
		if next := reload(t, e, id).NextRunAt; next != start.Add(6*time.Hour).UnixMilli() {
			t.Fatalf("next %d", next)
		}
	}
	// Within the grace window a skip schedule still fires the latest occurrence.
	clock.Store(start.Add(5*time.Hour + 30*time.Second).UnixMilli())
	if _, err := e.claimDue(context.Background(), graced.ID); err != nil {
		t.Fatal(err)
	}
	if fired := runsIn(t, e, graced.ID, "persisted"); len(fired) != 1 || fired[0].ScheduledFor != start.Add(5*time.Hour).UnixMilli() {
		t.Fatalf("grace %+v", runsOf(t, e, graced.ID))
	}
}

func TestScheduleTimezoneAndDSTFiring(t *testing.T) {
	e, _, _ := fixture(t)
	ny, _ := time.LoadLocation("America/New_York")
	clock := schedClock(e, time.Date(2026, 3, 7, 12, 0, 0, 0, ny))
	gap := addSchedule(t, e, Args{Name: "gap", To: "alice", Cron: "30 2 * * *", Timezone: "America/New_York", Body: "g"})
	// 2026-03-07 02:30 EST already passed; next is the nonexistent 03-08 02:30,
	// which fires once at the end of the gap (03:00 EDT = 07:00Z).
	gapEnd := time.Date(2026, 3, 8, 7, 0, 0, 0, time.UTC)
	if gap.NextRunAt != gapEnd.UnixMilli() || !strings.HasSuffix(gap.NextRunLocal, "-04:00") {
		t.Fatalf("gap next %s", gap.NextRunLocal)
	}
	clock.Store(gapEnd.UnixMilli() - 1)
	e.scheduleOnce(context.Background())
	if len(runsOf(t, e, gap.ID)) != 0 {
		t.Fatal("fired before gap end")
	}
	clock.Store(gapEnd.UnixMilli())
	e.scheduleOnce(context.Background())
	runs := runsOf(t, e, gap.ID)
	if len(runs) != 1 || runs[0].ScheduledFor != gapEnd.UnixMilli() || !strings.HasSuffix(runs[0].ScheduledForLocal, "-04:00") {
		t.Fatalf("gap runs %+v", runs)
	}
	if next := reload(t, e, gap.ID).NextRunAt; next != time.Date(2026, 3, 9, 2, 30, 0, 0, ny).UnixMilli() {
		t.Fatalf("after gap next %v", time.UnixMilli(next).In(ny))
	}

	clock.Store(time.Date(2026, 10, 31, 12, 0, 0, 0, ny).UnixMilli())
	repeat := addSchedule(t, e, Args{Name: "repeat", To: "alice", Cron: "30 1 * * *", Timezone: "America/New_York", Body: "r"})
	first := time.Date(2026, 11, 1, 5, 30, 0, 0, time.UTC)  // 01:30 EDT
	second := time.Date(2026, 11, 1, 6, 30, 0, 0, time.UTC) // 01:30 EST
	clock.Store(first.UnixMilli())
	e.scheduleOnce(context.Background())
	clock.Store(second.UnixMilli())
	e.scheduleOnce(context.Background())
	runs = runsOf(t, e, repeat.ID)
	if len(runs) != 1 || runs[0].ScheduledFor != first.UnixMilli() {
		t.Fatalf("repeated wall time fired %d times: %+v", len(runs), runs)
	}
	if next := reload(t, e, repeat.ID).NextRunAt; next != time.Date(2026, 11, 2, 1, 30, 0, 0, ny).UnixMilli() {
		t.Fatalf("after repeat next %v", time.UnixMilli(next).In(ny))
	}
}

func TestScheduleConcurrentClaimsAndManualRunsDoNotDuplicate(t *testing.T) {
	e, f, w := fixture(t)
	start := time.Date(2026, 5, 1, 9, 0, 0, 0, time.UTC)
	clock := schedClock(e, start)
	msg := addSchedule(t, e, Args{Name: "msg", To: "alice", Cron: "@every 1m", Body: "m"})
	clock.Store(start.Add(time.Minute).UnixMilli())
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(2)
		go func() { defer wg.Done(); _, _ = e.claimDue(context.Background(), msg.ID) }()
		go func() { defer wg.Done(); e.scheduleOnce(context.Background()) }()
	}
	wg.Wait()
	if runs := runsOf(t, e, msg.ID); len(runs) != 1 || runs[0].State != "persisted" {
		t.Fatalf("duplicate claims: %+v", runs)
	}
	ms, _ := list[model.Message](context.Background(), e.store, "messages", model.Scope{})
	if len(ms) != 1 {
		t.Fatalf("messages %d", len(ms))
	}

	// Concurrent manual runs of a dispatch schedule: one claims, the others see
	// the outstanding occurrence; one prompt at most.
	setObservation(t, e, f, w, "working", 3, w.CompletionSeq)
	disp := addSchedule(t, e, Args{Name: "disp", To: "alice", Cron: "@daily", Spec: "task"})
	var errs atomic.Int32
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := schedReq(t, e, "schedule.run", scopeA, Args{ID: disp.ID}); err != nil {
				errs.Add(1)
			}
		}()
	}
	wg.Wait()
	runs := runsOf(t, e, disp.ID)
	if len(runs) != 1 || int(errs.Load()) != 7 || promptCount(f) != 0 {
		t.Fatalf("manual runs %d errors %d prompts %d", len(runs), errs.Load(), promptCount(f))
	}
	_, err := schedReq(t, e, "schedule.run", scopeA, Args{ID: disp.ID})
	wantCode(t, err, "run_outstanding")

	// A replayed request ID returns its receipt instead of claiming again.
	idle := uint64(4)
	setObservation(t, e, f, w, "idle", 4, &idle)
	_, _ = schedReq(t, e, "schedule.disable", scopeA, Args{ID: disp.ID})
	raw, _ := json.Marshal(Args{ID: disp.ID})
	req := model.Request{Version: model.Protocol, ID: newID("op"), Op: "schedule.run", Scope: scopeA, ScopeExplicit: true, Args: raw, Caller: model.Caller{Cwd: "/tmp"}}
	a, errA := e.Handle(context.Background(), req)
	b, errB := e.Handle(context.Background(), req)
	if errA != nil || errB != nil {
		t.Fatalf("replay: %v %v", errA, errB)
	}
	ra, _ := json.Marshal(a.(model.ScheduleRun).ID)
	rb, _ := json.Marshal(b.(map[string]any)["id"])
	if string(ra) != string(rb) || len(runsOf(t, e, disp.ID)) != 2 || promptCount(f) != 1 {
		t.Fatalf("replayed manual run duplicated: %s %s runs %d prompts %d", ra, rb, len(runsOf(t, e, disp.ID)), promptCount(f))
	}
}

func TestScheduleRestartRecoversInterruptedAttemptFromEvidence(t *testing.T) {
	e, f, w := fixture(t)
	clock := schedClock(e, time.Date(2026, 6, 1, 8, 0, 0, 0, time.UTC))
	sc := addSchedule(t, e, Args{Name: "nightly", To: "alice", Cron: "@daily", Timezone: "UTC", Spec: "nightly task"})
	// A crash after the attempt intent but before the dispatch intent: the
	// receipt has no linked dispatch, so no prompt can have been sent.
	attempt := newID("op")
	var run model.ScheduleRun
	current := reload(t, e, sc.ID)
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		var err error
		run, err = e.createRunTx(tx, current, model.ScheduleRun{OccurrenceKey: "t:1", Trigger: "scheduled", ScheduledFor: e.now(), State: "dispatching", AttemptID: attempt, Attempts: 1}, "daemon", "")
		if err != nil {
			return err
		}
		return tx.Put("operations", attempt, model.Operation{ID: attempt, Op: "schedule.dispatch", State: "accepted"})
	}); err != nil {
		t.Fatal(err)
	}
	// Restart: a new engine over the same store with no in-flight memory.
	e.Close()
	e2 := NewEngine(e.store, Options{Now: e.opts.Now})
	t.Cleanup(e2.Close)
	e2.sessions = e.sessions
	e2.scheduleOnce(context.Background())
	got := waitRun(t, e2, run.ID, "dispatched")
	if got.Attempts != 2 || promptCount(f) != 1 {
		t.Fatalf("recovered %+v prompts %d", got, promptCount(f))
	}
	if op, _ := get[model.Operation](context.Background(), e2.store, "operations", attempt); op.State != "failed" || op.ErrorCode != "attempt_interrupted" {
		t.Fatalf("interrupted receipt %+v", op)
	}

	// A crash after dispatch intent (dispatch still "sending") is uncertain and
	// is never retried, even across further scheduler passes.
	d := mustDispatchSending(t, e2, w, sc)
	clock.Add(time.Hour.Milliseconds())
	for i := 0; i < 3; i++ {
		e2.scheduleOnce(context.Background())
	}
	time.Sleep(50 * time.Millisecond)
	u := waitRun(t, e2, d.ScheduleRunID, "uncertain")
	if u.DispatchID != d.ID || !strings.Contains(u.Error, "never resent") || promptCount(f) != 1 {
		t.Fatalf("uncertain %+v prompts %d", u, promptCount(f))
	}
}

// mustDispatchSending persists a dispatching occurrence whose attempt receipt is
// linked to a dispatch still in "sending", as left by a crash mid-prompt.
func mustDispatchSending(t *testing.T, e *Engine, w model.Worker, sc model.Schedule) model.Dispatch {
	t.Helper()
	attempt := newID("op")
	d := model.Dispatch{ID: newID("dispatch"), SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, WorkerID: w.ID, AttachmentID: w.AttachmentID, Spec: sc.Spec, Status: "sending", Attempt: 1, OperationID: attempt, CreatedAt: e.now()}
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		// Settle the earlier recovered dispatch so this one can be active.
		prior, err := txList[model.Dispatch](tx, "dispatches", model.Scope{WorkerID: w.ID})
		if err != nil {
			return err
		}
		for _, p := range prior {
			p.Status = "settled"
			if err := tx.Put("dispatches", p.ID, p); err != nil {
				return err
			}
		}
		run, err := e.createRunTx(tx, sc, model.ScheduleRun{OccurrenceKey: "t:2", Trigger: "scheduled", ScheduledFor: e.now(), State: "dispatching", AttemptID: attempt, Attempts: 1}, "daemon", "")
		if err != nil {
			return err
		}
		d.ScheduleRunID = run.ID
		runRec := model.Run{ID: newID("run"), SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, Kind: "adhoc", Status: "active", Implicit: true}
		d.RunID = runRec.ID
		if err := tx.Put("runs", runRec.ID, runRec); err != nil {
			return err
		}
		if err := tx.Put("dispatches", d.ID, d); err != nil {
			return err
		}
		return tx.Put("operations", attempt, model.Operation{ID: attempt, Op: "schedule.dispatch", State: "accepted", ResourceKind: "dispatches", ResourceID: d.ID})
	}); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestScheduleUncertainDispatchIsNeverResent(t *testing.T) {
	e, f, _ := fixture(t)
	clock := schedClock(e, time.Date(2026, 7, 1, 8, 0, 0, 0, time.UTC))
	f.mu.Lock()
	f.uncertain = true
	f.mu.Unlock()
	sc := addSchedule(t, e, Args{Name: "u", To: "alice", Cron: "@every 1m", Spec: "task"})
	v, err := schedReq(t, e, "schedule.run", scopeA, Args{ID: sc.ID})
	if err != nil {
		t.Fatal(err)
	}
	run := v.(model.ScheduleRun)
	if run.State != "uncertain" || run.DispatchID == "" {
		t.Fatalf("run %+v", run)
	}
	op, _ := get[model.Operation](context.Background(), e.store, "operations", run.AttemptID)
	if op.State != "uncertain" {
		t.Fatalf("attempt receipt %+v", op)
	}
	f.mu.Lock()
	f.uncertain = false
	f.mu.Unlock()
	for i := 0; i < 3; i++ {
		clock.Add(time.Minute.Milliseconds())
		e.kickScheduler(run.WorkerID)
		e.scheduleOnce(context.Background())
	}
	time.Sleep(100 * time.Millisecond)
	if promptCount(f) != 1 {
		t.Fatalf("uncertain prompt resent: %d", promptCount(f))
	}
	// Later occurrences are refused by the still-active uncertain dispatch and
	// wait as blocked/skipped history; the original stays inspectable.
	if got, _ := get[model.ScheduleRun](context.Background(), e.store, "schedule_runs", run.ID); got.State != "uncertain" {
		t.Fatalf("run changed %+v", got)
	}
	if blocked := runsIn(t, e, sc.ID, "blocked"); len(blocked) != 1 || !strings.HasPrefix(blocked[0].Reason, "dispatch_active") || blocked[0].SkippedCount != 2 {
		t.Fatalf("later occurrences %+v", runsOf(t, e, sc.ID))
	}
}

func TestScheduleOfflineLostTerminalAndStaleTargets(t *testing.T) {
	e, f, w := fixture(t)
	clock := schedClock(e, time.Date(2026, 8, 1, 8, 0, 0, 0, time.UTC))
	disp := addSchedule(t, e, Args{Name: "d", To: "alice", Cron: "@every 1m", Spec: "task"})
	ops := func() int {
		os, _ := list[model.Operation](context.Background(), e.store, "operations", model.Scope{})
		n := 0
		for _, o := range os {
			if o.Op == "schedule.dispatch" {
				n++
			}
		}
		return n
	}
	for _, state := range []string{"offline", "lost"} {
		setWorkerState(t, e, w.ID, state)
		_, _ = schedReq(t, e, "schedule.disable", scopeA, Args{ID: disp.ID})
		v, err := schedReq(t, e, "schedule.run", scopeA, Args{ID: disp.ID})
		if err != nil {
			t.Fatal(err)
		}
		if run := v.(model.ScheduleRun); run.State != "blocked" || !strings.Contains(run.Reason, "target_unavailable") || ops() != 0 {
			t.Fatalf("%s: %+v ops %d", state, run, ops())
		}
	}
	// Stale identity: a reused pane with a different terminal cannot be prompted.
	setWorkerState(t, e, w.ID, "idle")
	f.mu.Lock()
	f.p.TerminalID = "terminal-reused"
	f.mu.Unlock()
	_, _ = schedReq(t, e, "schedule.disable", scopeA, Args{ID: disp.ID})
	v, err := schedReq(t, e, "schedule.run", scopeA, Args{ID: disp.ID})
	if err != nil {
		t.Fatal(err)
	}
	if run := v.(model.ScheduleRun); run.State != "blocked" || !strings.HasPrefix(run.Reason, "stale_attachment") || promptCount(f) != 0 {
		t.Fatalf("stale identity %+v prompts %d", run, promptCount(f))
	}
	f.mu.Lock()
	f.p.TerminalID = "terminal-1"
	f.mu.Unlock()
	_, _ = schedReq(t, e, "schedule.disable", scopeA, Args{ID: disp.ID})

	// Terminal worker whose alias is reused: the schedule keeps its worker ID.
	msg := addSchedule(t, e, Args{Name: "m", To: "alice", Cron: "@every 1m", Body: "hi"})
	setWorkerState(t, e, w.ID, "released")
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		return tx.Put("workers", "worker_b", model.Worker{ID: "worker_b", SessionID: "s_a", WorkspaceID: "ws_a", Name: "alice", State: "idle", AttachmentID: "att_b"})
	}); err != nil {
		t.Fatal(err)
	}
	clock.Add(time.Minute.Milliseconds())
	e.scheduleOnce(context.Background())
	blocked := runsIn(t, e, msg.ID, "blocked")
	if len(blocked) != 1 || !strings.Contains(blocked[0].Reason, "target_terminal") || blocked[0].WorkerID != w.ID {
		t.Fatalf("terminal message %+v", runsOf(t, e, msg.ID))
	}
	ms, _ := list[model.Message](context.Background(), e.store, "messages", model.Scope{})
	for _, m := range ms {
		if m.ToID == "worker_b" {
			t.Fatal("reused alias silently retargeted")
		}
	}
	// Disabling makes the blocked state actionable: it is cancelled, not lost.
	if _, err := schedReq(t, e, "schedule.disable", scopeA, Args{ID: msg.ID}); err != nil {
		t.Fatal(err)
	}
	if c := runsIn(t, e, msg.ID, "cancelled"); len(c) != 1 || c[0].ID != blocked[0].ID {
		t.Fatalf("cancel %+v", runsOf(t, e, msg.ID))
	}
	_, err = schedReq(t, e, "schedule.add", scopeA, Args{Name: "late", To: w.ID, Cron: "@hourly", Body: "x"})
	wantCode(t, err, "worker_not_live")
}

func TestScheduleIsolationAcrossTwoSessions(t *testing.T) {
	e, _, w := fixture(t)
	scopeB := model.Scope{SessionID: "s_b", WorkspaceID: "ws_b"}
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		if err := tx.Put("sessions", "s_b", model.Session{ID: "s_b", HerdrName: "other", SocketPath: "/tmp/other.sock", Status: "online"}); err != nil {
			return err
		}
		if err := tx.Put("workspaces", "ws_b", model.Workspace{ID: "ws_b", SessionID: "s_b"}); err != nil {
			return err
		}
		return tx.Put("workers", "worker_bb", model.Worker{ID: "worker_bb", SessionID: "s_b", WorkspaceID: "ws_b", Name: "alice", State: "idle", AttachmentID: "att_bb"})
	}); err != nil {
		t.Fatal(err)
	}
	a := addSchedule(t, e, Args{Name: "daily", To: "alice", Cron: "@daily", Body: "a"})
	if a.WorkerID != w.ID {
		t.Fatalf("name resolved outside scope: %s", a.WorkerID)
	}
	_, err := schedReq(t, e, "schedule.add", scopeA, Args{Name: "cross", To: "worker_bb", Cron: "@daily", Body: "x"})
	wantCode(t, err, "invalid_scope")
	v, err := schedReq(t, e, "schedule.add", scopeB, Args{Name: "daily", To: "alice", Cron: "@daily", Body: "b"})
	if err != nil {
		t.Fatal(err)
	}
	b := v.(model.Schedule)
	if b.WorkerID != "worker_bb" {
		t.Fatalf("session B target %s", b.WorkerID)
	}
	for _, c := range []struct {
		scope model.Scope
		want  string
	}{{scopeA, a.ID}, {scopeB, b.ID}, {model.Scope{SessionID: "s_b"}, b.ID}} {
		l, err := schedReq(t, e, "schedule.list", c.scope, Args{})
		if err != nil {
			t.Fatal(err)
		}
		if got := l.([]model.Schedule); len(got) != 1 || got[0].ID != c.want {
			t.Fatalf("list %+v: %+v", c.scope, got)
		}
	}
	_, err = schedReq(t, e, "schedule.show", scopeB, Args{ID: a.ID})
	wantCode(t, err, "not_found")
	_, err = schedReq(t, e, "schedule.disable", scopeB, Args{ID: a.ID})
	wantCode(t, err, "not_found")
	if s, err := schedReq(t, e, "schedule.show", scopeB, Args{ID: "daily"}); err != nil || s.(map[string]any)["schedule"].(model.Schedule).ID != b.ID {
		t.Fatalf("name in B: %v %v", s, err)
	}
	evs, _ := e.store.Events(context.Background(), 0, model.Scope{SessionID: "s_b"}, []string{"schedule.created"}, 0)
	if len(evs) != 1 || evs[0].SessionID != "s_b" {
		t.Fatalf("session B events %+v", evs)
	}
}

func TestScheduleClaimCollisionAdvancesWithoutSpinning(t *testing.T) {
	e, _, _ := fixture(t)
	nine := time.Date(2026, 9, 1, 9, 0, 0, 0, time.UTC)
	clock := schedClock(e, nine.Add(-time.Minute))
	sc := addSchedule(t, e, Args{Name: "nine", To: "alice", Cron: "0 9 * * *", Timezone: "UTC", Body: "b"})
	clock.Store(nine.UnixMilli())
	e.scheduleOnce(context.Background())
	// The clock steps back and the schedule is re-enabled: the series returns
	// to the occurrence that was already claimed.
	clock.Store(nine.Add(-2 * time.Minute).UnixMilli())
	for _, op := range []string{"schedule.disable", "schedule.enable"} {
		if _, err := schedReq(t, e, op, scopeA, Args{ID: sc.ID}); err != nil {
			t.Fatal(err)
		}
	}
	if next := reload(t, e, sc.ID).NextRunAt; next != nine.UnixMilli() {
		t.Fatalf("precondition: next %d", next)
	}
	clock.Store(nine.UnixMilli())
	wake := e.scheduleOnce(context.Background())
	if runs := runsOf(t, e, sc.ID); len(runs) != 1 {
		t.Fatalf("occurrence claimed twice: %+v", runs)
	}
	if next := reload(t, e, sc.ID).NextRunAt; next != nine.AddDate(0, 0, 1).UnixMilli() {
		t.Fatalf("schedule stalled at %d", next)
	}
	if wake < time.Second {
		t.Fatalf("loop would spin: wake %v", wake)
	}
}

func TestScheduledDispatchOccurrenceFollowsSettlementAndResolution(t *testing.T) {
	e, f, w := fixture(t)
	clock := schedClock(e, time.Date(2026, 9, 2, 8, 0, 0, 0, time.UTC))
	sc := addSchedule(t, e, Args{Name: "s", To: "alice", Cron: "@every 1h", Spec: "task"})
	v, err := schedReq(t, e, "schedule.run", scopeA, Args{ID: sc.ID})
	if err != nil {
		t.Fatal(err)
	}
	first := v.(model.ScheduleRun)
	head, _ := e.store.Head(context.Background())
	if _, err := call(t, e, "done", Args{Dispatch: first.DispatchID, Attachment: w.AttachmentID, Body: "ok"}); err != nil {
		t.Fatal(err)
	}
	if got, _ := get[model.ScheduleRun](context.Background(), e.store, "schedule_runs", first.ID); got.State != "dispatched" {
		t.Fatalf("report alone moved occurrence: %+v", got)
	}
	setObservation(t, e, f, w, "working", 3, w.CompletionSeq)
	seq := uint64(4)
	setObservation(t, e, f, w, "idle", 4, &seq)
	got, _ := get[model.ScheduleRun](context.Background(), e.store, "schedule_runs", first.ID)
	if got.State != "settled" || got.Reason != "done" {
		t.Fatalf("occurrence did not follow settlement: %+v", got)
	}
	if evs, _ := e.store.Events(context.Background(), head, model.Scope{Global: true}, []string{"schedule.run.settled"}, 0); len(evs) != 1 {
		t.Fatalf("settled events %d", len(evs))
	}

	// An uncertain prompt resolved as failed frees the worker. The uncertain
	// occurrence becomes failed and is never retried; only the next occurrence
	// sends a new prompt.
	f.mu.Lock()
	f.uncertain = true
	f.mu.Unlock()
	v, err = schedReq(t, e, "schedule.run", scopeA, Args{ID: sc.ID})
	if err != nil {
		t.Fatal(err)
	}
	second := v.(model.ScheduleRun)
	if second.State != "uncertain" || promptCount(f) != 2 {
		t.Fatalf("second %+v prompts %d", second, promptCount(f))
	}
	f.mu.Lock()
	f.uncertain = false
	f.mu.Unlock()
	if _, err := call(t, e, "operation.resolve", Args{ID: second.AttemptID, Resolution: "failed", Reason: "prompt never appeared in the pane"}); err != nil {
		t.Fatal(err)
	}
	if got, _ := get[model.ScheduleRun](context.Background(), e.store, "schedule_runs", second.ID); got.State != "failed" {
		t.Fatalf("resolution not reflected: %+v", got)
	}
	for i := 0; i < 3; i++ {
		e.kickScheduler(w.ID)
		e.scheduleOnce(context.Background())
	}
	if promptCount(f) != 2 {
		t.Fatalf("resolved occurrence was retried: %d prompts", promptCount(f))
	}
	clock.Add(time.Hour.Milliseconds())
	e.scheduleOnce(context.Background())
	third := waitRun(t, e, reload(t, e, sc.ID).LastRunID, "dispatched")
	if third.ID == second.ID || promptCount(f) != 3 {
		t.Fatalf("next occurrence %+v prompts %d", third, promptCount(f))
	}
}

func TestScheduleRecoveryClassifiesLandedDispatch(t *testing.T) {
	e, _, w := fixture(t)
	schedClock(e, time.Date(2026, 9, 3, 8, 0, 0, 0, time.UTC))
	sc := addSchedule(t, e, Args{Name: "landed", To: "alice", Cron: "@daily", Spec: "task"})
	d := mustDispatchSending(t, e, w, sc)
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		current, err := txGet[model.Dispatch](tx, "dispatches", d.ID)
		if err != nil {
			return err
		}
		current.Status = "active"
		return tx.Put("dispatches", d.ID, current)
	}); err != nil {
		t.Fatal(err)
	}
	if err := e.recoverRuns(context.Background()); err != nil {
		t.Fatal(err)
	}
	run, _ := get[model.ScheduleRun](context.Background(), e.store, "schedule_runs", d.ScheduleRunID)
	op, _ := get[model.Operation](context.Background(), e.store, "operations", run.AttemptID)
	if run.State != "dispatched" || run.DispatchID != d.ID || op.State != "completed" {
		t.Fatalf("landed dispatch: run %+v receipt %+v", run, op)
	}
}

func TestScheduleWorkerCallerSeesOwnSchedulesWhileRunScoped(t *testing.T) {
	e, _, w := fixture(t)
	sc := addSchedule(t, e, Args{Name: "own", To: "alice", Cron: "@daily", Body: "b"})
	mustDispatch(t, e, w) // gives the worker an inferred run scope
	raw, _ := json.Marshal(Args{})
	v, err := e.Handle(context.Background(), model.Request{Version: model.Protocol, Op: "schedule.list", Caller: model.Caller{WorkerID: w.ID, AttachmentID: w.AttachmentID}, Args: raw})
	if err != nil {
		t.Fatal(err)
	}
	if got := v.([]model.Schedule); len(got) != 1 || got[0].ID != sc.ID {
		t.Fatalf("worker list %+v", got)
	}
}

func TestSchedulerLoopWakesOnKick(t *testing.T) {
	e, _, _ := fixture(t)
	start := time.Date(2026, 9, 4, 8, 0, 0, 0, time.UTC)
	clock := schedClock(e, start)
	sc := addSchedule(t, e, Args{Name: "loop", To: "alice", Cron: "@every 1h", Body: "b"})
	e.background(e.scheduler)
	time.Sleep(20 * time.Millisecond)
	if len(runsOf(t, e, sc.ID)) != 0 {
		t.Fatal("fired early")
	}
	clock.Store(start.Add(time.Hour).UnixMilli())
	e.kickScheduler("")
	deadline := time.Now().Add(2 * time.Second)
	for len(runsOf(t, e, sc.ID)) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("loop did not claim after kick")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestScheduleListHonorsExplicitRunScopeAndJoinsLastRun(t *testing.T) {
	e, _, w := fixture(t)
	disp := addSchedule(t, e, Args{Name: "with-run", To: "alice", Cron: "@daily", Spec: "task"})
	addSchedule(t, e, Args{Name: "plain", To: "alice", Cron: "@daily", Body: "b"})
	v, err := schedReq(t, e, "schedule.run", scopeA, Args{ID: disp.ID})
	if err != nil {
		t.Fatal(err)
	}
	run := v.(model.ScheduleRun)
	l, err := schedReq(t, e, "schedule.list", model.Scope{RunID: run.RunID}, Args{})
	if err != nil {
		t.Fatal(err)
	}
	if got := l.([]model.Schedule); len(got) != 1 || got[0].ID != disp.ID {
		t.Fatalf("explicit run scope widened: %+v", got)
	}
	l, _ = schedReq(t, e, "schedule.list", scopeA, Args{})
	for _, sc := range l.([]model.Schedule) {
		if sc.ID == disp.ID && (sc.LastRun == nil || sc.LastRun.ID != run.ID) {
			t.Fatalf("last run not joined: %+v", sc)
		}
	}
	if stored := reload(t, e, disp.ID); stored.LastRun != nil || stored.WorkerID != w.ID {
		t.Fatalf("joined last run persisted: %+v", stored)
	}
}

func TestScheduleAttemptReceiptFollowsDeliveryEvidenceOnly(t *testing.T) {
	e, f, w := fixture(t)
	sc := addSchedule(t, e, Args{Name: "ev", To: "alice", Cron: "@every 1h", Spec: "task"})
	uncertainRun := func() model.ScheduleRun {
		t.Helper()
		f.mu.Lock()
		f.uncertain = true
		f.mu.Unlock()
		v, err := schedReq(t, e, "schedule.run", scopeA, Args{ID: sc.ID})
		f.mu.Lock()
		f.uncertain = false
		f.mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
		return v.(model.ScheduleRun)
	}
	receipt := func(id string) string {
		op, _ := get[model.Operation](context.Background(), e.store, "operations", id)
		return op.State
	}
	// Failing a dispatch proves nothing about delivery: the receipt stays uncertain.
	first := uncertainRun()
	if _, err := call(t, e, "fail", Args{Dispatch: first.DispatchID, Reason: "operator gave up"}); err != nil {
		t.Fatal(err)
	}
	if got, _ := get[model.ScheduleRun](context.Background(), e.store, "schedule_runs", first.ID); got.State != "failed" || receipt(first.AttemptID) != "uncertain" {
		t.Fatalf("failed without evidence: run %+v receipt %s", got, receipt(first.AttemptID))
	}
	// A report plus turn end proves the prompt landed: the receipt completes and
	// the occurrence event follows the dispatch event.
	second := uncertainRun()
	head, _ := e.store.Head(context.Background())
	if _, err := call(t, e, "done", Args{Dispatch: second.DispatchID, Attachment: w.AttachmentID, Body: "ok"}); err != nil {
		t.Fatal(err)
	}
	setObservation(t, e, f, w, "working", 3, w.CompletionSeq)
	seq := uint64(4)
	setObservation(t, e, f, w, "idle", 4, &seq)
	if got, _ := get[model.ScheduleRun](context.Background(), e.store, "schedule_runs", second.ID); got.State != "settled" || receipt(second.AttemptID) != "completed" {
		t.Fatalf("settled with evidence: run %+v receipt %s", got, receipt(second.AttemptID))
	}
	evs, _ := e.store.Events(context.Background(), head, model.Scope{Global: true}, []string{"dispatch.settled", "schedule.run.settled"}, 0)
	if len(evs) < 2 || evs[0].Type != "dispatch.settled" || evs[len(evs)-1].Type != "schedule.run.settled" {
		t.Fatalf("event order %+v", evs)
	}
}
