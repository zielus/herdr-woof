package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/zielus/herdr-woof/internal/herdr"
	"github.com/zielus/herdr-woof/internal/model"
	"github.com/zielus/herdr-woof/internal/store"
)

func TestUncertainExternalErrorAlwaysCarriesQueryableReceipt(t *testing.T) {
	e, f, w := fixture(t)
	f.mu.Lock()
	f.uncertain = true
	f.mu.Unlock()
	b, _ := json.Marshal(Args{To: w.ID, Spec: "task"})
	req := model.Request{Version: model.Protocol, ID: "op_live_lost", Op: "dispatch", Scope: model.Scope{Global: true}, Args: b}
	_, err := e.Handle(context.Background(), req)
	var me *model.Error
	if !errors.As(err, &me) || me.Code != "uncertain" || me.OperationID != req.ID {
		t.Fatalf("uncertainty has no inspectable operation ID: %#v", err)
	}
	op, err := get[model.Operation](context.Background(), e.store, "operations", me.OperationID)
	if err != nil || op.State != "uncertain" {
		t.Fatalf("receipt not persisted: %+v %v", op, err)
	}
}

func TestMissingSnapshotCannotLoseNewlyBoundAgent(t *testing.T) {
	e, _, w := fixture(t)
	stale := w
	stale.NativeSession = nil
	stale.AgentProcess = nil
	stale.TerminalID = ""
	stale.State = "starting"
	if err := e.observeWorker(context.Background(), stale, herdr.Pane{}, false); err != nil {
		t.Fatal(err)
	}
	current, _ := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	if current.State == "lost" {
		t.Fatal("stale prelaunch snapshot lost newly bound worker")
	}
}

func TestRecoveredWorkerCanInspectBindingButStaleActorCannotMutate(t *testing.T) {
	e, _, w := fixture(t)
	b, _ := json.Marshal(Args{ID: w.ID})
	r := model.Request{Version: model.Protocol, Op: "worker.show", Caller: model.Caller{WorkerID: w.ID, AttachmentID: "old"}, Args: b}
	v, err := e.Handle(context.Background(), r)
	if err != nil || v.(model.Worker).AttachmentID != w.AttachmentID {
		t.Fatalf("cannot inspect current binding: %v", err)
	}
	r.Op = "gate.create"
	r.ID = "op_stale_mutation"
	r.Args = json.RawMessage(`{"question":"safe?"}`)
	if _, err := e.Handle(context.Background(), r); err == nil {
		t.Fatal("obsolete attachment mutated state")
	}
}

func TestInvestigatedFinalWakeResolutionPreservesReceiptAndDoesNotResend(t *testing.T) {
	for _, resolution := range []string{"completed", "failed"} {
		t.Run(resolution, func(t *testing.T) {
			e, f, w := fixture(t)
			_, d := seedReviewDelivery(t, e, w, "acknowledged", "consumed")
			if err := e.write(context.Background(), func(tx *store.Tx) error {
				return e.finishTx(tx, d.AttemptID, map[string]bool{"acknowledged": true}, nil, "completed")
			}); err != nil {
				t.Fatal(err)
			}
			before, _ := get[model.Operation](context.Background(), e.store, "operations", d.AttemptID)
			if _, err := call(t, e, "operation.resolve", Args{ID: d.AttemptID, Resolution: resolution, Reason: "inspected terminal and confirmed readiness; no replay"}); err != nil {
				t.Fatal(err)
			}
			current, _ := get[model.Delivery](context.Background(), e.store, "deliveries", d.ID)
			if current.Status != "consumed" || current.ConsumedAt != d.ConsumedAt || (current.WakeStatus != "resolved" && current.WakeStatus != "abandoned") {
				t.Fatalf("resolution regressed receipt: %+v", current)
			}
			after, _ := get[model.Operation](context.Background(), e.store, "operations", d.AttemptID)
			a, _ := json.Marshal(before)
			b, _ := json.Marshal(after)
			if string(a) != string(b) {
				t.Fatal("rewrote successful mutation receipt")
			}
			e.processInbox(w.ID)
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.prompts) != 0 {
				t.Fatal("resolution resent old prompt")
			}
		})
	}
}

func TestAliasReuseDoesNotMatchTerminalWorkers(t *testing.T) {
	e, _, w := fixture(t)
	for _, state := range []string{"failed", "stopped", "released"} {
		old := w
		old.ID = "worker_old_" + state
		old.State = state
		if err := e.write(context.Background(), func(tx *store.Tx) error { return tx.Put("workers", old.ID, old) }); err != nil {
			t.Fatal(err)
		}
	}
	current, err := e.resolveWorker(context.Background(), w.Name, workerScope(w))
	if err != nil || current.ID != w.ID {
		t.Fatalf("terminal workers poisoned live alias: %+v %v", current, err)
	}
}

func TestDispatchIntentRejectsBindingOrLifecycleChangedDuringReadiness(t *testing.T) {
	for _, change := range []string{"attachment", "lifecycle"} {
		t.Run(change, func(t *testing.T) {
			e, f, w := fixture(t)
			f.mu.Lock()
			f.beforeRead = func() {
				if err := e.write(context.Background(), func(tx *store.Tx) error {
					current, x := txGet[model.Worker](tx, "workers", w.ID)
					if x != nil {
						return x
					}
					if change == "attachment" {
						current.AttachmentID = "replacement"
					} else {
						current.StateSeq = w.StateSeq + 2
					}
					return tx.Put("workers", current.ID, current)
				}); err != nil {
					t.Error(err)
				}
			}
			f.mu.Unlock()
			if _, err := call(t, e, "dispatch", Args{To: w.ID, Spec: "task"}); err == nil {
				t.Fatal("stale readiness snapshot dispatched")
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.prompts) != 0 {
				t.Fatal("sent to changed attachment/lifecycle")
			}
			ds, _ := list[model.Dispatch](context.Background(), e.store, "dispatches", model.Scope{WorkerID: w.ID})
			if len(ds) != 0 {
				t.Fatal("persisted dispatch with stale binding evidence")
			}
		})
	}
}

func TestShutdownPersistsInterruptedAutomaticWakeBeforeReleasingStore(t *testing.T) {
	e, f, w := fixture(t)
	started := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	f.mu.Lock()
	f.beforePrompt = func() { close(started); <-release }
	f.mu.Unlock()
	v, err := call(t, e, "send", Args{To: w.ID, Body: "read then acknowledge"})
	if err != nil {
		t.Fatal(err)
	}
	message := v.(map[string]any)["message"].(model.Message)
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("automatic wake did not start")
	}
	e.Close()
	deliveries, err := list[model.Delivery](context.Background(), e.store, "deliveries", model.Scope{WorkerID: w.ID})
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range deliveries {
		if d.MessageID != message.ID {
			continue
		}
		op, x := get[model.Operation](context.Background(), e.store, "operations", d.AttemptID)
		if x != nil || d.WakeStatus != "uncertain" || op.State != "uncertain" {
			t.Fatalf("writer released before interrupted wake receipt: %+v %+v %v", d, op, x)
		}
		return
	}
	t.Fatal("durable delivery missing after shutdown")
}

func TestFailedSpawnResolutionReleasesOnlyUnboundReservation(t *testing.T) {
	e, _, w := fixture(t)
	const opID = "op_spawn_unknown"
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		w.State = "starting"
		w.NativeSession = nil
		w.AgentProcess = nil
		if err := tx.Put("workers", w.ID, w); err != nil {
			return err
		}
		return tx.Put("operations", opID, model.Operation{ID: opID, Op: "worker.spawn", Fingerprint: "test", State: "uncertain", ResourceKind: "workers", ResourceID: w.ID})
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := call(t, e, "operation.resolve", Args{ID: opID, Resolution: "failed", Reason: "live agent.get proved no agent; pane left for inspection"}); err != nil {
		t.Fatal(err)
	}
	current, _ := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	if current.State != "failed" || current.Ready || current.PaneID != w.PaneID {
		t.Fatalf("reservation not visibly released: %+v", current)
	}
}
