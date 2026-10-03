package daemon

import (
	"context"
	"encoding/json"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/store"
	"path/filepath"
	"reflect"
	"testing"
)

func TestOperationReceiptRejectsChangedPayloadAndSurvivesRestart(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "woof.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { checkCleanup(t, st.Close()) }()
	e := NewEngine(st, Options{})
	req := model.Request{Version: model.Protocol, ID: "op_test", Op: "gate.create", Scope: model.Scope{Global: true}, Args: json.RawMessage(`{"question":"Ship?","options":["yes","no"]}`)}
	first, err := e.Handle(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewEngine(st, Options{}).Handle(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := json.Marshal(first)
	b, _ := json.Marshal(second)
	var aa, bb any
	if err := json.Unmarshal(a, &aa); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &bb); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(aa, bb) {
		t.Fatalf("receipt result changed %s %s", a, b)
	}
	var gates []model.Gate
	if err := st.List(ctx, "gates", model.Scope{}, &gates); err != nil {
		t.Fatal(err)
	}
	if len(gates) != 1 {
		t.Fatalf("duplicated %d gates", len(gates))
	}
	req.Args = json.RawMessage(`{"question":"Different?"}`)
	_, err = e.Handle(ctx, req)
	if err == nil {
		t.Fatal("changed payload accepted")
	}
}

func TestExplicitScopeOverridesCallerButInvalidRelationshipsFail(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "woof.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { checkCleanup(t, st.Close()) }()
	e := NewEngine(st, Options{})
	_, err = st.Write(ctx, func(tx *store.Tx) error {
		for _, s := range []model.Session{{ID: "s_a", HerdrName: "a", SocketPath: "/tmp/a", Status: "offline"}, {ID: "s_b", HerdrName: "b", SocketPath: "/tmp/b", Status: "offline"}} {
			if err := tx.Put("sessions", s.ID, s); err != nil {
				return err
			}
		}
		return tx.Put("workspaces", "ws_a", model.Workspace{ID: "ws_a", SessionID: "s_a", HerdrWorkspaceID: "w1"})
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := e.normalizeScope(ctx, model.Request{Scope: model.Scope{SessionID: "s_b"}, Caller: model.Caller{HerdrSocket: "/tmp/a"}})
	if err != nil || got.SessionID != "s_b" {
		t.Fatalf("scope %+v %v", got, err)
	}
	_, err = e.normalizeScope(ctx, model.Request{Scope: model.Scope{SessionID: "s_b", WorkspaceID: "ws_a"}})
	if err == nil {
		t.Fatal("cross-session relationship accepted")
	}
}
