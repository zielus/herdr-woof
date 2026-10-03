package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"github.com/zielus/herdr-woof-v2/internal/herdr"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/store"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type sessionFixture struct {
	mu          sync.Mutex
	socket      string
	listener    net.Listener
	clients     map[net.Conn]bool
	pane        herdr.Pane
	protocol    int
	beforeAck   func()
	extraPanes  []herdr.Pane
	processInfo herdr.ProcessInfo
	methods     []string
}

func newSessionFixture(t *testing.T, name string) *sessionFixture {
	t.Helper()
	d, e := os.MkdirTemp("/tmp", "woof-session-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	kind, agent, cwd, ready := "codex", name, "/tmp", true
	f := &sessionFixture{socket: filepath.Join(d, "h.sock"), clients: map[net.Conn]bool{}, protocol: 22, pane: herdr.Pane{PaneID: "w1:p1", WorkspaceID: "w1", TerminalID: "terminal-" + name, Agent: &kind, Name: &agent, Cwd: &cwd, InteractiveReady: &ready, AgentStatus: "idle", StateChangeSeq: 2, AgentSession: &model.NativeSession{Source: "hook", Agent: "codex", Kind: "session", Value: name}}}
	f.start(t)
	t.Cleanup(f.stop)
	return f
}
func (f *sessionFixture) start(t *testing.T) {
	l, e := net.Listen("unix", f.socket)
	if e != nil {
		t.Fatal(e)
	}
	f.mu.Lock()
	f.listener = l
	f.mu.Unlock()
	go func() {
		for {
			c, e := l.Accept()
			if e != nil {
				return
			}
			go f.handle(c)
		}
	}()
}
func (f *sessionFixture) handle(c net.Conn) {
	defer c.Close()
	b, _ := bufio.NewReader(c).ReadBytes('\n')
	var req struct {
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}
	if json.Unmarshal(b, &req) != nil {
		return
	}
	f.mu.Lock()
	f.methods = append(f.methods, req.Method)
	p := f.pane
	extra := append([]herdr.Pane{}, f.extraPanes...)
	protocol := f.protocol
	processInfo := f.processInfo
	f.mu.Unlock()
	var result any
	switch req.Method {
	case "ping":
		result = map[string]any{"protocol": protocol, "version": "test"}
	case "session.snapshot":
		panes := append([]herdr.Pane{p}, extra...)
		workspaces := []any{}
		seen := map[string]bool{}
		for _, pane := range panes {
			if !seen[pane.WorkspaceID] {
				seen[pane.WorkspaceID] = true
				workspaces = append(workspaces, map[string]any{"workspace_id": pane.WorkspaceID, "label": "workspace"})
			}
		}
		result = map[string]any{"snapshot": map[string]any{"workspaces": workspaces, "panes": panes, "agents": panes}}
	case "agent.get":
		target, _ := req.Params["target"].(string)
		for _, candidate := range extra {
			if candidate.PaneID == target {
				p = candidate
				break
			}
		}
		result = map[string]any{"agent": p}
	case "pane.get":
		result = map[string]any{"pane": p}
	case "pane.process_info":
		result = map[string]any{"process_info": processInfo}
	case "agent.read":
		result = map[string]any{"read": map[string]string{"text": "› \n\n"}}
	case "events.subscribe":
		f.mu.Lock()
		hook := f.beforeAck
		f.beforeAck = nil
		f.mu.Unlock()
		if hook != nil {
			hook()
		}
		f.mu.Lock()
		f.clients[c] = true
		json.NewEncoder(c).Encode(map[string]any{"result": map[string]any{"type": "subscription_started"}})
		f.mu.Unlock()
		defer func() { f.mu.Lock(); delete(f.clients, c); f.mu.Unlock() }()
		var b [1]byte
		c.Read(b[:])
		return
	default:
		result = map[string]any{}
	}
	json.NewEncoder(c).Encode(map[string]any{"result": result})
}
func (f *sessionFixture) stop() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listener != nil {
		f.listener.Close()
		f.listener = nil
	}
	for c := range f.clients {
		c.Close()
	}
}
func (f *sessionFixture) event(t *testing.T, status string, seq uint64) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pane.AgentStatus = status
	f.pane.StateChangeSeq = seq
	for c := range f.clients {
		if e := json.NewEncoder(c).Encode(map[string]any{"event": "pane.agent_status_changed", "data": map[string]any{"pane_id": f.pane.PaneID, "agent_status": status}}); e != nil {
			t.Error(e)
		}
	}
}
func sessionEngine(t *testing.T) *Engine {
	t.Helper()
	st, e := store.Open(filepath.Join(t.TempDir(), "woof.db"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { st.Close() })
	engine := NewEngine(st, Options{})
	t.Cleanup(engine.Close)
	return engine
}
func attachFixture(t *testing.T, e *Engine, f *sessionFixture, name string) model.Session {
	t.Helper()
	raw, _ := json.Marshal(Args{Socket: f.socket, HerdrName: name})
	out, err := e.Handle(context.Background(), model.Request{Version: 1, ID: newID("op"), Op: "session.attach", Scope: model.Scope{Global: true}, Args: raw})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(out)
	var s model.Session
	json.Unmarshal(b, &s)
	return s
}
func seedSessionWorker(t *testing.T, e *Engine, s model.Session, f *sessionFixture) model.Worker {
	t.Helper()
	ctx := context.Background()
	ws, err := list[model.Workspace](ctx, e.store, "workspaces", model.Scope{SessionID: s.ID})
	if err != nil || len(ws) != 1 {
		t.Fatalf("workspace sync %v %v", ws, err)
	}
	f.mu.Lock()
	p := f.pane
	f.mu.Unlock()
	w := model.Worker{ID: newID("worker"), Name: "worker", SessionID: s.ID, WorkspaceID: ws[0].ID, PaneID: p.PaneID, TerminalID: p.TerminalID, AgentName: *p.Name, AgentKind: *p.Agent, NativeSession: p.AgentSession, AttachmentID: newID("attachment"), Generation: 1, State: "idle", RawStatus: "idle", StateSeq: 2, Ready: true}
	err = e.write(ctx, func(tx *store.Tx) error { return tx.Put("workers", w.ID, w) })
	if err != nil {
		t.Fatal(err)
	}
	if err = e.refreshSession(ctx, s.ID); err != nil {
		t.Fatal(err)
	}
	return w
}
func eventuallySession(t *testing.T, e *Engine, id string, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		s, err := get[model.Session](context.Background(), e.store, "sessions", id)
		if err == nil && s.Status == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	s, _ := get[model.Session](context.Background(), e.store, "sessions", id)
	t.Fatalf("session status want %s got %+v", want, s)
}
func TestSessionsSamePaneIDsRouteIndependentlyAndOutageIsolated(t *testing.T) {
	e := sessionEngine(t)
	a, b := newSessionFixture(t, "a"), newSessionFixture(t, "b")
	sa, sb := attachFixture(t, e, a, "a"), attachFixture(t, e, b, "b")
	if sa.ID == sb.ID {
		t.Fatal("session identities merged")
	}
	wa, wb := seedSessionWorker(t, e, sa, a), seedSessionWorker(t, e, sb, b)
	if !e.subscriptionReady(wa) || !e.subscriptionReady(wb) {
		t.Fatal("missing subscription barrier")
	}
	a.stop()
	eventuallySession(t, e, sa.ID, "offline")
	b.event(t, "working", 3)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		w, _ := get[model.Worker](context.Background(), e.store, "workers", wb.ID)
		if w.State == "working" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	w, _ := get[model.Worker](context.Background(), e.store, "workers", wb.ID)
	if w.State != "working" {
		t.Fatal(w)
	}
	other, _ := get[model.Worker](context.Background(), e.store, "workers", wa.ID)
	if other.State != "offline" || other.Ready || other.AttachmentID != wa.AttachmentID || other.StateSeq != wa.StateSeq || other.TerminalID != wa.TerminalID {
		t.Fatal(other)
	}
	a.start(t)
	eventuallySession(t, e, sa.ID, "online")
}
func TestSessionReplacementRejectsOldGenerationCallback(t *testing.T) {
	e := sessionEngine(t)
	f := newSessionFixture(t, "a")
	s := attachFixture(t, e, f, "a")
	w := seedSessionWorker(t, e, s, f)
	e.runtimeMu.Lock()
	old := e.sessions[s.ID].generation
	e.runtimeMu.Unlock()
	if err := e.refreshSession(context.Background(), s.ID); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.pane.AgentStatus = "working"
	f.pane.StateChangeSeq = 3
	f.mu.Unlock()
	e.sessionEvent(context.Background(), s.ID, old, herdr.Event{Name: "pane.agent_status_changed", Data: json.RawMessage(fmt.Sprintf(`{"pane_id":%q}`, w.PaneID))})
	now, _ := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	if now.State != "idle" {
		t.Fatalf("stale callback updated %v", now)
	}
	e.runtimeMu.Lock()
	fresh := e.sessions[s.ID].generation
	e.runtimeMu.Unlock()
	e.sessionEvent(context.Background(), s.ID, fresh, herdr.Event{Name: "pane.agent_status_changed", Data: json.RawMessage(fmt.Sprintf(`{"pane_id":%q}`, w.PaneID))})
	now, _ = get[model.Worker](context.Background(), e.store, "workers", w.ID)
	if now.State != "working" {
		t.Fatal(now)
	}
}
func TestSessionProtocolMismatchVisibleAndAttachDeduplicatesSocket(t *testing.T) {
	e := sessionEngine(t)
	f := newSessionFixture(t, "a")
	f.mu.Lock()
	f.protocol = 23
	f.mu.Unlock()
	s := attachFixture(t, e, f, "a")
	again := attachFixture(t, e, f, "a")
	if s.ID != again.ID {
		t.Fatal("same socket duplicated")
	}
	now, _ := get[model.Session](context.Background(), e.store, "sessions", s.ID)
	if now.Status != "offline" || now.Protocol != 23 || now.Error == "" {
		t.Fatal(now)
	}
}
func TestSessionMovedPanePreservesWorkerIdentityAndAttachment(t *testing.T) {
	e := sessionEngine(t)
	f := newSessionFixture(t, "a")
	s := attachFixture(t, e, f, "a")
	w := seedSessionWorker(t, e, s, f)
	f.mu.Lock()
	f.pane.PaneID = "w1:p9"
	f.mu.Unlock()
	if err := e.refreshSession(context.Background(), s.ID); err != nil {
		t.Fatal(err)
	}
	now, err := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	if err != nil {
		t.Fatal(err)
	}
	if now.PaneID != "w1:p9" || now.ID != w.ID || now.AttachmentID != w.AttachmentID || now.TerminalID != w.TerminalID || !e.subscriptionReady(now) {
		t.Fatalf("pane move broke logical attachment: %+v", now)
	}
}
func TestSessionStartupReconnectsPersistedRegistry(t *testing.T) {
	e := sessionEngine(t)
	f := newSessionFixture(t, "a")
	s := attachFixture(t, e, f, "a")
	w := seedSessionWorker(t, e, s, f)
	e.Close()
	next := NewEngine(e.store, Options{})
	t.Cleanup(next.Close)
	next.startSessions()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if next.subscriptionReady(w) {
			now, _ := get[model.Worker](context.Background(), next.store, "workers", w.ID)
			if now.AttachmentID != w.AttachmentID {
				t.Fatal("restart changed verified attachment")
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("restart did not establish persisted worker subscription")
}
func TestSessionRecoveryRejectsReusedPaneIdentity(t *testing.T) {
	e := sessionEngine(t)
	f := newSessionFixture(t, "a")
	s := attachFixture(t, e, f, "a")
	w := seedSessionWorker(t, e, s, f)
	f.mu.Lock()
	f.pane.TerminalID = "different-terminal"
	f.pane.AgentSession = &model.NativeSession{Source: "hook", Agent: "codex", Kind: "session", Value: "new-incarnation"}
	f.mu.Unlock()
	if err := e.refreshSession(context.Background(), s.ID); err != nil {
		t.Fatal(err)
	}
	now, err := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	if err != nil {
		t.Fatal(err)
	}
	if now.State != "lost" || now.Ready || e.subscriptionReady(now) || now.AttachmentID != w.AttachmentID {
		t.Fatalf("matching pane ID was accepted as identity: %+v", now)
	}
}

func TestSessionRefreshDoesNotLoseBindingCompletedDuringAcknowledgment(t *testing.T) {
	e := sessionEngine(t)
	f := newSessionFixture(t, "a")
	s := attachFixture(t, e, f, "a")
	ws, _ := list[model.Workspace](context.Background(), e.store, "workspaces", model.Scope{SessionID: s.ID})
	w := model.Worker{ID: newID("worker"), Name: "starting", SessionID: s.ID, WorkspaceID: ws[0].ID, State: "starting", AttachmentID: newID("attachment")}
	if err := e.write(context.Background(), func(tx *store.Tx) error { return tx.Put("workers", w.ID, w) }); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.beforeAck = func() {
		fresh := w
		fresh.PaneID = f.pane.PaneID
		fresh.TerminalID = f.pane.TerminalID
		fresh.AgentKind = *f.pane.Agent
		fresh.AgentName = *f.pane.Name
		fresh.NativeSession = f.pane.AgentSession
		fresh.State = "idle"
		fresh.RawStatus = "idle"
		fresh.Ready = true
		if err := e.write(context.Background(), func(tx *store.Tx) error { return tx.Put("workers", fresh.ID, fresh) }); err != nil {
			t.Error(err)
		}
	}
	f.mu.Unlock()
	if err := e.refreshSession(context.Background(), s.ID); err != nil {
		t.Fatal(err)
	}
	current, err := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.State == "lost" {
		t.Fatal("completed launch lost from obsolete pre-ack worker snapshot")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if e.subscriptionReady(current) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("fresh subscription was not scheduled for changed binding")
}
func TestSessionReadoptionCannotReuseOldAttachmentBarrier(t *testing.T) {
	e := sessionEngine(t)
	f := newSessionFixture(t, "a")
	s := attachFixture(t, e, f, "a")
	w := seedSessionWorker(t, e, s, f)
	old := w
	w.AttachmentID = newID("attachment")
	w.PaneID = "w1:p2"
	if err := e.write(context.Background(), func(tx *store.Tx) error { return tx.Put("workers", w.ID, w) }); err != nil {
		t.Fatal(err)
	}
	if e.subscriptionReady(w) {
		t.Fatal("new attachment inherited old pane subscription barrier")
	}
	if !e.subscriptionReady(old) {
		t.Fatal("original confirmed attachment lost barrier without replacement")
	}
}
func TestSessionRecoveryFindsUniqueNativeSessionAfterPaneAndTerminalChange(t *testing.T) {
	e := sessionEngine(t)
	f := newSessionFixture(t, "a")
	s := attachFixture(t, e, f, "a")
	w := seedSessionWorker(t, e, s, f)
	process := exec.Command("sleep", "60")
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { process.Process.Kill(); process.Wait() })
	identity, err := birthIdentity(process.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	var info herdr.ProcessInfo
	data, _ := json.Marshal(map[string]any{"foreground_processes": []any{map[string]any{"pid": identity.PID, "name": "codex", "argv0": "codex"}}})
	if err := json.Unmarshal(data, &info); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.processInfo = info
	f.pane.PaneID = "w1:p9"
	f.pane.TerminalID = "new-terminal"
	f.mu.Unlock()
	if err := e.refreshSession(context.Background(), s.ID); err != nil {
		t.Fatal(err)
	}
	current, err := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.State == "lost" || current.PaneID != "w1:p9" || current.AttachmentID == w.AttachmentID || !e.subscriptionReady(current) || current.AgentProcess == nil || current.AgentProcess.PID != identity.PID || current.AgentProcess.Birth != identity.Birth {
		t.Fatalf("unique native session not recovered: %+v", current)
	}
}
func TestSessionNativeRecoveryRefusesAmbiguousLiveMatches(t *testing.T) {
	e := sessionEngine(t)
	f := newSessionFixture(t, "a")
	s := attachFixture(t, e, f, "a")
	w := seedSessionWorker(t, e, s, f)
	f.mu.Lock()
	f.pane.PaneID = "w1:p9"
	f.pane.TerminalID = "new-terminal"
	duplicate := f.pane
	duplicate.PaneID = "w1:p10"
	duplicate.TerminalID = "another-terminal"
	f.extraPanes = []herdr.Pane{duplicate}
	f.mu.Unlock()
	if err := e.refreshSession(context.Background(), s.ID); err != nil {
		t.Fatal(err)
	}
	current, err := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.State != "lost" || e.subscriptionReady(current) || !strings.Contains(current.Error, "ambiguous") {
		t.Fatalf("ambiguous native session not exposed: %+v", current)
	}
}
func TestSessionSocketAliasesDeduplicateOnlineAndOffline(t *testing.T) {
	e := sessionEngine(t)
	f := newSessionFixture(t, "a")
	s := attachFixture(t, e, f, "a")
	real, err := filepath.EvalSymlinks(f.socket)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	alias := filepath.Join(dir, "alias")
	if err = os.Symlink(filepath.Dir(real), alias); err != nil {
		t.Fatal(err)
	}
	for _, online := range []bool{true, false} {
		if !online {
			f.stop()
		}
		raw, _ := json.Marshal(Args{Socket: filepath.Join(alias, filepath.Base(real)), HerdrName: "same"})
		out, err := e.Handle(context.Background(), model.Request{Version: 1, ID: newID("attach"), Op: "session.attach", Scope: model.Scope{Global: true}, ScopeExplicit: true, Args: raw})
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(out)
		var again model.Session
		json.Unmarshal(b, &again)
		if again.ID != s.ID {
			t.Fatalf("socket alias duplicated session online=%t: %s vs %s", online, s.ID, again.ID)
		}
	}
}
func TestSessionMoveAliasCollisionRenamesOnlyMovedWorker(t *testing.T) {
	e := sessionEngine(t)
	f := newSessionFixture(t, "a")
	s := attachFixture(t, e, f, "a")
	w := seedSessionWorker(t, e, s, f)
	f.mu.Lock()
	other := f.pane
	other.PaneID = "w2:p1"
	other.WorkspaceID = "w2"
	other.TerminalID = "other-terminal"
	otherNative := *other.AgentSession
	otherNative.Value = "other-native"
	other.AgentSession = &otherNative
	otherName := "other-agent"
	other.Name = &otherName
	f.extraPanes = []herdr.Pane{other}
	f.mu.Unlock()
	if err := e.refreshSession(context.Background(), s.ID); err != nil {
		t.Fatal(err)
	}
	workspaces, _ := list[model.Workspace](context.Background(), e.store, "workspaces", model.Scope{SessionID: s.ID})
	var target string
	for _, ws := range workspaces {
		if ws.HerdrWorkspaceID == "w2" {
			target = ws.ID
		}
	}
	second := w
	second.ID = newID("worker")
	second.WorkspaceID = target
	second.PaneID = other.PaneID
	second.TerminalID = other.TerminalID
	second.NativeSession = other.AgentSession
	second.AgentName = otherName
	second.AttachmentID = newID("attachment")
	if err := e.write(context.Background(), func(tx *store.Tx) error { return tx.Put("workers", second.ID, second) }); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.pane.WorkspaceID = "w2"
	f.pane.PaneID = "w2:p2"
	f.mu.Unlock()
	if err := e.refreshSession(context.Background(), s.ID); err != nil {
		t.Fatal(err)
	}
	current, _ := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	unmoved, _ := get[model.Worker](context.Background(), e.store, "workers", second.ID)
	session, _ := get[model.Session](context.Background(), e.store, "sessions", s.ID)
	if session.Status != "online" || current.Name == w.Name || !strings.Contains(current.Error, w.Name) || unmoved.Name != second.Name || current.AttachmentID != w.AttachmentID || current.WorkspaceID != target || !e.subscriptionReady(current) || !e.subscriptionReady(unmoved) {
		t.Fatalf("alias move harmed session/identity: session=%+v moved=%+v unmoved=%+v", session, current, unmoved)
	}
}

func TestSessionAttachInheritedScopeDoesNotRetargetExplicitSocket(t *testing.T) {
	e := sessionEngine(t)
	a, b := newSessionFixture(t, "a"), newSessionFixture(t, "b")
	original := attachFixture(t, e, a, "a")
	raw, _ := json.Marshal(Args{Socket: b.socket, HerdrName: "b"})
	out, err := e.Handle(context.Background(), model.Request{Version: 1, ID: newID("attach"), Op: "session.attach", Scope: model.Scope{SessionID: original.ID}, Caller: model.Caller{HerdrSocket: a.socket}, Args: raw})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(out)
	var attached model.Session
	json.Unmarshal(data, &attached)
	previous, _ := get[model.Session](context.Background(), e.store, "sessions", original.ID)
	if attached.ID == original.ID || previous.SocketPath != original.SocketPath {
		t.Fatalf("inherited scope retargeted caller session: original=%+v current=%+v attached=%+v", original, previous, attached)
	}
}
