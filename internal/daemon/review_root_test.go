package daemon

import (
	"context"
	"encoding/json"
	"github.com/zielus/herdr-woof-v2/internal/herdr"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/store"
	"os"
	"testing"
	"time"
)

func TestPromptResponseCannotResurrectExplicitFail(t *testing.T) {
	e, f, w := fixture(t)
	f.mu.Lock()
	f.beforePrompt = func() {
		ds, _ := list[model.Dispatch](context.Background(), e.store, "dispatches", model.Scope{WorkerID: w.ID})
		if len(ds) != 1 {
			t.Error("missing committed dispatch")
			return
		}
		_, err := call(t, e, "fail", Args{Dispatch: ds[0].ID, Reason: "operator canceled"})
		if err != nil {
			t.Error(err)
		}
	}
	f.mu.Unlock()
	v, err := call(t, e, "dispatch", Args{To: w.ID, Spec: "task"})
	if err != nil {
		t.Fatal(err)
	}
	d := v.(model.Dispatch)
	if d.Status != "failed" || d.Outcome != "operator canceled" {
		t.Fatalf("resurrected %+v", d)
	}
	run, _ := get[model.Run](context.Background(), e.store, "runs", d.RunID)
	if run.Status != "completed" {
		t.Fatal("failed adhoc run remains active")
	}
}
func TestCannotResolveAnExecutingOperation(t *testing.T) {
	e, f, w := fixture(t)
	f.mu.Lock()
	f.beforePrompt = func() {
		ds, _ := list[model.Dispatch](context.Background(), e.store, "dispatches", model.Scope{WorkerID: w.ID})
		_, err := call(t, e, "operation.resolve", Args{ID: ds[0].OperationID, Resolution: "failed", Reason: "test investigation"})
		if err == nil {
			t.Error("resolved executing mutation")
		}
	}
	f.mu.Unlock()
	mustDispatch(t, e, w)
}
func TestCallerAttachmentCheckedIndependentlyOfGlobalOrExplicitScope(t *testing.T) {
	e, _, w := fixture(t)
	for _, scope := range []model.Scope{{Global: true}, {SessionID: w.SessionID}, {WorkerID: w.ID}} {
		_, err := e.normalizeScope(context.Background(), model.Request{Scope: scope, ScopeExplicit: true, Caller: model.Caller{WorkerID: w.ID, AttachmentID: "obsolete"}})
		if err == nil {
			t.Errorf("stale caller accepted scope %+v", scope)
		}
	}
}
func TestReceiptRemainsQueryableWithObsoleteCallerContext(t *testing.T) {
	e, _, w := fixture(t)
	b, _ := json.Marshal(Args{Question: "yes?"})
	req := model.Request{Version: model.Protocol, ID: newID("op"), Op: "gate.create", Caller: model.Caller{WorkerID: w.ID, AttachmentID: w.AttachmentID}, Args: b}
	v, err := e.Handle(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	_ = e.write(context.Background(), func(tx *store.Tx) error {
		current, x := txGet[model.Worker](tx, "workers", w.ID)
		if x != nil {
			return x
		}
		current.AttachmentID = "new"
		return tx.Put("workers", current.ID, current)
	})
	again, err := e.Handle(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := json.Marshal(v)
	b, _ = json.Marshal(again)
	var aa, bb map[string]any
	json.Unmarshal(a, &aa)
	json.Unmarshal(b, &bb)
	if aa["id"] != bb["id"] {
		t.Fatal("receipt changed after attachment")
	}
}
func TestOriginalEndEvidenceSurvivesMailboxTurnAndBusyReportWaits(t *testing.T) {
	e, f, w := fixture(t)
	d := mustDispatch(t, e, w)
	setObservation(t, e, f, w, "working", 3, w.CompletionSeq)
	seq := uint64(4)
	setObservation(t, e, f, w, "idle", 4, &seq)
	setObservation(t, e, f, w, "working", 5, &seq)
	v, err := call(t, e, "done", Args{Dispatch: d.ID, Attachment: w.AttachmentID})
	if err != nil {
		t.Fatal(err)
	}
	reported := v.(model.Dispatch)
	if reported.Status == "settled" {
		t.Fatal("report while mailbox turn working settled")
	}
	seq6 := uint64(6)
	setObservation(t, e, f, w, "idle", 6, &seq6)
	got, _ := get[model.Dispatch](context.Background(), e.store, "dispatches", d.ID)
	if got.EndSeq != 4 || got.WorkingSeq != 3 || got.Status != "settled" {
		t.Fatalf("mailbox rewrote original evidence %+v", got)
	}
}
func TestUnobservedDispatchEscalatesAfterCrashIntent(t *testing.T) {
	e, _, w := fixture(t)
	d := mustDispatch(t, e, w)
	_ = e.write(context.Background(), func(tx *store.Tx) error {
		current, err := txGet[model.Dispatch](tx, "dispatches", d.ID)
		if err != nil {
			return err
		}
		current.Status = "sending"
		current.SentAt = time.Now().Add(-2 * time.Minute).UnixMilli()
		return tx.Put("dispatches", d.ID, current)
	})
	if err := e.watchdogOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, _ := get[model.Dispatch](context.Background(), e.store, "dispatches", d.ID)
	if !got.Alerts["prompt_outcome_unobserved"] {
		t.Fatal("crash intent silently stuck")
	}
}
func TestStaleAttachmentObservationCannotLoseReAdoptedWorker(t *testing.T) {
	e, _, w := fixture(t)
	_ = e.write(context.Background(), func(tx *store.Tx) error {
		current, err := txGet[model.Worker](tx, "workers", w.ID)
		if err != nil {
			return err
		}
		current.AttachmentID = "new"
		return tx.Put("workers", w.ID, current)
	})
	if err := e.observeWorker(context.Background(), w, herdr.Pane{}, false); err != nil {
		t.Fatal(err)
	}
	got, _ := get[model.Worker](context.Background(), e.store, "workers", w.ID)
	if got.State == "lost" {
		t.Fatal("old callback lost new binding")
	}
}
func TestRegularSocketPathNeverDeleted(t *testing.T) {
	p := serverPaths(t)
	os.WriteFile(p.Sock, []byte("keep me"), 0600)
	err := Run(context.Background(), Options{Paths: p})
	if err == nil {
		t.Fatal("regular socket path replaced")
	}
	b, _ := os.ReadFile(p.Sock)
	if string(b) != "keep me" {
		t.Fatal("regular file destroyed")
	}
}
