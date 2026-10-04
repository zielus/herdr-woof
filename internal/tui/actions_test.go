package tui

import (
	"github.com/zielus/herdr-woof/internal/model"
	"testing"
)

func TestWorkerActionFreezesActualTargetScope(t *testing.T) {
	w := model.Worker{ID: "worker_a", Name: "Builder", SessionID: "session_a", WorkspaceID: "workspace_a", WorktreeID: "tree_a", RunID: "run_a"}
	for _, tc := range []struct {
		name   string
		browse model.Scope
		run    string
	}{
		{"global", model.Scope{Global: true}, ""},
		{"compatible", model.Scope{SessionID: "session_a", WorkspaceID: "workspace_a", WorktreeID: "tree_a", RunID: "run_a"}, "run_a"},
		{"other run", model.Scope{RunID: "run_b"}, ""},
		{"other workspace", model.Scope{WorkspaceID: "workspace_b", RunID: "run_a"}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, err := NewWorkerAction("ask", w, tc.browse)
			if err != nil {
				t.Fatal(err)
			}
			want := model.Scope{SessionID: "session_a", WorkspaceID: "workspace_a", WorktreeID: "tree_a", RunID: tc.run}
			if a.To != "worker:worker_a" || a.Scope != want {
				t.Fatalf("target/scope = %+v", a)
			}
		})
	}
	w.RunID = ""
	a, err := NewWorkerAction("send", w, model.Scope{SessionID: "session_a", WorkspaceID: "workspace_a", RunID: "run_shared"})
	if err != nil || a.Scope.RunID != "run_shared" {
		t.Fatalf("shared run scope lost: %+v %v", a, err)
	}
	if _, err := NewWorkerAction("stop", w, model.Scope{}); err == nil {
		t.Fatal("allowed lifecycle mutation")
	}
}

func TestMessageActionsRequireHumanOwnedReceipt(t *testing.T) {
	m := model.Message{ID: "msg_a", ToKind: "human", ToID: "human", Kind: "question", SessionID: "session_a", WorkspaceID: "workspace_a", WorktreeID: "tree_a", RunID: "run_a"}
	good := InboxEntry{Message: m, Delivery: model.Delivery{ID: "delivery_a", MessageID: m.ID, Human: true}}
	for _, kind := range []string{"ack", "consume", "reply"} {
		a, err := NewMessageAction(kind, good)
		if err != nil {
			t.Fatal(err)
		}
		if a.ID != m.ID || a.Scope != (model.Scope{SessionID: "session_a", WorkspaceID: "workspace_a", WorktreeID: "tree_a", RunID: "run_a"}) {
			t.Fatalf("scope changed: %+v", a)
		}
		for _, bad := range []model.Delivery{{ID: "delivery_a", MessageID: m.ID, WorkerID: "worker_a"}, {ID: "delivery_a", MessageID: "other", Human: true}, {ID: "delivery_a", MessageID: m.ID, Human: true, WorkerID: "worker_a"}} {
			entry := good
			entry.Delivery = bad
			if _, err := NewMessageAction(kind, entry); err == nil {
				t.Fatalf("%s allowed another owner's receipt %+v", kind, bad)
			}
		}
	}
	for _, change := range []func(*model.Message){func(m *model.Message) { m.Kind = "message" }, func(m *model.Message) { m.Status = "replied" }, func(m *model.Message) { m.ToKind = "worker" }} {
		bad := good
		change(&bad.Message)
		if _, err := NewMessageAction("reply", bad); err == nil {
			t.Fatal("allowed invalid reply")
		}
	}
}

func TestGateActionFreezesOptionsAndRejectsResolvedGate(t *testing.T) {
	gate := model.Gate{ID: "gate_a", SessionID: "session_a", WorkspaceID: "workspace_a", RunID: "run_a", Status: "open", Question: "Approve?", Options: []string{"yes", "no"}}
	a, err := NewGateAction(gate)
	if err != nil {
		t.Fatal(err)
	}
	gate.Options[0] = "changed"
	if a.Kind != "gate.resolve" || a.ID != "gate_a" || a.Options[0] != "yes" || a.Scope.RunID != "run_a" {
		t.Fatalf("gate changed: %+v", a)
	}
	gate.Status = "resolved"
	if _, err := NewGateAction(gate); err == nil {
		t.Fatal("allowed resolved gate")
	}
}

func TestMessageActionFreezesActualReviewRecipient(t *testing.T) {
	entry := InboxEntry{Message: model.Message{ID: "msg_a", Kind: "question", ToKind: "human", ToID: "human", FromKind: "worker", FromWorkerID: "worker_sender"}, Delivery: model.Delivery{ID: "delivery_a", MessageID: "msg_a", Human: true}}
	for _, kind := range []string{"reply", "ack", "consume"} {
		a, err := NewMessageAction(kind, entry)
		if err != nil {
			t.Fatal(err)
		}
		want := "human"
		if kind == "reply" {
			want = "worker:worker_sender"
		}
		if a.To != want {
			t.Fatalf("%s review target %q, want %q", kind, a.To, want)
		}
	}
	entry.Message.FromWorkerID = ""
	reply, err := NewMessageAction("reply", entry)
	if err != nil {
		t.Fatal(err)
	}
	if reply.To != "human" {
		t.Fatalf("human sender review target %q", reply.To)
	}
}
