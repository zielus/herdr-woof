package rpc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"github.com/zielus/herdr-woof/internal/model"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func fixture(t *testing.T, reply string, hold bool) string {
	t.Helper()
	d, e := os.MkdirTemp("/tmp", "woof-rpc-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { checkTestError(t, os.RemoveAll(d)) })
	s := filepath.Join(d, "s")
	l, e := net.Listen("unix", s)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { closeTestResource(t, l) })
	go func() {
		c, e := l.Accept()
		if e != nil {
			return
		}
		defer closeTestResource(t, c)
		if _, err := bufio.NewReader(c).ReadBytes('\n'); err != nil {
			t.Error(err)
			return
		}
		if hold {
			b := make([]byte, 1)
			if _, err := c.Read(b); err == nil {
				t.Error("expected client cancellation to close the connection")
			}
			return
		}
		if _, err := io.WriteString(c, reply); err != nil {
			t.Error(err)
			return
		}
	}()
	return s
}
func TestUncertainReply(t *testing.T) {
	for _, reply := range []string{"", "nope\n", `{"version":1,"ok":true}`, `{"version":2,"ok":true}` + "\n", `{"version":1,"ok":true,"result":"bad"}` + "\n"} {
		t.Run(reply, func(t *testing.T) {
			var out int
			err := Call(context.Background(), fixture(t, reply, false), model.Request{Version: 1, ID: "op-x", Op: "send"}, &out)
			if !errors.Is(err, ErrLost) {
				t.Fatalf("want uncertainty, got %v", err)
			}
		})
	}
}
func TestCancellationAfterSend(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	err := Call(ctx, fixture(t, "", true), model.Request{Version: 1, Op: "send"}, nil)
	if !errors.Is(err, ErrLost) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v", err)
	}
}
func TestUnavailableAndServerError(t *testing.T) {
	err := Call(context.Background(), "/tmp/woof-definitely-absent", model.Request{Version: 1}, nil)
	if !errors.Is(err, ErrUnavailable) || errors.Is(err, ErrLost) {
		t.Fatal(err)
	}
	err = Call(context.Background(), fixture(t, `{"version":1,"ok":false,"error":{"code":"refused","message":"safe"}}`+"\n", false), model.Request{Version: 1}, nil)
	var e *model.Error
	if !errors.As(err, &e) || e.Code != "refused" || errors.Is(err, ErrLost) {
		t.Fatal(err)
	}
}

type partialWriter struct{}

func (partialWriter) Write(p []byte) (int, error) { return 1, io.ErrClosedPipe }
func TestPartialWriteUnknown(t *testing.T) {
	err := writeRequest(partialWriter{}, []byte("request\n"))
	if !errors.Is(err, ErrLost) || errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
}
func TestStreamVersionAndFraming(t *testing.T) {
	for _, r := range []string{`{"version":2,"ok":true}` + "\n", `{"version":1,"ok":true}`} {
		err := Stream(context.Background(), fixture(t, r, false), model.Request{Version: 1}, func(_ json.RawMessage) error { return nil })
		if !errors.Is(err, ErrLost) {
			t.Fatal(err)
		}
	}
}
func TestCallsDoNotLeakCancellationWaiters(t *testing.T) {
	before := runtime.NumGoroutine()
	for i := 0; i < 30; i++ {
		e := Call(context.Background(), fixture(t, "{\"version\":1,\"ok\":true,\"result\":{}}\n", false), model.Request{Version: 1, Op: "ping"}, nil)
		if e != nil {
			t.Fatal(e)
		}
	}
	deadline := time.Now().Add(time.Second)
	for runtime.NumGoroutine() > before+2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := runtime.NumGoroutine(); n > before+2 {
		t.Fatalf("calls leaked cancellation waiters: before %d after %d", before, n)
	}
}

func checkTestError(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Error(err)
	}
}

func closeTestResource(t *testing.T, c io.Closer) {
	t.Helper()
	// Explicit listener shutdown may precede its registered cleanup.
	if err := c.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		t.Error(err)
	}
}
