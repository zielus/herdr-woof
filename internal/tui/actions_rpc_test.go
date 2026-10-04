package tui

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zielus/herdr-woof-v2/internal/client"
	"github.com/zielus/herdr-woof-v2/internal/daemon"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/paths"
	"github.com/zielus/herdr-woof-v2/internal/store"
)

func actionDaemon(t *testing.T) (*RPCBackend, *client.Client, model.Worker, *store.Store) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "woof-act-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	st, err := store.Open(filepath.Join(dir, "woof.db"))
	if err != nil {
		t.Fatal(err)
	}
	worker := model.Worker{ID: "worker_a", SessionID: "session_a", WorkspaceID: "workspace_a", WorktreeID: "tree_a", Name: "Builder", State: "offline", AttachmentID: "attachment_a"}
	_, err = st.Write(context.Background(), func(tx *store.Tx) error {
		records := []struct {
			kind, id string
			value    any
		}{
			{"sessions", "session_a", model.Session{ID: "session_a", SocketPath: "/tmp/nonexistent", Status: "offline"}},
			{"workspaces", "workspace_a", model.Workspace{ID: "workspace_a", SessionID: "session_a", Cwd: dir}},
			{"worktrees", "tree_a", model.Worktree{ID: "tree_a", SessionID: "session_a", WorkspaceID: "workspace_a", Path: dir}},
			{"runs", "run_a", model.Run{ID: "run_a", SessionID: "session_a", WorkspaceID: "workspace_a", WorktreeID: "tree_a", Status: "active"}},
			{"workspaces", "workspace_other", model.Workspace{ID: "workspace_other", SessionID: "session_a", Cwd: dir}},
			{"runs", "run_other", model.Run{ID: "run_other", SessionID: "session_a", WorkspaceID: "workspace_other", Status: "active"}},
			{"workers", worker.ID, worker},
		}
		for _, r := range records {
			if err := tx.Put(r.kind, r.id, r.value); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	p := paths.Paths{Sock: filepath.Join(dir, "daemon.sock")}
	listener, err := net.Listen("unix", p.Sock)
	if err != nil {
		t.Fatal(err)
	}
	engine := daemon.NewEngine(st, daemon.Options{})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- daemon.Serve(ctx, listener, engine) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
		engine.Close()
		if err := st.Close(); err != nil {
			t.Error(err)
		}
	})
	human := &client.Client{Paths: p, Caller: model.Caller{ProcessID: os.Getpid(), Cwd: dir}, Scope: model.Scope{Global: true}, ScopeExplicit: true}
	inherited := *human
	inherited.Caller.WorkerID = "worker_stale"
	inherited.Caller.AttachmentID = "attachment_stale"
	inherited.Caller.HerdrSocket = "/tmp/stale"
	inherited.Caller.PaneID = "w1:p1"
	inherited.Scope = model.Scope{WorkerID: "worker_stale"}
	return &RPCBackend{Base: &inherited}, human, worker, st
}
func readActionMessage(t *testing.T, c *client.Client, id string) MessageDetail {
	t.Helper()
	var detail MessageDetail
	if err := c.Call(context.Background(), "message.show", map[string]string{"id": id}, &detail); err != nil {
		t.Fatal(err)
	}
	return detail
}
func resultMessage(t *testing.T, r ActionResult) model.Message {
	t.Helper()
	var out struct {
		Message model.Message `json:"message"`
	}
	if err := json.Unmarshal(r.Value, &out); err != nil {
		t.Fatal(err)
	}
	if out.Message.ID == "" {
		t.Fatal("action returned no message")
	}
	return out.Message
}

func TestActionDaemonAskReplyReceiptsAndArtifacts(t *testing.T) {
	b, human, w, _ := actionDaemon(t)
	ctx := context.Background()
	result, err := b.Act(ctx, Action{Kind: "ask", To: "human", Scope: model.Scope{Global: true}, Body: "Approve?", Artifacts: []string{"report.md", "report.md"}})
	if err != nil {
		t.Fatal(err)
	}
	question := resultMessage(t, result)
	if question.Kind != "question" || question.FromKind != "human" || question.FromWorkerID != "" {
		t.Fatalf("actor or question wrong: %+v", question)
	}
	if len(question.Artifacts) != 1 || question.Artifacts[0].Path != filepath.Join(human.Caller.Cwd, "report.md") {
		t.Fatalf("artifacts: %+v", question.Artifacts)
	}
	detail := readActionMessage(t, human, question.ID)
	if len(detail.Deliveries) != 1 || detail.Deliveries[0].Status != "delivered" {
		t.Fatalf("read changed receipt %+v", detail.Deliveries)
	}
	entry := InboxEntry{Message: detail.Message, Delivery: detail.Deliveries[0]}
	ack, err := NewMessageAction("ack", entry)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = b.Act(ctx, ack); err != nil {
		t.Fatal(err)
	}
	detail = readActionMessage(t, human, question.ID)
	if detail.Deliveries[0].Status != "acknowledged" {
		t.Fatal("human ack not persisted")
	}
	consume := ack
	consume.Kind = "consume"
	if _, err = b.Act(ctx, consume); err != nil {
		t.Fatal(err)
	}
	if readActionMessage(t, human, question.ID).Deliveries[0].Status != "consumed" {
		t.Fatal("consume not persisted")
	}
	reply, err := NewMessageAction("reply", entry)
	if err != nil {
		t.Fatal(err)
	}
	reply.Body = "Approved"
	replyResult, err := b.Act(ctx, reply)
	if err != nil {
		t.Fatal(err)
	}
	if resultMessage(t, replyResult).ReplyToMessageID != question.ID {
		t.Fatal("reply lost question ID")
	}
	if _, err = b.Act(ctx, reply); err == nil {
		t.Fatal("duplicate reply accepted")
	}

	send, err := NewWorkerAction("send", w, model.Scope{})
	if err != nil {
		t.Fatal(err)
	}
	send.Body = "Worker mailbox"
	workerResult, err := b.Act(ctx, send)
	if err != nil {
		t.Fatal(err)
	}
	workerMessage := resultMessage(t, workerResult)
	if workerMessage.SessionID != "session_a" || workerMessage.WorktreeID != "tree_a" || workerMessage.ToID != w.ID {
		t.Fatalf("worker routing %+v", workerMessage)
	}
	if _, err = b.Act(ctx, Action{Kind: "ack", ID: workerMessage.ID, Scope: send.Scope}); err == nil {
		t.Fatal("human mutated worker mailbox")
	}
	if readActionMessage(t, human, workerMessage.ID).Deliveries[0].AcknowledgedAt != 0 {
		t.Fatal("worker receipt mutated")
	}
}

func TestActionDaemonRejectsScopeDriftAndValidatesGate(t *testing.T) {
	b, human, w, _ := actionDaemon(t)
	ctx := context.Background()
	action, err := NewWorkerAction("send", w, model.Scope{SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, RunID: "run_a"})
	if err != nil {
		t.Fatal(err)
	}
	action.Body = "Run message"
	if _, err = b.Act(ctx, action); err != nil {
		t.Fatal(err)
	}
	action.Scope.RunID = "run_other"
	if _, err = b.Act(ctx, action); err == nil {
		t.Fatal("accepted run from another workspace")
	}
	action.Scope.RunID = "run_a"
	action.Scope.WorktreeID = ""
	if _, err = b.Act(ctx, action); err == nil {
		t.Fatal("accepted target scope drift")
	}
	var gate model.Gate
	if err := human.Call(ctx, "gate.create", map[string]any{"question": "Ship?", "options": []string{"yes", "no"}}, &gate); err != nil {
		t.Fatal(err)
	}
	resolve, err := NewGateAction(gate)
	if err != nil {
		t.Fatal(err)
	}
	resolve.Decision = "maybe"
	if _, err = b.Act(ctx, resolve); err == nil {
		t.Fatal("accepted invalid decision")
	}
	resolve.Decision = "yes"
	if _, err = b.Act(ctx, resolve); err != nil {
		t.Fatal(err)
	}
	var got model.Gate
	if err := human.Call(ctx, "gate.show", map[string]string{"id": gate.ID}, &got); err != nil {
		t.Fatal(err)
	}
	if got.Status != "resolved" || got.Decision != "yes" {
		t.Fatalf("gate %+v", got)
	}
	if _, err = b.Act(ctx, resolve); err == nil {
		t.Fatal("allowed duplicate resolve")
	}
}

// Socket fault test adapted from herdr-orch internal/client/client_test.go
// (MIT, Copyright (c) 2026 Stephen Ellington). The real client sends once and
// exposes uncertainty when the response is lost or the daemon returns it.
func TestActionUncertaintyPreservesOperationAndNeverResends(t *testing.T) {
	for _, mode := range []string{"drop", "uncertain"} {
		t.Run(mode, func(t *testing.T) {
			dir, err := os.MkdirTemp("/tmp", "woof-fault-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := os.RemoveAll(dir); err != nil {
					t.Error(err)
				}
			})
			sock := filepath.Join(dir, "daemon.sock")
			ln, err := net.Listen("unix", sock)
			if err != nil {
				t.Fatal(err)
			}
			var count atomic.Int32
			requests := make(chan model.Request, 4)
			done := make(chan struct{})
			go func() {
				defer close(done)
				for {
					conn, err := ln.Accept()
					if err != nil {
						return
					}
					var req model.Request
					err = json.NewDecoder(bufio.NewReader(conn)).Decode(&req)
					if err == nil {
						count.Add(1)
						requests <- req
						if mode == "uncertain" {
							if err := json.NewEncoder(conn).Encode(model.Response{Version: model.Protocol, Error: &model.Error{Code: "uncertain", OperationID: req.ID, Message: "inspect receipt"}}); err != nil {
								t.Error(err)
							}
						}
					}
					if err := conn.Close(); err != nil {
						t.Error(err)
					}
				}
			}()
			t.Cleanup(func() {
				if err := ln.Close(); err != nil {
					t.Error(err)
				}
				<-done
			})
			b := RPCBackend{Base: &client.Client{Paths: paths.Paths{Sock: sock}, Caller: model.Caller{Cwd: dir}}}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			result, err := b.Act(ctx, Action{Kind: "ask", To: "human", Scope: model.Scope{Global: true}, Body: "Question?"})
			var problem *model.Error
			if !errors.As(err, &problem) || !result.Uncertain || result.OperationID == "" || result.OperationID != problem.OperationID {
				t.Fatalf("uncertainty lost: %+v %v", result, err)
			}
			req := <-requests
			if req.ID != result.OperationID || req.Op != "ask" || count.Load() != 1 {
				t.Fatalf("resubmitted or changed operation: %+v count %d", req, count.Load())
			}
			var args map[string]any
			if err := json.Unmarshal(req.Args, &args); err != nil {
				t.Fatal(err)
			}
			if args["body"] != "Question?" || args["question"] != nil || args["timeout_ms"] != nil {
				t.Fatalf("ask body/no-wait contract: %+v", args)
			}
		})
	}
}

func TestInvalidActionsFailBeforeSocketMutation(t *testing.T) {
	b := RPCBackend{Base: &client.Client{Caller: model.Caller{Cwd: "/tmp"}}}
	for _, a := range []Action{
		{Kind: "send", To: "worker-name:ambiguous", Body: "body"},
		{Kind: "send", To: "human", Body: " "},
		{Kind: "reply", ID: "bad id", Body: "body"},
		{Kind: "consume", ID: "msg_a", Scope: model.Scope{WorkerID: "worker_a"}},
		{Kind: "gate.resolve", ID: "gate_a", Decision: "bad", Options: []string{"yes", "no"}},
		{Kind: "send", To: "human", Body: "body", Artifacts: []string{"bad\x00path"}},
	} {
		if result, err := b.Act(context.Background(), a); err == nil || result.Uncertain {
			t.Fatalf("invalid action sent: %+v %+v %v", a, result, err)
		}
	}
}

func TestActionRechecksStaleHumanReceiptBeforeMutation(t *testing.T) {
	b, human, w, st := actionDaemon(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result, err := b.Act(ctx, Action{Kind: "ask", To: "human", Scope: model.Scope{Global: true}, Body: "Approve?"})
	if err != nil {
		t.Fatal(err)
	}
	question := resultMessage(t, result)
	detail := readActionMessage(t, human, question.ID)
	entry := InboxEntry{Message: detail.Message, Delivery: detail.Deliveries[0]}
	actions := make([]Action, 0, 3)
	for _, kind := range []string{"reply", "ack", "consume"} {
		action, err := NewMessageAction(kind, entry)
		if err != nil {
			t.Fatal(err)
		}
		action.Body = "Approved"
		actions = append(actions, action)
	}
	// Model a stale snapshot at the durable read boundary. Production receipt
	// ownership is immutable; the fixture verifies that the client never trusts
	// the previously reviewed ownership if the canonical read disagrees.
	receipt := detail.Deliveries[0]
	receipt.Human = false
	receipt.WorkerID = w.ID
	_, err = st.Write(ctx, func(tx *store.Tx) error { return tx.Put("deliveries", receipt.ID, receipt) })
	if err != nil {
		t.Fatal(err)
	}
	var before []model.Operation
	if err := human.Call(ctx, "operation.list", nil, &before); err != nil {
		t.Fatal(err)
	}
	for _, action := range actions {
		if _, err := b.Act(ctx, action); err == nil {
			t.Fatalf("%s trusted stale human ownership", action.Kind)
		}
	}
	var after []model.Operation
	if err := human.Call(ctx, "operation.list", nil, &after); err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatal("stale receipt reached the mutation endpoint")
	}
	current := readActionMessage(t, human, question.ID)
	if current.Message.Status == "replied" || current.Deliveries[0].AcknowledgedAt != 0 || current.Deliveries[0].ConsumedAt != 0 {
		t.Fatal("stale action changed receipt state")
	}
}

func TestActionPreservesSessionWideRunForReusableWorker(t *testing.T) {
	b, human, w, _ := actionDaemon(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c := *human
	c.Scope = model.Scope{SessionID: w.SessionID}
	var run model.Run
	if err := c.Call(ctx, "run.create", map[string]string{"title": "Session-wide run"}, &run); err != nil {
		t.Fatal(err)
	}
	if run.WorkspaceID != "" || w.RunID != "" {
		t.Fatal("fixture must use session-wide run and reusable worker")
	}
	action, err := NewWorkerAction("send", w, model.Scope{SessionID: run.SessionID, RunID: run.ID})
	if err != nil {
		t.Fatal(err)
	}
	action.Body = "Session-wide selected run"
	result, err := b.Act(ctx, action)
	if err != nil {
		t.Fatal(err)
	}
	message := resultMessage(t, result)
	if message.RunID != run.ID {
		t.Fatalf("persisted run %q, want selected %q", message.RunID, run.ID)
	}
}

func TestActionPersistsTheCanonicalArtifactReferencesReviewed(t *testing.T) {
	b, human, _, _ := actionDaemon(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	f := NewForm(Action{Kind: "send", To: "human", Scope: model.Scope{Global: true}, Body: "References", Artifacts: []string{"report.md", "./report.md"}})
	reviewed, err := f.Review()
	if err != nil {
		t.Fatal(err)
	}
	result, err := b.Act(ctx, reviewed)
	if err != nil {
		t.Fatal(err)
	}
	message := resultMessage(t, result)
	if len(message.Artifacts) != len(reviewed.Artifacts) {
		t.Fatalf("confirmed %q but persisted %+v", reviewed.Artifacts, message.Artifacts)
	}
	for i, artifact := range message.Artifacts {
		if artifact.Path != reviewed.Artifacts[i] {
			t.Fatalf("confirmed %q persisted %q", reviewed.Artifacts[i], artifact.Path)
		}
	}
	if len(message.Artifacts) != 1 || !filepath.IsAbs(message.Artifacts[0].Path) || message.Artifacts[0].Path == filepath.Join(human.Caller.Cwd, "report.md") {
		t.Fatalf("confirmation used backend cwd instead of form cwd: %+v", message.Artifacts)
	}
}

func TestActionRejectsReplyWhenCanonicalSenderDiffersFromReview(t *testing.T) {
	b, human, w, st := actionDaemon(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result, err := b.Act(ctx, Action{Kind: "ask", To: "human", Scope: model.Scope{Global: true}, Body: "Approve?"})
	if err != nil {
		t.Fatal(err)
	}
	q := resultMessage(t, result)
	detail := readActionMessage(t, human, q.ID)
	action, err := NewMessageAction("reply", InboxEntry{Message: detail.Message, Delivery: detail.Deliveries[0]})
	if err != nil {
		t.Fatal(err)
	}
	action.Body = "Approved"
	q.FromKind = "worker"
	q.FromWorkerID = w.ID
	_, err = st.Write(ctx, func(tx *store.Tx) error { return tx.Put("messages", q.ID, q) })
	if err != nil {
		t.Fatal(err)
	}
	var before []model.Operation
	if err := human.Call(ctx, "operation.list", nil, &before); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Act(ctx, action); err == nil {
		t.Fatal("submitted reply to a recipient different from the confirmed target")
	}
	var after []model.Operation
	if err := human.Call(ctx, "operation.list", nil, &after); err != nil {
		t.Fatal(err)
	}
	if len(before) != len(after) {
		t.Fatal("stale reply target reached mutation endpoint")
	}
}
