package daemon

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/zielus/herdr-woof/internal/model"
	"github.com/zielus/herdr-woof/internal/store"
)

// Extends herdr-orch's PlanEvents cursor tests (MIT) to Woof's sparse global
// sequence and bounded snapshot boundary; no per-session database assumption.
func TestEventTailSparseScopeAndBounds(t *testing.T) {
	e := eventsEngine(t)
	ctx := context.Background()
	err := e.write(ctx, func(tx *store.Tx) error {
		if err := tx.Put("sessions", "s_a", model.Session{ID: "s_a"}); err != nil {
			return err
		}
		for i := 1; i <= 1004; i++ {
			scope := model.Scope{SessionID: "s_other"}
			if i%2 == 1 {
				scope.SessionID = "s_a"
			}
			typ := "worker.observed"
			if i == 1003 {
				typ = "dispatch.settled"
			}
			if err := tx.Event(typ, scope, "human", "", nil); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		limit       int
		types       []string
		count       int
		first, last int64
	}{
		{0, nil, 500, 5, 1003}, {900, nil, 500, 5, 1003}, {2, nil, 2, 1001, 1003},
		{2, []string{"dispatch.settled"}, 1, 1003, 1003},
	} {
		args, _ := json.Marshal(Args{Limit: tc.limit, Events: tc.types})
		out, err := e.Handle(ctx, model.Request{Version: model.Protocol, Op: "events.tail", Scope: model.Scope{SessionID: "s_a"}, ScopeExplicit: true, Args: args})
		if err != nil {
			t.Fatalf("tail read requires no mutation ID: %v", err)
		}
		raw, err := json.Marshal(out)
		if err != nil {
			t.Fatal(err)
		}
		var tail struct {
			Events []model.Event `json:"events"`
			Cursor int64         `json:"event_cursor"`
		}
		if err := json.Unmarshal(raw, &tail); err != nil {
			t.Fatal(err)
		}
		if tail.Cursor != 1004 || len(tail.Events) != tc.count || tail.Events[0].Seq != tc.first || tail.Events[len(tail.Events)-1].Seq != tc.last {
			t.Fatalf("limit %d: cursor=%d count=%d events=%v", tc.limit, tail.Cursor, len(tail.Events), tail.Events)
		}
		for i := 1; i < len(tail.Events); i++ {
			if tail.Events[i-1].Seq >= tail.Events[i].Seq {
				t.Fatal("tail is not ascending")
			}
		}
	}
	out, err := e.Handle(ctx, model.Request{Version: model.Protocol, Op: "events.tail", Scope: model.Scope{SessionID: "s_a"}, ScopeExplicit: true, Args: json.RawMessage(`{"events":["missing"]}`)})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(out)
	var tail struct {
		Events []model.Event `json:"events"`
		Cursor int64         `json:"event_cursor"`
	}
	if err := json.Unmarshal(raw, &tail); err != nil {
		t.Fatal(err)
	}
	if len(tail.Events) != 0 || tail.Cursor != 1004 {
		t.Fatalf("empty scope loses global head: %s", raw)
	}
	var receipts []model.Operation
	if err := e.store.List(ctx, "operations", model.Scope{}, &receipts); err != nil {
		t.Fatal(err)
	}
	if len(receipts) != 0 {
		t.Fatal("read created mutation receipts")
	}
}
