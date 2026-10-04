package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zielus/herdr-woof/internal/model"
	"github.com/zielus/herdr-woof/internal/store"
)

func TestContinuousBlockedTimeoutResetsAndEscalationDeduplicates(t *testing.T) {
	e, f, w := fixture(t)
	var clock atomic.Int64
	const base = int64(1800000000000)
	clock.Store(base)
	e.opts.Now = func() time.Time { return time.UnixMilli(clock.Load()) }
	e.opts.BlockedTimeout = 20 * time.Second
	e.opts.QuietTimeout = time.Hour
	e.opts.IdleTimeout = time.Hour
	d := mustDispatch(t, e, w)
	observe := func(status string, seq uint64, elapsed int64) {
		clock.Store(base + elapsed)
		setObservation(t, e, f, w, status, seq, w.CompletionSeq)
	}
	check := func(elapsed int64, want bool) {
		t.Helper()
		clock.Store(base + elapsed)
		if err := e.watchdogOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
		current, err := get[model.Dispatch](context.Background(), e.store, "dispatches", d.ID)
		if err != nil || current.Alerts["continuously_blocked"] != want {
			t.Fatalf("elapsed=%d dispatch=%+v err=%v", elapsed, current, err)
		}
	}
	observe("blocked", 3, 0)
	check(19000, false)
	observe("working", 4, 19000)
	current, err := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	if err != nil || current.BlockedAt != 0 {
		t.Fatalf("blocked timer survived leaving blocked: %+v %v", current, err)
	}
	observe("blocked", 5, 20000)
	check(39000, false) // cumulative blocked time is 38s; continuous time is only 19s.
	check(41000, true)
	check(42000, true)
	messages, err := list[model.Message](context.Background(), e.store, "messages", model.Scope{RunID: d.RunID})
	if err != nil || len(messages) != 1 || messages[0].Kind != "escalation" {
		t.Fatalf("reason repeated across ticks: %+v %v", messages, err)
	}
	// A new block episode in the same dispatch is debounced and reported again.
	observe("working", 6, 43000)
	observe("blocked", 7, 44000)
	check(63000, true)
	if messages, err = list[model.Message](context.Background(), e.store, "messages", model.Scope{RunID: d.RunID}); err != nil || len(messages) != 1 {
		t.Fatalf("new block alerted before its own debounce: %+v %v", messages, err)
	}
	check(65000, true)
	check(66000, true)
	if messages, err = list[model.Message](context.Background(), e.store, "messages", model.Scope{RunID: d.RunID}); err != nil || len(messages) != 2 {
		t.Fatalf("new block episode must alert exactly once: %+v %v", messages, err)
	}
	currentDispatch, _ := get[model.Dispatch](context.Background(), e.store, "dispatches", d.ID)
	if !activeDispatch(currentDispatch) {
		t.Fatal("blocked silence settled or failed the dispatch")
	}
}

func TestSharedRunWorktreeWorkersKeepIndependentReceiptsAndSurviveRelease(t *testing.T) {
	e, _, w := workerFixture(t, true)
	ctx := context.Background()
	gitTest(t, w.Cwd, "init", "-q")
	gitTest(t, w.Cwd, "config", "user.email", "acceptance@example.invalid")
	gitTest(t, w.Cwd, "config", "user.name", "acceptance")
	file := filepath.Join(w.Cwd, "shared.txt")
	if err := os.WriteFile(file, []byte("shared committed work"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTest(t, w.Cwd, "add", ".")
	gitTest(t, w.Cwd, "commit", "-qm", "shared work")
	remote := filepath.Join(t.TempDir(), "published.git")
	gitTest(t, w.Cwd, "clone", "--bare", w.Cwd, remote)
	gitTest(t, w.Cwd, "remote", "add", "origin", remote)
	gitTest(t, w.Cwd, "fetch", "-q", "origin")
	tree := model.Worktree{ID: "tree_shared", SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, Path: w.Cwd, OwnershipKind: "external"}
	if err := e.write(ctx, func(tx *store.Tx) error { return tx.Put("worktrees", tree.ID, tree) }); err != nil {
		t.Fatal(err)
	}
	v, err := workerCall(t, e, "run.create", model.Scope{WorktreeID: tree.ID}, Args{Title: "shared collaboration"})
	if err != nil {
		t.Fatal(err)
	}
	run := v.(model.Run)
	if run.WorktreeID != tree.ID || run.WorkspaceID != w.WorkspaceID {
		t.Fatalf("run ownership references: %+v", run)
	}
	w.RunID = run.ID
	w.WorktreeID = tree.ID
	other := w
	other.ID = "worker_shared_peer"
	other.Name = "shared-peer"
	other.PaneID = "w1:p2"
	other.TerminalID = "peer-terminal"
	other.AttachmentID = "peer-attachment"
	other.AgentProcess = nil
	native := *other.NativeSession
	native.Value = "peer-incarnation"
	other.NativeSession = &native
	if err := e.write(ctx, func(tx *store.Tx) error {
		if err := tx.Put("workers", w.ID, w); err != nil {
			return err
		}
		return tx.Put("workers", other.ID, other)
	}); err != nil {
		t.Fatal(err)
	}
	e.runtimeMu.Lock()
	e.sessions[w.SessionID].ready[w.ID] = false
	e.runtimeMu.Unlock()
	for _, worker := range []model.Worker{w, other} {
		if _, err := workerCall(t, e, "worker.retain", model.Scope{Global: true}, Args{ID: worker.ID, Retained: true}); err != nil {
			t.Fatal(err)
		}
	}
	v, err = workerCall(t, e, "send", model.Scope{RunID: run.ID}, Args{To: "run:" + run.ID, Body: "coordinate the shared checkout"})
	if err != nil {
		t.Fatal(err)
	}
	message := v.(map[string]any)["message"].(model.Message)
	receipts := v.(map[string]any)["deliveries"].([]model.Delivery)
	if len(receipts) != 2 {
		t.Fatalf("run broadcast did not snapshot both workers: %+v", receipts)
	}
	for _, worker := range []model.Worker{w, other} {
		op := "ack"
		if worker.ID == other.ID {
			op = "consume"
		}
		raw, _ := json.Marshal(Args{ID: message.ID})
		if _, err := e.Handle(ctx, model.Request{Version: model.Protocol, ID: newID("op"), Op: op, Caller: model.Caller{WorkerID: worker.ID, AttachmentID: worker.AttachmentID}, Args: raw}); err != nil {
			t.Fatal(err)
		}
	}
	receipts, err = list[model.Delivery](ctx, e.store, "deliveries", model.Scope{RunID: run.ID})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]model.Delivery{}
	for _, d := range receipts {
		got[d.WorkerID] = d
	}
	if got[w.ID].Status != "acknowledged" || got[w.ID].ConsumedAt != 0 || got[other.ID].Status != "consumed" {
		t.Fatalf("recipient states coupled: %+v", got)
	}
	if _, err := workerCall(t, e, "worker.release", model.Scope{Global: true}, Args{ID: w.ID}); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(file); err != nil || string(data) != "shared committed work" {
		t.Fatalf("release damaged shared checkout: %q %v", data, err)
	}
	e.Close()
	restarted := NewEngine(e.store, Options{})
	defer restarted.Close()
	workers, err := list[model.Worker](ctx, restarted.store, "workers", model.Scope{RunID: run.ID, WorktreeID: tree.ID})
	if err != nil || len(workers) != 2 {
		t.Fatalf("shared run workers did not persist: %+v %v", workers, err)
	}
	for _, worker := range workers {
		if !worker.Retained || worker.RunID != run.ID || worker.WorktreeID != tree.ID {
			t.Fatalf("persistent binding lost: %+v", worker)
		}
		if worker.ID == other.ID && worker.State != "idle" {
			t.Fatalf("release changed peer: %+v", worker)
		}
	}
	persistedRun, err := get[model.Run](ctx, restarted.store, "runs", run.ID)
	if err != nil || persistedRun.Status != "active" {
		t.Fatalf("releasing one worker ended manual run: %+v %v", persistedRun, err)
	}
	persistedReceipts, err := list[model.Delivery](ctx, restarted.store, "deliveries", model.Scope{RunID: run.ID})
	if err != nil || len(persistedReceipts) != 2 {
		t.Fatalf("shared receipts lost on restart: %+v %v", persistedReceipts, err)
	}
}

func TestExistingPaneSpawnWaitsForShellAndKeepsRoutingAndCwd(t *testing.T) {
	e, f, prior := workerFixture(t, false)
	ctx := context.Background()
	prior.State = "stopped"
	if err := e.write(ctx, func(tx *store.Tx) error { return tx.Put("workers", prior.ID, prior) }); err != nil {
		t.Fatal(err)
	}
	f.namedFile = filepath.Join(t.TempDir(), "launch-name")
	f.shellOnTab = true // the fixture changes to a named agent only after the CLI writes its name.
	f.pane.Agent = nil
	f.pane.Name = nil
	f.info.ShellPID = 101
	setForegroundPID(f, 202)
	reads := 0
	f.beforeInfo = func() {
		reads++
		if _, err := os.Stat(f.namedFile); err == nil && reads < 4 {
			t.Error("agent launched before two available-shell observations")
		}
		if reads >= 3 {
			setForegroundPID(f, 101)
		}
	}
	f.beforeTab = func(map[string]any) { t.Error("existing pane spawn created a new tab") }
	bin := filepath.Join(t.TempDir(), "fake-herdr")
	script := "#!/bin/sh\nprintf '%s' \"$3\" > \"$WOOF_TEST_NAME_FILE\"\nprintf '%s' '{\"result\":{\"agent\":{\"pane_id\":\"w1:p1\"}}}'\n"
	if err := os.WriteFile(bin, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_BIN_PATH", bin)
	t.Setenv("WOOF_TEST_NAME_FILE", f.namedFile)
	v, err := workerCall(t, e, "worker.spawn", model.Scope{WorkspaceID: prior.WorkspaceID}, Args{Name: "existing-shell", Pane: prior.PaneID, Cwd: prior.Cwd, Profile: "sleep", Retained: true})
	if err != nil {
		t.Fatal(err)
	}
	worker := v.(model.Worker)
	if worker.ID == prior.ID || worker.PaneID != prior.PaneID || worker.TerminalID != prior.TerminalID || worker.Cwd != prior.Cwd || !worker.Retained || worker.OperationID == "" || worker.State != "idle" {
		t.Fatalf("existing-shell binding: %+v", worker)
	}
	op, err := get[model.Operation](ctx, e.store, "operations", worker.OperationID)
	if err != nil || op.State != "completed" || op.ResourceID != worker.ID {
		t.Fatalf("existing-pane receipt: %+v %v", op, err)
	}
}
