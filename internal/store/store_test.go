// Persistence and event protection cases adapted from herdr-orch (MIT),
// internal/store/store_test.go and internal/store/plans_test.go.
package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/zielus/herdr-woof/internal/model"
)

var ctx = context.Background()

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "woof.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close store: %v", err)
		}
	})
	return s
}

func writeTest(t *testing.T, s *Store, fn func(*Tx) error) []model.Event {
	t.Helper()
	ev, err := s.Write(ctx, fn)
	if err != nil {
		t.Fatal(err)
	}
	return ev
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var e *model.Error
	if !errors.As(err, &e) || e.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}

func seed(t *testing.T, s *Store) {
	t.Helper()
	writeTest(t, s, func(tx *Tx) error {
		for _, rec := range []struct {
			kind, id string
			value    any
		}{
			{"sessions", "s_a", model.Session{ID: "s_a", Status: "attached"}},
			{"sessions", "s_b", model.Session{ID: "s_b", Status: "attached"}},
			{"workspaces", "ws_a", model.Workspace{ID: "ws_a", SessionID: "s_a"}},
			{"workspaces", "ws_b", model.Workspace{ID: "ws_b", SessionID: "s_b"}},
			{"worktrees", "wt_a", model.Worktree{ID: "wt_a", SessionID: "s_a", WorkspaceID: "ws_a", Path: "/a"}},
			{"runs", "r_a", model.Run{ID: "r_a", SessionID: "s_a", WorkspaceID: "ws_a", WorktreeID: "wt_a", Kind: "adhoc"}},
			{"workers", "w_a", model.Worker{ID: "w_a", SessionID: "s_a", WorkspaceID: "ws_a", WorktreeID: "wt_a", RunID: "r_a", Name: "builder", State: "idle"}},
			{"workers", "w_b", model.Worker{ID: "w_b", SessionID: "s_b", WorkspaceID: "ws_b", Name: "builder", State: "idle"}},
		} {
			if err := tx.Put(rec.kind, rec.id, rec.value); err != nil {
				return err
			}
		}
		return nil
	})
}

func TestMigrationReopenPreservesRecordsAndReplay(t *testing.T) {
	path := filepath.Join(t.TempDir(), "woof.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	seed(t, s)
	ev := writeTest(t, s, func(tx *Tx) error {
		return tx.Event("worker.created", model.Scope{WorkerID: "w_a", SessionID: "s_a"}, "human", "", map[string]string{"body": "hi"})
	})
	if len(ev) != 1 || ev[0].Seq < 1 || ev[0].ID == "" || ev[0].CreatedAt == 0 {
		t.Fatalf("events: %+v", ev)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close store: %v", err)
		}
	})
	var w model.Worker
	if err := s.Get(ctx, "workers", "w_a", &w); err != nil || w.Name != "builder" {
		t.Fatalf("record: %+v %v", w, err)
	}
	tail, err := s.Events(ctx, 0, model.Scope{}, nil, 0)
	if err != nil || len(tail) != 1 || tail[0].ID != ev[0].ID {
		t.Fatalf("replay: %+v %v", tail, err)
	}
	head, err := s.Head(ctx)
	if err != nil || head != ev[0].Seq {
		t.Fatalf("head=%d %v", head, err)
	}
	next := writeTest(t, s, func(tx *Tx) error { return tx.Event("worker.changed", model.Scope{}, "daemon", "", nil) })
	if next[0].Seq <= head {
		t.Fatal("cursor regressed after reopen")
	}
}

func TestRecordAndEventsCommitOrRollbackTogether(t *testing.T) {
	s := openTest(t)
	sentinel := errors.New("abort")
	events, err := s.Write(ctx, func(tx *Tx) error {
		if err := tx.Put("sessions", "s_a", model.Session{ID: "s_a"}); err != nil {
			return err
		}
		if err := tx.Event("session.attached", model.Scope{SessionID: "s_a"}, "daemon", "", nil); err != nil {
			return err
		}
		var got model.Session
		if err := tx.Get("sessions", "s_a", &got); err != nil {
			return err
		}
		if got.ID != "s_a" {
			t.Fatal("write not readable in transaction")
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) || len(events) != 0 {
		t.Fatalf("rollback returned %+v %v", events, err)
	}
	var got model.Session
	wantCode(t, s.Get(ctx, "sessions", "s_a", &got), "not_found")
	head, err := s.Head(ctx)
	if err != nil || head != 0 {
		t.Fatalf("rolled back event: %d %v", head, err)
	}
	events = writeTest(t, s, func(tx *Tx) error {
		if err := tx.Put("sessions", "s_a", model.Session{ID: "s_a"}); err != nil {
			return err
		}
		for _, typ := range []string{"session.attached", "session.changed"} {
			if err := tx.Event(typ, model.Scope{SessionID: "s_a"}, "daemon", "", nil); err != nil {
				return err
			}
		}
		return nil
	})
	if len(events) != 2 || events[0].Type != "session.attached" || events[1].Seq <= events[0].Seq {
		t.Fatalf("committed order: %+v", events)
	}
	if err := s.Get(ctx, "sessions", "s_a", &got); err != nil {
		t.Fatal(err)
	}
}

func TestAppendOnlyEventsRejectUpdateDeleteAndReplace(t *testing.T) {
	s := openTest(t)
	ev := writeTest(t, s, func(tx *Tx) error { return tx.Event("original", model.Scope{}, "human", "original", nil) })
	for _, q := range []string{
		`UPDATE events SET actor_id='spoofed'`,
		`DELETE FROM events`,
		`INSERT OR REPLACE INTO events SELECT seq,event_id,'spoofed',session_id,workspace_id,worktree_id,run_id,worker_id,actor_kind,actor_id,payload_json,created_at FROM events`,
		`INSERT OR REPLACE INTO events(event_id,type,actor_kind,payload_json,created_at) SELECT event_id,'spoofed','human','null',1 FROM events`,
	} {
		if _, err := s.db.Exec(q); err == nil {
			t.Fatalf("accepted: %s", q)
		}
	}
	got, err := s.Events(ctx, 0, model.Scope{}, nil, 0)
	if err != nil || len(got) != 1 || got[0].ID != ev[0].ID || got[0].Type != "original" {
		t.Fatalf("log changed: %+v %v", got, err)
	}
}

func TestScopeFilteringAcrossHierarchyAndGlobalOverride(t *testing.T) {
	s := openTest(t)
	seed(t, s)
	tests := []struct {
		kind  string
		scope model.Scope
		dst   any
		want  any
	}{
		{"sessions", model.Scope{WorkerID: "w_a"}, &[]model.Session{}, []string{"s_a"}},
		{"workspaces", model.Scope{RunID: "r_a"}, &[]model.Workspace{}, []string{"ws_a"}},
		{"worktrees", model.Scope{WorkerID: "w_a"}, &[]model.Worktree{}, []string{"wt_a"}},
		{"runs", model.Scope{WorktreeID: "wt_a", SessionID: "s_a"}, &[]model.Run{}, []string{"r_a"}},
		{"workers", model.Scope{WorkerID: "w_a", RunID: "r_a"}, &[]model.Worker{}, []string{"w_a"}},
		{"workers", model.Scope{WorkspaceID: "ws_b", RunID: "r_a"}, &[]model.Worker{}, []string{}},
		{"workers", model.Scope{Global: true, WorkerID: "missing"}, &[]model.Worker{}, []string{"w_a", "w_b"}},
	}
	for _, tc := range tests {
		t.Run(tc.kind+"/"+tc.scope.WorkerID+tc.scope.RunID+tc.scope.WorkspaceID, func(t *testing.T) {
			if err := s.List(ctx, tc.kind, tc.scope, tc.dst); err != nil {
				t.Fatal(err)
			}
			slice := reflect.ValueOf(tc.dst).Elem()
			ids := []string{}
			for i := 0; i < slice.Len(); i++ {
				ids = append(ids, slice.Index(i).FieldByName("ID").String())
			}
			if !reflect.DeepEqual(ids, tc.want) {
				t.Fatalf("ids=%v want=%v", ids, tc.want)
			}
		})
	}
	writeTest(t, s, func(tx *Tx) error {
		var workers []model.Worker
		if err := tx.List("workers", model.Scope{SessionID: "s_a"}, &workers); err != nil {
			return err
		}
		if len(workers) != 1 || workers[0].ID != "w_a" {
			t.Fatalf("tx scope: %+v", workers)
		}
		return nil
	})
}

func TestWorkerAliasReservedOfflineAndReusableOnlyAfterTerminal(t *testing.T) {
	s := openTest(t)
	seed(t, s)
	var w model.Worker
	if err := s.Get(ctx, "workers", "w_a", &w); err != nil {
		t.Fatal(err)
	}
	w.State = "offline"
	writeTest(t, s, func(tx *Tx) error { return tx.Put("workers", w.ID, w) })
	other := w
	other.ID = "w_other"
	_, err := s.Write(ctx, func(tx *Tx) error { return tx.Put("workers", other.ID, other) })
	wantCode(t, err, "name_conflict")
	for _, terminal := range []string{"released", "stopped", "failed"} {
		w.State = terminal
		writeTest(t, s, func(tx *Tx) error { return tx.Put("workers", w.ID, w) })
		other.State = "idle"
		writeTest(t, s, func(tx *Tx) error { return tx.Put("workers", other.ID, other) })
		other.State = terminal
		writeTest(t, s, func(tx *Tx) error { return tx.Put("workers", other.ID, other) })
	}
}

func TestOneActiveDispatchIncludesUncertain(t *testing.T) {
	s := openTest(t)
	seed(t, s)
	d := model.Dispatch{ID: "d_a", SessionID: "s_a", WorkspaceID: "ws_a", RunID: "r_a", WorkerID: "w_a", Status: "uncertain"}
	writeTest(t, s, func(tx *Tx) error { return tx.Put("dispatches", d.ID, d) })
	other := d
	other.ID = "d_b"
	other.Status = "pending"
	_, err := s.Write(ctx, func(tx *Tx) error { return tx.Put("dispatches", other.ID, other) })
	wantCode(t, err, "busy_worker")
	d.Status = "completed"
	writeTest(t, s, func(tx *Tx) error { return tx.Put("dispatches", d.ID, d) })
	writeTest(t, s, func(tx *Tx) error { return tx.Put("dispatches", other.ID, other) })
}

func TestBroadcastDeliveryAndReceiptAreAtomicAndReadOnly(t *testing.T) {
	s := openTest(t)
	seed(t, s)
	broadcast := func(tx *Tx) error {
		m := model.Message{ID: "m_a", SessionID: "s_a", WorkspaceID: "ws_a", RunID: "r_a", FromWorkerID: "w_a", ToKind: "run", ToID: "r_a", Kind: "note", Status: "queued", Body: "durable"}
		if err := tx.Put("messages", m.ID, m); err != nil {
			return err
		}
		for _, w := range []string{"w_a", "w_b"} {
			d := model.Delivery{ID: "delivery_" + w, MessageID: m.ID, WorkerID: w, Status: "queued", WakeStatus: "pending"}
			if w == "w_a" {
				d.SessionID = "s_a"
				d.WorkspaceID = "ws_a"
				d.RunID = "r_a"
			} else {
				d.SessionID = "s_b"
				d.WorkspaceID = "ws_b"
			}
			if err := tx.Put("deliveries", d.ID, d); err != nil {
				return err
			}
		}
		if err := tx.Put("operations", "op_a", model.Operation{ID: "op_a", Op: "send", Fingerprint: "fp", State: "completed", ResourceKind: "messages", ResourceID: m.ID}); err != nil {
			return err
		}
		return tx.Event("message.persisted", model.Scope{RunID: "r_a"}, "worker", "w_a", nil)
	}
	_, err := s.Write(ctx, func(tx *Tx) error {
		if err := broadcast(tx); err != nil {
			return err
		}
		return errors.New("abort")
	})
	if err == nil {
		t.Fatal("wanted rollback")
	}
	for _, table := range []string{"messages", "deliveries", "operations"} {
		var v []map[string]any
		if err := s.List(ctx, table, model.Scope{Global: true}, &v); err != nil || len(v) != 0 {
			t.Fatalf("leaked %s: %+v %v", table, v, err)
		}
	}
	writeTest(t, s, broadcast)
	var ds []model.Delivery
	if err := s.List(ctx, "deliveries", model.Scope{SessionID: "s_b", WorkerID: "w_b"}, &ds); err != nil || len(ds) != 1 || ds[0].Status != "queued" {
		t.Fatalf("recipient scope: %+v %v", ds, err)
	}
	if err := s.List(ctx, "deliveries", model.Scope{WorktreeID: "wt_a"}, &ds); err != nil || len(ds) != 1 || ds[0].WorkerID != "w_a" {
		t.Fatalf("recipient worktree: %+v %v", ds, err)
	}
	var ms []model.Message
	if err := s.List(ctx, "messages", model.Scope{WorkerID: "w_b"}, &ms); err != nil || len(ms) != 1 || ms[0].Status != "queued" {
		t.Fatalf("message recipient: %+v %v", ms, err)
	}
	var op model.Operation
	if err := s.Get(ctx, "operations", "op_a", &op); err != nil || op.State != "completed" || op.ResourceID != "m_a" {
		t.Fatalf("receipt: %+v %v", op, err)
	}
	wantCode(t, s.List(ctx, "operations", model.Scope{RunID: "r_a"}, &[]model.Operation{}), "invalid_scope")
}

func TestEventReplayFiltersCursorScopeTypeAndLimit(t *testing.T) {
	s := openTest(t)
	ev := writeTest(t, s, func(tx *Tx) error {
		for _, e := range []struct{ typ, run, worker string }{{"message.persisted", "r_a", "w_a"}, {"worker.done", "r_a", "w_a"}, {"worker.done", "r_b", "w_b"}, {"worker.done", "r_a", "w_a"}} {
			if err := tx.Event(e.typ, model.Scope{RunID: e.run, WorkerID: e.worker}, "daemon", "", nil); err != nil {
				return err
			}
		}
		return nil
	})
	got, err := s.Events(ctx, ev[0].Seq, model.Scope{RunID: "r_a", WorkerID: "w_a"}, []string{"worker.done"}, 1)
	if err != nil || len(got) != 1 || got[0].Seq != ev[1].Seq {
		t.Fatalf("filtered replay: %+v %v", got, err)
	}
	got, err = s.Events(ctx, ev[1].Seq, model.Scope{RunID: "r_a"}, nil, 0)
	if err != nil || len(got) != 1 || got[0].Seq != ev[3].Seq {
		t.Fatalf("tail: %+v %v", got, err)
	}
}

func TestInvalidKindsIdentityForeignKeysAndDestinationRefused(t *testing.T) {
	s := openTest(t)
	var v model.Worker
	wantCode(t, s.Get(ctx, "workers; DROP TABLE sessions", "x", &v), "invalid_kind")
	wantCode(t, s.List(ctx, "events", model.Scope{}, &[]model.Event{}), "invalid_kind")
	_, err := s.Write(ctx, func(tx *Tx) error { return tx.Put("workers", "w_x", model.Worker{ID: "different"}) })
	wantCode(t, err, "invalid_record")
	_, err = s.Write(ctx, func(tx *Tx) error {
		return tx.Put("workspaces", "ws_x", model.Workspace{ID: "ws_x", SessionID: "missing"})
	})
	wantCode(t, err, "conflict")
	if err := s.List(ctx, "workers", model.Scope{}, []model.Worker{}); err == nil {
		t.Fatal("accepted nonpointer destination")
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := s.Write(canceled, func(tx *Tx) error { return nil }); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled write: %v", err)
	}
}

func TestExplicitEventSequencesCannotRegress(t *testing.T) {
	s := openTest(t)
	writeTest(t, s, func(tx *Tx) error { return tx.Event("original", model.Scope{}, "human", "", nil) })
	for _, seq := range []int64{-1, 0} {
		_, err := s.db.Exec(`INSERT INTO events(seq,event_id,type,actor_kind,payload_json,created_at) VALUES(?,'new','test','human','null',1)`, seq)
		if err == nil {
			t.Fatalf("accepted regressing event sequence %d", seq)
		}
	}
	got, err := s.Events(ctx, 0, model.Scope{}, nil, 0)
	if err != nil || len(got) != 1 {
		t.Fatalf("events after refusal: %+v %v", got, err)
	}
}

func TestFailedMigrationLeavesExistingDatabaseUntouched(t *testing.T) {
	path := filepath.Join(t.TempDir(), "partial.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})
	if _, err := db.Exec(`CREATE TABLE runs(original TEXT); INSERT INTO runs VALUES('preserve')`); err != nil {
		t.Fatal(err)
	}
	if s, err := Open(path); err == nil {
		if err := s.Close(); err != nil {
			t.Errorf("close unexpected store: %v", err)
		}
		t.Fatal("expected conflicting schema refusal")
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name='sessions'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial migration persisted: %d %v", count, err)
	}
	var original string
	if err := db.QueryRow(`SELECT original FROM runs`).Scan(&original); err != nil || original != "preserve" {
		t.Fatalf("original changed: %q %v", original, err)
	}
	if _, err := db.Exec(`PRAGMA user_version=999`); err != nil {
		t.Fatal(err)
	}
	if s, err := Open(path); err == nil {
		if err := s.Close(); err != nil {
			t.Errorf("close unexpected store: %v", err)
		}
		t.Fatal("accepted unsupported future schema")
	}
}

func TestNormalizedScopesUpdateWithRecordAndPathEscaping(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "a ?#%.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close store: %v", err)
		}
	})
	seed(t, s)
	var w model.Worker
	if err := s.Get(ctx, "workers", "w_a", &w); err != nil {
		t.Fatal(err)
	}
	w.WorkspaceID = "ws_b"
	w.SessionID = "s_b"
	w.WorktreeID = ""
	w.RunID = ""
	w.Name = "moved"
	writeTest(t, s, func(tx *Tx) error { return tx.Put("workers", w.ID, w) })
	var workers []model.Worker
	if err := s.List(ctx, "workers", model.Scope{SessionID: "s_a"}, &workers); err != nil || len(workers) != 0 {
		t.Fatalf("old scope: %+v %v", workers, err)
	}
	if err := s.List(ctx, "workers", model.Scope{SessionID: "s_b", WorkspaceID: "ws_b"}, &workers); err != nil || len(workers) != 2 || workers[0].Name != "moved" {
		t.Fatalf("new scope: %+v %v", workers, err)
	}
}

func TestDispatchCompletionMessageReferenceIsValidatedAtomically(t *testing.T) {
	s := openTest(t)
	seed(t, s)
	d := model.Dispatch{ID: "d_a", SessionID: "s_a", WorkspaceID: "ws_a", RunID: "r_a", WorkerID: "w_a", Status: "pending", DoneMessageID: "m_missing"}
	_, err := s.Write(ctx, func(tx *Tx) error { return tx.Put("dispatches", d.ID, d) })
	wantCode(t, err, "conflict")
	d.DoneMessageID = "m_done"
	writeTest(t, s, func(tx *Tx) error {
		// Mutual report/dispatch links may be created in either order in one write.
		if err := tx.Put("dispatches", d.ID, d); err != nil {
			return err
		}
		return tx.Put("messages", "m_done", model.Message{ID: "m_done", DispatchID: d.ID, FromWorkerID: "w_a", Kind: "done", ToKind: "daemon"})
	})
}

func TestWorkersRunScopeIncludesAdhocDispatchMembership(t *testing.T) {
	s := openTest(t)
	seed(t, s)
	writeTest(t, s, func(tx *Tx) error {
		w, err := func() (model.Worker, error) { var w model.Worker; err := tx.Get("workers", "w_a", &w); return w, err }()
		if err != nil {
			return err
		}
		w.RunID = ""
		if err := tx.Put("workers", w.ID, w); err != nil {
			return err
		}
		return tx.Put("dispatches", "d_adhoc", model.Dispatch{ID: "d_adhoc", SessionID: "s_a", WorkspaceID: "ws_a", RunID: "r_a", WorkerID: w.ID, Status: "pending"})
	})
	var workers []model.Worker
	if err := s.List(ctx, "workers", model.Scope{RunID: "r_a"}, &workers); err != nil || len(workers) != 1 || workers[0].ID != "w_a" {
		t.Fatalf("adhoc run members: %+v %v", workers, err)
	}
}

func TestWorktreeHumanReceiptsUseMessageScope(t *testing.T) {
	s := openTest(t)
	seed(t, s)
	writeTest(t, s, func(tx *Tx) error {
		for _, m := range []model.Message{
			{ID: "m_here", SessionID: "s_a", WorkspaceID: "ws_a", WorktreeID: "wt_a", ToKind: "human"},
			{ID: "m_else", SessionID: "s_b", WorkspaceID: "ws_b", ToKind: "human"},
			{ID: "m_worker", SessionID: "s_b", WorkspaceID: "ws_b", ToKind: "worker", ToID: "w_a"},
		} {
			if err := tx.Put("messages", m.ID, m); err != nil {
				return err
			}
		}
		for _, d := range []model.Delivery{
			{ID: "dl_here", MessageID: "m_here", SessionID: "s_a", WorkspaceID: "ws_a", Human: true},
			{ID: "dl_else", MessageID: "m_else", SessionID: "s_b", WorkspaceID: "ws_b", Human: true},
			{ID: "dl_worker", MessageID: "m_worker", SessionID: "s_a", WorkspaceID: "ws_a", WorkerID: "w_a"},
		} {
			if err := tx.Put("deliveries", d.ID, d); err != nil {
				return err
			}
		}
		return nil
	})
	var ds []model.Delivery
	if err := s.List(ctx, "deliveries", model.Scope{WorktreeID: "wt_a"}, &ds); err != nil {
		t.Fatal(err)
	}
	if len(ds) != 2 {
		t.Fatalf("want same-worktree human receipt and existing worker membership, got %+v", ds)
	}
	ids := map[string]bool{}
	for _, d := range ds {
		ids[d.ID] = true
	}
	if !ids["dl_here"] || !ids["dl_worker"] || ids["dl_else"] {
		t.Fatalf("scope leaked: %+v", ds)
	}
}
