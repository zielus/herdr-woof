package store

import "fmt"

// Migrations and append-only guards adapted from herdr-orch's transactional
// schema migration pattern and plan_events protection (MIT).
const schemaVersion = 2
const schema = `
CREATE TABLE sessions(id TEXT PRIMARY KEY, herdr_name TEXT NOT NULL, socket_path TEXT NOT NULL, status TEXT NOT NULL, record_json TEXT NOT NULL);
CREATE TABLE workspaces(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), record_json TEXT NOT NULL);
CREATE TABLE worktrees(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), owner_run_id TEXT REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED, record_json TEXT NOT NULL);
CREATE TABLE runs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), workspace_id TEXT REFERENCES workspaces(id), worktree_id TEXT REFERENCES worktrees(id), invoker_worker_id TEXT REFERENCES workers(id) DEFERRABLE INITIALLY DEFERRED, record_json TEXT NOT NULL);
CREATE TABLE workers(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), worktree_id TEXT REFERENCES worktrees(id), run_id TEXT REFERENCES runs(id), name TEXT NOT NULL, state TEXT NOT NULL, pane_id TEXT, attachment_id TEXT, record_json TEXT NOT NULL);
CREATE UNIQUE INDEX workers_active_alias ON workers(workspace_id,name) WHERE state NOT IN ('released','stopped','failed');
CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id), workspace_id TEXT REFERENCES workspaces(id), worktree_id TEXT REFERENCES worktrees(id), run_id TEXT REFERENCES runs(id), from_worker_id TEXT REFERENCES workers(id), to_kind TEXT NOT NULL, to_id TEXT, reply_to_message_id TEXT REFERENCES messages(id), dispatch_id TEXT REFERENCES dispatches(id) DEFERRABLE INITIALLY DEFERRED, record_json TEXT NOT NULL);
CREATE TABLE deliveries(id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id), worker_id TEXT REFERENCES workers(id), session_id TEXT REFERENCES sessions(id), workspace_id TEXT REFERENCES workspaces(id), run_id TEXT REFERENCES runs(id), human INTEGER NOT NULL CHECK(human IN (0,1)), record_json TEXT NOT NULL);
CREATE UNIQUE INDEX deliveries_worker ON deliveries(message_id,worker_id) WHERE worker_id IS NOT NULL;
CREATE UNIQUE INDEX deliveries_human ON deliveries(message_id) WHERE human=1;
CREATE TABLE dispatches(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), worktree_id TEXT REFERENCES worktrees(id), run_id TEXT NOT NULL REFERENCES runs(id), worker_id TEXT NOT NULL REFERENCES workers(id), attachment_id TEXT, done_message_id TEXT REFERENCES messages(id) DEFERRABLE INITIALLY DEFERRED, status TEXT NOT NULL, record_json TEXT NOT NULL);
CREATE UNIQUE INDEX dispatches_active_worker ON dispatches(worker_id) WHERE status NOT IN ('completed','failed','canceled','cancelled','stopped','released','settled');
CREATE TABLE gates(id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id), workspace_id TEXT REFERENCES workspaces(id), run_id TEXT REFERENCES runs(id), status TEXT NOT NULL, record_json TEXT NOT NULL);
CREATE TABLE operations(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, record_json TEXT NOT NULL);
CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, session_id TEXT, workspace_id TEXT, worktree_id TEXT, run_id TEXT, worker_id TEXT, actor_kind TEXT NOT NULL, actor_id TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX events_session_seq ON events(session_id,seq);
CREATE INDEX events_workspace_seq ON events(workspace_id,seq);
CREATE INDEX events_worktree_seq ON events(worktree_id,seq);
CREATE INDEX events_run_seq ON events(run_id,seq);
CREATE INDEX events_worker_seq ON events(worker_id,seq);
CREATE INDEX workers_session ON workers(session_id);
CREATE INDEX workers_run ON workers(run_id);
CREATE INDEX workers_worktree ON workers(worktree_id);
CREATE INDEX messages_run ON messages(run_id);
CREATE INDEX messages_sender ON messages(from_worker_id);
CREATE INDEX messages_reply ON messages(reply_to_message_id);
CREATE INDEX deliveries_worker_scope ON deliveries(worker_id,run_id);
CREATE INDEX dispatches_run ON dispatches(run_id);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'events is append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'events is append-only'); END;
CREATE TRIGGER events_no_replace BEFORE INSERT ON events
 WHEN EXISTS(SELECT 1 FROM events WHERE seq=NEW.seq OR event_id=NEW.event_id)
 BEGIN SELECT RAISE(ABORT,'events is append-only'); END;
-- BEFORE INSERT sees -1 for an automatically assigned rowid, so sequence
-- monotonicity must be checked after SQLite has assigned the actual rowid.
CREATE TRIGGER events_monotonic AFTER INSERT ON events
 WHEN NEW.seq <= COALESCE((SELECT MAX(seq) FROM events WHERE seq != NEW.seq),0)
 BEGIN SELECT RAISE(ABORT,'event sequence must increase'); END;
`

// Migration 2 adds the native time scheduler. Version 1 DDL above stays
// byte-identical so existing databases migrate by adding tables only.
const schemaV2 = `
CREATE TABLE schedules(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), worker_id TEXT NOT NULL REFERENCES workers(id), name TEXT NOT NULL, state TEXT NOT NULL, record_json TEXT NOT NULL);
CREATE UNIQUE INDEX schedules_active_name ON schedules(workspace_id,name) WHERE state != 'removed';
CREATE INDEX schedules_session ON schedules(session_id);
CREATE INDEX schedules_worker ON schedules(worker_id);
CREATE TABLE schedule_runs(id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES schedules(id), session_id TEXT NOT NULL REFERENCES sessions(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), worker_id TEXT NOT NULL REFERENCES workers(id), run_id TEXT REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED, occurrence_key TEXT NOT NULL, state TEXT NOT NULL, dispatch_id TEXT REFERENCES dispatches(id) DEFERRABLE INITIALLY DEFERRED, message_id TEXT REFERENCES messages(id) DEFERRABLE INITIALLY DEFERRED, record_json TEXT NOT NULL);
CREATE UNIQUE INDEX schedule_runs_occurrence ON schedule_runs(schedule_id,occurrence_key);
CREATE INDEX schedule_runs_schedule_state ON schedule_runs(schedule_id,state);
CREATE INDEX schedule_runs_worker ON schedule_runs(worker_id);
CREATE INDEX schedule_runs_run ON schedule_runs(run_id);
CREATE INDEX schedule_runs_state ON schedule_runs(state);
`

func (s *Store) migrate() (err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return databaseError(err)
	}
	defer rollback(tx, &err)
	var version int
	if err := tx.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}
	if version > schemaVersion {
		return fmt.Errorf("database schema version %d is newer than supported version %d", version, schemaVersion)
	}
	if version == 0 {
		if _, err := tx.Exec(schema); err != nil {
			return fmt.Errorf("migration 1: %w", err)
		}
		version = 1
	}
	if version == 1 {
		if _, err := tx.Exec(schemaV2); err != nil {
			return fmt.Errorf("migration 2: %w", err)
		}
	}
	if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version=%d`, schemaVersion)); err != nil {
		return err
	}
	return databaseError(tx.Commit())
}
