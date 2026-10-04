// Lost-request test adapted from herdr-orch (MIT, Copyright (c) 2026 Stephen Ellington).
package client

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/paths"
	"golang.org/x/sys/unix"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func fakeDaemon(t *testing.T) (string, func(string) int, func(string) string) {
	t.Helper()
	d, e := os.MkdirTemp("/tmp", "woof-client-")
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
	var mu sync.Mutex
	counts := map[string]int{}
	ids := map[string]string{}
	go func() {
		for {
			c, e := l.Accept()
			if e != nil {
				return
			}
			go func() {
				defer closeTestResource(t, c)
				b, err := bufio.NewReader(c).ReadBytes('\n')
				if err != nil {
					t.Error(err)
					return
				}
				var r model.Request
				if err := json.Unmarshal(b, &r); err != nil {
					t.Error(err)
					return
				}
				mu.Lock()
				counts[r.Op]++
				ids[r.Op] = r.ID
				mu.Unlock()
				if r.Op == "ping" {
					if _, err := c.Write([]byte("{\"version\":1,\"ok\":true}\n")); err != nil {
						t.Error(err)
						return
					}
				}
			}()
		}
	}()
	return s, func(op string) int { mu.Lock(); defer mu.Unlock(); return counts[op] }, func(op string) string { mu.Lock(); defer mu.Unlock(); return ids[op] }
}
func TestLostRequestNotResent(t *testing.T) {
	s, count, id := fakeDaemon(t)
	c := &Client{Paths: paths.Paths{Sock: s}}
	for _, op := range []string{"ask", "send", "inbox.consume", "worker.start"} {
		err := c.Call(context.Background(), op, nil, nil)
		var e *model.Error
		if !errors.As(err, &e) || e.Code != "outcome_unknown" || e.OperationID == "" || e.OperationID != id(op) || !strings.Contains(e.Message, e.OperationID) {
			t.Fatalf("%s: %v", op, err)
		}
		if count(op) != 1 {
			t.Fatal("mutation repeated")
		}
	}
	for _, op := range []string{"status", "operation.list"} {
		if err := c.Call(context.Background(), op, nil, nil); err == nil {
			t.Fatalf("%s: expected lost read response", op)
		}
		if count(op) != 2 {
			t.Fatalf("%s read should retry once", op)
		}
	}
}
func TestNewContextAndDaemonEnvironment(t *testing.T) {
	t.Setenv("WOOF_STATE_DIR", t.TempDir())
	t.Setenv("WOOF_WORKER_ID", "w1")
	t.Setenv("WOOF_RUN_ID", "r1")
	t.Setenv("WOOF_ATTACHMENT_ID", "a1")
	t.Setenv("HERDR_PANE_ID", "w:p")
	t.Setenv("HERDR_SESSION", "stale")
	t.Setenv("HERDR_SOCKET_PATH", "socket")
	t.Setenv("HERDR_BIN_PATH", "custom")
	c, e := New()
	if e != nil {
		t.Fatal(e)
	}
	if c.Caller.WorkerID != "w1" || c.Caller.AttachmentID != "a1" || c.Scope.RunID != "r1" || c.Caller.ProcessID != os.Getpid() {
		t.Fatal(c)
	}
	env := daemonEnv(c.Paths)
	for _, v := range env {
		if strings.HasPrefix(v, "WOOF_WORKER_ID=") || strings.HasPrefix(v, "HERDR_SOCKET_PATH=") || strings.HasPrefix(v, "HERDR_SESSION=") || strings.HasPrefix(v, "WOOF_RUN_ID=") {
			t.Fatal(v)
		}
	}
	if !strings.Contains(strings.Join(env, "\n"), "HERDR_BIN_PATH=custom") {
		t.Fatal("daemon Herdr binary override missing")
	}
}

// The test binary acts as a standalone woofd fixture when launched with no argv.
func TestMain(m *testing.M) {
	if os.Getenv("WOOF_TEST_DAEMON") == "1" {
		os.Exit(runDaemonFixture())
	}
	os.Exit(m.Run())
}

func runDaemonFixture() (code int) {
	if path := os.Getenv("WOOF_TEST_LOCK"); path != "" {
		lock, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
		if err != nil {
			return 3
		}
		defer func() {
			if lock.Close() != nil {
				code = 3
			}
		}()
		if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			failed, err := os.OpenFile(os.Getenv("WOOF_TEST_REFUSED"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				return 3
			}
			_, writeErr := failed.WriteString("ownership refused\n")
			closeErr := failed.Close()
			if writeErr != nil || closeErr != nil {
				return 3
			}
			return 4
		}
	}
	l, err := net.Listen("unix", os.Getenv("WOOF_TEST_SOCKET"))
	if err != nil {
		return 2
	}
	defer func() {
		if l.Close() != nil {
			code = 2
		}
	}()
	f, err := os.OpenFile(os.Getenv("WOOF_TEST_STARTS"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return 2
	}
	encodeErr := json.NewEncoder(f).Encode(map[string]any{"pid": os.Getpid(), "sid": os.Getpid(), "argv": os.Args[1:], "env": daemonFixtureEnv()})
	closeErr := f.Close()
	if encodeErr != nil || closeErr != nil {
		return 2
	}
	for {
		c, err := l.Accept()
		if err != nil {
			return 2
		}
		_, readErr := bufio.NewReader(c).ReadBytes('\n')
		var writeErr error
		if readErr == nil {
			_, writeErr = c.Write([]byte("{\"version\":1,\"ok\":true}\n"))
		}
		closeErr := c.Close()
		if readErr != nil || writeErr != nil || closeErr != nil {
			return 2
		}
	}
}
func TestDetachedBootstrapDiscoverySerializesClients(t *testing.T) {
	d, e := os.MkdirTemp("/tmp", "woof-bootstrap-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { checkTestError(t, os.RemoveAll(d)) })
	t.Setenv("WOOF_STATE_DIR", d)
	t.Setenv("WOOF_CONFIG", filepath.Join(d, "config.yml"))
	c, e := New()
	if e != nil {
		t.Fatal(e)
	}
	exe, e := os.Executable()
	if e != nil {
		t.Fatal(e)
	}
	starts := filepath.Join(d, "starts")
	t.Setenv("WOOF_DAEMON_BIN", exe)
	t.Setenv("WOOF_TEST_DAEMON", "1")
	t.Setenv("WOOF_TEST_SOCKET", c.Paths.Sock)
	t.Setenv("WOOF_TEST_STARTS", starts)
	t.Cleanup(func() { cleanupDaemonProcesses(t, starts) })
	var wg sync.WaitGroup
	errs := make(chan error, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- c.EnsureDaemon(context.Background()) }()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	b, e := os.ReadFile(starts)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Count(string(b), "\n") != 1 {
		t.Fatalf("multiple daemon launches: %s", b)
	}
	var r struct {
		PID  int      `json:"pid"`
		Argv []string `json:"argv"`
		Env  []string `json:"env"`
	}
	if e = json.Unmarshal(b, &r); e != nil {
		t.Fatal(e)
	}
	if len(r.Argv) != 0 {
		t.Fatal(r.Argv)
	}
	if !strings.Contains(strings.Join(r.Env, "\n"), "WOOF_STATE_DIR="+c.Paths.Dir) {
		t.Fatal("daemon state override missing")
	}
	sid, e := unix.Getsid(r.PID)
	if e != nil || sid != r.PID {
		t.Fatalf("daemon not detached: %d %v", sid, e)
	}
	if e = c.EnsureDaemon(context.Background()); e != nil {
		t.Fatal(e)
	}
}

func daemonFixtureEnv() []string {
	var out []string
	for _, entry := range os.Environ() {
		if strings.HasPrefix(entry, "WOOF_") || strings.HasPrefix(entry, "HERDR_") {
			out = append(out, entry)
		}
	}
	return out
}

func waitDaemon(t *testing.T, handle func(model.Request, net.Conn)) string {
	t.Helper()
	d, err := os.MkdirTemp("/tmp", "woof-wait-client-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { checkTestError(t, os.RemoveAll(d)) })
	path := filepath.Join(d, "s")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeTestResource(t, ln) })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer closeTestResource(t, c)
				b, err := bufio.NewReader(c).ReadBytes('\n')
				if err != nil {
					t.Error(err)
					return
				}
				var r model.Request
				if err := json.Unmarshal(b, &r); err != nil {
					t.Error(err)
					return
				}
				handle(r, c)
			}()
		}
	}()
	return path
}

func TestWaitImplicitCursorSurvivesLostFirstReply(t *testing.T) {
	var mu sync.Mutex
	head, statuses, waits := int64(10), 0, 0
	requests := make(chan model.Request, 2)
	path := waitDaemon(t, func(r model.Request, conn net.Conn) {
		mu.Lock()
		defer mu.Unlock()
		switch r.Op {
		case "ping":
			if err := json.NewEncoder(conn).Encode(model.Response{Version: 1, OK: true}); err != nil {
				t.Error(err)
				return
			}
		case "status":
			statuses++
			b, _ := json.Marshal(map[string]int64{"event_cursor": head})
			if err := json.NewEncoder(conn).Encode(model.Response{Version: 1, OK: true, Result: b}); err != nil {
				t.Error(err)
				return
			}
		case "wait":
			requests <- r
			waits++
			if waits == 1 {
				// Event 11 matched this wait, but its reply is lost after commit.
				head = 11
				if _, err := conn.Write([]byte(`{"version":1,"ok":true,"result":`)); err != nil {
					t.Error(err)
					return
				}
				return
			}
			var a struct {
				Since *int64 `json:"since"`
			}
			if err := json.Unmarshal(r.Args, &a); err != nil {
				t.Error(err)
				return
			}
			if a.Since == nil || *a.Since >= 11 {
				if err := json.NewEncoder(conn).Encode(model.Response{Version: 1, Error: &model.Error{Code: "timeout", Message: "missed committed event"}}); err != nil {
					t.Error(err)
					return
				}
				return
			}
			if err := json.NewEncoder(conn).Encode(model.Response{Version: 1, OK: true, Result: json.RawMessage(`{"seq":11,"type":"gate.created"}`)}); err != nil {
				t.Error(err)
				return
			}
		}
	})
	c := &Client{Paths: paths.Paths{Sock: path}}
	var event model.Event
	if err := c.Call(context.Background(), "wait", map[string]any{"events": []string{"gate.created"}, "custom_field": "preserved"}, &event); err != nil {
		t.Fatal(err)
	}
	if event.Seq != 11 {
		t.Fatalf("event skipped: %+v", event)
	}
	mu.Lock()
	statusCount := statuses
	mu.Unlock()
	if statusCount != 1 {
		t.Fatalf("captured initial head %d times", statusCount)
	}
	for i := 0; i < 2; i++ {
		r := <-requests
		var a map[string]any
		if err := json.Unmarshal(r.Args, &a); err != nil {
			t.Error(err)
			return
		}
		if a["since"] != float64(10) || a["custom_field"] != "preserved" {
			t.Fatalf("retry changed arguments: %s", r.Args)
		}
	}
}

func TestWaitTimeoutUsesOneDeadlineAcrossReconnect(t *testing.T) {
	for _, op := range []string{"wait", "question.wait"} {
		t.Run(op, func(t *testing.T) {
			var mu sync.Mutex
			attempts := 0
			requests := make(chan model.Request, 2)
			path := waitDaemon(t, func(r model.Request, conn net.Conn) {
				if r.Op == "ping" {
					if err := json.NewEncoder(conn).Encode(model.Response{Version: 1, OK: true}); err != nil {
						t.Error(err)
						return
					}
					return
				}
				requests <- r
				mu.Lock()
				attempts++
				first := attempts == 1
				mu.Unlock()
				if first {
					time.Sleep(30 * time.Millisecond)
					return
				}
				var b [1]byte
				if _, err := conn.Read(b[:]); err == nil {
					t.Error("expected client cancellation to close the connection")
				}
			})
			ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
			defer cancel()
			c := &Client{Paths: paths.Paths{Sock: path}}
			start := time.Now()
			err := c.Call(ctx, op, map[string]any{"since": 10, "id": "msg_q", "timeout_ms": 80}, nil)
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("deadline error missing: %v", err)
			}
			if elapsed := time.Since(start); elapsed > 250*time.Millisecond {
				t.Fatalf("relative timeout reset on reconnect: %s", elapsed)
			}
			for i := 0; i < 2; i++ {
				r := <-requests
				var a map[string]any
				if err := json.Unmarshal(r.Args, &a); err != nil {
					t.Error(err)
					return
				}
				if a["timeout_ms"] != float64(0) || a["since"] != float64(10) {
					t.Fatalf("server received resettable timeout: %s", r.Args)
				}
			}
		})
	}
}

func ownershipFixture(t *testing.T) (*Client, *os.File) {
	t.Helper()
	d, err := os.MkdirTemp("/tmp", "woof-drain-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { checkTestError(t, os.RemoveAll(d)) })
	t.Setenv("WOOF_STATE_DIR", d)
	t.Setenv("WOOF_CONFIG", filepath.Join(d, "config.yml"))
	c, err := New()
	if err != nil {
		t.Fatal(err)
	}
	lock, err := os.OpenFile(c.Paths.Lock, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		closeTestResource(t, lock)
		t.Fatal(err)
	}
	t.Cleanup(func() {
		checkTestError(t, syscall.Flock(int(lock.Fd()), syscall.LOCK_UN))
		closeTestResource(t, lock)
	})
	return c, lock
}
func ownerReadServer(t *testing.T, path string, response func() string) (net.Listener, <-chan struct{}) {
	t.Helper()
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeTestResource(t, ln) })
	first := make(chan struct{})
	var once sync.Once
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer closeTestResource(t, conn)
				if _, err := bufio.NewReader(conn).ReadBytes('\n'); err != nil {
					t.Error(err)
					return
				}
				once.Do(func() { close(first) })
				if _, err := conn.Write([]byte(response())); err != nil {
					t.Error(err)
					return
				}
			}()
		}
	}()
	return ln, first
}
func TestEnsureDaemonWaitsForBusyOwnerToBecomeHealthy(t *testing.T) {
	c, _ := ownershipFixture(t)
	t.Setenv("WOOF_DAEMON_BIN", "/nonexistent/daemon-must-not-spawn")
	var mu sync.Mutex
	healthy := false
	_, first := ownerReadServer(t, c.Paths.Sock, func() string {
		mu.Lock()
		defer mu.Unlock()
		if healthy {
			return "{\"version\":1,\"ok\":true}\n"
		}
		return "" // closing listener accepts a ping but cannot return a response
	})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- c.EnsureDaemon(ctx) }()
	<-first
	select {
	case err := <-done:
		t.Fatalf("busy owner abandoned before health transition: %v", err)
	case <-time.After(80 * time.Millisecond):
	}
	mu.Lock()
	healthy = true
	mu.Unlock()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
func TestEnsureDaemonWaitsForReleasedOwnerAndSpawnsOnlyOnce(t *testing.T) {
	c, old := ownershipFixture(t)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	starts := filepath.Join(c.Paths.Dir, "starts")
	refused := filepath.Join(c.Paths.Dir, "refused")
	t.Setenv("WOOF_DAEMON_BIN", exe)
	t.Setenv("WOOF_TEST_DAEMON", "1")
	t.Setenv("WOOF_TEST_SOCKET", c.Paths.Sock)
	t.Setenv("WOOF_TEST_STARTS", starts)
	t.Setenv("WOOF_TEST_LOCK", c.Paths.Lock)
	t.Setenv("WOOF_TEST_REFUSED", refused)
	t.Cleanup(func() { cleanupDaemonProcesses(t, starts) })
	ln, first := ownerReadServer(t, c.Paths.Sock, func() string { return "" })
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	errs := make(chan error, 6)
	for i := 0; i < 6; i++ {
		go func() { errs <- c.EnsureDaemon(ctx) }()
	}
	<-first
	select {
	case err := <-errs:
		t.Fatalf("closing owner caused premature bootstrap failure: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if b, _ := os.ReadFile(starts); len(b) > 0 {
		t.Fatalf("spawned while old owner held lock: %s", b)
	}
	// The socket disappears before the writer/ownership lock has fully drained.
	closeTestResource(t, ln)
	time.Sleep(80 * time.Millisecond)
	if b, _ := os.ReadFile(refused); len(b) > 0 {
		t.Fatalf("spawn attempted against old owner: %s", b)
	}
	if err := syscall.Flock(int(old.Fd()), syscall.LOCK_UN); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 6; i++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	b, err := os.ReadFile(starts)
	if err != nil || strings.Count(string(b), "\n") != 1 {
		t.Fatalf("want one detached replacement: %s %v", b, err)
	}
	if b, _ := os.ReadFile(refused); len(b) > 0 {
		t.Fatalf("replacement launch refused: %s", b)
	}
}
func TestEnsureDaemonPreservesProtocolErrorsWhileOwnerBusy(t *testing.T) {
	for _, reply := range []string{
		"{\"version\":1,\"ok\":false,\"error\":{\"code\":\"protocol_mismatch\",\"message\":\"incompatible owner\"}}\n",
		"{\"version\":99,\"ok\":true}\n",
	} {
		t.Run(reply, func(t *testing.T) {
			c, _ := ownershipFixture(t)
			ownerReadServer(t, c.Paths.Sock, func() string { return reply })
			start := time.Now()
			err := c.EnsureDaemon(context.Background())
			if err == nil || time.Since(start) > time.Second {
				t.Fatalf("protocol error hidden by owner wait: %v", err)
			}
		})
	}
}

func TestEnsureDaemonBusyOwnershipWaitUsesCallerDeadline(t *testing.T) {
	c, _ := ownershipFixture(t)
	t.Setenv("WOOF_DAEMON_BIN", "/nonexistent/daemon-must-not-spawn")
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	start := time.Now()
	err := c.EnsureDaemon(ctx)
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
		t.Fatalf("ownership wait lost caller deadline: %v", err)
	}
	if _, err := os.Stat(c.Paths.Log); !os.IsNotExist(err) {
		t.Fatalf("spawn attempted while owner remained busy: %v", err)
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

func cleanupDaemonProcesses(t *testing.T, starts string) {
	t.Helper()
	b, err := os.ReadFile(starts)
	// A failed launch has no process record to clean up.
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		t.Error(err)
		return
	}
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		var process struct {
			PID int `json:"pid"`
		}
		if err := json.Unmarshal([]byte(line), &process); err != nil {
			t.Error(err)
			continue
		}
		if process.PID <= 0 {
			t.Errorf("invalid daemon fixture PID: %d", process.PID)
			continue
		}
		p, err := os.FindProcess(process.PID)
		if err != nil {
			t.Error(err)
			continue
		}
		if err := p.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			t.Error(err)
		}
		checkTestError(t, p.Release())
	}
}

func TestEventReadsNeverCarryMutationIdentity(t *testing.T) {
	c := &Client{}
	for _, op := range []string{"events.tail", "events.follow"} {
		req, err := c.request(op, nil)
		if err != nil {
			t.Fatal(err)
		}
		if req.ID != "" {
			t.Fatalf("%s read generated mutation ID %s", op, req.ID)
		}
	}
}
