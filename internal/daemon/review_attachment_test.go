package daemon

import (
	"context"
	"os"
	"testing"

	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/store"
)

func TestNativeConversationCannotOverrideRecordedProcessBirth(t *testing.T) {
	e, f, w := workerFixture(t, true)
	c, _ := e.sessionClient(w.SessionID)
	f.mu.Lock()
	p := f.pane
	f.mu.Unlock()
	old := *w.AgentProcess
	old.Birth = "different-process-birth"
	w.AgentProcess = &old
	verified, err := e.verifyAttachmentEvidence(context.Background(), w, p, c)
	if err != nil || verified {
		t.Fatalf("same conversation accepted a replaced process: verified=%t err=%v", verified, err)
	}
}

func TestReplacementProcessCannotSettleOriginalDispatch(t *testing.T) {
	e, f, w := fixture(t)
	d := mustDispatch(t, e, w)
	process, err := birthIdentity(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	process.Birth = "original-process-birth"
	w.AgentProcess = &process
	if err := e.write(context.Background(), func(tx *store.Tx) error { return tx.Put("workers", w.ID, w) }); err != nil {
		t.Fatal(err)
	}
	if _, err := call(t, e, "done", Args{Dispatch: d.ID, Attachment: w.AttachmentID}); err != nil {
		t.Fatal(err)
	}
	setObservation(t, e, f, w, "working", 3, w.CompletionSeq)
	completion := uint64(4)
	setObservation(t, e, f, w, "idle", 4, &completion)
	current, err := get[model.Dispatch](context.Background(), e.store, "dispatches", d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.Status == "settled" || current.TurnEnded || current.WorkingSeq != 0 {
		t.Fatalf("new process settled original turn in same conversation: %+v", current)
	}
	worker, err := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	if err != nil || worker.State != "lost" || worker.AttachmentID != w.AttachmentID {
		t.Fatalf("normal observation silently reattached replacement: %+v %v", worker, err)
	}
}

func TestNativeAttachmentVerifiesAliveBirthWithoutRequiringForeground(t *testing.T) {
	e, f, w := workerFixture(t, true)
	c, _ := e.sessionClient(w.SessionID)
	f.mu.Lock()
	p := f.pane
	setForegroundPID(f, os.Getpid())
	f.mu.Unlock()
	// Coding agents can launch tools into the foreground. Native identity plus
	// the recorded live process birth must still establish their attachment.
	verified, err := e.verifyAttachmentEvidence(context.Background(), w, p, c)
	if err != nil || !verified {
		t.Fatalf("tool foreground invalidated live native attachment: %t %v", verified, err)
	}
	w.NativeSession = nil
	p.AgentSession = nil
	verified, err = e.verifyAttachmentEvidence(context.Background(), w, p, c)
	if err != nil || verified {
		t.Fatalf("process-only attachment skipped foreground evidence: %t %v", verified, err)
	}
	f.mu.Lock()
	setForegroundPID(f, w.AgentProcess.PID)
	f.mu.Unlock()
	verified, err = e.verifyAttachmentEvidence(context.Background(), w, p, c)
	if err != nil || !verified {
		t.Fatalf("verified foreground birth rejected: %t %v", verified, err)
	}
}

func TestNativeAttachmentRejectsExitedRecordedProcess(t *testing.T) {
	e, f, w := workerFixture(t, true)
	c, _ := e.sessionClient(w.SessionID)
	f.mu.Lock()
	p := f.pane
	f.mu.Unlock()
	if err := f.process.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = f.process.Wait()
	verified, err := e.verifyAttachmentEvidence(context.Background(), w, p, c)
	if err != nil || verified {
		t.Fatalf("native conversation accepted dead process: %t %v", verified, err)
	}
}

func TestNativeProcessRecoveryRequiresNewGenerationAndCannotCompleteOldTurn(t *testing.T) {
	e, f, w := workerFixture(t, true)
	ctx := context.Background()
	actual := *w.AgentProcess
	stale := actual
	stale.Birth = "prior-process-birth"
	w.AgentProcess = &stale
	const dispatchID = "dispatch_old_process"
	if err := e.write(ctx, func(tx *store.Tx) error {
		if err := tx.Put("runs", "run_old_process", model.Run{ID: "run_old_process", SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, Status: "active"}); err != nil {
			return err
		}
		if err := tx.Put("workers", w.ID, w); err != nil {
			return err
		}
		return tx.Put("dispatches", dispatchID, model.Dispatch{ID: dispatchID, RunID: "run_old_process", WorkerID: w.ID, SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, AttachmentID: w.AttachmentID, Status: "active", BaselineSeq: 2, WorkingSeq: 3})
	}); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	p := f.pane
	p.StateChangeSeq = 4
	completion := uint64(4)
	p.CompletionSeq = &completion
	f.mu.Unlock()
	if err := e.observeWorker(ctx, w, p, true); err != nil {
		t.Fatal(err)
	}
	current, err := get[model.Worker](ctx, e.store, "workers", w.ID)
	if err != nil || current.ID != w.ID || current.AttachmentID == w.AttachmentID || current.Generation != w.Generation+1 || current.AgentProcess == nil || current.AgentProcess.Birth != actual.Birth {
		t.Fatalf("native recovery did not recapture a new incarnation: %+v %v", current, err)
	}
	dispatch, err := get[model.Dispatch](ctx, e.store, "dispatches", dispatchID)
	if err != nil || dispatch.TurnEnded || dispatch.Status == "settled" || dispatch.AttachmentID != w.AttachmentID {
		t.Fatalf("recovery carried original turn evidence forward: %+v %v", dispatch, err)
	}
	_, err = workerCall(t, e, "done", model.Scope{Global: true}, Args{Dispatch: dispatchID, Attachment: w.AttachmentID})
	workerCode(t, err, "stale_attachment")
}
