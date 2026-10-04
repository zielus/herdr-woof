package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zielus/herdr-woof/internal/herdr"
	"github.com/zielus/herdr-woof/internal/model"
	"github.com/zielus/herdr-woof/internal/store"
)

func nativeRecoveryCase(t *testing.T) (*Engine, *lifecycleAgent, model.Worker, herdr.Pane, model.ProcessIdentity) {
	t.Helper()
	e, f, w := workerFixture(t, true)
	actual := *w.AgentProcess
	stale := actual
	stale.Birth = "old-incarnation"
	w.AgentProcess = &stale
	w.StateSeq = 3
	w.RawStatus = "working"
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		if err := tx.Put("runs", "recovery_run", model.Run{ID: "recovery_run", SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, Status: "active"}); err != nil {
			return err
		}
		if err := tx.Put("workers", w.ID, w); err != nil {
			return err
		}
		return tx.Put("dispatches", "recovery_dispatch", model.Dispatch{ID: "recovery_dispatch", RunID: "recovery_run", WorkerID: w.ID, SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, AttachmentID: w.AttachmentID, Status: "active", BaselineSeq: 2, WorkingSeq: 3})
	}); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	p := f.pane
	p.TerminalID = "resumed-terminal"
	p.StateChangeSeq = 4
	completion := uint64(4)
	p.CompletionSeq = &completion
	f.mu.Unlock()
	return e, f, w, p, actual
}

func assertRecoveryHeld(t *testing.T, e *Engine, original model.Worker) model.Worker {
	t.Helper()
	current, err := get[model.Worker](context.Background(), e.store, "workers", original.ID)
	if err != nil || current.State != "offline" || !current.RecoveryHeld || current.Ready || current.Error == "" || !sameSessionBinding(original, current) || current.Generation != original.Generation || current.StateSeq != original.StateSeq {
		t.Fatalf("incomplete recovery erased old evidence: %+v %v", current, err)
	}
	dispatch, err := get[model.Dispatch](context.Background(), e.store, "dispatches", "recovery_dispatch")
	if err != nil || dispatch.TurnEnded || dispatch.Status == "settled" || dispatch.AttachmentID != original.AttachmentID {
		t.Fatalf("unverified recovery completed old turn: %+v %v", dispatch, err)
	}
	return current
}

func finishNativeRecovery(t *testing.T, e *Engine, f *lifecycleAgent, held model.Worker, p herdr.Pane, actual model.ProcessIdentity) {
	t.Helper()
	f.mu.Lock()
	setForegroundPID(f, actual.PID)
	f.info.ForegroundProcesses[0].Name = "sleep"
	f.info.ForegroundProcesses[0].Argv0 = "sleep"
	f.mu.Unlock()
	if err := e.observeWorker(context.Background(), held, p, true); err != nil {
		t.Fatal(err)
	}
	current, err := get[model.Worker](context.Background(), e.store, "workers", held.ID)
	if err != nil || current.ID != held.ID || current.RecoveryHeld || current.AttachmentID == held.AttachmentID || current.Generation != held.Generation+1 || current.TerminalID != p.TerminalID || current.AgentProcess == nil || current.AgentProcess.Birth != actual.Birth || current.State == "offline" {
		t.Fatalf("verified process did not establish new incarnation: %+v %v", current, err)
	}
	dispatch, err := get[model.Dispatch](context.Background(), e.store, "dispatches", "recovery_dispatch")
	if err != nil || dispatch.TurnEnded || dispatch.Status == "settled" || dispatch.AttachmentID != held.AttachmentID {
		t.Fatalf("new generation settled original dispatch: %+v %v", dispatch, err)
	}
}

func TestNativeRecoveryToolForegroundHoldsOldBirthUntilVerifiedRecapture(t *testing.T) {
	e, f, w, p, actual := nativeRecoveryCase(t)
	f.mu.Lock()
	setForegroundPID(f, os.Getpid())
	f.info.ForegroundProcesses[0].Name = "git"
	f.info.ForegroundProcesses[0].Argv0 = "git"
	f.mu.Unlock()
	for i := 0; i < 2; i++ {
		if err := e.observeWorker(context.Background(), w, p, true); err != nil {
			t.Fatal("one unverified worker failed session reconciliation", err)
		}
		assertRecoveryHeld(t, e, w)
	}
	events, err := e.store.Events(context.Background(), 0, model.Scope{WorkerID: w.ID}, []string{"worker.recovery_held"}, 0)
	if err != nil || len(events) != 1 {
		t.Fatalf("held reason not durable/deduplicated: %+v %v", events, err)
	}
	held := assertRecoveryHeld(t, e, w)
	finishNativeRecovery(t, e, f, held, p, actual)
}

func TestNativeRecoveryReadFailureHoldsOldEvidenceAndCanRecoverLater(t *testing.T) {
	e, f, w, p, actual := nativeRecoveryCase(t)
	originalClient, _ := e.sessionClient(w.SessionID)
	dir, err := os.MkdirTemp("/tmp", "woof-native-read-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { checkCleanup(t, os.RemoveAll(dir)) })
	socket := filepath.Join(dir, "h.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { checkCleanup(t, ln.Close()) })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }() // The peer may already have disconnected; cleanup is best effort.
		if _, err := bufio.NewReader(conn).ReadBytes('\n'); err != nil {
			return // The client may disconnect during recovery.
		}
		// A disconnected client needs no retry of its fixture response.
		if err := json.NewEncoder(conn).Encode(map[string]any{"error": map[string]string{"code": "temporarily_unavailable", "message": "process inspection unavailable"}}); err != nil {
			return
		}
	}()
	e.runtimeMu.Lock()
	e.sessions[w.SessionID].client = herdr.New(socket)
	e.runtimeMu.Unlock()
	if err := e.observeWorker(context.Background(), w, p, true); err != nil {
		t.Fatal("read failure disconnected session instead of holding worker", err)
	}
	held := assertRecoveryHeld(t, e, w)
	e.runtimeMu.Lock()
	e.sessions[w.SessionID].client = originalClient
	e.runtimeMu.Unlock()
	finishNativeRecovery(t, e, f, held, p, actual)
}

func TestNativeRecoveryHoldCannotOverwriteFreshReAdoption(t *testing.T) {
	e, _, w, _, _ := nativeRecoveryCase(t)
	fresh := w
	fresh.AttachmentID = "fresh-adoption"
	fresh.Generation++
	fresh.Error = "fresh binding"
	if err := e.write(context.Background(), func(tx *store.Tx) error { return tx.Put("workers", fresh.ID, fresh) }); err != nil {
		t.Fatal(err)
	}
	if err := e.holdNativeRecovery(context.Background(), w, "obsolete recovery"); err != nil {
		t.Fatal(err)
	}
	current, err := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	if err != nil || current.AttachmentID != fresh.AttachmentID || current.State != fresh.State || current.Error != fresh.Error {
		t.Fatalf("old recovery overwrote new adoption: %+v %v", current, err)
	}
	events, err := e.store.Events(context.Background(), 0, model.Scope{WorkerID: w.ID}, []string{"worker.recovery_held"}, 0)
	if err != nil || len(events) != 0 {
		t.Fatalf("stale hold emitted an event: %+v %v", events, err)
	}
}

func nativeRecoverySession(t *testing.T) (*Engine, *sessionFixture, model.Worker, model.ProcessIdentity) {
	t.Helper()
	e, old, w, p, actual := nativeRecoveryCase(t)
	w.AgentKind = "codex"
	native := *w.NativeSession
	native.Agent = w.AgentKind
	w.NativeSession = &native
	p.Agent = &w.AgentKind
	p.AgentSession = &native
	f := newSessionFixture(t, "recovery")
	f.mu.Lock()
	f.pane = p
	old.mu.Lock()
	setForegroundPID(old, os.Getpid())
	old.info.ForegroundProcesses[0].Name = "git"
	old.info.ForegroundProcesses[0].Argv0 = "git"
	f.processInfo = old.info
	old.mu.Unlock()
	f.mu.Unlock()
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		if err := tx.Put("workers", w.ID, w); err != nil {
			return err
		}
		s, err := txGet[model.Session](tx, "sessions", w.SessionID)
		if err != nil {
			return err
		}
		s.SocketPath = f.socket
		s.Status = "online"
		return tx.Put("sessions", s.ID, s)
	}); err != nil {
		t.Fatal(err)
	}
	if err := e.refreshSession(context.Background(), w.SessionID); err != nil {
		t.Fatal(err)
	}
	assertRecoveryHeld(t, e, w)
	return e, f, w, actual
}

func verifiedRecoveryForeground(f *sessionFixture, actual model.ProcessIdentity) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.processInfo.ForegroundProcesses[0].PID = actual.PID
	f.processInfo.ForegroundProcesses[0].Name = *f.pane.Agent
	f.processInfo.ForegroundProcesses[0].Argv0 = *f.pane.Agent
}
func waitNativeRecapture(t *testing.T, e *Engine, w model.Worker) model.Worker {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		current, _ := get[model.Worker](context.Background(), e.store, "workers", w.ID)
		if current.AttachmentID != w.AttachmentID && current.State != "offline" && current.State != "lost" {
			return current
		}
		time.Sleep(time.Millisecond)
	}
	current, _ := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	t.Fatalf("held incarnation did not recapture: %+v", current)
	return current
}
func waitNativeRetry(t *testing.T, e *Engine, w model.Worker) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, running := e.inFlight.Load("native-read-recovery:" + w.ID); !running {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("native read recovery did not finish")
}
func countNativeReads(f *sessionFixture) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	count := 0
	for _, method := range f.methods {
		if method == "pane.process_info" {
			count++
		}
	}
	return count
}

func TestNativeRecoveryHeldWorkerRecapturesThroughSessionEvent(t *testing.T) {
	e, f, w, actual := nativeRecoverySession(t)
	verifiedRecoveryForeground(f, actual)
	f.event(t, "idle", 4)
	current := waitNativeRecapture(t, e, w)
	if current.RecoveryHeld || current.RecoveryPaneID != "" || current.RecoveryReadAt != 0 || current.AgentProcess == nil || current.AgentProcess.Birth != actual.Birth {
		t.Fatalf("live callback did not clear verified hold: %+v", current)
	}
	d, err := get[model.Dispatch](context.Background(), e.store, "dispatches", "recovery_dispatch")
	if err != nil || d.TurnEnded || d.Status == "settled" {
		t.Fatalf("live recapture settled old dispatch: %+v %v", d, err)
	}
}

func TestNativeRecoveryHeldOnlineWorkerRetriesReadsWithoutEvent(t *testing.T) {
	e, f, w, actual := nativeRecoverySession(t)
	now := inboxClock(e)
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		d, err := txGet[model.Dispatch](tx, "dispatches", "recovery_dispatch")
		if err != nil {
			return err
		}
		d.Status = "failed" // isolate recovery reads from existing alert delivery
		return tx.Put("dispatches", d.ID, d)
	}); err != nil {
		t.Fatal(err)
	}
	// A persisted message makes accidental watchdog-triggered wakeup observable.
	delivery := seedUnattemptedInbox(t, e, w)
	baseline := countNativeReads(f)
	for i := 0; i < 3; i++ {
		if err := e.watchdogOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	waitNativeRetry(t, e, w)
	if countNativeReads(f) != baseline {
		t.Fatalf("read retries were not throttled")
	}
	now.Add(1001)
	for i := 0; i < 3; i++ {
		if err := e.watchdogOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	waitNativeRetry(t, e, w)
	if got := countNativeReads(f); got != baseline+1 {
		t.Fatalf("online held worker read retries=%d want %d", got, baseline+1)
	}
	assertRecoveryHeld(t, e, w)
	events, err := e.store.Events(context.Background(), 0, model.Scope{WorkerID: w.ID}, []string{"worker.recovery_held"}, 0)
	if err != nil || len(events) != 1 {
		t.Fatalf("repeat holds not deduplicated: %+v %v", events, err)
	}
	verifiedRecoveryForeground(f, actual)
	now.Add(1001)
	if err := e.watchdogOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitNativeRetry(t, e, w)
	current := waitNativeRecapture(t, e, w)
	if current.RecoveryHeld {
		t.Fatalf("verified retry still held: %+v", current)
	}
	// Wait for the read-only subscription barrier, not long-lived stream tasks.
	deadline := time.Now().Add(2 * time.Second)
	for !e.subscriptionReady(current) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !e.subscriptionReady(current) {
		t.Fatal("verified retry did not restore subscription readiness")
	}
	now.Add(1001)
	if err := e.watchdogOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitNativeRetry(t, e, w)
	if got := countNativeReads(f); got != baseline+2 {
		t.Fatalf("healthy worker still polled: %d reads want %d", got, baseline+2)
	}
	d, err := get[model.Delivery](context.Background(), e.store, "deliveries", delivery.ID)
	if err != nil || d.AttemptID != "" || d.AttemptedAt != 0 || d.WakeStatus != "queued" {
		t.Fatalf("watchdog recovery attempted queued prompt: %+v %v", d, err)
	}
	f.mu.Lock()
	for _, method := range f.methods {
		if method == "agent.prompt" || method == "agent.start" || method == "pane.close" {
			t.Errorf("recovery replayed mutation %s", method)
		}
	}
	f.mu.Unlock()
	// A real subsequent lifecycle event resumes normal queued delivery progression.
	f.event(t, "idle", 5)
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		d, _ = get[model.Delivery](context.Background(), e.store, "deliveries", delivery.ID)
		if d.AttemptID != "" {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if d.AttemptID == "" {
		t.Fatalf("live event after recovery did not resume queued delivery: %+v", d)
	}
}

func TestNativeRecoveryOldCallbackSnapshotUsesCurrentHold(t *testing.T) {
	e, f, w, p, actual := nativeRecoveryCase(t)
	f.mu.Lock()
	setForegroundPID(f, os.Getpid())
	f.info.ForegroundProcesses[0].Name = "git"
	f.info.ForegroundProcesses[0].Argv0 = "git"
	f.mu.Unlock()
	if err := e.observeWorker(context.Background(), w, p, true); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	setForegroundPID(f, actual.PID)
	f.info.ForegroundProcesses[0].Name = "sleep"
	f.info.ForegroundProcesses[0].Argv0 = "sleep"
	f.mu.Unlock()
	// The callback captured w before the hold was committed. Its native evidence
	// still belongs to the durable held worker and may establish a new generation.
	if err := e.observeWorker(context.Background(), w, p, false); err != nil {
		t.Fatal(err)
	}
	current, err := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	if err != nil || current.State == "lost" || current.AttachmentID == w.AttachmentID || current.RecoveryHeld {
		t.Fatalf("pre-hold callback lost current hold: %+v %v", current, err)
	}
	d, _ := get[model.Dispatch](context.Background(), e.store, "dispatches", "recovery_dispatch")
	if d.TurnEnded {
		t.Fatalf("pre-hold callback completed original dispatch: %+v", d)
	}
}

func TestNativeRecoveryDifferentPaneHoldKeepsOneSubscription(t *testing.T) {
	e, f, w, actual := nativeRecoverySession(t)
	f.mu.Lock()
	f.pane.PaneID = "w1:p9"
	f.mu.Unlock()
	if err := e.refreshSession(context.Background(), w.SessionID); err != nil {
		t.Fatal(err)
	}
	current := assertRecoveryHeld(t, e, w)
	if current.RecoveryPaneID != "w1:p9" || current.PaneID != w.PaneID {
		t.Fatalf("recovery route replaced durable binding: %+v", current)
	}
	e.runtimeMu.Lock()
	generation := e.sessions[w.SessionID].generation
	e.runtimeMu.Unlock()
	// A read-only recovery target does not require repeated stream replacement.
	// If reconciliation requested another barrier, its 300 ms retry would fire.
	time.Sleep(650 * time.Millisecond)
	e.runtimeMu.Lock()
	later := e.sessions[w.SessionID].generation
	e.runtimeMu.Unlock()
	if later != generation {
		t.Fatalf("held different pane repeatedly resubscribed: %d -> %d", generation, later)
	}
	verifiedRecoveryForeground(f, actual)
	f.event(t, "idle", 4)
	current = waitNativeRecapture(t, e, w)
	if current.PaneID != "w1:p9" || current.RecoveryHeld {
		t.Fatalf("event on saved target did not recapture: %+v", current)
	}
	d, _ := get[model.Dispatch](context.Background(), e.store, "dispatches", "recovery_dispatch")
	if d.TurnEnded {
		t.Fatalf("different pane recapture settled old dispatch: %+v", d)
	}
}

func TestNativeRecoveryHeldTargetCannotAuthorizeDifferentConversation(t *testing.T) {
	e, f, w, _ := nativeRecoverySession(t)
	f.mu.Lock()
	other := *f.pane.AgentSession
	other.Value = "unrelated-conversation"
	f.pane.AgentSession = &other
	f.mu.Unlock()
	f.event(t, "idle", 4)
	deadline := time.Now().Add(2 * time.Second)
	var current model.Worker
	for time.Now().Before(deadline) {
		current, _ = get[model.Worker](context.Background(), e.store, "workers", w.ID)
		if current.State == "lost" {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if current.State != "lost" || current.RecoveryHeld || current.AttachmentID != w.AttachmentID || current.AgentProcess.Birth != w.AgentProcess.Birth {
		t.Fatalf("routing hint authorized other conversation: %+v", current)
	}
}
