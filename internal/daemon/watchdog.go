package daemon

import (
	"context"
	"fmt"
	"github.com/zielus/herdr-woof/internal/herdr"
	"github.com/zielus/herdr-woof/internal/model"
	"github.com/zielus/herdr-woof/internal/store"
	"log"
	"regexp"
	"time"
)

// Adapted from Orch's durable dispatch escalation. Silence never causes failure
// or redispatch; deduplication is tied to the dispatch and reason, not inbox turns.
// Blocked workers are the exception: they alert per block episode, with or
// without a dispatch, and deduplicate on the worker record.
func (e *Engine) watchdogOnce(ctx context.Context) error {
	ss, err := list[model.Session](ctx, e.store, "sessions", model.Scope{})
	if err != nil {
		return err
	}
	for _, s := range ss {
		if s.Status != "online" {
			e.background(func() { _ = e.refreshSession(e.ctx, s.ID) })
		}
	}
	if err := e.recoverHeldWorkers(ctx); err != nil {
		return err
	}
	ds, err := list[model.Dispatch](ctx, e.store, "dispatches", model.Scope{})
	if err != nil {
		return err
	}
	for _, d := range ds {
		if !activeDispatch(d) {
			continue
		}
		w, err := get[model.Worker](ctx, e.store, "workers", d.WorkerID)
		if err != nil {
			continue
		}
		reasons := []string{}
		if d.AttachmentID != w.AttachmentID {
			reasons = append(reasons, "attachment_changed")
		}
		if d.Status == "sending" && e.now()-d.SentAt >= e.opts.QuietTimeout.Milliseconds() {
			reasons = append(reasons, "prompt_outcome_unobserved")
		}
		if d.ObservedWorkingAt == 0 && !d.TurnEnded && d.SentAt != 0 && e.now()-d.SentAt >= e.opts.QuietTimeout.Milliseconds() {
			reasons = append(reasons, "turn_unobserved")
		}
		if d.Status == "uncertain" {
			reasons = append(reasons, "prompt_outcome_uncertain")
		}
		if d.DoneAt != 0 && !d.TurnEnded && e.now()-d.DoneAt >= e.opts.QuietTimeout.Milliseconds() {
			reasons = append(reasons, "report_without_turn_end")
		}
		if idle(w.RawStatus) && d.DoneAt == 0 && d.IdleAt != 0 && e.now()-d.IdleAt >= e.opts.IdleTimeout.Milliseconds() {
			reasons = append(reasons, "idle_without_report")
		}
		// A blocked worker is silent because it waits for input. Its block
		// episode has its own alert and escalation, so it is not also reported
		// as inactivity.
		if !idle(w.RawStatus) && w.State != "blocked" && d.LastActivityAt != 0 && e.now()-d.LastActivityAt >= e.opts.QuietTimeout.Milliseconds() {
			reasons = append(reasons, "no_activity")
		}
		if w.State == "lost" || w.State == "offline" {
			reasons = append(reasons, "attachment_unavailable")
		}
		for _, reason := range reasons {
			if err = e.escalate(ctx, d, reason); err != nil {
				return err
			}
		}
	}
	workers, err := list[model.Worker](ctx, e.store, "workers", model.Scope{})
	if err != nil {
		return err
	}
	for _, w := range workers {
		if first, human := e.blockedDue(w); first || human {
			if err = e.escalateBlocked(ctx, w); err != nil {
				return err
			}
		}
	}
	deliveries, err := list[model.Delivery](ctx, e.store, "deliveries", model.Scope{})
	if err != nil {
		return err
	}
	if err := e.recoverInboxReads(ctx, deliveries); err != nil {
		return err
	}
	for _, delivery := range deliveries {
		if !delivery.Human && !delivery.Escalated && delivery.WakeStatus == "queued" && e.now()-delivery.CreatedAt >= e.opts.QuietTimeout.Milliseconds() {
			m, x := get[model.Message](ctx, e.store, "messages", delivery.MessageID)
			if x == nil && m.Kind == "escalation" {
				if x = e.write(ctx, func(tx *store.Tx) error {
					d, x := txGet[model.Delivery](tx, "deliveries", delivery.ID)
					if x != nil {
						return x
					}
					if d.Escalated {
						return nil
					}
					d.Escalated = true
					if x = tx.Put("deliveries", d.ID, d); x != nil {
						return x
					}
					return e.humanEscalationTx(tx, model.Scope{SessionID: m.SessionID, WorkspaceID: m.WorkspaceID, RunID: m.RunID}, "Escalation could not reach invoking worker. "+m.Body)
				}); x != nil {
					return x
				}
			}
		}
		if delivery.Human || delivery.Escalated || delivery.AttemptedAt == 0 || e.now()-delivery.AttemptedAt < e.opts.QuietTimeout.Milliseconds() {
			continue
		}
		if delivery.WakeStatus != "uncertain" && delivery.WakeStatus != "sending" && delivery.WakeStatus != "sent" && delivery.WakeStatus != "acknowledged" {
			continue
		}
		m, err := get[model.Message](ctx, e.store, "messages", delivery.MessageID)
		if err != nil || m.Kind == "escalation" {
			continue
		}
		_ = e.write(ctx, func(tx *store.Tx) error {
			d, err := txGet[model.Delivery](tx, "deliveries", delivery.ID)
			if err != nil {
				return err
			}
			if d.Escalated {
				return nil
			}
			d.Escalated = true
			if err = tx.Put("deliveries", d.ID, d); err != nil {
				return err
			}
			body := fmt.Sprintf("Message %s wakeup is %s without verified turn-end evidence. Inspect woof message show --id %s and worker read --id %s. Do not resend until investigated.", m.ID, d.WakeStatus, m.ID, d.WorkerID)
			return e.humanEscalationTx(tx, model.Scope{SessionID: d.SessionID, WorkspaceID: d.WorkspaceID, RunID: d.RunID}, body)
		})
	}
	return nil
}

// Retry incomplete incarnation evidence even when the session is healthy and
// no lifecycle event arrives. These tasks perform reads and reconciliation,
// never prompt delivery or replay of a previous mutation.
func (e *Engine) recoverHeldWorkers(ctx context.Context) error {
	workers, err := list[model.Worker](ctx, e.store, "workers", model.Scope{})
	if err != nil {
		return err
	}
	for _, w := range workers {
		if !w.RecoveryHeld || !sessionActive(w) || e.now()-w.RecoveryReadAt < time.Second.Milliseconds() {
			continue
		}
		s, err := get[model.Session](ctx, e.store, "sessions", w.SessionID)
		if err != nil || s.Status != "online" {
			continue
		}
		key := "native-read-recovery:" + w.ID
		if _, loaded := e.inFlight.LoadOrStore(key, true); loaded {
			continue
		}
		scheduled := false
		err = e.write(ctx, func(tx *store.Tx) error {
			current, err := txGet[model.Worker](tx, "workers", w.ID)
			if err != nil {
				return err
			}
			if !sameSessionBinding(w, current) || !current.RecoveryHeld || !sessionActive(current) || e.now()-current.RecoveryReadAt < time.Second.Milliseconds() {
				return nil
			}
			current.RecoveryReadAt = e.now()
			if err = tx.Put("workers", current.ID, current); err != nil {
				return err
			}
			scheduled = true
			return nil
		})
		if err != nil || !scheduled {
			e.inFlight.Delete(key)
			if err != nil {
				return err
			}
			continue
		}
		e.background(func() {
			defer e.inFlight.Delete(key)
			lane := e.lane("session:" + w.SessionID)
			lane.Lock()
			defer lane.Unlock()
			bounded, cancel := context.WithTimeout(e.ctx, 5*time.Second)
			defer cancel()
			current, err := get[model.Worker](bounded, e.store, "workers", w.ID)
			if err != nil || !sameSessionBinding(w, current) || !current.RecoveryHeld || !sessionActive(current) {
				return
			}
			c, err := e.sessionClient(current.SessionID)
			if err != nil {
				return
			}
			target := current.RecoveryPaneID
			if target == "" {
				target = current.PaneID
			}
			p, err := c.AgentGet(bounded, target)
			if err != nil {
				_ = e.holdNativeRecovery(bounded, current, "native recovery agent read failed: "+err.Error())
				return
			}
			_ = e.observeWorker(bounded, current, p, true, true)
		})
		if e.ctx.Err() != nil {
			e.inFlight.Delete(key)
		}
	}
	return nil
}
func (e *Engine) escalate(ctx context.Context, d model.Dispatch, reason string) error {
	var recipient string
	var fresh bool
	err := e.write(ctx, func(tx *store.Tx) error {
		current, err := txGet[model.Dispatch](tx, "dispatches", d.ID)
		if err != nil {
			return err
		}
		if current.Alerts == nil {
			current.Alerts = map[string]bool{}
		}
		if current.Alerts[reason] || !activeDispatch(current) {
			return nil
		}
		current.Alerts[reason] = true
		if err = tx.Put("dispatches", current.ID, current); err != nil {
			return err
		}
		run, err := txGet[model.Run](tx, "runs", current.RunID)
		if err != nil {
			return err
		}
		body := fmt.Sprintf("Dispatch %s for worker %s needs attention: %s. Run %s; attachment %s; report %s; turn ended=%t. Inspect: woof dispatch show --id %s; woof worker read --id %s. Then explicitly nudge --reason, fail --reason, or investigate. Silence will not fail or redispatch work.", current.ID, current.WorkerID, reason, current.RunID, current.AttachmentID, current.DoneMessageID, current.TurnEnded, current.ID, current.WorkerID)
		if current.Handoff != "" {
			body += " Handoff: " + current.Handoff
		}
		m, delivery, err := e.escalationTx(tx, model.Message{SessionID: current.SessionID, WorkspaceID: current.WorkspaceID, WorktreeID: current.WorktreeID, RunID: current.RunID, Body: body, DispatchID: current.ID}, run.InvokerWorkerID)
		if err != nil {
			return err
		}
		recipient = delivery.WorkerID
		fresh = true
		return tx.Event("dispatch.escalated", dispatchScope(current), "daemon", "", map[string]any{"reason": reason, "message": m})
	})
	if err != nil {
		return err
	}
	if fresh && recipient != "" {
		e.background(func() { e.processInbox(recipient) })
	}
	if fresh {
		e.notifyHuman(d.SessionID, d.ID+": "+reason, reason != "idle_without_report")
	}
	return nil
}

// notifyHuman asks Herdr for one notification per alert. Herdr may accept the
// request without showing anything (toast delivery off, no foreground client);
// that is logged and handed once to the local OS fallback instead of dropped.
func (e *Engine) notifyHuman(sessionID, body string, urgent bool) {
	const title = "Woof needs attention"
	e.background(func() {
		ctx, cancel := context.WithTimeout(e.ctx, 5*time.Second)
		defer cancel()
		reason := ""
		c, err := e.sessionClient(sessionID)
		if err == nil {
			var shown herdr.NotifyResult
			if shown, err = c.Notify(ctx, title, body, urgent); err == nil && shown.Shown {
				return
			}
			reason = shown.Reason
		}
		if err != nil {
			reason = err.Error()
		}
		log.Printf("human notification not shown by Herdr (%s): %s", reason, body)
		if e.opts.OSNotify == nil {
			return
		}
		if err = e.opts.OSNotify(e.ctx, title, body); err != nil {
			log.Printf("OS notification fallback: %v", err)
		}
	})
}

// blockedRule best-effort reads the id of the Herdr detection rule behind a
// block. It is quoted verbatim in the alert and never interpreted.
func (e *Engine) blockedRule(ctx context.Context, w model.Worker) string {
	c, err := e.sessionClient(w.SessionID)
	if err != nil || w.PaneID == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	id, state, err := c.AgentExplainRule(ctx, w.PaneID)
	if err != nil || state != "blocked" || !ruleID.MatchString(id) {
		return ""
	}
	return id
}

var ruleID = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)

// escalationTx persists one daemon escalation, addressed to the candidate worker
// when it is available and to the human otherwise; delivery.WorkerID tells which.
func (e *Engine) escalationTx(tx *store.Tx, m model.Message, candidate string) (model.Message, model.Delivery, error) {
	m.ID, m.FromKind, m.Kind, m.Status, m.ToKind, m.ToID, m.CreatedAt = newID("msg"), "daemon", "escalation", "persisted", "human", "human", e.now()
	delivery := model.Delivery{ID: newID("delivery"), MessageID: m.ID, SessionID: m.SessionID, WorkspaceID: m.WorkspaceID, RunID: m.RunID, Human: true, Status: "delivered", WakeStatus: "human", CreatedAt: e.now(), UpdatedAt: e.now()}
	if candidate != "" {
		w, x := txGet[model.Worker](tx, "workers", candidate)
		if x == nil && w.State != "released" && w.State != "lost" && w.State != "offline" && w.State != "stopped" && w.State != "failed" {
			m.ToKind = "worker"
			m.ToID = w.ID
			delivery.Human = false
			delivery.WorkerID = w.ID
			delivery.SessionID = w.SessionID
			delivery.WorkspaceID = w.WorkspaceID
			delivery.Status = "pending"
			delivery.WakeStatus = "queued"
		}
	}
	if err := tx.Put("messages", m.ID, m); err != nil {
		return m, delivery, err
	}
	return m, delivery, tx.Put("deliveries", delivery.ID, delivery)
}

// blockedDue reports what the worker's current block episode still owes: the
// first alert once the block outlasts BlockedTimeout, or the single human
// escalation once a block reported to a worker outlasts BlockedEscalationTimeout.
func (e *Engine) blockedDue(w model.Worker) (first, human bool) {
	if w.State != "blocked" || w.BlockedAt == 0 || e.now()-w.BlockedAt < e.opts.BlockedTimeout.Milliseconds() {
		return false, false
	}
	first = w.BlockedAlertedAt == 0
	human = !first && w.BlockedEscalatedAt == 0 && e.now()-w.BlockedAlertedAt >= e.opts.BlockedEscalationTimeout.Milliseconds()
	return first, human
}

// escalateBlocked reports a block episode to the requesting worker when one is
// known and available, otherwise to the human. It only informs: the prompt is
// never answered and no dispatch is settled, failed, nudged or redispatched.
func (e *Engine) escalateBlocked(ctx context.Context, w model.Worker) error {
	var recipient, note string
	// Read outside the transaction; a stale or missing rule only omits a sentence.
	rule := e.blockedRule(ctx, w)
	err := e.write(ctx, func(tx *store.Tx) error {
		current, err := txGet[model.Worker](tx, "workers", w.ID)
		if err != nil {
			return err
		}
		first, human := e.blockedDue(current)
		if !first && !human {
			return nil
		}
		ds, err := txList[model.Dispatch](tx, "dispatches", model.Scope{WorkerID: current.ID})
		if err != nil {
			return err
		}
		var d *model.Dispatch
		for i := range ds {
			if activeDispatch(ds[i]) {
				d = &ds[i]
				break
			}
		}
		workspace := current.WorkspaceID
		if ws, x := txGet[model.Workspace](tx, "workspaces", current.WorkspaceID); x == nil && ws.Name != "" {
			workspace = ws.Name + " (" + ws.ID + ")"
		}
		m := model.Message{SessionID: current.SessionID, WorkspaceID: current.WorkspaceID, WorktreeID: current.WorktreeID, RunID: current.RunID}
		where, inspect := "workspace "+workspace, "woof worker read --id "+current.ID
		if d != nil {
			m.RunID, m.DispatchID = d.RunID, d.ID
			where += "; dispatch " + d.ID
			if d.Handoff != "" {
				where += "; handoff " + d.Handoff
			}
			inspect += "; woof dispatch show --id " + d.ID
		}
		// The requester is the invoker of the dispatch run, or of the run the
		// worker belongs to; a worker never receives its own block alert.
		candidate := ""
		if run, x := txGet[model.Run](tx, "runs", m.RunID); m.RunID != "" && x == nil && run.InvokerWorkerID != current.ID {
			candidate = run.InvokerWorkerID
		}
		who := fmt.Sprintf("Worker %s (%s)", current.Name, current.ID)
		blockedFor := (time.Duration(e.now()-current.BlockedAt) * time.Millisecond).Round(time.Second)
		m.Body = fmt.Sprintf("%s needs attention: Herdr has reported it blocked for %s, which usually means an approval or question UI is waiting for input; Woof cannot see which. Location: %s. Inspect: %s. Woof will not answer the prompt and will not settle, fail or redispatch anything.", who, blockedFor, where, inspect)
		if rule != "" && current.PaneID == w.PaneID {
			m.Body += " Herdr detection rule: " + rule + "."
		}
		reason, state := "continuously_blocked", "blocked"
		if human {
			reason, state, candidate = "blocked_unresolved", "still blocked", ""
			// One human escalation per episode: the unreachable-invoker fallback
			// may already have sent it, and must not send another after this one.
			if alert, x := txGet[model.Delivery](tx, "deliveries", current.BlockedAlertDeliveryID); x == nil {
				told := alert.Escalated
				alert.Escalated = true
				if err = tx.Put("deliveries", alert.ID, alert); err != nil {
					return err
				}
				if told {
					current.BlockedEscalatedAt = e.now()
					return tx.Put("workers", current.ID, current)
				}
				m.Body = fmt.Sprintf("Still blocked after worker %s was notified. ", alert.WorkerID) + m.Body
			}
		}
		m, delivery, err := e.escalationTx(tx, m, candidate)
		if err != nil {
			return err
		}
		if first {
			current.BlockedAlertedAt = e.now()
		}
		if delivery.Human {
			current.BlockedEscalatedAt = e.now()
		} else {
			current.BlockedAlertDeliveryID = delivery.ID
		}
		if err = tx.Put("workers", current.ID, current); err != nil {
			return err
		}
		recipient = delivery.WorkerID
		note = fmt.Sprintf("%s is %s; %s. %s", who, state, where, "woof worker read --id "+current.ID)
		payload := map[string]any{"reason": reason, "message": m}
		if d == nil {
			return tx.Event("worker.escalated", workerScope(current), "daemon", "", payload)
		}
		if d.Alerts == nil {
			d.Alerts = map[string]bool{}
		}
		d.Alerts[reason] = true
		if err = tx.Put("dispatches", d.ID, *d); err != nil {
			return err
		}
		return tx.Event("dispatch.escalated", dispatchScope(*d), "daemon", "", payload)
	})
	if err != nil || note == "" {
		return err
	}
	if recipient != "" {
		e.background(func() { e.processInbox(recipient) })
	}
	e.notifyHuman(w.SessionID, note, true)
	return nil
}
func (e *Engine) humanEscalationTx(tx *store.Tx, s model.Scope, body string) error {
	m := model.Message{ID: newID("msg"), SessionID: s.SessionID, WorkspaceID: s.WorkspaceID, RunID: s.RunID, FromKind: "daemon", ToKind: "human", ToID: "human", Kind: "escalation", Status: "persisted", Body: body, CreatedAt: e.now()}
	d := model.Delivery{ID: newID("delivery"), MessageID: m.ID, SessionID: s.SessionID, WorkspaceID: s.WorkspaceID, RunID: s.RunID, Human: true, Status: "delivered", WakeStatus: "human", CreatedAt: e.now(), UpdatedAt: e.now()}
	if err := tx.Put("messages", m.ID, m); err != nil {
		return err
	}
	if err := tx.Put("deliveries", d.ID, d); err != nil {
		return err
	}
	return tx.Event("delivery.escalated", s, "daemon", "", m)
}
