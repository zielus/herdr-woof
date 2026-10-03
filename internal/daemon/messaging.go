package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/zielus/herdr-woof-v2/internal/artifacts"
	"github.com/zielus/herdr-woof-v2/internal/herdr"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/prompt"
	"github.com/zielus/herdr-woof-v2/internal/store"
)

func (e *Engine) send(ctx context.Context, r model.Request, a Args) (any, error) {
	kind := a.Kind
	if kind == "" {
		kind = "message"
	}
	if r.Op == "ask" {
		kind = "question"
	}
	var replyID string
	if r.Op == "reply" {
		q, err := get[model.Message](ctx, e.store, "messages", a.ID)
		if err != nil {
			return nil, err
		}
		if q.Kind != "question" {
			return nil, problem("invalid_args", "reply requires a question")
		}
		if q.Status == "replied" {
			return nil, problem("already_replied", "question already has a reply")
		}
		if !deliveryBelongs(r, q.ToID, q.ToKind == "human") {
			return nil, problem("wrong_recipient", "only the question recipient may reply")
		}
		replyID = q.ID
		kind = "reply"
		a.To = "human"
		if q.FromWorkerID != "" {
			a.To = q.FromWorkerID
		}
		r.Scope = model.Scope{SessionID: q.SessionID, WorkspaceID: q.WorkspaceID, WorktreeID: q.WorktreeID, RunID: q.RunID, WorkerID: r.Scope.WorkerID}
	}
	if strings.TrimSpace(a.Body) == "" {
		return nil, problem("invalid_args", "message text required")
	}
	refs, err := artifacts.Resolve(a.Artifacts, r.Caller.Cwd)
	if err != nil {
		return nil, err
	}
	toKind, toID := "worker", a.To
	var recipientID string
	if a.To == "human" {
		toKind = "human"
	} else if strings.HasPrefix(a.To, "run:") {
		if kind == "question" {
			return nil, problem("invalid_recipient", "questions require one worker or human")
		}
		toKind = "run"
		toID = strings.TrimPrefix(a.To, "run:")
	} else {
		w, err := e.resolveWorker(ctx, a.To, r.Scope)
		if err != nil {
			return nil, err
		}
		recipientID = w.ID
		toID = w.ID
	}
	m := model.Message{ID: newID("msg"), FromKind: "human", FromWorkerID: r.Caller.WorkerID, ToKind: toKind, ToID: toID, Subject: a.Subject, Body: a.Body, Kind: kind, Status: "persisted", Artifacts: refs, CreatedAt: e.now(), ReplyToMessageID: replyID}
	if r.Caller.WorkerID != "" {
		m.FromKind = "worker"
	}
	var recipients []model.Worker
	deliveries := []model.Delivery{}
	err = e.write(ctx, func(tx *store.Tx) error {
		if toKind == "run" {
			run, err := txGet[model.Run](tx, "runs", toID)
			if err != nil {
				return err
			}
			r.Scope = model.Scope{SessionID: run.SessionID, WorkspaceID: run.WorkspaceID, WorktreeID: run.WorktreeID, RunID: run.ID}
			// Membership and immutable delivery snapshot share the message transaction.
			members, err := txList[model.Worker](tx, "workers", model.Scope{RunID: run.ID})
			if err != nil {
				return err
			}
			for _, w := range members {
				if !terminalRecipient(w) {
					recipients = append(recipients, w)
				}
			}
		} else if toKind == "worker" {
			w, err := txGet[model.Worker](tx, "workers", recipientID)
			if err != nil {
				return err
			}
			if terminalRecipient(w) {
				return problem("released", "worker is terminal (%s)", w.State)
			}
			recipients = append(recipients, w)
			if r.Scope.SessionID == "" {
				r.Scope.SessionID = w.SessionID
			}
			if r.Scope.WorkspaceID == "" {
				r.Scope.WorkspaceID = w.WorkspaceID
			}
		}
		m.SessionID = r.Scope.SessionID
		m.WorkspaceID = r.Scope.WorkspaceID
		m.WorktreeID = r.Scope.WorktreeID
		m.RunID = r.Scope.RunID
		if replyID != "" {
			q, err := txGet[model.Message](tx, "messages", replyID)
			if err != nil {
				return err
			}
			if q.Status == "replied" {
				return problem("already_replied", "question already replied")
			}
			if !deliveryBelongs(r, q.ToID, q.ToKind == "human") {
				return problem("wrong_recipient", "question recipient changed")
			}
			q.Status = "replied"
			if err := tx.Put("messages", q.ID, q); err != nil {
				return err
			}
			original, err := txList[model.Delivery](tx, "deliveries", model.Scope{})
			if err != nil {
				return err
			}
			for _, d := range original {
				if d.MessageID == q.ID && deliveryBelongs(r, d.WorkerID, d.Human) {
					if _, err := e.ackDeliveryTx(tx, d, false); err != nil {
						return err
					}
				}
			}
		}
		if err := tx.Put("messages", m.ID, m); err != nil {
			return err
		}
		for _, w := range recipients {
			d := model.Delivery{ID: newID("delivery"), MessageID: m.ID, WorkerID: w.ID, SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, RunID: m.RunID, Status: "pending", WakeStatus: "queued", CreatedAt: e.now(), UpdatedAt: e.now()}
			deliveries = append(deliveries, d)
			if err := tx.Put("deliveries", d.ID, d); err != nil {
				return err
			}
			recipientScope := model.Scope{SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, WorktreeID: w.WorktreeID, RunID: m.RunID, WorkerID: w.ID}
			if err := tx.Event("message.available", recipientScope, m.FromKind, m.FromWorkerID, map[string]any{"message": m, "delivery": d}); err != nil {
				return err
			}
		}
		if toKind == "human" {
			d := model.Delivery{ID: newID("delivery"), MessageID: m.ID, SessionID: m.SessionID, WorkspaceID: m.WorkspaceID, RunID: m.RunID, Human: true, Status: "delivered", WakeStatus: "human", CreatedAt: e.now(), UpdatedAt: e.now(), DeliveredAt: e.now()}
			deliveries = append(deliveries, d)
			if err := tx.Put("deliveries", d.ID, d); err != nil {
				return err
			}
			if err := tx.Event("message.available", model.Scope{SessionID: m.SessionID, WorkspaceID: m.WorkspaceID, WorktreeID: m.WorktreeID, RunID: m.RunID}, m.FromKind, m.FromWorkerID, map[string]any{"message": m, "delivery": d}); err != nil {
				return err
			}
		}
		if err := tx.Event("message.persisted", r.Scope, m.FromKind, m.FromWorkerID, m); err != nil {
			return err
		}
		if replyID != "" {
			if err := tx.Event("question.replied", r.Scope, m.FromKind, m.FromWorkerID, map[string]any{"question_id": replyID, "reply": m}); err != nil {
				return err
			}
		}
		return e.finishTx(tx, r.ID, map[string]any{"message": m, "deliveries": deliveries}, nil, "completed")
	})
	if err != nil {
		return nil, err
	}
	for _, w := range recipients {
		e.background(func() { e.processInbox(w.ID) })
	}
	return map[string]any{"message": m, "deliveries": deliveries}, nil
}

func terminalRecipient(w model.Worker) bool {
	return w.State == "released" || w.State == "stopped" || w.State == "failed"
}
func deliveryBelongs(r model.Request, workerID string, human bool) bool {
	if human {
		return r.Caller.WorkerID == ""
	}
	if r.Caller.WorkerID != "" {
		return r.Caller.WorkerID == workerID
	}
	return r.Scope.WorkerID != "" && r.Scope.WorkerID == workerID
}

// Receipt progression is monotonic; acknowledging a consumed message never
// regresses consumption, and acknowledgment alone cannot end a live wake turn.
func (e *Engine) ackDeliveryTx(tx *store.Tx, d model.Delivery, consume bool) (model.Delivery, error) {
	if d.AcknowledgedAt == 0 {
		d.AcknowledgedAt = e.now()
	}
	if consume && d.ConsumedAt == 0 {
		d.ConsumedAt = e.now()
	}
	if d.ConsumedAt != 0 {
		d.Status = "consumed"
	} else {
		d.Status = "acknowledged"
	}
	switch d.WakeStatus {
	case "sending", "sent", "uncertain":
		d.WakeStatus = "acknowledged"
	case "queued":
		d.WakeStatus = "ended"
	}
	d.UpdatedAt = e.now()
	d.Error = ""
	if d.AttemptID != "" {
		op, err := txGet[model.Operation](tx, "operations", d.AttemptID)
		if err == nil && (op.State == "accepted" || op.State == "uncertain") {
			if err := e.finishTx(tx, op.ID, map[string]any{"acknowledged": true, "message_id": d.MessageID}, nil, "completed"); err != nil {
				return d, err
			}
		}
	}
	return d, tx.Put("deliveries", d.ID, d)
}

func (e *Engine) inbox(ctx context.Context, r model.Request, a Args) (any, error) {
	s := r.Scope
	id := a.ID
	if id == "" {
		id = r.Caller.WorkerID
	}
	human := id == "human" || (id == "" && s.WorkerID == "")
	if !human {
		w, err := e.resolveWorker(ctx, id, s)
		if err != nil {
			return nil, err
		}
		s = model.Scope{WorkerID: w.ID}
	}
	ds, err := list[model.Delivery](ctx, e.store, "deliveries", s)
	if err != nil {
		return nil, err
	}
	var entries []map[string]any
	for _, d := range ds {
		if human && !d.Human {
			continue
		}
		if !a.All && d.ConsumedAt != 0 {
			continue
		}
		m, err := get[model.Message](ctx, e.store, "messages", d.MessageID)
		if err != nil {
			return nil, err
		}
		entries = append(entries, map[string]any{"message": m, "delivery": d, "artifacts": artifacts.Status(m.Artifacts)})
	}
	if entries == nil {
		entries = []map[string]any{}
	}
	return entries, nil
}
func (e *Engine) ack(ctx context.Context, r model.Request, a Args) (any, error) {
	out := []model.Delivery{}
	err := e.write(ctx, func(tx *store.Tx) error {
		m, err := txGet[model.Message](tx, "messages", a.ID)
		if err != nil {
			return err
		}
		ds, err := txList[model.Delivery](tx, "deliveries", model.Scope{})
		if err != nil {
			return err
		}
		for _, d := range ds {
			if d.MessageID == m.ID && deliveryBelongs(r, d.WorkerID, d.Human) {
				updated, err := e.ackDeliveryTx(tx, d, r.Op == "consume")
				if err != nil {
					return err
				}
				out = append(out, updated)
			}
		}
		if len(out) == 0 {
			return problem("wrong_recipient", "no delivery belongs to caller; humans may explicitly select a worker")
		}
		if err := tx.Event("message."+r.Op, r.Scope, "worker", r.Caller.WorkerID, map[string]any{"message_id": m.ID, "deliveries": out}); err != nil {
			return err
		}
		return e.finishTx(tx, r.ID, out, nil, "completed")
	})
	return out, err
}

// processInbox is triggered by commits and lifecycle events. A per-worker lane
// covers readiness, durable intent, and prompt outcome; uncertain intents survive restart.
func (e *Engine) processInbox(workerID string, readinessRecovery ...bool) {
	lane := e.lane(workerID)
	lane.Lock()
	defer lane.Unlock()
	ctx, cancel := context.WithTimeout(e.ctx, 35*time.Second)
	defer cancel()
	w, err := get[model.Worker](ctx, e.store, "workers", workerID)
	if err != nil {
		return
	}
	if terminalRecipient(w) || w.State == "lost" || w.State == "offline" {
		e.holdQueuedDeliveries(ctx, w.ID, "held: worker "+w.State)
		return
	}
	if !e.subscriptionReady(w) {
		e.holdQueuedDeliveries(ctx, w.ID, "held: lifecycle subscription not ready")
		return
	}
	ds, err := list[model.Delivery](ctx, e.store, "deliveries", model.Scope{WorkerID: w.ID})
	if err != nil {
		return
	}
	recovery := len(readinessRecovery) == 1 && readinessRecovery[0]
	if recovery {
		eligible := false
		for _, d := range ds {
			eligible = eligible || inboxReadRecoverable(d)
		}
		if !eligible {
			return
		}
	}
	// One unresolved wake occupies the lane until its own turn is known ended.
	for _, d := range ds {
		if d.AttachmentID == w.AttachmentID && (d.WakeStatus == "sending" || d.WakeStatus == "uncertain" || d.WakeStatus == "sent" || d.WakeStatus == "acknowledged") {
			if d.WakeStatus == "sending" {
				if _, live := e.inFlight.Load(d.AttemptID); !live {
					e.markLostWake(ctx, d)
				}
			}
			e.holdQueuedDeliveries(ctx, w.ID, "held: prior wake "+d.ID+" needs matching turn end")
			return
		}
	}
	dispatches, _ := list[model.Dispatch](ctx, e.store, "dispatches", model.Scope{WorkerID: w.ID})
	for _, d := range dispatches {
		if activeDispatch(d) && !d.TurnEnded {
			e.holdQueuedDeliveries(ctx, w.ID, "held: active dispatch "+d.ID)
			return
		}
	}
	c, err := e.sessionClient(w.SessionID)
	if err != nil {
		e.holdQueuedDeliveries(ctx, w.ID, "held: session offline")
		return
	}
	p, err := c.AgentGet(ctx, w.PaneID)
	if err != nil {
		e.holdQueuedDeliveries(ctx, w.ID, inboxReadFailure+err.Error())
		return
	}
	verified, err := e.verifyAttachmentEvidence(ctx, w, p, c)
	if err != nil {
		e.holdQueuedDeliveries(ctx, w.ID, inboxReadFailure+err.Error())
		return
	}
	if !verified {
		e.holdQueuedDeliveries(ctx, w.ID, "held: live attachment unverified")
		return
	}
	if !idle(p.AgentStatus) || p.InteractiveReady == nil || !*p.InteractiveReady {
		e.holdQueuedDeliveries(ctx, w.ID, "held: agent busy or not interactive")
		return
	}
	screen, err := c.AgentRead(ctx, w.PaneID, "ansi", 100)
	if err != nil {
		e.holdQueuedDeliveries(ctx, w.ID, inboxReadFailure+err.Error())
		return
	}
	if !prompt.Safe(w.AgentKind, screen) {
		e.holdQueuedDeliveries(ctx, w.ID, "held: prompt draft or readiness unknown")
		return
	}
	var pending []model.Delivery
	var messages []model.Message
	for _, d := range ds {
		if recovery && !inboxReadRecoverable(d) {
			continue
		}
		if d.WakeStatus == "queued" && d.ConsumedAt == 0 && d.AcknowledgedAt == 0 {
			m, err := get[model.Message](ctx, e.store, "messages", d.MessageID)
			if err == nil {
				pending = append(pending, d)
				messages = append(messages, m)
			}
			if len(pending) == 1 {
				break
			}
		}
	}
	if len(pending) == 0 {
		return
	}
	attempt := newID("wake")
	// Cover the intent/transport gap as well as the external call itself, so
	// concurrent recovery cannot mistake this live write for a crashed attempt.
	e.inFlight.Store(attempt, true)
	defer e.inFlight.Delete(attempt)
	notice := prompt.Notice(messages, w)
	payload, _ := json.Marshal(struct{ WorkerID, Attachment, Text string }{w.ID, w.AttachmentID, notice})
	hash := sha256.Sum256(payload)
	err = e.write(ctx, func(tx *store.Tx) error {
		current, err := txGet[model.Worker](tx, "workers", w.ID)
		if err != nil {
			return err
		}
		if current.AttachmentID != w.AttachmentID || terminalRecipient(current) {
			return problem("stale_attachment", "worker changed before wake intent")
		}
		if err := tx.Put("operations", attempt, model.Operation{ID: attempt, Op: "inbox.prompt", Fingerprint: hex.EncodeToString(hash[:]), State: "accepted", ResourceKind: "deliveries", ResourceID: pending[0].ID, CreatedAt: e.now(), UpdatedAt: e.now()}); err != nil {
			return err
		}
		for i := range pending {
			d, err := txGet[model.Delivery](tx, "deliveries", pending[i].ID)
			if err != nil {
				return err
			}
			if recovery && !inboxReadRecoverable(d) {
				return problem("delivery_changed", "delivery no longer qualifies for unattempted read recovery")
			}
			if d.WakeStatus != "queued" || d.ConsumedAt != 0 || d.AcknowledgedAt != 0 {
				return problem("delivery_changed", "delivery already attempted")
			}
			d.WakeStatus = "sending"
			d.AttemptID = attempt
			d.AttachmentID = w.AttachmentID
			d.BaselineSeq = p.StateChangeSeq
			d.BaselineCompletionSeq = p.CompletionSeq
			d.WorkingSeq = 0
			d.Error = ""
			d.AttemptedAt = e.now()
			d.UpdatedAt = e.now()
			pending[i] = d
			if err = tx.Put("deliveries", d.ID, d); err != nil {
				return err
			}
		}
		return tx.Event("delivery.attempted", workerScope(w), "daemon", "", map[string]any{"attempt_id": attempt, "deliveries": pending})
	})
	if err != nil {
		return
	}
	err = c.AgentPrompt(ctx, w.PaneID, notice)
	state := "sent"
	if err != nil {
		state = "queued"
		if isUncertain(err) {
			state = "uncertain"
		}
	}
	_ = e.write(context.Background(), func(tx *store.Tx) error {
		observedState := state
		for _, old := range pending {
			d, x := txGet[model.Delivery](tx, "deliveries", old.ID)
			if x != nil {
				return x
			}
			if d.AttemptID != attempt {
				continue
			}
			if d.WakeStatus == "sending" {
				d.WakeStatus = state
			}
			observedState = d.WakeStatus
			d.UpdatedAt = e.now()
			if err != nil && d.WakeStatus != "ended" && d.WakeStatus != "acknowledged" && d.WakeStatus != "resolved" {
				d.Error = err.Error()
			} else if err == nil {
				if d.AcknowledgedAt == 0 {
					d.Status = "delivered"
				}
				d.DeliveredAt = e.now()
			}
			if x = tx.Put("deliveries", d.ID, d); x != nil {
				return x
			}
		}
		receiptState := "completed"
		if err != nil {
			receiptState = "failed"
			if isUncertain(err) {
				receiptState = "uncertain"
			}
		}
		if x := e.finishTx(tx, attempt, map[string]any{"delivery_id": pending[0].ID, "wake_status": observedState}, err, receiptState); x != nil {
			return x
		}
		return tx.Event("delivery."+observedState, workerScope(w), "daemon", "", map[string]any{"attempt_id": attempt, "error": errText(err)})
	})
}

func (e *Engine) holdQueuedDeliveries(ctx context.Context, workerID, reason string) {
	_ = e.write(ctx, func(tx *store.Tx) error {
		ds, err := txList[model.Delivery](tx, "deliveries", model.Scope{WorkerID: workerID})
		if err != nil {
			return err
		}
		for _, d := range ds {
			if d.WakeStatus == "queued" && d.ConsumedAt == 0 && d.AcknowledgedAt == 0 && d.Error != reason {
				d.Error = reason
				d.UpdatedAt = e.now()
				if err := tx.Put("deliveries", d.ID, d); err != nil {
					return err
				}
				w, err := txGet[model.Worker](tx, "workers", workerID)
				if err != nil {
					return err
				}
				if err := tx.Event("delivery.held", workerScope(w), "daemon", "", d); err != nil {
					return err
				}
			}
		}
		return nil
	})
}
func (e *Engine) markLostWake(ctx context.Context, old model.Delivery) {
	_ = e.write(ctx, func(tx *store.Tx) error {
		d, err := txGet[model.Delivery](tx, "deliveries", old.ID)
		if err != nil {
			return err
		}
		if d.WakeStatus != "sending" || d.AttemptID != old.AttemptID {
			return nil
		}
		if _, live := e.inFlight.Load(d.AttemptID); live {
			return nil
		}
		d.WakeStatus = "uncertain"
		d.Error = "wake intent has no live transport attempt; inspect operation and worker before explicit resolution"
		d.UpdatedAt = e.now()
		if err := tx.Put("deliveries", d.ID, d); err != nil {
			return err
		}
		op, err := txGet[model.Operation](tx, "operations", d.AttemptID)
		if err == nil && op.State == "accepted" {
			if err := e.finishTx(tx, op.ID, nil, problem("uncertain", "%s", d.Error), "uncertain"); err != nil {
				return err
			}
		}
		w, err := txGet[model.Worker](tx, "workers", d.WorkerID)
		if err != nil {
			return err
		}
		return tx.Event("delivery.uncertain", workerScope(w), "daemon", "", d)
	})
}
func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// Positive evidence can arrive before the prompt RPC result. Both the delivery
// and operation receipt retain that evidence; later transport results cannot erase it.
func (e *Engine) observeDeliveriesTx(tx *store.Tx, current model.Worker, p herdr.Pane) error {
	ds, err := txList[model.Delivery](tx, "deliveries", model.Scope{WorkerID: current.ID})
	if err != nil {
		return err
	}
	for _, d := range ds {
		if d.AttachmentID != current.AttachmentID || p.StateChangeSeq < d.BaselineSeq {
			continue
		}
		active := d.WakeStatus == "sending" || d.WakeStatus == "sent" || d.WakeStatus == "uncertain" || d.WakeStatus == "acknowledged"
		if !active {
			continue
		}
		if p.StateChangeSeq > d.BaselineSeq && (p.AgentStatus == "working" || p.AgentStatus == "blocked") && p.StateChangeSeq > d.WorkingSeq {
			d.WorkingSeq = p.StateChangeSeq
			d.UpdatedAt = e.now()
			if err := tx.Put("deliveries", d.ID, d); err != nil {
				return err
			}
		}
		byObservedTurn := d.WorkingSeq > d.BaselineSeq && p.StateChangeSeq > d.WorkingSeq
		byCompletion := d.BaselineCompletionSeq != nil && p.CompletionSeq != nil && *p.CompletionSeq > *d.BaselineCompletionSeq && *p.CompletionSeq == p.StateChangeSeq && p.StateChangeSeq > d.BaselineSeq
		if !idle(p.AgentStatus) || (!byObservedTurn && !byCompletion) {
			continue
		}
		d.WakeStatus = "ended"
		d.UpdatedAt = e.now()
		d.Error = ""
		if d.Status == "pending" {
			d.Status = "delivered"
			d.DeliveredAt = e.now()
		}
		if err := tx.Put("deliveries", d.ID, d); err != nil {
			return err
		}
		if d.AttemptID != "" {
			op, err := txGet[model.Operation](tx, "operations", d.AttemptID)
			if err == nil && (op.State == "accepted" || op.State == "uncertain") {
				if err := e.finishTx(tx, op.ID, map[string]any{"delivery_id": d.ID, "turn_ended": true}, nil, "completed"); err != nil {
					return err
				}
			}
		}
		if err := tx.Event("delivery.turn_ended", workerScope(current), "daemon", "", d); err != nil {
			return err
		}
	}
	return nil
}
