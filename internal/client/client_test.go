// Lost-request test adapted from herdr-orch (MIT, Copyright (c) 2026 Stephen Ellington).
package client

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/paths"
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
	t.Cleanup(func() { os.RemoveAll(d) })
	s := filepath.Join(d, "s")
	l, e := net.Listen("unix", s)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { l.Close() })
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
				defer c.Close()
				b, _ := bufio.NewReader(c).ReadBytes('\n')
				var r model.Request
				json.Unmarshal(b, &r)
				mu.Lock()
				counts[r.Op]++
				ids[r.Op] = r.ID
				mu.Unlock()
				if r.Op == "ping" {
					c.Write([]byte("{\"version\":1,\"ok\":true}\n"))
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
		c.Call(context.Background(), op, nil, nil)
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
		if path := os.Getenv("WOOF_TEST_LOCK"); path != "" {
			lock, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
			if err != nil {
				os.Exit(3)
			}
			defer lock.Close()
			if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
				if failed, err := os.OpenFile(os.Getenv("WOOF_TEST_REFUSED"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600); err == nil {
					failed.WriteString("ownership refused\n")
					failed.Close()
				}
				os.Exit(4)
			}
		}
		l, e := net.Listen("unix", os.Getenv("WOOF_TEST_SOCKET"))
		if e != nil {
			os.Exit(2)
		}
		f, e := os.OpenFile(os.Getenv("WOOF_TEST_STARTS"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if e != nil {
			os.Exit(2)
		}
		json.NewEncoder(f).Encode(map[string]any{"pid": os.Getpid(), "sid": os.Getpid(), "argv": os.Args[1:], "env": daemonFixtureEnv()})
		f.Close()
		for {
			c, e := l.Accept()
			if e != nil {
				os.Exit(0)
			}
			bufio.NewReader(c).ReadBytes('\n')
			c.Write([]byte("{\"version\":1,\"ok\":true}\n"))
			c.Close()
		}
	}
	os.Exit(m.Run())
}
func TestDetachedBootstrapDiscoverySerializesClients(t *testing.T) {
	d, e := os.MkdirTemp("/tmp", "woof-bootstrap-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
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
	t.Cleanup(func() {
		b, _ := os.ReadFile(starts)
		var r struct {
			PID int `json:"pid"`
		}
		json.Unmarshal(b, &r)
		if r.PID > 0 {
			p, _ := os.FindProcess(r.PID)
			p.Kill()
		}
	})
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
	sid, e := syscall.Getsid(r.PID)
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
	t.Cleanup(func() { os.RemoveAll(d) })
	path := filepath.Join(d, "s")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				b, _ := bufio.NewReader(c).ReadBytes('\n')
				var r model.Request
				json.Unmarshal(b, &r)
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
			json.NewEncoder(conn).Encode(model.Response{Version: 1, OK: true})
		case "status":
			statuses++
			b, _ := json.Marshal(map[string]int64{"event_cursor": head})
			json.NewEncoder(conn).Encode(model.Response{Version: 1, OK: true, Result: b})
		case "wait":
			requests <- r
			waits++
			if waits == 1 {
				// Event 11 matched this wait, but its reply is lost after commit.
				head = 11
				conn.Write([]byte(`{"version":1,"ok":true,"result":`))
				return
			}
			var a struct {
				Since *int64 `json:"since"`
			}
			json.Unmarshal(r.Args, &a)
			if a.Since == nil || *a.Since >= 11 {
				json.NewEncoder(conn).Encode(model.Response{Version: 1, Error: &model.Error{Code: "timeout", Message: "missed committed event"}})
				return
			}
			json.NewEncoder(conn).Encode(model.Response{Version: 1, OK: true, Result: json.RawMessage(`{"seq":11,"type":"gate.created"}`)})
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
		json.Unmarshal(r.Args, &a)
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
					json.NewEncoder(conn).Encode(model.Response{Version: 1, OK: true})
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
				conn.Read(b[:]) // cancellation closes the pending wait connection
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
				json.Unmarshal(r.Args, &a)
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
	t.Cleanup(func() { os.RemoveAll(d) })
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
		lock.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); lock.Close() })
	return c, lock
}
func ownerReadServer(t *testing.T, path string, response func() string) (net.Listener, <-chan struct{}) {
	t.Helper()
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	first := make(chan struct{})
	var once sync.Once
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				bufio.NewReader(conn).ReadBytes('\n')
				once.Do(func() { close(first) })
				conn.Write([]byte(response()))
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
	t.Cleanup(func() {
		b, _ := os.ReadFile(starts)
		for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
			var process struct {
				PID int `json:"pid"`
			}
			json.Unmarshal([]byte(line), &process)
			if process.PID > 0 {
				p, _ := os.FindProcess(process.PID)
				p.Kill()
			}
		}
	})
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
	ln.Close()
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
