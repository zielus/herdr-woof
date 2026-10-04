package store

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	"github.com/zielus/herdr-woof-v2/internal/model"
)

// v1Database creates a database exactly as a version 1 daemon left it.
func v1Database(t *testing.T, extra string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "woof.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Errorf("close v1 database: %v", err)
		}
	}()
	seed := schema + `PRAGMA user_version=1;
INSERT INTO sessions(id,herdr_name,socket_path,status,record_json) VALUES('s1','one','/tmp/one.sock','online','{"id":"s1","herdr_name":"one","socket_path":"/tmp/one.sock","status":"online"}');
INSERT INTO workspaces(id,session_id,record_json) VALUES('ws1','s1','{"id":"ws1","session_id":"s1"}');
INSERT INTO workers(id,session_id,workspace_id,name,state,record_json) VALUES('w1','s1','ws1','alice','idle','{"id":"w1","session_id":"s1","workspace_id":"ws1","name":"alice","state":"idle"}');
INSERT INTO events(event_id,type,session_id,actor_kind,payload_json,created_at) VALUES('e1','session.attached','s1','daemon','{}',1);
` + extra
	if _, err := db.Exec(seed); err != nil {
		t.Fatal(err)
	}
	return path
}

func userVersion(t *testing.T, path string) int {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	}()
	var v int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestMigrationV1ToV2PreservesStateAndAddsSchedules(t *testing.T) {
	path := v1Database(t, "")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	var w model.Worker
	if err := s.Get(ctx, "workers", "w1", &w); err != nil || w.Name != "alice" {
		t.Fatalf("worker lost: %+v %v", w, err)
	}
	evs, err := s.Events(ctx, 0, model.Scope{Global: true}, nil, 0)
	if err != nil || len(evs) != 1 || evs[0].ID != "e1" {
		t.Fatalf("events lost: %+v %v", evs, err)
	}
	if _, err := s.db.Exec(`UPDATE events SET type='x'`); err == nil {
		t.Fatal("append-only trigger lost during migration")
	}
	sched := model.Schedule{ID: "sched_1", SessionID: "s1", WorkspaceID: "ws1", WorkerID: "w1", Name: "daily", State: "active"}
	writeTest(t, s, func(tx *Tx) error { return tx.Put("schedules", sched.ID, sched) })
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if v := userVersion(t, path); v != 2 {
		t.Fatalf("user_version %d", v)
	}
	// Reopening an already migrated database is a no-op.
	s = openPath(t, path)
	var got model.Schedule
	if err := s.Get(ctx, "schedules", sched.ID, &got); err != nil || got.Name != "daily" {
		t.Fatalf("schedule after reopen: %+v %v", got, err)
	}
}

func TestFailedScheduleMigrationLeavesVersionOneUntouched(t *testing.T) {
	path := v1Database(t, `CREATE TABLE schedules(legacy TEXT); INSERT INTO schedules VALUES('keep');`)
	if s, err := Open(path); err == nil {
		if err := s.Close(); err != nil {
			t.Errorf("close unexpected store: %v", err)
		}
		t.Fatal("conflicting schedules table accepted")
	}
	if v := userVersion(t, path); v != 1 {
		t.Fatalf("partial migration changed version to %d", v)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	}()
	var legacy string
	var runs int
	if err := db.QueryRow(`SELECT legacy FROM schedules`).Scan(&legacy); err != nil || legacy != "keep" {
		t.Fatalf("legacy table changed: %q %v", legacy, err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name='schedule_runs'`).Scan(&runs); err != nil || runs != 0 {
		t.Fatalf("partial migration persisted: %d %v", runs, err)
	}
}

func openPath(t *testing.T, path string) *Store {
	t.Helper()
	s, err := Open(path)
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

func seedScheduleScope(t *testing.T, s *Store) {
	t.Helper()
	writeTest(t, s, func(tx *Tx) error {
		for _, id := range []string{"s1", "s2"} {
			if err := tx.Put("sessions", id, model.Session{ID: id, HerdrName: id, SocketPath: "/tmp/" + id, Status: "online"}); err != nil {
				return err
			}
			if err := tx.Put("workspaces", "ws_"+id, model.Workspace{ID: "ws_" + id, SessionID: id}); err != nil {
				return err
			}
			if err := tx.Put("workers", "w_"+id, model.Worker{ID: "w_" + id, SessionID: id, WorkspaceID: "ws_" + id, Name: "alice", State: "idle"}); err != nil {
				return err
			}
			sc := model.Schedule{ID: "sched_" + id, SessionID: id, WorkspaceID: "ws_" + id, WorkerID: "w_" + id, Name: "daily", State: "active"}
			if err := tx.Put("schedules", sc.ID, sc); err != nil {
				return err
			}
			run := model.ScheduleRun{ID: "srun_" + id, ScheduleID: sc.ID, SessionID: id, WorkspaceID: sc.WorkspaceID, WorkerID: sc.WorkerID, OccurrenceKey: "t:1", State: "persisted"}
			if err := tx.Put("schedule_runs", run.ID, run); err != nil {
				return err
			}
		}
		return nil
	})
}

func TestScheduleOccurrenceKeyAndActiveNameAreUnique(t *testing.T) {
	s := openTest(t)
	seedScheduleScope(t, s)
	_, err := s.Write(ctx, func(tx *Tx) error {
		return tx.Put("schedule_runs", "srun_dup", model.ScheduleRun{ID: "srun_dup", ScheduleID: "sched_s1", SessionID: "s1", WorkspaceID: "ws_s1", WorkerID: "w_s1", OccurrenceKey: "t:1", State: "claimed"})
	})
	var me *model.Error
	if !errors.As(err, &me) || me.Code != "occurrence_claimed" {
		t.Fatalf("duplicate occurrence accepted: %v", err)
	}
	_, err = s.Write(ctx, func(tx *Tx) error {
		return tx.Put("schedules", "sched_dup", model.Schedule{ID: "sched_dup", SessionID: "s1", WorkspaceID: "ws_s1", WorkerID: "w_s1", Name: "daily", State: "active"})
	})
	if !errors.As(err, &me) || me.Code != "name_conflict" {
		t.Fatalf("duplicate active name accepted: %v", err)
	}
	writeTest(t, s, func(tx *Tx) error {
		removed := model.Schedule{ID: "sched_s1", SessionID: "s1", WorkspaceID: "ws_s1", WorkerID: "w_s1", Name: "daily", State: "removed"}
		if err := tx.Put("schedules", removed.ID, removed); err != nil {
			return err
		}
		return tx.Put("schedules", "sched_new", model.Schedule{ID: "sched_new", SessionID: "s1", WorkspaceID: "ws_s1", WorkerID: "w_s1", Name: "daily", State: "active"})
	})
}

func TestScheduleScopeSelectorsIsolateSessions(t *testing.T) {
	s := openTest(t)
	seedScheduleScope(t, s)
	for _, scope := range []model.Scope{{SessionID: "s1"}, {WorkspaceID: "ws_s1"}, {WorkerID: "w_s1"}, {SessionID: "s1", WorkerID: "w_s1"}} {
		var scheds []model.Schedule
		if err := s.List(ctx, "schedules", scope, &scheds); err != nil || len(scheds) != 1 || scheds[0].ID != "sched_s1" {
			t.Fatalf("schedules %+v: %+v %v", scope, scheds, err)
		}
		var runs []model.ScheduleRun
		if err := s.List(ctx, "schedule_runs", scope, &runs); err != nil || len(runs) != 1 || runs[0].ID != "srun_s1" {
			t.Fatalf("runs %+v: %+v %v", scope, runs, err)
		}
	}
	var none []model.Schedule
	if err := s.List(ctx, "schedules", model.Scope{SessionID: "s1", WorkspaceID: "ws_s2"}, &none); err != nil || len(none) != 0 {
		t.Fatalf("cross-session scope leaked: %+v %v", none, err)
	}
	if err := s.List(ctx, "schedules", model.Scope{WorktreeID: "wt_none", RunID: "run_none"}, &none); err != nil || len(none) != 0 {
		t.Fatalf("worktree/run selectors: %+v %v", none, err)
	}
	var all []model.Schedule
	if err := s.List(ctx, "schedules", model.Scope{Global: true}, &all); err != nil || len(all) != 2 {
		t.Fatalf("global: %+v %v", all, err)
	}
}
