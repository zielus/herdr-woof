package daemon

import (
	"context"
	"errors"
	"os"
	"syscall"

	"github.com/zielus/herdr-woof-v2/internal/herdr"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/store"
)

func sameAttachment(w model.Worker, p herdr.Pane) bool {
	if w.TerminalID == "" || p.TerminalID != w.TerminalID || p.Agent == nil || *p.Agent != w.AgentKind {
		return false
	}
	if w.AgentName != "" && (p.Name == nil || *p.Name != w.AgentName) {
		return false
	}
	if w.NativeSession != nil {
		return p.AgentSession != nil && *p.AgentSession == *w.NativeSession
	}
	return w.AgentProcess != nil
}

// A native conversation identifies the conversation, not an OS incarnation.
// When process evidence was recorded, both must continue to match. Reconciliation
// may bind a resumed conversation to a new generation; normal observations cannot.
func (e *Engine) verifyAttachmentEvidence(ctx context.Context, w model.Worker, p herdr.Pane, c *herdr.Client) (bool, error) {
	if !sameAttachment(w, p) {
		return false, nil
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if w.AgentProcess == nil {
		return w.NativeSession != nil, nil
	}
	if w.AgentProcess.PID <= 0 || w.AgentProcess.Birth == "" {
		return false, nil
	}
	// Without native identity, foreground membership is also needed. With native
	// identity, child tools may own the foreground while the original agent lives.
	if w.NativeSession == nil {
		info, err := c.ProcessInfo(ctx, p.PaneID)
		if err != nil {
			return false, err
		}
		foreground := false
		for _, process := range info.ForegroundProcesses {
			if process.PID == w.AgentProcess.PID {
				foreground = true
				break
			}
		}
		if !foreground {
			return false, nil
		}
	}
	live, err := birthIdentity(w.AgentProcess.PID)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ESRCH) {
			return false, nil
		}
		// Inspection denial is not proof that the process died. Keep the outcome
		// unverifiable so recovery cannot silently replace a live incarnation.
		return false, err
	}
	return live.Birth == w.AgentProcess.Birth, nil
}
func (e *Engine) verifyAttachment(ctx context.Context, w model.Worker, p herdr.Pane, c *herdr.Client) bool {
	ok, err := e.verifyAttachmentEvidence(ctx, w, p, c)
	return err == nil && ok
}

// holdNativeRecovery keeps incomplete native continuity local to this worker.
// Conversation identity cannot erase a recorded process birth or authorize a
// new generation until fresh agent process evidence is available.
func (e *Engine) holdNativeRecovery(ctx context.Context, w model.Worker, reason string, panes ...herdr.Pane) error {
	return e.write(ctx, func(tx *store.Tx) error {
		current, err := txGet[model.Worker](tx, "workers", w.ID)
		if err != nil {
			return err
		}
		if !sameSessionBinding(w, current) || !sessionActive(current) {
			return nil
		}
		changed := !current.RecoveryHeld || current.State != "offline" || current.Ready || current.Error != reason
		if len(panes) == 1 && matchingNative(current, panes[0]) {
			current.RecoveryPaneID = panes[0].PaneID
		}
		current.RecoveryHeld = true
		current.RecoveryReadAt = e.now()
		current.State = "offline"
		current.Ready = false
		current.Error = reason
		current.UpdatedAt = e.now()
		if err = tx.Put("workers", current.ID, current); err != nil {
			return err
		}
		if changed {
			return tx.Event("worker.recovery_held", workerScope(current), "daemon", "", current)
		}
		return nil
	})
}

func matchingNative(w model.Worker, p herdr.Pane) bool {
	return w.NativeSession != nil && p.AgentSession != nil && *w.NativeSession == *p.AgentSession && p.Agent != nil && *p.Agent == w.AgentKind
}

func clearNativeRecovery(w *model.Worker) {
	w.RecoveryHeld = false
	w.RecoveryPaneID = ""
	w.RecoveryReadAt = 0
}
