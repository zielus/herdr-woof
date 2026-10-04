// Package store is Woof's canonical SQLite persistence boundary. The daemon must
// hold its global ownership lock before Open; clients never open this store.
// SQLite connection, migration and transaction patterns adapted from herdr-orch
// internal/store/store.go, copyright (c) 2026 Stephen Ellington (MIT).
// See DONOR_LICENSE.txt for the retained donor license.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"reflect"
	"strings"
	"time"

	"github.com/zielus/herdr-woof-v2/internal/model"
	"modernc.org/sqlite"
)

// Store serializes all access through one SQLite connection.
type Store struct{ db *sql.DB }

// Tx exposes record and event operations on one atomic write transaction.
// It must not be retained or used after the Write callback returns.
type Tx struct {
	ctx    context.Context
	sql    *sql.Tx
	events []model.Event
}

type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// Each column is both an indexed relationship/identity and a field in record_json.
// Names are internal constants, never caller-controlled SQL identifiers.
var columns = map[string][]string{
	"sessions":   {"herdr_name", "socket_path", "status"},
	"workspaces": {"session_id"},
	"worktrees":  {"session_id", "workspace_id", "owner_run_id"},
	"runs":       {"session_id", "workspace_id", "worktree_id", "invoker_worker_id"},
	"workers":    {"session_id", "workspace_id", "worktree_id", "run_id", "name", "state", "pane_id", "attachment_id"},
	"messages":   {"session_id", "workspace_id", "worktree_id", "run_id", "from_worker_id", "to_kind", "to_id", "reply_to_message_id", "dispatch_id"},
	"deliveries": {"message_id", "worker_id", "session_id", "workspace_id", "run_id", "human"},
	"dispatches": {"session_id", "workspace_id", "worktree_id", "run_id", "worker_id", "attachment_id", "done_message_id", "status"},
	"gates":      {"session_id", "workspace_id", "run_id", "status"},
	"operations": {"fingerprint", "state"},
}

func refusal(code, format string, args ...any) error {
	return &model.Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

func databaseError(err error) error {
	if err == nil {
		return nil
	}
	var e *sqlite.Error
	if errors.As(err, &e) {
		switch e.Code() & 255 {
		case 5, 6:
			return refusal("busy", "database is busy: %s", err)
		case 19:
			switch {
			case strings.Contains(err.Error(), "workers.workspace_id, workers.name"):
				return refusal("name_conflict", "worker alias is already reserved in this workspace")
			case strings.Contains(err.Error(), "dispatches.worker_id"):
				return refusal("busy_worker", "worker already has an active dispatch (including an uncertain dispatch)")
			default:
				return refusal("conflict", "database constraint refused the change: %s", err)
			}
		}
	}
	return err
}

func Open(path string) (*Store, error) {
	if path == "" {
		return nil, refusal("invalid_path", "database path is required")
	}
	dsn := path
	if path != ":memory:" {
		dsn = (&url.URL{Scheme: "file", Path: path}).String()
	}
	dsn += "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}
func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Write(ctx context.Context, fn func(*Tx) error) (events []model.Event, err error) {
	sqltx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, databaseError(err)
	}
	defer rollback(sqltx, &err)
	tx := &Tx{ctx: ctx, sql: sqltx, events: []model.Event{}}
	if err := fn(tx); err != nil {
		return nil, databaseError(err)
	}
	if err := sqltx.Commit(); err != nil {
		return nil, databaseError(err)
	}
	return tx.events, nil
}

// Rollback is also deferred after a successful commit and after database/sql
// rolls back a canceled context. ErrTxDone is expected in those cases. Other
// cleanup failures must retain the original error (including model.Error codes).
func rollback(tx *sql.Tx, resultErr *error) {
	if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
		*resultErr = errors.Join(*resultErr, fmt.Errorf("rollback transaction: %w", err))
	}
}

func closeRows(rows *sql.Rows, resultErr *error) {
	if err := rows.Close(); err != nil {
		*resultErr = errors.Join(*resultErr, fmt.Errorf("close query rows: %w", err))
	}
}

func (s *Store) Get(ctx context.Context, kind, id string, dst any) error {
	return get(ctx, s.db, kind, id, dst)
}
func (t *Tx) Get(kind, id string, dst any) error { return get(t.ctx, t.sql, kind, id, dst) }
func get(ctx context.Context, q queryer, kind, id string, dst any) error {
	if _, ok := columns[kind]; !ok {
		return refusal("invalid_kind", "unknown record kind %q", kind)
	}
	var data []byte
	err := q.QueryRowContext(ctx, "SELECT record_json FROM "+kind+" WHERE id=?", id).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return refusal("not_found", "no %s record %q", kind, id)
	}
	if err != nil {
		return databaseError(err)
	}
	return json.Unmarshal(data, dst)
}

func (t *Tx) Put(kind, id string, value any) error {
	cols, ok := columns[kind]
	if !ok {
		return refusal("invalid_kind", "unknown record kind %q", kind)
	}
	data, err := json.Marshal(value)
	if err != nil {
		return refusal("invalid_record", "encode %s: %v", kind, err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return refusal("invalid_record", "%s record must be an object", kind)
	}
	var recordID string
	if err := json.Unmarshal(fields["id"], &recordID); err != nil || id == "" || recordID != id {
		return refusal("invalid_record", "record id must equal nonempty key %q", id)
	}
	names := []string{"id", "record_json"}
	args := []any{id, string(data)}
	updates := []string{"record_json=excluded.record_json"}
	for _, col := range cols {
		names = append(names, col)
		updates = append(updates, col+"=excluded."+col)
		var value any
		raw := fields[col]
		if col == "human" {
			var b bool
			if len(raw) > 0 {
				if err := json.Unmarshal(raw, &b); err != nil {
					return refusal("invalid_record", "human must be boolean")
				}
			}
			if b {
				value = 1
			} else {
				value = 0
			}
		} else {
			var v string
			if len(raw) > 0 {
				if err := json.Unmarshal(raw, &v); err != nil {
					return refusal("invalid_record", "%s must be a string", col)
				}
			}
			if strings.HasSuffix(col, "_id") && v == "" {
				value = nil
			} else {
				value = v
			}
		}
		args = append(args, value)
	}
	query := "INSERT INTO " + kind + "(" + strings.Join(names, ",") + ") VALUES(" + placeholders(len(args)) + ") ON CONFLICT(id) DO UPDATE SET " + strings.Join(updates, ",")
	_, err = t.sql.ExecContext(t.ctx, query, args...)
	return databaseError(err)
}

func (s *Store) List(ctx context.Context, kind string, scope model.Scope, dst any) error {
	return list(ctx, s.db, kind, scope, dst)
}
func (t *Tx) List(kind string, scope model.Scope, dst any) error {
	return list(t.ctx, t.sql, kind, scope, dst)
}
func list(ctx context.Context, q queryer, kind string, scope model.Scope, dst any) (err error) {
	if _, ok := columns[kind]; !ok {
		return refusal("invalid_kind", "unknown record kind %q", kind)
	}
	v := reflect.ValueOf(dst)
	if !v.IsValid() || v.Kind() != reflect.Pointer || v.IsNil() || v.Elem().Kind() != reflect.Slice {
		return refusal("invalid_destination", "List destination must be a nonnil pointer to a slice")
	}
	where, args, err := scopeWhere(kind, scope)
	if err != nil {
		return err
	}
	rows, err := q.QueryContext(ctx, "SELECT t.record_json FROM "+kind+" t WHERE "+where+" ORDER BY t.id", args...)
	if err != nil {
		return databaseError(err)
	}
	defer closeRows(rows, &err)
	result := reflect.MakeSlice(v.Elem().Type(), 0, 0)
	for rows.Next() {
		var data []byte
		if err := rows.Scan(&data); err != nil {
			return err
		}
		elem := reflect.New(result.Type().Elem())
		if err := json.Unmarshal(data, elem.Interface()); err != nil {
			return err
		}
		result = reflect.Append(result, elem.Elem())
	}
	if err := rows.Err(); err != nil {
		return databaseError(err)
	}
	v.Elem().Set(result)
	return nil
}

func (t *Tx) Event(eventType string, scope model.Scope, actorKind, actorID string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	scope.Global = false
	e := model.Event{ID: "e_" + hex.EncodeToString(random[:]), Type: eventType, Scope: scope, ActorKind: actorKind, ActorID: actorID, Payload: data, CreatedAt: time.Now().UnixMilli()}
	result, err := t.sql.ExecContext(t.ctx, `INSERT INTO events(event_id,type,session_id,workspace_id,worktree_id,run_id,worker_id,actor_kind,actor_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, e.ID, e.Type, nullable(scope.SessionID), nullable(scope.WorkspaceID), nullable(scope.WorktreeID), nullable(scope.RunID), nullable(scope.WorkerID), actorKind, nullable(actorID), string(data), e.CreatedAt)
	if err != nil {
		return databaseError(err)
	}
	e.Seq, err = result.LastInsertId()
	if err != nil {
		return err
	}
	t.events = append(t.events, e)
	return nil
}
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func placeholders(n int) string { return strings.TrimSuffix(strings.Repeat("?,", n), ",") }

func (s *Store) Head(ctx context.Context) (int64, error) {
	var seq int64
	err := s.db.QueryRowContext(ctx, "SELECT COALESCE(MAX(seq),0) FROM events").Scan(&seq)
	return seq, databaseError(err)
}

func (s *Store) Events(ctx context.Context, since int64, scope model.Scope, types []string, limit int) (events []model.Event, err error) {
	where, args, err := scopeWhere("events", scope)
	if err != nil {
		return nil, err
	}
	where += " AND t.seq>?"
	args = append(args, since)
	if len(types) > 0 {
		where += " AND t.type IN (" + placeholders(len(types)) + ")"
		for _, typ := range types {
			args = append(args, typ)
		}
	}
	query := `SELECT seq,event_id,type,COALESCE(session_id,''),COALESCE(workspace_id,''),COALESCE(worktree_id,''),COALESCE(run_id,''),COALESCE(worker_id,''),actor_kind,COALESCE(actor_id,''),payload_json,created_at FROM events t WHERE ` + where + ` ORDER BY seq`
	if limit > 0 {
		query += " LIMIT ?"
		args = append(args, limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, databaseError(err)
	}
	defer closeRows(rows, &err)
	result := []model.Event{}
	for rows.Next() {
		var e model.Event
		var payload string
		if err := rows.Scan(&e.Seq, &e.ID, &e.Type, &e.SessionID, &e.WorkspaceID, &e.WorktreeID, &e.RunID, &e.WorkerID, &e.ActorKind, &e.ActorID, &payload, &e.CreatedAt); err != nil {
			return nil, err
		}
		e.Payload = json.RawMessage(payload)
		result = append(result, e)
	}
	return result, databaseError(rows.Err())
}

// EventTail returns at most the latest 500 matching events in ascending order.
// Capture the global head first: append-only events committed during the query
// belong to follow replay, including when this scope has no matching history.
func (s *Store) EventTail(ctx context.Context, scope model.Scope, types []string, limit int) (tail model.EventTail, err error) {
	head, err := s.Head(ctx)
	if err != nil {
		return tail, err
	}
	tail.EventCursor = head
	tail.Events = []model.Event{}
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	where, args, err := scopeWhere("events", scope)
	if err != nil {
		return tail, err
	}
	where += " AND t.seq<=?"
	args = append(args, head)
	if len(types) > 0 {
		where += " AND t.type IN (" + placeholders(len(types)) + ")"
		for _, typ := range types {
			args = append(args, typ)
		}
	}
	args = append(args, limit)
	query := `SELECT seq,event_id,type,COALESCE(session_id,''),COALESCE(workspace_id,''),COALESCE(worktree_id,''),COALESCE(run_id,''),COALESCE(worker_id,''),actor_kind,COALESCE(actor_id,''),payload_json,created_at FROM events t WHERE ` + where + ` ORDER BY seq DESC LIMIT ?`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return tail, databaseError(err)
	}
	defer closeRows(rows, &err)
	for rows.Next() {
		var ev model.Event
		var payload string
		if err := rows.Scan(&ev.Seq, &ev.ID, &ev.Type, &ev.SessionID, &ev.WorkspaceID, &ev.WorktreeID, &ev.RunID, &ev.WorkerID, &ev.ActorKind, &ev.ActorID, &payload, &ev.CreatedAt); err != nil {
			return tail, err
		}
		ev.Payload = json.RawMessage(payload)
		tail.Events = append(tail.Events, ev)
	}
	for i, j := 0, len(tail.Events)-1; i < j; i, j = i+1, j-1 {
		tail.Events[i], tail.Events[j] = tail.Events[j], tail.Events[i]
	}
	return tail, databaseError(rows.Err())
}
