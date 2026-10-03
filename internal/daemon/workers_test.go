// Worker lifecycle scenarios adapted from herdr-orch internal/daemon/engine_test.go
// (MIT, Copyright (c) 2026 Stephen Ellington); strengthened identity/uncertainty rules.
package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/zielus/herdr-woof-v2/internal/herdr"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/paths"
	"github.com/zielus/herdr-woof-v2/internal/profiles"
	"github.com/zielus/herdr-woof-v2/internal/store"
)

type lifecycleAgent struct {
	mu                   sync.Mutex
	pane                 herdr.Pane
	info                 herdr.ProcessInfo
	gone, uncertainClose bool
	closes               int
	process              *exec.Cmd
	beforeTab            func(map[string]any)
	namedFile            string
	beforeInfo           func()
	shellOnTab           bool
}

func workerFixture(t *testing.T, withProcess bool) (*Engine, *lifecycleAgent, model.Worker) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "woof.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	checkout := filepath.Join(dir, "checkout")
	if err := os.Mkdir(checkout, 0700); err != nil {
		t.Fatal(err)
	}
	kind, name, cwd, ready := "sleep", "original", checkout, true
	native := &model.NativeSession{Source: "fixture", Agent: kind, Kind: "session", Value: "incarnation"}
	f := &lifecycleAgent{pane: herdr.Pane{PaneID: "w1:p1", WorkspaceID: "w1", TerminalID: "term_a", Agent: &kind, Name: &name, Cwd: &cwd, InteractiveReady: &ready, AgentSession: native, AgentStatus: "idle"}}
	w := model.Worker{ID: "worker_a", SessionID: "s_a", WorkspaceID: "ws_a", PaneID: f.pane.PaneID, Name: "alice", AgentKind: kind, AgentName: name, TerminalID: f.pane.TerminalID, NativeSession: native, AttachmentID: "att_a", State: "idle", Cwd: checkout, Ready: true}
	if withProcess {
		f.process = exec.Command("sleep", "60")
		if err := f.process.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { f.process.Process.Kill(); f.process.Wait() })
		ident, err := birthIdentity(f.process.Process.Pid)
		if err != nil {
			t.Fatal(err)
		}
		w.AgentProcess = &ident
		f.info.TTY = ident.TTY
		f.info.ForegroundProcesses = append(f.info.ForegroundProcesses, struct {
			PID     int      `json:"pid"`
			Name    string   `json:"name"`
			Argv0   string   `json:"argv0"`
			Argv    []string `json:"argv"`
			Cmdline string   `json:"cmdline"`
			Cwd     string   `json:"cwd"`
		}{PID: ident.PID, Name: "sleep", Argv0: "sleep"})
	}
	socketDir, err := os.MkdirTemp("/tmp", "woof-worker-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(socketDir) })
	sock := filepath.Join(socketDir, "h.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				line, _ := bufio.NewReader(c).ReadBytes('\n')
				var r struct {
					Method string         `json:"method"`
					Params map[string]any `json:"params"`
				}
				json.Unmarshal(line, &r)
				f.mu.Lock()
				defer f.mu.Unlock()
				var result any
				switch r.Method {
				case "pane.get", "agent.get":
					if f.gone {
						json.NewEncoder(c).Encode(map[string]any{"error": map[string]string{"code": "pane_not_found", "message": "gone"}})
						return
					}
					p := f.pane
					if f.namedFile != "" {
						if data, err := os.ReadFile(f.namedFile); err == nil {
							name := string(data)
							p.Name = &name
							f.pane.Name = &name
							if f.shellOnTab {
								kind := "sleep"
								p.Agent = &kind
								f.pane.Agent = &kind
							}
						}
					}
					result = map[string]any{"pane": p, "agent": p}
				case "pane.process_info":
					if f.beforeInfo != nil {
						f.beforeInfo()
					}
					result = map[string]any{"process_info": f.info}
				case "pane.read":
					result = map[string]any{"read": map[string]string{"text": "valuable transcript"}}
				case "tab.create":
					if f.beforeTab != nil {
						f.beforeTab(r.Params)
					}
					if f.shellOnTab {
						f.pane.Agent = nil
						f.pane.Name = nil
					}
					result = map[string]any{"root_pane": f.pane}
				case "pane.close":
					f.closes++
					if f.uncertainClose {
						return
					}
					f.gone = true
					if f.process != nil {
						f.process.Process.Kill()
					}
					result = map[string]bool{"closed": true}
				case "notification.show":
					result = map[string]bool{"shown": true}
				default:
					result = map[string]any{}
				}
				json.NewEncoder(c).Encode(map[string]any{"result": result})
			}()
		}
	}()
	e := NewEngine(st, Options{Paths: paths.Paths{Archive: filepath.Join(dir, "archive")}, Config: profiles.Config{Profiles: map[string]profiles.Profile{"sleep": {Agent: "sleep", Args: []string{"--literal", "$(unsafe)"}}}, Defaults: profiles.Defaults{WorkerProfile: "sleep"}}})
	t.Cleanup(e.Close)
	_, err = st.Write(context.Background(), func(tx *store.Tx) error {
		if err := tx.Put("sessions", "s_a", model.Session{ID: "s_a", SocketPath: sock, Status: "attached"}); err != nil {
			return err
		}
		if err := tx.Put("workspaces", "ws_a", model.Workspace{ID: "ws_a", SessionID: "s_a", HerdrWorkspaceID: "w1", Cwd: checkout}); err != nil {
			return err
		}
		return tx.Put("workers", w.ID, w)
	})
	if err != nil {
		t.Fatal(err)
	}
	e.sessions[w.SessionID] = &sessionRuntime{client: herdr.New(sock), ready: map[string]bool{w.ID: true}, readyAttachments: map[string]string{w.ID: w.AttachmentID}, generation: 1}
	return e, f, w
}

func workerCode(t *testing.T, err error, code string) {
	t.Helper()
	var e *model.Error
	if !errors.As(err, &e) || e.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}
func workerCall(t *testing.T, e *Engine, op string, scope model.Scope, a Args) (any, error) {
	t.Helper()
	data, _ := json.Marshal(a)
	return e.Handle(context.Background(), model.Request{Version: model.Protocol, ID: newID("op"), Op: op, Scope: scope, Args: data})
}

func TestBirthIdentityRejectsReusedPIDAndNonAgentEvidence(t *testing.T) {
	e, f, w := workerFixture(t, true)
	ident, err := birthIdentity(w.AgentProcess.PID)
	if err != nil || ident.Birth == "" || ident.Birth != w.AgentProcess.Birth {
		t.Fatalf("identity %+v %v", ident, err)
	}
	w.AgentProcess.Birth = "wrong-incarnation"
	if err := e.write(context.Background(), func(tx *store.Tx) error { return tx.Put("workers", w.ID, w) }); err != nil {
		t.Fatal(err)
	}
	_, err = workerCall(t, e, "worker.release", model.Scope{Global: true}, Args{ID: w.ID, Force: true})
	workerCode(t, err, "stale_attachment")
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closes != 0 {
		t.Fatal("closed pane with reused agent PID")
	}
}

func TestBusyWorkerWithoutDispatchRequiresForceForReleaseAndStop(t *testing.T) {
	for _, op := range []string{"worker.release", "worker.stop"} {
		t.Run(op, func(t *testing.T) {
			e, f, w := workerFixture(t, true)
			f.mu.Lock()
			f.pane.AgentStatus = "working"
			f.mu.Unlock()
			_, err := workerCall(t, e, op, model.Scope{Global: true}, Args{ID: w.ID})
			workerCode(t, err, "worker_busy")
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.closes != 0 {
				t.Fatal("closed a busy worker without force")
			}
		})
	}
}

func TestSignalChecksOriginalProcessBirthImmediately(t *testing.T) {
	e, _, w := workerFixture(t, true)
	_ = e
	expected := *w.AgentProcess
	expected.Birth = "different-birth"
	if err := signalOriginalProcess(expected, syscall.SIGTERM); err == nil {
		t.Fatal("signal accepted mismatching process birth")
	}
	if _, err := birthIdentity(w.AgentProcess.PID); err != nil {
		t.Fatal("reused PID was signaled")
	}
}

func TestRetainRecordAndReceiptCommitTogether(t *testing.T) {
	e, _, w := workerFixture(t, false)
	data, _ := json.Marshal(Args{ID: w.ID, Retained: true})
	req := model.Request{Version: model.Protocol, ID: "retain_once", Op: "worker.retain", Scope: model.Scope{Global: true}, Args: data}
	_, err := e.Handle(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	op, _ := get[model.Operation](context.Background(), e.store, "operations", req.ID)
	if !got.Retained || op.State != "completed" || got.OperationID != req.ID {
		t.Fatalf("worker=%+v receipt=%+v", got, op)
	}
	if _, err := e.Handle(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	events, _ := e.store.Events(context.Background(), 0, model.Scope{WorkerID: w.ID}, []string{"worker.retained"}, 0)
	if len(events) != 1 {
		t.Fatalf("duplicated retain: %d", len(events))
	}
}

func TestAdoptionRequiresIncarnationEvidenceAndFencesOldDispatch(t *testing.T) {
	e, f, w := workerFixture(t, false)
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		if err := tx.Put("runs", "r_a", model.Run{ID: "r_a", SessionID: w.SessionID, WorkspaceID: w.WorkspaceID}); err != nil {
			return err
		}
		return tx.Put("dispatches", "d_a", model.Dispatch{ID: "d_a", SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, WorkerID: w.ID, RunID: "r_a", Status: "pending", AttachmentID: w.AttachmentID})
	}); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.pane.TerminalID = "term_b"
	f.pane.AgentSession = &model.NativeSession{Source: "fixture", Agent: "sleep", Kind: "session", Value: "new-incarnation"}
	f.mu.Unlock()
	v, err := workerCall(t, e, "worker.adopt", model.Scope{WorkspaceID: w.WorkspaceID}, Args{ID: w.ID, Pane: w.PaneID, Name: w.Name})
	if err != nil {
		t.Fatal(err)
	}
	got := v.(model.Worker)
	if got.ID != w.ID || got.AttachmentID == w.AttachmentID || got.TerminalID != "term_b" {
		t.Fatalf("adoption: %+v", got)
	}
	d, _ := get[model.Dispatch](context.Background(), e.store, "dispatches", "d_a")
	if d.Status != "failed" {
		t.Fatalf("old dispatch not fenced: %+v", d)
	}
	f.mu.Lock()
	f.pane.AgentSession = nil
	f.mu.Unlock()
	_, err = workerCall(t, e, "worker.adopt", model.Scope{WorkspaceID: w.WorkspaceID}, Args{Pane: w.PaneID, Name: "other"})
	workerCode(t, err, "identity_unverified")
}

func TestAdoptionUsesLiveCwdAndRejectsConflictingExplicitCwd(t *testing.T) {
	e, f, w := workerFixture(t, false)
	actual := t.TempDir()
	f.mu.Lock()
	f.pane.Cwd = &actual
	f.mu.Unlock()
	v, err := workerCall(t, e, "worker.adopt", model.Scope{WorkspaceID: w.WorkspaceID}, Args{ID: w.ID, Pane: w.PaneID, Name: w.Name})
	if err != nil {
		t.Fatal(err)
	}
	if got := v.(model.Worker); got.Cwd != actual {
		t.Fatalf("saved cwd %q differs from live %q", got.Cwd, actual)
	}
	_, err = workerCall(t, e, "worker.adopt", model.Scope{WorkspaceID: w.WorkspaceID}, Args{ID: w.ID, Pane: w.PaneID, Cwd: w.Cwd})
	workerCode(t, err, "bad_cwd")
}

func TestUncertainCloseIsPersistedAndNotReplayed(t *testing.T) {
	e, f, w := workerFixture(t, true)
	f.uncertainClose = true
	data, _ := json.Marshal(Args{ID: w.ID, Force: true})
	req := model.Request{Version: model.Protocol, ID: "release_once", Op: "worker.release", Scope: model.Scope{Global: true}, Args: data}
	_, err := e.Handle(context.Background(), req)
	if !isUncertain(err) {
		t.Fatalf("wanted uncertain close, got %v", err)
	}
	var me *model.Error
	if !errors.As(err, &me) || me.OperationID != req.ID {
		t.Fatalf("missing operation ID: %v", err)
	}
	_, err = e.Handle(context.Background(), req)
	if !isUncertain(err) {
		t.Fatalf("wanted uncertain receipt, got %v", err)
	}
	op, _ := get[model.Operation](context.Background(), e.store, "operations", req.ID)
	stored, _ := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	if stored.OperationID != req.ID {
		t.Fatalf("worker missing receipt: %+v", stored)
	}
	if op.State != "uncertain" || op.ResourceID != w.ID {
		t.Fatalf("receipt: %+v", op)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closes != 1 {
		t.Fatalf("close replayed %d times", f.closes)
	}
	if _, err := birthIdentity(w.AgentProcess.PID); err != nil {
		t.Fatal("signaled process after uncertain close")
	}
}

func TestReleaseProtectsGitAndLeavesSharedWorktree(t *testing.T) {
	e, f, w := workerFixture(t, true)
	dir := w.Cwd
	gitTest(t, dir, "init", "-q")
	gitTest(t, dir, "config", "user.email", "test@test")
	gitTest(t, dir, "config", "user.name", "test")
	os.WriteFile(filepath.Join(dir, "work.txt"), []byte("private work"), 0600)
	_, err := workerCall(t, e, "worker.release", model.Scope{Global: true}, Args{ID: w.ID})
	workerCode(t, err, "unsaved_work")
	gitTest(t, dir, "add", ".")
	gitTest(t, dir, "commit", "-qm", "work")
	_, err = workerCall(t, e, "worker.release", model.Scope{Global: true}, Args{ID: w.ID})
	workerCode(t, err, "unsaved_work")
	remote := filepath.Join(t.TempDir(), "remote.git")
	gitTest(t, dir, "clone", "--bare", dir, remote)
	gitTest(t, dir, "remote", "add", "origin", remote)
	gitTest(t, dir, "fetch", "-q", "origin")
	// No upstream is configured, but remote refs contain HEAD and protect it.
	if reasons, err := worktreeUnsaved(context.Background(), dir); err != nil || len(reasons) != 0 {
		t.Fatalf("remote-contained work refused: %v %v", reasons, err)
	}
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		if err := tx.Put("worktrees", "wt_shared", model.Worktree{ID: "wt_shared", SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, Path: dir, OwnershipKind: "external"}); err != nil {
			return err
		}
		w.WorktreeID = "wt_shared"
		if err := tx.Put("workers", w.ID, w); err != nil {
			return err
		}
		other := w
		other.ID = "worker_b"
		other.Name = "bob"
		return tx.Put("workers", other.ID, other)
	}); err != nil {
		t.Fatal(err)
	}
	v, err := workerCall(t, e, "worker.release", model.Scope{Global: true}, Args{ID: w.ID})
	if err != nil {
		t.Fatal(err)
	}
	res := v.(CloseResult)
	if res.Worker.State != "released" || res.ArchivePath == "" {
		t.Fatalf("release: %+v", res)
	}
	data, err := os.ReadFile(res.ArchivePath)
	if err != nil || string(data) != "valuable transcript" {
		t.Fatalf("archive %q %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "work.txt")); err != nil {
		t.Fatal("shared worktree removed")
	}
	other, _ := get[model.Worker](context.Background(), e.store, "workers", "worker_b")
	if other.State != "idle" {
		t.Fatal("shared worker changed")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closes != 1 {
		t.Fatal("unexpected closes")
	}
}

func gitTest(t *testing.T, dir string, args ...string) {
	t.Helper()
	c := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if out, err := c.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %s %v", args, out, err)
	}
}

func TestSpawnPersistsIntentBeforeTabAndKeepsRawProfileArgs(t *testing.T) {
	e, f, _ := workerFixture(t, false)
	f.namedFile = filepath.Join(t.TempDir(), "name")
	f.shellOnTab = true
	f.info.ShellPID = 101
	setForegroundPID(f, 101)
	bin := filepath.Join(t.TempDir(), "fake-herdr")
	script := "#!/bin/sh\nprintf '%s' \"$3\" > \"$WOOF_TEST_NAME_FILE\"\nprintf '%s' '{\"result\":{\"agent\":{\"pane_id\":\"w1:p1\"}}}'\n"
	if err := os.WriteFile(bin, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_BIN_PATH", bin)
	t.Setenv("WOOF_TEST_NAME_FILE", f.namedFile)
	f.beforeTab = func(params map[string]any) {
		workers, err := list[model.Worker](context.Background(), e.store, "workers", model.Scope{})
		if err != nil {
			t.Error(err)
		}
		var starting model.Worker
		for _, w := range workers {
			if w.Name == "spawned" {
				starting = w
			}
		}
		if starting.ID == "" || starting.State != "starting" {
			t.Errorf("side effect without reservation: %+v", workers)
		}
		env, ok := params["env"].(map[string]any)
		if !ok || env["WOOF_WORKER_ID"] != starting.ID || env["WOOF_ATTACHMENT_ID"] != starting.AttachmentID {
			t.Errorf("launch context: %+v", params)
		}
		if params["focus"] != false {
			t.Error("spawn stole focus")
		}
	}
	v, err := workerCall(t, e, "worker.spawn", model.Scope{WorkspaceID: "ws_a"}, Args{Name: "spawned", Profile: "sleep"})
	if err != nil {
		t.Fatal(err)
	}
	w := v.(model.Worker)
	if w.ID == w.PaneID || w.State != "idle" || w.ProfileName != "sleep" || len(w.Args) != 2 || w.Args[1] != "$(unsafe)" {
		t.Fatalf("spawn: %+v", w)
	}
}

var _ = time.Second

func setForegroundPID(f *lifecycleAgent, pid int) {
	f.info.ForegroundProcesses = nil
	f.info.ForegroundProcesses = append(f.info.ForegroundProcesses, struct {
		PID     int      `json:"pid"`
		Name    string   `json:"name"`
		Argv0   string   `json:"argv0"`
		Argv    []string `json:"argv"`
		Cmdline string   `json:"cmdline"`
		Cwd     string   `json:"cwd"`
	}{PID: pid, Name: "zsh"})
}

func TestShellReadinessWaitsForStartupChildAndStableTerminal(t *testing.T) {
	e, f, w := workerFixture(t, false)
	f.mu.Lock()
	f.pane.Agent = nil
	f.pane.Name = nil
	f.info.ShellPID = 101
	setForegroundPID(f, 202)
	reads := 0
	f.beforeInfo = func() {
		reads++
		if reads >= 3 {
			setForegroundPID(f, 101)
		}
	}
	f.mu.Unlock()
	c, _ := e.sessionClient(w.SessionID)
	if err := waitShellReady(context.Background(), c, w, "w1", time.Second); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if reads < 4 {
		t.Fatalf("launched before stable shell readiness: %d reads", reads)
	}
}

func TestShellReadinessAbortsChangedTerminalAndBusyDeadline(t *testing.T) {
	for _, changed := range []bool{true, false} {
		t.Run(fmt.Sprint(changed), func(t *testing.T) {
			e, f, w := workerFixture(t, false)
			f.mu.Lock()
			f.pane.Agent = nil
			f.pane.Name = nil
			f.info.ShellPID = 101
			setForegroundPID(f, 202)
			if changed {
				f.pane.TerminalID = "replacement"
			}
			f.mu.Unlock()
			c, _ := e.sessionClient(w.SessionID)
			err := waitShellReady(context.Background(), c, w, "w1", 100*time.Millisecond)
			code := "shell_not_ready"
			if changed {
				code = "stale_attachment"
			}
			workerCode(t, err, code)
		})
	}
}

func TestUncertainSpawnExposesReceiptAndNeverReplays(t *testing.T) {
	e, f, _ := workerFixture(t, false)
	f.shellOnTab = true
	f.info.ShellPID = 101
	setForegroundPID(f, 101)
	marker := filepath.Join(t.TempDir(), "launches")
	bin := filepath.Join(t.TempDir(), "fake-herdr")
	script := "#!/bin/sh\nprintf 'launch\\n' >> \"$WOOF_TEST_LAUNCH_FILE\"\nprintf '%s' '{\"error\":{\"code\":\"timeout\",\"message\":\"startup outcome unknown\"}}' >&2\nexit 1\n"
	if err := os.WriteFile(bin, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_BIN_PATH", bin)
	t.Setenv("WOOF_TEST_LAUNCH_FILE", marker)
	data, _ := json.Marshal(Args{Name: "uncertain-spawn", Profile: "sleep"})
	req := model.Request{Version: model.Protocol, ID: "spawn_once", Op: "worker.spawn", Scope: model.Scope{WorkspaceID: "ws_a"}, Args: data}
	for i := 0; i < 2; i++ {
		_, err := e.Handle(context.Background(), req)
		var me *model.Error
		if !errors.As(err, &me) || me.Code != "uncertain" || me.OperationID != req.ID {
			t.Fatalf("missing inspectable uncertainty: %v", err)
		}
	}
	data, err := os.ReadFile(marker)
	if err != nil || string(data) != "launch\n" {
		t.Fatalf("launch replayed: %q %v", data, err)
	}
	op, err := get[model.Operation](context.Background(), e.store, "operations", req.ID)
	if err != nil || op.State != "uncertain" || op.ResourceID == "" {
		t.Fatalf("receipt %+v %v", op, err)
	}
	w, err := get[model.Worker](context.Background(), e.store, "workers", op.ResourceID)
	if err != nil || w.OperationID != req.ID || w.State != "starting" {
		t.Fatalf("worker %+v %v", w, err)
	}
}

func TestSpawnBusyShellDeadlineDoesNotStartAgent(t *testing.T) {
	e, f, _ := workerFixture(t, false)
	f.shellOnTab = true
	f.info.ShellPID = 101
	setForegroundPID(f, 202)
	marker := filepath.Join(t.TempDir(), "launches")
	bin := filepath.Join(t.TempDir(), "fake-herdr")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nprintf 'launch' > \"$WOOF_TEST_LAUNCH_FILE\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_BIN_PATH", bin)
	t.Setenv("WOOF_TEST_LAUNCH_FILE", marker)
	data, _ := json.Marshal(Args{Name: "busy-shell", Profile: "sleep"})
	req := model.Request{Version: model.Protocol, ID: "spawn_busy_shell", Op: "worker.spawn", Scope: model.Scope{WorkspaceID: "ws_a"}, Args: data}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	_, err := e.Handle(ctx, req)
	workerCode(t, err, "shell_not_ready")
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("launched into busy shell: %v", err)
	}
	workers, _ := list[model.Worker](context.Background(), e.store, "workers", model.Scope{})
	for _, w := range workers {
		if w.OperationID == req.ID && (w.State != "failed" || w.PaneID == "") {
			t.Fatalf("unobservable reserved shell: %+v", w)
		}
	}
}
