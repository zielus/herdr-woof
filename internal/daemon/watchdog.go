package daemon

import (
	"context"
	"fmt"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/store"
	"time"
)

// Adapted from Orch's durable dispatch escalation. Silence never causes failure
// or redispatch; deduplication is tied to the dispatch and reason, not inbox turns.
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
		if w.RawStatus == "blocked" && w.BlockedAt != 0 && e.now()-w.BlockedAt >= e.opts.BlockedTimeout.Milliseconds() {
			reasons = append(reasons, "continuously_blocked")
		}
		if !idle(w.RawStatus) && d.LastActivityAt != 0 && e.now()-d.LastActivityAt >= e.opts.QuietTimeout.Milliseconds() {
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
		recipient = run.InvokerWorkerID
		body := fmt.Sprintf("Dispatch %s for worker %s needs attention: %s. Run %s; attachment %s; report %s; turn ended=%t. Inspect: woof dispatch show --id %s; woof worker read --id %s. Then explicitly nudge --reason, fail --reason, or investigate. Silence will not fail or redispatch work.", current.ID, current.WorkerID, reason, current.RunID, current.AttachmentID, current.DoneMessageID, current.TurnEnded, current.ID, current.WorkerID)
		if current.Handoff != "" {
			body += " Handoff: " + current.Handoff
		}
		m := model.Message{ID: newID("msg"), SessionID: current.SessionID, WorkspaceID: current.WorkspaceID, WorktreeID: current.WorktreeID, RunID: current.RunID, FromKind: "daemon", Kind: "escalation", Status: "persisted", Body: body, ToKind: "human", ToID: "human", DispatchID: current.ID, CreatedAt: e.now()}
		delivery := model.Delivery{ID: newID("delivery"), MessageID: m.ID, SessionID: m.SessionID, WorkspaceID: m.WorkspaceID, RunID: m.RunID, Human: true, Status: "delivered", WakeStatus: "human", CreatedAt: e.now(), UpdatedAt: e.now()}
		if recipient != "" {
			w, x := txGet[model.Worker](tx, "workers", recipient)
			if x == nil && w.State != "released" && w.State != "lost" && w.State != "offline" && w.State != "stopped" && w.State != "failed" {
				m.ToKind = "worker"
				m.ToID = w.ID
				delivery.Human = false
				delivery.WorkerID = w.ID
				delivery.SessionID = w.SessionID
				delivery.WorkspaceID = w.WorkspaceID
				delivery.Status = "pending"
				delivery.WakeStatus = "queued"
			} else {
				recipient = ""
			}
		}
		if err = tx.Put("messages", m.ID, m); err != nil {
			return err
		}
		if err = tx.Put("deliveries", delivery.ID, delivery); err != nil {
			return err
		}
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
		c, x := e.sessionClient(d.SessionID)
		if x == nil {
			e.background(func() {
				ctx, cancel := context.WithTimeout(e.ctx, 5*time.Second)
				defer cancel()
				_ = c.Notify(ctx, "Woof needs attention", d.ID+": "+reason, reason != "idle_without_report")
			})
		}
	}
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
