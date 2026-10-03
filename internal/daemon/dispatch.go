package daemon

import (
	"context"
	"strings"

	"github.com/zielus/herdr-woof-v2/internal/artifacts"
	"github.com/zielus/herdr-woof-v2/internal/herdr"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/prompt"
	"github.com/zielus/herdr-woof-v2/internal/store"
)

func idle(status string) bool { return status == "idle" || status == "done" }
func (e *Engine) dispatch(ctx context.Context, r model.Request, a Args) (any, error) {
	target := a.ID
	if target == "" {
		target = a.To
	}
	w, err := e.resolveWorker(ctx, target, r.Scope)
	if err != nil {
		return nil, err
	}
	lane := e.lane(w.ID)
	lane.Lock()
	defer lane.Unlock()
	w, err = get[model.Worker](ctx, e.store, "workers", w.ID)
	if err != nil {
		return nil, err
	}
	if !sessionActive(w) || w.State == "offline" {
		return nil, problem("worker_not_live", "worker is %s; inspect and reconcile its attachment", w.State)
	}
	if strings.TrimSpace(a.Spec) == "" {
		a.Spec = a.Body
	}
	if strings.TrimSpace(a.Spec) == "" && a.Handoff != "" {
		a.Spec = "Read the handoff file and carry out its request."
	}
	if strings.TrimSpace(a.Spec) == "" {
		return nil, problem("invalid_args", "dispatch spec required")
	}
	c, err := e.sessionClient(w.SessionID)
	if err != nil {
		return nil, err
	}
	if !e.subscriptionReady(w) {
		return nil, problem("subscription_not_ready", "lifecycle subscription must be confirmed before dispatch")
	}
	p, err := c.AgentGet(ctx, w.PaneID)
	if err != nil {
		return nil, problem("precondition_unavailable", "%v", err)
	}
	if !e.verifyAttachment(ctx, w, p, c) {
		return nil, problem("stale_attachment", "worker identity changed; inspect and re-adopt")
	}
	if !idle(p.AgentStatus) || p.InteractiveReady == nil || !*p.InteractiveReady {
		return nil, problem("worker_busy", "worker is not verified ready")
	}
	screen, err := c.AgentRead(ctx, w.PaneID, "ansi", 100)
	if err != nil {
		return nil, problem("precondition_unavailable", "%v", err)
	}
	if !prompt.Safe(w.AgentKind, screen) {
		return nil, problem("input_draft", "worker prompt is drafted or unknown")
	}
	ds, err := list[model.Delivery](ctx, e.store, "deliveries", model.Scope{WorkerID: w.ID})
	if err != nil {
		return nil, err
	}
	for _, d := range ds {
		if d.AttachmentID == w.AttachmentID && (d.WakeStatus == "sending" || d.WakeStatus == "uncertain" || d.WakeStatus == "sent" || d.WakeStatus == "acknowledged") {
			return nil, problem("wake_pending", "previous prompt has no verified turn-end evidence")
		}
	}
	handoff := ""
	if a.Handoff != "" {
		refs, err := artifacts.Resolve([]string{a.Handoff}, r.Caller.Cwd)
		if err != nil {
			return nil, err
		}
		handoff = refs[0].Path
	}
	d := model.Dispatch{ID: newID("dispatch"), SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, WorktreeID: w.WorktreeID, WorkerID: w.ID, AttachmentID: w.AttachmentID, Spec: a.Spec, Handoff: handoff, Status: "sending", Attempt: 1, BaselineSeq: p.StateChangeSeq, BaselineCompletionSeq: p.CompletionSeq, CreatedAt: e.now(), SentAt: e.now(), LastActivityAt: e.now(), Alerts: map[string]bool{}, OperationID: r.ID}
	runID := r.Scope.RunID
	if runID == "" {
		runID = w.RunID
	}
	var run model.Run
	if runID == "" {
		run = model.Run{ID: newID("run"), SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, WorktreeID: w.WorktreeID, InvokerWorkerID: r.Caller.WorkerID, InvokerPaneRef: r.Caller.PaneID, Kind: "adhoc", Title: a.Spec, Status: "active", Implicit: true, CreatedAt: e.now(), UpdatedAt: e.now()}
		d.RunID = run.ID
	} else {
		v, err := get[model.Run](ctx, e.store, "runs", runID)
		if err != nil {
			return nil, err
		}
		if v.SessionID != w.SessionID || (v.WorkspaceID != "" && v.WorkspaceID != w.WorkspaceID) {
			return nil, problem("invalid_scope", "run and worker must share session/workspace")
		}
		d.RunID = runID
	}
	err = e.write(ctx, func(tx *store.Tx) error {
		current, err := txGet[model.Worker](tx, "workers", w.ID)
		if err != nil {
			return err
		}
		if !sameSessionBinding(w, current) || !sessionActive(current) || current.State == "offline" || current.StateSeq > p.StateChangeSeq {
			return problem("stale_attachment", "worker binding or lifecycle changed before dispatch intent; inspect current state")
		}
		active, err := txList[model.Dispatch](tx, "dispatches", model.Scope{WorkerID: w.ID})
		if err != nil {
			return err
		}
		for _, x := range active {
			if activeDispatch(x) {
				return problem("dispatch_active", "one active dispatch per worker")
			}
		}
		if run.ID != "" {
			if err = tx.Put("runs", run.ID, run); err != nil {
				return err
			}
			if err = tx.Event("run.created", dispatchScope(d), "worker", r.Caller.WorkerID, run); err != nil {
				return err
			}
		}
		if err = tx.Put("dispatches", d.ID, d); err != nil {
			return err
		}
		op, err := txGet[model.Operation](tx, "operations", r.ID)
		if err != nil {
			return err
		}
		op.ResourceKind = "dispatches"
		op.ResourceID = d.ID
		if err = tx.Put("operations", op.ID, op); err != nil {
			return err
		}
		return tx.Event("dispatch.created", dispatchScope(d), "worker", r.Caller.WorkerID, d)
	})
	if err != nil {
		return nil, err
	}
	err = c.AgentPrompt(ctx, w.PaneID, prompt.Dispatch(d, w))
	if err != nil {
		if isUncertain(err) {
			d.Status = "uncertain"
		} else {
			d.Status = "failed"
			d.Outcome = "prompt_refused"
			d.SettledAt = e.now()
		}
	} else {
		d.Status = "active"
	}
	commitErr := e.write(context.Background(), func(tx *store.Tx) error {
		current, x := txGet[model.Dispatch](tx, "dispatches", d.ID)
		if x != nil {
			return x
		}
		// A delayed transport result cannot reopen a dispatch already reported,
		// settled, canceled or explicitly failed by another transaction.
		if current.Status == "sending" {
			current.Status = d.Status
			if d.Outcome != "" {
				current.Outcome = d.Outcome
			}
			if d.SettledAt != 0 {
				current.SettledAt = d.SettledAt
			}
			if x = tx.Put("dispatches", current.ID, current); x != nil {
				return x
			}
			if x = tx.Event("dispatch."+current.Status, dispatchScope(current), "daemon", "", current); x != nil {
				return x
			}
		}
		d = current
		state := "completed"
		if err != nil {
			state = "failed"
			if isUncertain(err) {
				state = "uncertain"
			}
		}
		return e.finishTx(tx, r.ID, d, err, state)
	})
	if commitErr != nil {
		return d, &model.Error{Code: "uncertain", Message: commitErr.Error(), OperationID: r.ID}
	}
	if err != nil && isUncertain(err) {
		return d, &model.Error{Code: "uncertain", Message: err.Error(), OperationID: r.ID}
	}
	return d, err
}
func (e *Engine) done(ctx context.Context, r model.Request, a Args) (any, error) {
	id := a.Dispatch
	if id == "" {
		id = a.ID
	}
	if id == "" || a.Attachment == "" {
		return nil, problem("invalid_args", "done requires dispatch and attachment IDs")
	}
	refs, err := artifacts.Resolve(a.Artifacts, r.Caller.Cwd)
	if err != nil {
		return nil, err
	}
	outcome := a.Outcome
	if outcome == "" {
		outcome = "done"
	}
	if outcome != "done" && outcome != "failed" {
		return nil, problem("invalid_args", "outcome must be done or failed")
	}
	var d model.Dispatch
	err = e.write(ctx, func(tx *store.Tx) error {
		var err error
		d, err = txGet[model.Dispatch](tx, "dispatches", id)
		if err != nil {
			return err
		}
		w, err := txGet[model.Worker](tx, "workers", d.WorkerID)
		if err != nil {
			return err
		}
		if d.AttachmentID != a.Attachment || w.AttachmentID != a.Attachment {
			return problem("stale_attachment", "report does not match current dispatch attachment")
		}
		if r.Caller.WorkerID != "" && r.Caller.WorkerID != d.WorkerID {
			return problem("wrong_worker", "report belongs to another worker")
		}
		if d.DoneMessageID != "" {
			if d.ReportOutcome != outcome {
				return problem("report_conflict", "completion outcome already recorded")
			}
			return e.finishTx(tx, r.ID, d, nil, "completed")
		}
		if !activeDispatch(d) {
			return problem("dispatch_finished", "dispatch no longer active")
		}
		m := model.Message{ID: newID("msg"), SessionID: d.SessionID, WorkspaceID: d.WorkspaceID, WorktreeID: d.WorktreeID, RunID: d.RunID, FromKind: "worker", FromWorkerID: d.WorkerID, ToKind: "human", ToID: "human", Kind: "report", Status: "persisted", Body: a.Body, Artifacts: refs, DispatchID: d.ID, CreatedAt: e.now()}
		d.DoneMessageID = m.ID
		d.DoneAt = e.now()
		d.ReportOutcome = outcome
		if d.TurnEnded && idle(w.RawStatus) && w.StateSeq >= d.EndSeq && w.State != "offline" && w.State != "lost" {
			d.Status = "settled"
			d.SettledAt = e.now()
			d.Outcome = outcome
		}
		if err = tx.Put("messages", m.ID, m); err != nil {
			return err
		}
		if err = tx.Put("dispatches", d.ID, d); err != nil {
			return err
		}
		if err = tx.Event("dispatch.reported", dispatchScope(d), "worker", d.WorkerID, map[string]any{"dispatch": d, "report": m}); err != nil {
			return err
		}
		if d.Status == "settled" {
			if err = e.settleRunTx(tx, d); err != nil {
				return err
			}
			if err = e.dispatchEventTx(tx, "dispatch.settled", d); err != nil {
				return err
			}
		}
		return e.finishTx(tx, r.ID, d, nil, "completed")
	})
	if err == nil {
		e.background(func() { e.processInbox(d.WorkerID) })
	}
	return d, err
}
func (e *Engine) settleRunTx(tx *store.Tx, d model.Dispatch) error {
	run, err := txGet[model.Run](tx, "runs", d.RunID)
	if err != nil {
		return err
	}
	if !run.Implicit {
		return nil
	}
	run.Status = "completed"
	run.CompletedAt = e.now()
	run.UpdatedAt = e.now()
	return tx.Put("runs", run.ID, run)
}

// observeWorker accepts fresh agent.get evidence only. Stale idle and unknown,
// disconnected or reset counters can never establish completion.
func (e *Engine) observeWorker(ctx context.Context, w model.Worker, p herdr.Pane, recovery bool, readOnly ...bool) error {
	// Callback snapshots can predate a durable hold without changing binding.
	// Read the current eligibility before deciding that native continuity is lost.
	latest, err := get[model.Worker](ctx, e.store, "workers", w.ID)
	if err != nil {
		return err
	}
	if !sameSessionBinding(w, latest) || !sessionActive(latest) {
		return nil
	}
	w = latest
	quiet := len(readOnly) == 1 && readOnly[0]
	if p.PaneID == "" {
		return e.write(ctx, func(tx *store.Tx) error {
			current, err := txGet[model.Worker](tx, "workers", w.ID)
			if err != nil {
				return err
			}
			if !sameSessionBinding(w, current) || !sessionActive(current) || (current.State == "starting" && current.NativeSession == nil && current.AgentProcess == nil) {
				return nil
			}
			if current.RecoveryHeld {
				return nil
			}
			current.State = "lost"
			current.Ready = false
			current.Error = "pane or agent missing; explicit re-adoption required"
			current.UpdatedAt = e.now()
			if err = tx.Put("workers", w.ID, current); err != nil {
				return err
			}
			return tx.Event("worker.lost", workerScope(current), "daemon", "", current)
		})
	}
	c, err := e.sessionClient(w.SessionID)
	if err != nil {
		return err
	}
	continuous, verificationErr := e.verifyAttachmentEvidence(ctx, w, p, c)
	if verificationErr != nil {
		if matchingNative(w, p) {
			return e.holdNativeRecovery(ctx, w, "native attachment verification failed: "+verificationErr.Error(), p)
		}
		return verificationErr
	}
	nativeContinuity := (recovery || w.RecoveryHeld) && matchingNative(w, p)
	if w.RecoveryHeld && nativeContinuity {
		continuous = false
	}
	if !continuous && !nativeContinuity {
		return e.write(ctx, func(tx *store.Tx) error {
			current, err := txGet[model.Worker](tx, "workers", w.ID)
			if err != nil {
				return err
			}
			if !sameSessionBinding(w, current) || !sessionActive(current) || (current.State == "starting" && current.NativeSession == nil && current.AgentProcess == nil) {
				return nil
			}
			// A concurrent reconciliation may have held this exact native
			// conversation after our eligibility read. Leave it for a fresh retry.
			if current.RecoveryHeld && matchingNative(current, p) {
				return nil
			}
			current.State = "lost"
			clearNativeRecovery(&current)
			current.Ready = false
			current.Error = "agent incarnation changed; explicit re-adoption required"
			if err = tx.Put("workers", w.ID, current); err != nil {
				return err
			}
			return tx.Event("worker.identity_lost", workerScope(current), "daemon", "", current)
		})
	}
	var recoveredProcess *model.ProcessIdentity
	if !continuous && nativeContinuity {
		if p.TerminalID == "" {
			return e.holdNativeRecovery(ctx, w, "native recovery terminal identity is unverified", p)
		}
		info, x := c.ProcessInfo(ctx, p.PaneID)
		if x == nil {
			_, recoveredProcess, x = processEvidence(info, w.AgentKind)
		}
		if x != nil {
			return e.holdNativeRecovery(ctx, w, "native session found but agent process birth cannot be verified: "+x.Error(), p)
		}
		if recoveredProcess == nil {
			return e.holdNativeRecovery(ctx, w, "native session found but agent process birth is unverified; waiting for fresh agent evidence or explicit re-adoption", p)
		}
	}
	err = e.write(ctx, func(tx *store.Tx) error {
		current, err := txGet[model.Worker](tx, "workers", w.ID)
		if err != nil {
			return err
		}
		if !sameSessionBinding(w, current) || !sessionActive(current) || (current.State == "starting" && current.NativeSession == nil && current.AgentProcess == nil) {
			return nil
		}
		if !continuous && nativeContinuity {
			current.AttachmentID = newID("attachment")
			current.Generation++
			current.PaneAliases = nil
			current.AgentProcess = recoveredProcess
			current.TerminalID = p.TerminalID
			current.StateSeq = p.StateChangeSeq
			current.CompletionSeq = p.CompletionSeq
			current.Error = "recovered native session; active dispatch requires explicit reconciliation"
		}
		clearNativeRecovery(&current)
		changed := current.StateSeq != p.StateChangeSeq || current.RawStatus != p.AgentStatus || current.PaneID != p.PaneID
		if p.Revision < current.Revision && !recovery && !w.RecoveryHeld {
			return nil
		}
		reset := p.StateChangeSeq < current.StateSeq
		if reset {
			current.AttachmentID = newID("attachment")
			current.Generation++
			current.Error = "sequence reset invalidated turn baselines"
		}
		if current.PaneID != p.PaneID && continuous {
			current.PaneAliases = append(current.PaneAliases, current.PaneID)
		}
		current.PaneID = p.PaneID
		current.RawStatus = p.AgentStatus
		current.State = p.AgentStatus
		current.Ready = !reset && p.InteractiveReady != nil && *p.InteractiveReady
		current.UpdatedAt = e.now()
		current.LastSeenAt = e.now()
		if p.AgentStatus == "blocked" {
			if current.BlockedAt == 0 {
				current.BlockedAt = e.now()
			}
		} else {
			current.BlockedAt = 0
		}
		ds, err := txList[model.Dispatch](tx, "dispatches", model.Scope{WorkerID: w.ID})
		if err != nil {
			return err
		}
		for _, d := range ds {
			if !activeDispatch(d) || d.AttachmentID != current.AttachmentID || reset {
				continue
			}
			if !d.TurnEnded && p.StateChangeSeq > d.BaselineSeq && (p.AgentStatus == "working" || p.AgentStatus == "blocked") {
				if d.ObservedWorkingAt == 0 {
					d.ObservedWorkingAt = e.now()
				}
				d.WorkingSeq = p.StateChangeSeq
				if changed {
					d.LastActivityAt = e.now()
				}
			}
			ended := idle(p.AgentStatus) && p.StateChangeSeq > d.BaselineSeq && ((d.WorkingSeq > d.BaselineSeq && p.StateChangeSeq > d.WorkingSeq) || (d.BaselineCompletionSeq != nil && p.CompletionSeq != nil && *p.CompletionSeq > *d.BaselineCompletionSeq && *p.CompletionSeq == p.StateChangeSeq))
			if ended && !d.TurnEnded {
				d.TurnEnded = true
				d.EndSeq = p.StateChangeSeq
				if d.IdleAt == 0 {
					d.IdleAt = e.now()
				}
			}
			if d.TurnEnded && d.DoneAt != 0 && idle(p.AgentStatus) {
				d.Status = "settled"
				d.Outcome = d.ReportOutcome
				d.SettledAt = e.now()
				if err = e.settleRunTx(tx, d); err != nil {
					return err
				}
				if err = e.dispatchEventTx(tx, "dispatch.settled", d); err != nil {
					return err
				}
			}
			if err = tx.Put("dispatches", d.ID, d); err != nil {
				return err
			}
		}
		if err = e.observeDeliveriesTx(tx, current, p); err != nil {
			return err
		}
		current.Revision = p.Revision
		current.StateSeq = p.StateChangeSeq
		current.CompletionSeq = p.CompletionSeq
		if err = tx.Put("workers", current.ID, current); err != nil {
			return err
		}
		if changed || !continuous {
			return tx.Event("worker.observed", workerScope(current), "daemon", "", current)
		}
		return nil
	})
	if err == nil {
		current, _ := get[model.Worker](ctx, e.store, "workers", w.ID)
		if quiet {
			if current.AttachmentID != w.AttachmentID {
				e.background(func() { _ = e.refreshSession(e.ctx, current.SessionID, true) })
			}
			return nil
		}
		if current.AttachmentID != w.AttachmentID || current.State == "lost" {
			ds, _ := list[model.Dispatch](ctx, e.store, "dispatches", model.Scope{WorkerID: w.ID})
			for _, d := range ds {
				if activeDispatch(d) {
					_ = e.escalate(ctx, d, "attachment_changed")
				}
			}
			if current.AttachmentID != w.AttachmentID {
				e.background(func() { _ = e.refreshSession(e.ctx, current.SessionID) })
			}
		}
		e.background(func() { e.processInbox(w.ID) })
	}
	return err
}
func (e *Engine) dispatchControl(ctx context.Context, r model.Request, a Args) (any, error) {
	id := a.Dispatch
	if id == "" {
		id = a.ID
	}
	d, err := get[model.Dispatch](ctx, e.store, "dispatches", id)
	if err != nil {
		return nil, err
	}
	if !activeDispatch(d) {
		return nil, problem("dispatch_finished", "dispatch is no longer active")
	}
	if a.Reason == "" {
		return nil, problem("invalid_args", "reason required")
	}
	if r.Op == "fail" {
		err = e.write(ctx, func(tx *store.Tx) error {
			current, err := txGet[model.Dispatch](tx, "dispatches", id)
			if err != nil {
				return err
			}
			if !activeDispatch(current) {
				return problem("dispatch_finished", "dispatch finished")
			}
			current.Status = "failed"
			current.Outcome = a.Reason
			current.SettledAt = e.now()
			d = current
			if err = tx.Put("dispatches", id, d); err != nil {
				return err
			}
			if err = e.settleRunTx(tx, d); err != nil {
				return err
			}
			if err = tx.Event("dispatch.failed", dispatchScope(d), "worker", r.Caller.WorkerID, d); err != nil {
				return err
			}
			return e.finishTx(tx, r.ID, d, nil, "completed")
		})
		return d, err
	}
	// A nudge is durable mailbox traffic and uses the same safe prompt lane.
	sendReq := r
	sendReq.Op = "send"
	sendReq.Scope = dispatchScope(d)
	sendReq.Scope.WorkerID = ""
	a.To = d.WorkerID
	a.Kind = "nudge"
	a.Body = a.Reason
	out, err := e.send(ctx, sendReq, a)
	if err == nil {
		_ = e.write(ctx, func(tx *store.Tx) error {
			current, x := txGet[model.Dispatch](tx, "dispatches", id)
			if x != nil {
				return x
			}
			current.Nudges++
			return tx.Put("dispatches", id, current)
		})
	}
	return out, err
}

func (e *Engine) dispatchEventTx(tx *store.Tx, kind string, d model.Dispatch) error {
	if err := tx.Event(kind, dispatchScope(d), "daemon", "", d); err != nil {
		return err
	}
	run, err := txGet[model.Run](tx, "runs", d.RunID)
	if err != nil {
		return err
	}
	if run.InvokerWorkerID != "" && run.InvokerWorkerID != d.WorkerID {
		w, err := txGet[model.Worker](tx, "workers", run.InvokerWorkerID)
		if err != nil {
			return err
		}
		scope := workerScope(w)
		scope.RunID = d.RunID
		return tx.Event(kind, scope, "daemon", "", d)
	}
	return nil
}
