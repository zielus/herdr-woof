package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"strings"
	"testing"

	"github.com/zielus/herdr-woof-v2/internal/model"
	"modernc.org/sqlite"
)

// Interpose only the SQLite query boundary; persistence and filtering remain
// real. A writer commits after Head but before the tail SELECT executes.
type tailConnector struct {
	path        string
	beforeQuery func()
}

func (c tailConnector) Driver() driver.Driver { return &sqlite.Driver{} }
func (c tailConnector) Connect(context.Context) (driver.Conn, error) {
	d, err := c.Driver().Open(c.path)
	if err != nil {
		return nil, err
	}
	return &tailConnection{Conn: d, beforeQuery: c.beforeQuery}, nil
}

type tailConnection struct {
	driver.Conn
	beforeQuery func()
}

func (c *tailConnection) QueryContext(ctx context.Context, q string, args []driver.NamedValue) (driver.Rows, error) {
	if strings.Contains(q, "ORDER BY seq DESC") {
		c.beforeQuery()
	}
	d, ok := c.Conn.(driver.QueryerContext)
	if !ok {
		return nil, errors.New("SQLite driver lacks QueryContext")
	}
	return d.QueryContext(ctx, q, args)
}

func TestEventTailExcludesCommitAfterCapturedHead(t *testing.T) {
	writer := openTest(t)
	// Database location is inspected from SQLite, avoiding a replacement fake
	// event store or a production-only hook.
	var seq int
	var name, path string
	if err := writer.db.QueryRow("PRAGMA database_list").Scan(&seq, &name, &path); err != nil {
		t.Fatal(err)
	}
	writeTest(t, writer, func(tx *Tx) error {
		return tx.Event("worker.observed", model.Scope{SessionID: "s_a"}, "human", "", nil)
	})
	db := sql.OpenDB(tailConnector{path: path, beforeQuery: func() {
		writeTest(t, writer, func(tx *Tx) error {
			return tx.Event("worker.observed", model.Scope{SessionID: "s_a"}, "human", "", nil)
		})
	}})
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	reader := &Store{db: db}
	tail, err := reader.EventTail(ctx, model.Scope{SessionID: "s_a"}, nil, 500)
	if err != nil {
		t.Fatal(err)
	}
	if tail.EventCursor != 1 || len(tail.Events) != 1 || tail.Events[0].Seq != 1 {
		t.Fatalf("raced commit crossed snapshot boundary: %+v", tail)
	}
	replay, err := writer.Events(ctx, tail.EventCursor, model.Scope{SessionID: "s_a"}, nil, 0)
	if err != nil || len(replay) != 1 || replay[0].Seq != 2 {
		t.Fatalf("raced commit missing from replay: %+v %v", replay, err)
	}
}
