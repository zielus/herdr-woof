package daemon

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/zielus/herdr-woof-v2/internal/herdr"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/store"
)

func seedReviewDelivery(t *testing.T, e *Engine, w model.Worker, wake, status string) (model.Message, model.Delivery) {
	t.Helper()
	seq := uint64(2)
	m := model.Message{ID: newID("msg"), ToKind: "worker", ToID: w.ID, Body: "durable message", Kind: "message", Status: "persisted", SessionID: w.SessionID, WorkspaceID: w.WorkspaceID}
	d := model.Delivery{ID: newID("delivery"), MessageID: m.ID, WorkerID: w.ID, SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, Status: status, WakeStatus: wake, AttachmentID: w.AttachmentID, BaselineSeq: 2, BaselineCompletionSeq: &seq, AttemptID: newID("wake")}
	if status == "consumed" {
		d.ConsumedAt = 100
		d.AcknowledgedAt = 90
	}
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		if err := tx.Put("messages", m.ID, m); err != nil {
			return err
		}
		if err := tx.Put("deliveries", d.ID, d); err != nil {
			return err
		}
		return tx.Put("operations", d.AttemptID, model.Operation{ID: d.AttemptID, Op: "inbox.prompt", State: "accepted", ResourceKind: "deliveries", ResourceID: d.ID})
	}); err != nil {
		t.Fatal(err)
	}
	return m, d
}

func mailboxRequest(t *testing.T, e *Engine, op string, caller, scopeWorker string, a Args) (any, error) {
	t.Helper()
	raw, _ := json.Marshal(a)
	identity := model.Caller{WorkerID: caller}
	if caller != "" {
		w, err := get[model.Worker](context.Background(), e.store, "workers", caller)
		if err != nil {
			t.Fatal(err)
		}
		identity.AttachmentID = w.AttachmentID
	}
	return e.Handle(context.Background(), model.Request{Version: model.Protocol, ID: newID("op"), Op: op, Scope: model.Scope{WorkerID: scopeWorker}, Caller: identity, Args: raw})
}

func TestMailboxTurnEndUsesObservedWorkingWithoutCompletionCounters(t *testing.T) {
	e, f, w := fixture(t)
	_, d := seedReviewDelivery(t, e, w, "uncertain", "pending")
	setObservation(t, e, f, w, "idle", 4, nil)
	got, _ := get[model.Delivery](context.Background(), e.store, "deliveries", d.ID)
	if got.WakeStatus != "uncertain" {
		t.Fatal("idle alone ended uncertain wake")
	}
	setObservation(t, e, f, w, "working", 5, nil)
	setObservation(t, e, f, w, "idle", 7, nil)
	got, _ = get[model.Delivery](context.Background(), e.store, "deliveries", d.ID)
	if got.WakeStatus != "ended" || got.WorkingSeq != 5 {
		t.Fatalf("matching turn remained reserved: %+v", got)
	}
	op, _ := get[model.Operation](context.Background(), e.store, "operations", d.AttemptID)
	if op.State != "completed" {
		t.Fatalf("positive lifecycle did not resolve receipt: %+v", op)
	}
}

func TestMailboxGappedCompletionWithoutWorkingCannotEndWake(t *testing.T) {
	e, f, w := fixture(t)
	_, d := seedReviewDelivery(t, e, w, "sent", "delivered")
	completion := uint64(3)
	setObservation(t, e, f, w, "idle", 5, &completion)
	got, _ := get[model.Delivery](context.Background(), e.store, "deliveries", d.ID)
	if got.WakeStatus != "sent" {
		t.Fatal("gapped completion treated as exact turn end")
	}
	setObservation(t, e, f, w, "working", 6, &completion)
	setObservation(t, e, f, w, "idle", 8, &completion)
	got, _ = get[model.Delivery](context.Background(), e.store, "deliveries", d.ID)
	if got.WakeStatus != "ended" {
		t.Fatal("observed working->idle ignored")
	}
}

func TestAckCannotDowngradeConsumptionOrCrossWorkerByScope(t *testing.T) {
	e, _, w := fixture(t)
	m, d := seedReviewDelivery(t, e, w, "ended", "consumed")
	if _, err := mailboxRequest(t, e, "ack", w.ID, w.ID, Args{ID: m.ID}); err != nil {
		t.Fatal(err)
	}
	got, _ := get[model.Delivery](context.Background(), e.store, "deliveries", d.ID)
	if got.Status != "consumed" || got.ConsumedAt != 100 || got.AcknowledgedAt != 90 {
		t.Fatalf("consumed receipt regressed: %+v", got)
	}
	other := w
	other.ID = "worker_b"
	other.Name = "bob"
	if err := e.write(context.Background(), func(tx *store.Tx) error { return tx.Put("workers", other.ID, other) }); err != nil {
		t.Fatal(err)
	}
	m2, _ := seedReviewDelivery(t, e, other, "queued", "pending")
	_, err := mailboxRequest(t, e, "ack", w.ID, other.ID, Args{ID: m2.ID})
	workerCode(t, err, "wrong_recipient")
	if _, err := mailboxRequest(t, e, "ack", "", other.ID, Args{ID: m2.ID}); err != nil {
		t.Fatal("human explicit recipient should be allowed", err)
	}
}

func TestReplyAcknowledgesOriginalReceiptWithoutConsuming(t *testing.T) {
	e, _, w := fixture(t)
	m, d := seedReviewDelivery(t, e, w, "uncertain", "pending")
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		m.Kind = "question"
		m.FromKind = "human"
		return tx.Put("messages", m.ID, m)
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := mailboxRequest(t, e, "reply", w.ID, w.ID, Args{ID: m.ID, Body: "answer"}); err != nil {
		t.Fatal(err)
	}
	got, _ := get[model.Delivery](context.Background(), e.store, "deliveries", d.ID)
	if got.AcknowledgedAt == 0 || got.Status != "acknowledged" || got.ConsumedAt != 0 || got.WakeStatus != "acknowledged" {
		t.Fatalf("original receipt not acknowledged: %+v", got)
	}
	e.processInbox(w.ID)
	got, _ = get[model.Delivery](context.Background(), e.store, "deliveries", d.ID)
	if got.WakeStatus == "ended" {
		t.Fatal("ack alone released uncertain turn")
	}
}

func TestPromptOutcomeCannotOverwriteConcurrentConsumeAndFinalReceipt(t *testing.T) {
	e, f, w := fixture(t)
	f.uncertain = true
	f.beforePrompt = func() {
		ds, _ := list[model.Delivery](context.Background(), e.store, "deliveries", model.Scope{WorkerID: w.ID})
		if len(ds) != 1 {
			t.Errorf("expected durable delivery before prompt, got %d", len(ds))
			return
		}
		if _, err := mailboxRequest(t, e, "consume", w.ID, w.ID, Args{ID: ds[0].MessageID}); err != nil {
			t.Error(err)
		}
	}
	if _, err := call(t, e, "send", Args{To: w.ID, Body: "test"}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	var d model.Delivery
	for time.Now().Before(deadline) {
		ds, _ := list[model.Delivery](context.Background(), e.store, "deliveries", model.Scope{WorkerID: w.ID})
		if len(ds) == 1 {
			d = ds[0]
			if d.ConsumedAt != 0 {
				if _, active := e.inFlight.Load(d.AttemptID); !active {
					break
				}
			}
		}
		time.Sleep(time.Millisecond * 5)
	}
	if d.Status != "consumed" || d.WakeStatus != "acknowledged" {
		t.Fatalf("late prompt changed receipt: %+v", d)
	}
	op, _ := get[model.Operation](context.Background(), e.store, "operations", d.AttemptID)
	if op.State != "completed" {
		t.Fatalf("late transport error changed final op: %+v", op)
	}
}

func TestSendingIntentWithoutLiveAttemptBecomesUncertainAndNotReplayed(t *testing.T) {
	e, f, w := fixture(t)
	_, d := seedReviewDelivery(t, e, w, "sending", "pending")
	e.processInbox(w.ID)
	got, _ := get[model.Delivery](context.Background(), e.store, "deliveries", d.ID)
	if got.WakeStatus != "uncertain" || got.Error == "" {
		t.Fatalf("crashed sending intent invisible: %+v", got)
	}
	op, _ := get[model.Operation](context.Background(), e.store, "operations", d.AttemptID)
	if op.State != "uncertain" {
		t.Fatalf("crashed request receipt not exposed: %+v", op)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.prompts) != 0 {
		t.Fatal("replayed crashed wake")
	}
}

func TestRunBroadcastCommitSnapshotsMembersAndRecipientEvents(t *testing.T) {
	e, _, w := fixture(t)
	other := w
	other.ID = "worker_b"
	other.Name = "bob"
	other.RunID = "r_a"
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		if err := tx.Put("runs", "r_a", model.Run{ID: "r_a", SessionID: w.SessionID, WorkspaceID: w.WorkspaceID}); err != nil {
			return err
		}
		if err := tx.Put("workers", other.ID, other); err != nil {
			return err
		}
		return tx.Put("dispatches", "d_membership", model.Dispatch{ID: "d_membership", WorkerID: w.ID, SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, RunID: "r_a", Status: "pending", AttachmentID: w.AttachmentID})
	}); err != nil {
		t.Fatal(err)
	}
	// Commit is blocked while membership changes. Snapshot reads must occur after
	// this change, inside the same serialized write as durable deliveries.
	r := model.Request{ID: newID("op"), Op: "send", Scope: model.Scope{Global: true}}
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		return tx.Put("operations", r.ID, model.Operation{ID: r.ID, State: "accepted"})
	}); err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	done := make(chan any, 1)
	go func() {
		v, err := e.send(context.Background(), r, Args{To: "run:r_a", Body: "broadcast"})
		if err != nil {
			done <- err
		} else {
			done <- v
		}
	}()
	time.Sleep(20 * time.Millisecond)
	if _, err := e.store.Write(context.Background(), func(tx *store.Tx) error { other.State = "released"; return tx.Put("workers", other.ID, other) }); err != nil {
		t.Fatal(err)
	}
	e.mu.Unlock()
	v := <-done
	if err, ok := v.(error); ok {
		t.Fatal(err)
	}
	ds := v.(map[string]any)["deliveries"].([]model.Delivery)
	if len(ds) != 1 || ds[0].WorkerID != w.ID {
		t.Fatalf("stale broadcast members: %+v", ds)
	}
	events, err := e.store.Events(context.Background(), 0, model.Scope{WorkerID: w.ID}, []string{"message.available"}, 0)
	if err != nil || len(events) != 1 {
		t.Fatalf("worker default wait has no recipient event: %+v %v", events, err)
	}
}

func TestBusyMailboxHoldsObservableReason(t *testing.T) {
	e, f, w := fixture(t)
	_, d := seedReviewDelivery(t, e, w, "queued", "pending")
	f.mu.Lock()
	f.p.AgentStatus = "working"
	f.mu.Unlock()
	e.processInbox(w.ID)
	got, _ := get[model.Delivery](context.Background(), e.store, "deliveries", d.ID)
	if got.WakeStatus != "queued" || got.Error == "" {
		t.Fatalf("held reason missing: %+v", got)
	}
}

var _ = herdr.Pane{}
