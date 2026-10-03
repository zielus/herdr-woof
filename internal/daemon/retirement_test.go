package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/zielus/herdr-woof-v2/internal/herdr"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/store"
)

func retirementPeer(t *testing.T, e *Engine, w model.Worker, mode string) *atomic.Int32 {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "woof-retirement-")
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
	closes := &atomic.Int32{}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = conn.Close() }() // The peer may already have disconnected; cleanup is best effort.
				data, err := bufio.NewReader(conn).ReadBytes('\n')
				if err != nil {
					return // Recovery may disconnect a client before sending a request.
				}
				var request struct {
					Method string `json:"method"`
				}
				if err := json.Unmarshal(data, &request); err != nil {
					t.Error(err)
					return
				}
				response := map[string]any{}
				switch request.Method {
				case "agent.get":
					if mode == "agent_read_failure" {
						return
					}
					if mode == "positive_replacement" || mode == "positive_same_terminal" {
						kind, name := w.AgentKind, "replacement-agent"
						terminal := "replacement-terminal"
						if mode == "positive_same_terminal" {
							terminal = w.TerminalID
						}
						response["result"] = map[string]any{"agent": herdr.Pane{PaneID: w.PaneID, WorkspaceID: "w1", TerminalID: terminal, Agent: &kind, Name: &name, AgentSession: w.NativeSession, AgentStatus: "working"}}
					} else {
						response["error"] = map[string]string{"code": "agent_not_found", "message": "no registered agent"}
					}
				case "pane.get":
					if mode == "pane_read_failure" {
						return
					}
					switch mode {
					case "positive_same_terminal":
						response["result"] = map[string]any{"pane": herdr.Pane{PaneID: w.PaneID, WorkspaceID: "w1", TerminalID: w.TerminalID}}
					case "replacement", "positive_replacement":
						response["result"] = map[string]any{"pane": herdr.Pane{PaneID: w.PaneID, WorkspaceID: "w1", TerminalID: "replacement-terminal"}}
					default:
						response["error"] = map[string]string{"code": "pane_not_found", "message": "absent"}
					}
				case "pane.close":
					closes.Add(1)
					response["result"] = map[string]bool{"closed": true}
				default:
					response["result"] = map[string]any{}
				}
				// A disconnected client needs no retry of its fixture response.
				if err := json.NewEncoder(conn).Encode(response); err != nil {
					return
				}
			}()
		}
	}()
	e.runtimeMu.Lock()
	e.sessions[w.SessionID].client = herdr.New(socket)
	e.runtimeMu.Unlock()
	return closes
}

func TestLostPaneRetirementFreesAliasAndKeepsSharedWorktree(t *testing.T) {
	for _, op := range []string{"worker.release", "worker.stop"} {
		t.Run(op, func(t *testing.T) {
			e, f, w := workerFixture(t, true)
			if err := f.process.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			_ = f.process.Wait()
			w.State = "lost"
			tree := model.Worktree{ID: "shared_retirement_tree", SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, Path: w.Cwd, OwnershipKind: "external"}
			w.WorktreeID = tree.ID
			other := w
			other.ID = "retirement_peer"
			other.Name = "peer"
			other.State = "idle"
			other.PaneID = "w1:p2"
			other.AgentProcess = nil
			if err := e.write(context.Background(), func(tx *store.Tx) error {
				if err := tx.Put("worktrees", tree.ID, tree); err != nil {
					return err
				}
				if err := tx.Put("workers", w.ID, w); err != nil {
					return err
				}
				return tx.Put("workers", other.ID, other)
			}); err != nil {
				t.Fatal(err)
			}
			closes := retirementPeer(t, e, w, "absent")
			v, err := workerCall(t, e, op, model.Scope{Global: true}, Args{ID: w.ID})
			if err != nil {
				t.Fatal(err)
			}
			result := v.(CloseResult)
			want := "released"
			if op == "worker.stop" {
				want = "stopped"
			}
			if result.Worker.State != want || result.Worker.Ready || result.Worker.OperationID == "" {
				t.Fatalf("retirement result: %+v", result)
			}
			if closes.Load() != 0 {
				t.Fatal("attempted to close absent pane")
			}
			if _, err := os.Stat(tree.Path); err != nil {
				t.Fatal("shared worktree removed", err)
			}
			peer, _ := get[model.Worker](context.Background(), e.store, "workers", other.ID)
			if peer.State != "idle" {
				t.Fatalf("changed peer %+v", peer)
			}
			opReceipt, err := get[model.Operation](context.Background(), e.store, "operations", result.Worker.OperationID)
			if err != nil || opReceipt.State != "completed" || opReceipt.ResourceID != w.ID {
				t.Fatalf("receipt %+v %v", opReceipt, err)
			}
			replacement := w
			replacement.ID = "alias_replacement"
			replacement.State = "starting"
			if err := e.write(context.Background(), func(tx *store.Tx) error { return tx.Put("workers", replacement.ID, replacement) }); err != nil {
				t.Fatal("retirement did not free alias", err)
			}
		})
	}
}

func TestReplacementPaneRetirementNeverClosesOrSignalsReplacement(t *testing.T) {
	e, f, w := workerFixture(t, true)
	// The recorded PID now denotes a different birth. It may belong to another
	// process, so retirement must never signal it or close the replacement pane.
	stale := *w.AgentProcess
	stale.Birth = "old-incarnation"
	w.AgentProcess = &stale
	w.State = "offline"
	if err := e.write(context.Background(), func(tx *store.Tx) error { return tx.Put("workers", w.ID, w) }); err != nil {
		t.Fatal(err)
	}
	closes := retirementPeer(t, e, w, "replacement")
	if _, err := workerCall(t, e, "worker.release", model.Scope{Global: true}, Args{ID: w.ID}); err != nil {
		t.Fatal(err)
	}
	if closes.Load() != 0 {
		t.Fatal("closed replacement terminal")
	}
	if _, err := birthIdentity(f.process.Process.Pid); err != nil {
		t.Fatal("signaled replacement process", err)
	}
}

func TestRetirementRefusesSurvivingOrMissingRecordedProcessProof(t *testing.T) {
	for _, withoutProof := range []bool{false, true} {
		t.Run(map[bool]string{false: "alive", true: "missing_birth"}[withoutProof], func(t *testing.T) {
			e, _, w := workerFixture(t, true)
			w.State = "lost"
			if withoutProof {
				w.AgentProcess = nil
			}
			if err := e.write(context.Background(), func(tx *store.Tx) error { return tx.Put("workers", w.ID, w) }); err != nil {
				t.Fatal(err)
			}
			closes := retirementPeer(t, e, w, "absent")
			_, err := workerCall(t, e, "worker.stop", model.Scope{Global: true}, Args{ID: w.ID, Force: true})
			workerCode(t, err, "cleanup_unverified")
			current, _ := get[model.Worker](context.Background(), e.store, "workers", w.ID)
			if current.State == "stopped" || current.State == "released" || closes.Load() != 0 {
				t.Fatalf("unverified retirement: %+v", current)
			}
		})
	}
}

func TestRetirementReadFailuresStayInspectableAndNeverMutatePane(t *testing.T) {
	for _, mode := range []string{"agent_read_failure", "pane_read_failure"} {
		t.Run(mode, func(t *testing.T) {
			e, f, w := workerFixture(t, true)
			_ = f.process.Process.Kill()
			_ = f.process.Wait()
			closes := retirementPeer(t, e, w, mode)
			_, err := workerCall(t, e, "worker.release", model.Scope{Global: true}, Args{ID: w.ID})
			workerCode(t, err, "uncertain")
			current, _ := get[model.Worker](context.Background(), e.store, "workers", w.ID)
			if current.State == "released" || current.State == "stopped" || closes.Load() != 0 {
				t.Fatalf("read failure retired worker: %+v", current)
			}
		})
	}
}

func TestNativeWorkspaceFlagOverridesOnlyInferredWorkspaceWithinSession(t *testing.T) {
	e, f, w := workerFixture(t, false)
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		if err := tx.Put("workspaces", "ws_native", model.Workspace{ID: "ws_native", SessionID: w.SessionID, HerdrWorkspaceID: "w2", Cwd: w.Cwd}); err != nil {
			return err
		}
		if err := tx.Put("sessions", "other_session", model.Session{ID: "other_session", SocketPath: "/tmp/other"}); err != nil {
			return err
		}
		return tx.Put("workspaces", "ws_other", model.Workspace{ID: "ws_other", SessionID: "other_session", HerdrWorkspaceID: "other-native", Cwd: w.Cwd})
	}); err != nil {
		t.Fatal(err)
	}
	w.WorktreeID = "inherited_tree"
	w.RunID = "inherited_run"
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		if err := tx.Put("worktrees", w.WorktreeID, model.Worktree{ID: w.WorktreeID, SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, Path: w.Cwd, OwnershipKind: "external"}); err != nil {
			return err
		}
		if err := tx.Put("runs", w.RunID, model.Run{ID: w.RunID, SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, WorktreeID: w.WorktreeID, Status: "active"}); err != nil {
			return err
		}
		return tx.Put("workers", w.ID, w)
	}); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.pane.WorkspaceID = "w2"
	f.pane.PaneID = "w2:p1"
	f.mu.Unlock()
	raw, _ := json.Marshal(Args{Name: "native-target", Pane: "w2:p1", Workspace: "w2"})
	v, err := e.Handle(context.Background(), model.Request{Version: model.Protocol, ID: newID("op"), Op: "worker.adopt", Scope: workerScope(w), Caller: model.Caller{WorkerID: w.ID, AttachmentID: w.AttachmentID}, Args: raw})
	if err != nil {
		t.Fatal(err)
	}
	adopted := v.(model.Worker)
	if adopted.WorkspaceID != "ws_native" || adopted.SessionID != w.SessionID || adopted.WorktreeID != "" || adopted.RunID != "" {
		t.Fatalf("native workspace flag ignored: %+v", adopted)
	}
	_, err = e.Handle(context.Background(), model.Request{Version: model.Protocol, ID: newID("op"), Op: "worker.adopt", Scope: model.Scope{WorkspaceID: w.WorkspaceID}, ScopeExplicit: true, Args: raw})
	workerCode(t, err, "invalid_scope")
	raw, _ = json.Marshal(Args{Name: "cross-target", Pane: "w2:p1", Workspace: "other-native"})
	_, err = e.Handle(context.Background(), model.Request{Version: model.Protocol, ID: newID("op"), Op: "worker.adopt", Scope: model.Scope{SessionID: w.SessionID}, ScopeExplicit: true, Args: raw})
	workerCode(t, err, "workspace_not_found")
}

func TestNativeWorkspaceFlagRequiresExplicitSessionForCrossSessionAdoption(t *testing.T) {
	e := sessionEngine(t)
	a, b := newSessionFixture(t, "a"), newSessionFixture(t, "b")
	sa, sb := attachFixture(t, e, a, "a"), attachFixture(t, e, b, "b")
	caller := seedSessionWorker(t, e, sa, a)
	raw, _ := json.Marshal(Args{Name: "explicit-cross-session", Pane: "w1:p1", Workspace: "w1"})
	v, err := e.Handle(context.Background(), model.Request{Version: model.Protocol, ID: newID("op"), Op: "worker.adopt", Scope: model.Scope{SessionID: sb.ID}, ScopeExplicit: true, Caller: model.Caller{WorkerID: caller.ID, AttachmentID: caller.AttachmentID}, Args: raw})
	if err != nil {
		t.Fatal(err)
	}
	adopted := v.(model.Worker)
	if adopted.SessionID != sb.ID || adopted.SessionID == sa.ID {
		t.Fatalf("native pane name routed to caller session: %+v", adopted)
	}
	workspaces, err := list[model.Workspace](context.Background(), e.store, "workspaces", model.Scope{SessionID: sb.ID})
	if err != nil || len(workspaces) != 1 || adopted.WorkspaceID != workspaces[0].ID {
		t.Fatalf("cross-session workspace mapping: %+v %+v %v", adopted, workspaces, err)
	}
}

func TestRetirementProtectsRecordedCwdAlongsideSharedTree(t *testing.T) {
	e, f, w := workerFixture(t, true)
	_ = f.process.Process.Kill()
	_ = f.process.Wait()
	w.State = "lost"
	gitTest(t, w.Cwd, "init", "-q")
	if err := os.WriteFile(filepath.Join(w.Cwd, "unsaved.txt"), []byte("keep this work"), 0600); err != nil {
		t.Fatal(err)
	}
	tree := model.Worktree{ID: "different_shared_tree", SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, Path: t.TempDir(), OwnershipKind: "external"}
	w.WorktreeID = tree.ID
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		if err := tx.Put("worktrees", tree.ID, tree); err != nil {
			return err
		}
		return tx.Put("workers", w.ID, w)
	}); err != nil {
		t.Fatal(err)
	}
	closes := retirementPeer(t, e, w, "absent")
	_, err := workerCall(t, e, "worker.release", model.Scope{Global: true}, Args{ID: w.ID})
	workerCode(t, err, "unsaved_work")
	current, _ := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	if current.State != "lost" || closes.Load() != 0 {
		t.Fatalf("uncommitted cwd ignored during retirement: %+v", current)
	}
}

func TestPositiveReplacementAgentRetiresOnlyDeadOldBinding(t *testing.T) {
	for _, scenario := range []string{"dead_old_process", "alive_old_process", "same_terminal"} {
		t.Run(scenario, func(t *testing.T) {
			e, f, w := workerFixture(t, true)
			if scenario != "alive_old_process" {
				_ = f.process.Process.Kill()
				_ = f.process.Wait()
			}
			w.State = "lost"
			if err := e.write(context.Background(), func(tx *store.Tx) error { return tx.Put("workers", w.ID, w) }); err != nil {
				t.Fatal(err)
			}
			mode := "positive_replacement"
			if scenario == "same_terminal" {
				mode = "positive_same_terminal"
			}
			closes := retirementPeer(t, e, w, mode)
			_, err := workerCall(t, e, "worker.stop", model.Scope{Global: true}, Args{ID: w.ID})
			switch scenario {
			case "dead_old_process":
				if err != nil {
					t.Fatal(err)
				}
			case "alive_old_process":
				workerCode(t, err, "cleanup_unverified")
			case "same_terminal":
				workerCode(t, err, "stale_attachment")
			}
			current, readErr := get[model.Worker](context.Background(), e.store, "workers", w.ID)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if scenario == "dead_old_process" && current.State != "stopped" {
				t.Fatalf("old binding not retired: %+v", current)
			}
			if scenario != "dead_old_process" && current.State == "stopped" {
				t.Fatalf("unverified binding retired: %+v", current)
			}
			if closes.Load() != 0 {
				t.Fatal("closed a positively identified replacement agent")
			}
			if scenario == "alive_old_process" {
				if _, err := birthIdentity(f.process.Process.Pid); err != nil {
					t.Fatal("signaled surviving recorded process", err)
				}
			}
		})
	}
}
