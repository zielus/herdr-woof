package daemon

import (
	"context"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"testing"
)

func TestHumanReceiptEventsIdentifyHumanActor(t *testing.T) {
	e, _, _ := fixture(t)
	result, err := mailboxRequest(t, e, "send", "", "", Args{To: "human", Body: "human receipt audit"})
	if err != nil {
		t.Fatal(err)
	}
	message := result.(map[string]any)["message"].(model.Message)
	for _, op := range []string{"ack", "consume"} {
		before, err := e.store.Head(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := mailboxRequest(t, e, op, "", "", Args{ID: message.ID}); err != nil {
			t.Fatal(err)
		}
		events, err := e.store.Events(context.Background(), before, model.Scope{}, []string{"message." + op}, 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(events) != 1 || events[0].ActorKind != "human" || events[0].ActorID != "" {
			t.Fatalf("human %s event actor=%+v", op, events)
		}
	}
}
func TestWorkerReceiptEventsKeepWorkerActor(t *testing.T) {
	e, _, w := fixture(t)
	message, _ := seedReviewDelivery(t, e, w, "queued", "pending")
	before, err := e.store.Head(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := mailboxRequest(t, e, "ack", w.ID, "", Args{ID: message.ID}); err != nil {
		t.Fatal(err)
	}
	events, err := e.store.Events(context.Background(), before, model.Scope{}, []string{"message.ack"}, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].ActorKind != "worker" || events[0].ActorID != w.ID {
		t.Fatalf("worker actor=%+v", events)
	}
}
