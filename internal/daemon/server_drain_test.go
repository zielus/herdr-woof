package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/zielus/herdr-woof-v2/internal/model"
)

type failingAcceptListener struct {
	conn      net.Conn
	writing   <-chan struct{}
	failed    chan struct{}
	acceptErr error
	accepted  bool
}

func (l *failingAcceptListener) Close() error   { return nil }
func (l *failingAcceptListener) Addr() net.Addr { return &net.UnixAddr{Name: "fixture", Net: "unix"} }

func (l *failingAcceptListener) Accept() (net.Conn, error) {
	if !l.accepted {
		l.accepted = true
		return l.conn, nil
	}
	<-l.writing
	close(l.failed)
	return nil, l.acceptErr
}

// Blocking the response keeps a real RPC handler active when Accept fails.
type blockedResponseConn struct {
	net.Conn
	writing chan struct{}
	release <-chan struct{}
	once    sync.Once
}

func (c *blockedResponseConn) Write([]byte) (int, error) {
	c.once.Do(func() { close(c.writing) })
	<-c.release
	return 0, net.ErrClosed
}

func TestServeDrainsHandlersAfterAcceptFailure(t *testing.T) {
	e := eventsEngine(t)
	server, client := net.Pipe()
	defer func() { _ = client.Close() }() // Close the peer even if the assertion fails.
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	writing := make(chan struct{})
	acceptErr := errors.New("listener failure")
	ln := &failingAcceptListener{conn: &blockedResponseConn{Conn: server, writing: writing, release: release}, writing: writing, failed: make(chan struct{}), acceptErr: acceptErr}
	done := make(chan error, 1)
	go func() { done <- Serve(context.Background(), ln, e) }()
	if _, err := client.Write([]byte("{\"version\":1,\"op\":\"ping\"}\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ln.failed:
	case <-time.After(time.Second):
		t.Fatal("listener did not fail after response started")
	}
	select {
	case err := <-done:
		t.Fatalf("Serve returned before the active handler drained: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	unblock()
	select {
	case err := <-done:
		if !errors.Is(err, acceptErr) {
			t.Fatalf("lost listener error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Serve did not finish after handler drained")
	}
}

func TestWriteResponsePreservesJoinedCodedError(t *testing.T) {
	coded := &model.Error{Code: "uncertain", Message: "mutation outcome unknown", OperationID: "op_cleanup"}
	cleanupErr := errors.New("rollback failed")
	joined := errors.Join(coded, cleanupErr)
	var response bytes.Buffer
	if err := writeResponse(&response, nil, joined); err != nil {
		t.Fatal(err)
	}
	var got model.Response
	if err := json.Unmarshal(response.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.OK || got.Error == nil || got.Error.Code != coded.Code || got.Error.OperationID != coded.OperationID || got.Error.Message != joined.Error() {
		t.Fatalf("lost coded error or rollback evidence: %+v", got)
	}
	if coded.Message != "mutation outcome unknown" {
		t.Fatalf("serialization mutated the original error: %+v", coded)
	}
}
