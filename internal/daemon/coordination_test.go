package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/zielus/herdr-woof/internal/herdr"
	"github.com/zielus/herdr-woof/internal/model"
	"github.com/zielus/herdr-woof/internal/store"
)

// Donor cases: Orch report-before-idle, idle-before-report and durable mailbox.
// Woof strengthens them with attachment/sequence evidence and non-consuming reads.
type fakeAgent struct {
	mu           sync.Mutex
	p            herdr.Pane
	prompts      []string
	uncertain    bool
	beforePrompt func()
	beforeRead   func()
}

func fixture(t *testing.T) (*Engine, *fakeAgent, model.Worker) {
	t.Helper()
	ctx := context.Background()
	dir, err := os.MkdirTemp("/tmp", "woof-coord-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { checkCleanup(t, os.RemoveAll(dir)) })
	st, err := store.Open(filepath.Join(dir, "woof.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { checkCleanup(t, st.Close()) })
	e := NewEngine(st, Options{})
	t.Cleanup(e.Close)
	kind, name, cwd, ready := "claude", "woof-worker", "/tmp", true
	seq := uint64(2)
	native := &model.NativeSession{Source: "hook", Agent: "claude", Kind: "session", Value: "test-session"}
	f := &fakeAgent{p: herdr.Pane{PaneID: "w1:p1", WorkspaceID: "w1", TerminalID: "terminal-1", Agent: &kind, Name: &name, Cwd: &cwd, InteractiveReady: &ready, AgentStatus: "idle", StateChangeSeq: 2, CompletionSeq: &seq, AgentSession: native}}
	sock := filepath.Join(dir, "h.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { checkCleanup(t, ln.Close()) })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = c.Close() }() // The peer may already have disconnected; cleanup is best effort.
				line, err := bufio.NewReader(c).ReadBytes('\n')
				if err != nil {
					return // Recovery may disconnect a client before sending a request.
				}
				var req struct {
					Method string `json:"method"`
					Params struct {
						Text string `json:"text"`
					} `json:"params"`
				}
				if err := json.Unmarshal(line, &req); err != nil {
					t.Error(err)
					return
				}
				f.mu.Lock()
				defer f.mu.Unlock()
				var result any
				switch req.Method {
				case "agent.get", "pane.get":
					result = map[string]any{"agent": f.p, "pane": f.p}
				case "agent.read":
					if f.beforeRead != nil {
						f.beforeRead()
					}
					result = map[string]any{"read": map[string]any{"text": "────────────────────\n❯ \n────────────────────\n"}}
				case "agent.prompt":
					if f.beforePrompt != nil {
						f.beforePrompt()
					}
					f.prompts = append(f.prompts, req.Params.Text)
					if f.uncertain {
						return
					}
					result = map[string]bool{"accepted": true}
				case "notification.show":
					result = map[string]bool{"shown": true}
				default:
					result = map[string]any{}
				}
				// A disconnected client needs no retry of its fixture response.
				if err := json.NewEncoder(c).Encode(map[string]any{"result": result}); err != nil {
					return
				}
			}()
		}
	}()
	w := model.Worker{ID: "worker_a", SessionID: "s_a", WorkspaceID: "ws_a", Name: "alice", AgentKind: kind, AgentName: name, NativeSession: native, TerminalID: f.p.TerminalID, PaneID: f.p.PaneID, AttachmentID: "att_a", State: "idle", RawStatus: "idle", StateSeq: 2, CompletionSeq: &seq, Ready: true, CreatedAt: e.now()}
	_, err = st.Write(ctx, func(tx *store.Tx) error {
		if err := tx.Put("sessions", "s_a", model.Session{ID: "s_a", SocketPath: sock, HerdrName: "fake", Status: "online"}); err != nil {
			return err
		}
		if err := tx.Put("workspaces", "ws_a", model.Workspace{ID: "ws_a", SessionID: "s_a", HerdrWorkspaceID: "w1"}); err != nil {
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
func call(t *testing.T, e *Engine, op string, a Args) (any, error) {
	t.Helper()
	b, _ := json.Marshal(a)
	return e.Handle(context.Background(), model.Request{Version: model.Protocol, ID: newID("op"), Op: op, Scope: model.Scope{Global: true}, Args: b, Caller: model.Caller{Cwd: "/tmp"}})
}
func mustDispatch(t *testing.T, e *Engine, w model.Worker) model.Dispatch {
	t.Helper()
	v, err := call(t, e, "dispatch", Args{ID: w.ID, Spec: "small task"})
	if err != nil {
		t.Fatal(err)
	}
	return v.(model.Dispatch)
}
func setObservation(t *testing.T, e *Engine, f *fakeAgent, w model.Worker, status string, seq uint64, completed *uint64) {
	t.Helper()
	f.mu.Lock()
	f.p.AgentStatus = status
	f.p.StateChangeSeq = seq
	f.p.CompletionSeq = completed
	p := f.p
	f.mu.Unlock()
	current, err := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = e.observeWorker(context.Background(), current, p, false); err != nil {
		t.Fatal(err)
	}
}
func TestReportNeedsMatchingTurnEnd(t *testing.T) {
	e, f, w := fixture(t)
	d := mustDispatch(t, e, w)
	_, err := call(t, e, "done", Args{Dispatch: d.ID, Attachment: w.AttachmentID, Body: "completed"})
	if err != nil {
		t.Fatal(err)
	}
	setObservation(t, e, f, w, "idle", 2, w.CompletionSeq)
	got, _ := get[model.Dispatch](context.Background(), e.store, "dispatches", d.ID)
	if got.Status == "settled" {
		t.Fatal("stale idle settled")
	}
	setObservation(t, e, f, w, "working", 3, w.CompletionSeq)
	seq := uint64(4)
	setObservation(t, e, f, w, "unknown", 4, &seq)
	got, _ = get[model.Dispatch](context.Background(), e.store, "dispatches", d.ID)
	if got.Status == "settled" {
		t.Fatal("unknown settled")
	}
	setObservation(t, e, f, w, "idle", 4, &seq)
	got, _ = get[model.Dispatch](context.Background(), e.store, "dispatches", d.ID)
	if got.Status != "settled" || got.Outcome != "done" {
		t.Fatalf("not settled %+v", got)
	}
}
func TestTurnEndBeforeReportAndAtomicAssociation(t *testing.T) {
	e, f, w := fixture(t)
	d := mustDispatch(t, e, w)
	setObservation(t, e, f, w, "working", 3, w.CompletionSeq)
	seq := uint64(4)
	setObservation(t, e, f, w, "idle", 4, &seq)
	got, _ := get[model.Dispatch](context.Background(), e.store, "dispatches", d.ID)
	if got.Status == "settled" {
		t.Fatal("idle alone settled")
	}
	v, err := call(t, e, "done", Args{Dispatch: d.ID, Attachment: w.AttachmentID})
	if err != nil {
		t.Fatal(err)
	}
	got = v.(model.Dispatch)
	if got.Status != "settled" {
		t.Fatalf("report did not settle %+v", got)
	}
	m, err := get[model.Message](context.Background(), e.store, "messages", got.DoneMessageID)
	if err != nil || m.DispatchID != d.ID {
		t.Fatalf("report association %+v %v", m, err)
	}
}
func TestResetAndReplacedIncarnationCannotSettle(t *testing.T) {
	e, f, w := fixture(t)
	d := mustDispatch(t, e, w)
	setObservation(t, e, f, w, "working", 3, w.CompletionSeq)
	zero := uint64(0)
	setObservation(t, e, f, w, "idle", 0, &zero)
	_, err := call(t, e, "done", Args{Dispatch: d.ID, Attachment: w.AttachmentID})
	if err == nil {
		t.Fatal("old attachment accepted after reset")
	}
	seq := uint64(4)
	setObservation(t, e, f, w, "idle", 4, &seq)
	got, _ := get[model.Dispatch](context.Background(), e.store, "dispatches", d.ID)
	if got.Status == "settled" {
		t.Fatal("reset baseline settled")
	}
}
func TestUncertainPromptIsDurableAndNeverResent(t *testing.T) {
	e, f, w := fixture(t)
	f.mu.Lock()
	f.uncertain = true
	f.mu.Unlock()
	v, err := call(t, e, "dispatch", Args{ID: w.ID, Spec: "task"})
	if !isUncertain(err) {
		t.Fatalf("want uncertain got %v", err)
	}
	d := v.(model.Dispatch)
	if d.Status != "uncertain" {
		t.Fatal(d.Status)
	}
	e.processInbox(w.ID)
	_, _ = call(t, e, "dispatch", Args{ID: w.ID, Spec: "task again"})
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.prompts) != 1 {
		t.Fatalf("resent uncertain prompt: %d", len(f.prompts))
	}
}
func TestInboxPersistenceArtifactsAndBusyEventDelivery(t *testing.T) {
	e, f, w := fixture(t)
	f.mu.Lock()
	f.p.AgentStatus = "working"
	f.p.StateChangeSeq = 3
	f.beforePrompt = func() {
		ms, _ := list[model.Message](context.Background(), e.store, "messages", model.Scope{})
		if len(ms) != 1 {
			t.Errorf("prompt before persistence: %d", len(ms))
		}
	}
	f.mu.Unlock()
	path := filepath.Join(t.TempDir(), "handoff.txt")
	if err := os.WriteFile(path, []byte("large private context"), 0600); err != nil {
		t.Fatal(err)
	}
	v, err := call(t, e, "send", Args{To: w.ID, Body: "please inspect", Artifacts: []string{path}})
	if err != nil {
		t.Fatal(err)
	}
	m := v.(map[string]any)["message"].(model.Message)
	e.processInbox(w.ID)
	f.mu.Lock()
	if len(f.prompts) != 0 {
		t.Fatal("prompted busy")
	}
	f.mu.Unlock()
	seq := uint64(4)
	setObservation(t, e, f, w, "idle", 4, &seq)
	deadline := time.Now().Add(time.Second)
	for {
		f.mu.Lock()
		n := len(f.prompts)
		text := ""
		if n > 0 {
			text = f.prompts[0]
		}
		f.mu.Unlock()
		if n > 0 {
			if !contains(text, m.ID) || !contains(text, path) || contains(text, "large private context") {
				t.Fatalf("bad notice %q", text)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("event did not deliver queued message")
		}
		time.Sleep(time.Millisecond * 5)
	}
	before, _ := e.inbox(context.Background(), model.Request{Scope: model.Scope{WorkerID: w.ID}}, Args{ID: w.ID})
	after, _ := e.inbox(context.Background(), model.Request{Scope: model.Scope{WorkerID: w.ID}}, Args{ID: w.ID})
	a, _ := json.Marshal(before)
	b, _ := json.Marshal(after)
	if string(a) != string(b) {
		t.Fatal("inbox consumed on read")
	}
}
func contains(a, b string) bool {
	for i := 0; i+len(b) <= len(a); i++ {
		if a[i:i+len(b)] == b {
			return true
		}
	}
	return false
}
func TestWatchdogEscalationDedupSurvivesInboxWakes(t *testing.T) {
	e, f, w := fixture(t)
	d := mustDispatch(t, e, w)
	seq := uint64(4)
	setObservation(t, e, f, w, "idle", 4, &seq)
	_ = e.write(context.Background(), func(tx *store.Tx) error {
		current, err := txGet[model.Dispatch](tx, "dispatches", d.ID)
		if err != nil {
			return err
		}
		current.IdleAt = time.Now().Add(-5 * time.Minute).UnixMilli()
		return tx.Put("dispatches", d.ID, current)
	})
	for i := 0; i < 3; i++ {
		if err := e.watchdogOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	ms, _ := list[model.Message](context.Background(), e.store, "messages", model.Scope{})
	if len(ms) != 1 {
		t.Fatalf("duplicate escalation %d", len(ms))
	}
	got, _ := get[model.Dispatch](context.Background(), e.store, "dispatches", d.ID)
	if got.Status == "failed" {
		t.Fatal("silence auto failed")
	}
}

func TestAskReplyPersistsAcrossEngineRestart(t *testing.T) {
	e, _, w := fixture(t)
	e.runtimeMu.Lock()
	e.sessions[w.SessionID].ready[w.ID] = false
	e.runtimeMu.Unlock()
	v, err := call(t, e, "ask", Args{To: "human", Body: "Approve?"})
	if err != nil {
		t.Fatal(err)
	}
	q := v.(map[string]any)["message"].(model.Message)
	restarted := NewEngine(e.store, Options{})
	defer restarted.Close()
	b, _ := json.Marshal(Args{ID: q.ID, Body: "Approved"})
	reply, err := restarted.Handle(context.Background(), model.Request{Version: model.Protocol, ID: newID("op"), Op: "reply", Scope: model.Scope{Global: true}, Args: b})
	if err != nil {
		t.Fatal(err)
	}
	wait, err := restarted.questionWait(context.Background(), model.Request{}, Args{ID: q.ID, Timeout: 100})
	if err != nil {
		t.Fatal(err)
	}
	want := reply.(map[string]any)["message"].(model.Message)
	if wait.(model.Message).ID != want.ID {
		t.Fatal("reply missing after restart")
	}
}
func TestAdhocBroadcastSnapshotsReceipts(t *testing.T) {
	e, _, w := fixture(t)
	d := mustDispatch(t, e, w)
	e.runtimeMu.Lock()
	e.sessions[w.SessionID].ready[w.ID] = false
	e.runtimeMu.Unlock()
	v, err := call(t, e, "send", Args{To: "run:" + d.RunID, Body: "run notice"})
	if err != nil {
		t.Fatal(err)
	}
	ds := v.(map[string]any)["deliveries"].([]model.Delivery)
	if len(ds) != 1 || ds[0].WorkerID != w.ID {
		t.Fatalf("adhoc membership lost %+v", ds)
	}
	current, _ := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	if current.RunID != "" {
		t.Fatal("adhoc dispatch permanently bound reusable worker")
	}
}
func TestAckDoesNotReleasePromptLaneWithoutTurnEnd(t *testing.T) {
	e, f, w := fixture(t)
	v, err := call(t, e, "send", Args{To: w.ID, Body: "first"})
	if err != nil {
		t.Fatal(err)
	}
	e.processInbox(w.ID)
	m := v.(map[string]any)["message"].(model.Message)
	b, _ := json.Marshal(Args{ID: m.ID})
	_, err = e.Handle(context.Background(), model.Request{Version: model.Protocol, ID: newID("op"), Op: "ack", Scope: model.Scope{WorkerID: w.ID}, Caller: model.Caller{WorkerID: w.ID, AttachmentID: w.AttachmentID}, Args: b})
	if err != nil {
		t.Fatal(err)
	}
	_, err = call(t, e, "send", Args{To: w.ID, Body: "second"})
	if err != nil {
		t.Fatal(err)
	}
	e.processInbox(w.ID)
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.prompts) != 1 {
		t.Fatalf("ack unlocked lane %d", len(f.prompts))
	}
}
func TestAliasesFailAmbiguityAndExplicitWorkerRemainsAddressable(t *testing.T) {
	e, _, w := fixture(t)
	ctx := context.Background()
	other := w
	other.ID = "worker_b"
	other.WorkspaceID = "ws_b"
	other.PaneID = "w2:p1"
	_, err := e.store.Write(ctx, func(tx *store.Tx) error {
		if err := tx.Put("workspaces", "ws_b", model.Workspace{ID: "ws_b", SessionID: w.SessionID, HerdrWorkspaceID: "w2"}); err != nil {
			return err
		}
		return tx.Put("workers", other.ID, other)
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.resolveWorker(ctx, "worker-name:alice", model.Scope{SessionID: w.SessionID})
	if err == nil {
		t.Fatal("ambiguous alias guessed")
	}
	v, err := e.resolveWorker(ctx, "worker:"+w.ID, model.Scope{WorkspaceID: "ws_b"})
	if err != nil || v.ID != w.ID {
		t.Fatalf("explicit ID not addressable %+v %v", v, err)
	}
}
