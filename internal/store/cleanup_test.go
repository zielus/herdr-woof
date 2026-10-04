package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/zielus/herdr-woof/internal/model"
	"modernc.org/sqlite"
)

// This driver injects failures at database/sql's cleanup boundary, which SQLite
// cannot reliably produce on demand.
type cleanupFixture struct {
	rollbackErr error
	closeErr    error
	value       driver.Value
	read        bool
}

func (f *cleanupFixture) Connect(context.Context) (driver.Conn, error) { return f, nil }
func (f *cleanupFixture) Driver() driver.Driver                        { return f }
func (f *cleanupFixture) Open(string) (driver.Conn, error)             { return f, nil }
func (f *cleanupFixture) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("fixture does not prepare statements")
}
func (f *cleanupFixture) Close() error              { return nil }
func (f *cleanupFixture) Begin() (driver.Tx, error) { return f, nil }
func (f *cleanupFixture) Commit() error             { return nil }
func (f *cleanupFixture) Rollback() error           { return f.rollbackErr }
func (f *cleanupFixture) QueryContext(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
	return &cleanupRows{fixture: f}, nil
}

type cleanupRows struct{ fixture *cleanupFixture }

func (*cleanupRows) Columns() []string { return []string{"value"} }
func (r *cleanupRows) Close() error    { return r.fixture.closeErr }
func (r *cleanupRows) Next(values []driver.Value) error {
	if r.fixture.read {
		return io.EOF
	}
	r.fixture.read = true
	values[0] = r.fixture.value
	return nil
}

func fixtureStore(t *testing.T, f *cleanupFixture) *Store {
	t.Helper()
	db := sql.OpenDB(f)
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close fixture database: %v", err)
		}
	})
	return &Store{db: db}
}

func TestWritePreservesCallbackAndRollbackErrors(t *testing.T) {
	rollbackErr := errors.New("rollback failed")
	callbackErr := &model.Error{Code: "conflict", Message: "callback refused change"}
	s := fixtureStore(t, &cleanupFixture{rollbackErr: rollbackErr})
	events, err := s.Write(ctx, func(*Tx) error { return callbackErr })
	if !errors.Is(err, callbackErr) || !errors.Is(err, rollbackErr) || len(events) != 0 {
		t.Fatalf("write must retain both errors and no events: %v, %v", events, err)
	}
	wantCode(t, err, "conflict")
}

func TestMigrationPreservesVersionAndRollbackErrors(t *testing.T) {
	rollbackErr := errors.New("rollback failed")
	s := fixtureStore(t, &cleanupFixture{rollbackErr: rollbackErr, value: int64(999)})
	err := s.migrate()
	if !errors.Is(err, rollbackErr) || !strings.Contains(err.Error(), "schema version 999") {
		t.Fatalf("migration must retain version refusal and rollback error: %v", err)
	}
}

func TestListReportsCloseErrorAtEndOfRows(t *testing.T) {
	closeErr := errors.New("row close failed")
	s := fixtureStore(t, &cleanupFixture{closeErr: closeErr, value: `{ "id": "s_a" }`})
	var records []model.Session
	err := s.List(ctx, "sessions", model.Scope{}, &records)
	if !errors.Is(err, closeErr) || len(records) != 0 {
		t.Fatalf("list must check rows.Err before exposing records: %v, %v", records, err)
	}
}

func TestEventsPreservesScanAndCloseErrors(t *testing.T) {
	closeErr := errors.New("row close failed")
	// Events expects twelve columns; this one-column fixture fails Scan before
	// iteration completes, requiring deferred cleanup to preserve both failures.
	s := fixtureStore(t, &cleanupFixture{closeErr: closeErr, value: int64(1)})
	events, err := s.Events(ctx, 0, model.Scope{}, nil, 0)
	if !errors.Is(err, closeErr) || !strings.Contains(err.Error(), "Scan") || len(events) != 0 {
		t.Fatalf("events must retain scan and close errors: %v, %v", events, err)
	}
}

func TestListPreservesDecodeAndCloseErrors(t *testing.T) {
	closeErr := errors.New("row close failed")
	s := fixtureStore(t, &cleanupFixture{closeErr: closeErr, value: "{"})
	var records []model.Session
	err := s.List(ctx, "sessions", model.Scope{}, &records)
	var syntaxErr *json.SyntaxError
	if !errors.As(err, &syntaxErr) || !errors.Is(err, closeErr) {
		t.Fatalf("list must retain decode and close errors: %v", err)
	}
}

func TestCleanupPreservesSQLiteConstraintCause(t *testing.T) {
	realStore := openTest(t)
	if _, err := realStore.db.Exec(`CREATE TABLE cleanup_constraint(value INTEGER CHECK(value > 0))`); err != nil {
		t.Fatal(err)
	}
	_, cleanupErr := realStore.db.Exec(`INSERT INTO cleanup_constraint VALUES(-1)`)
	var original *sqlite.Error
	if !errors.As(cleanupErr, &original) || original.Code()&255 != 19 {
		t.Fatalf("fixture must produce a SQLite constraint error: %v", cleanupErr)
	}
	t.Run("rollback", func(t *testing.T) {
		primary := &model.Error{Code: "refused", Message: "callback refused change"}
		s := fixtureStore(t, &cleanupFixture{rollbackErr: cleanupErr})
		_, err := s.Write(ctx, func(*Tx) error { return primary })
		var got *sqlite.Error
		if !errors.Is(err, primary) || !errors.Is(err, cleanupErr) || !errors.As(err, &got) || got != original {
			t.Fatalf("rollback lost primary or SQLite cause: %v", err)
		}
		wantCode(t, err, "refused")
	})
	t.Run("close rows", func(t *testing.T) {
		s := fixtureStore(t, &cleanupFixture{closeErr: cleanupErr, value: "{"})
		var records []model.Session
		err := s.List(ctx, "sessions", model.Scope{}, &records)
		var syntaxErr *json.SyntaxError
		var got *sqlite.Error
		if !errors.As(err, &syntaxErr) || !errors.Is(err, cleanupErr) || !errors.As(err, &got) || got != original {
			t.Fatalf("row close lost decode or SQLite cause: %v", err)
		}
	})
}
