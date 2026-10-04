package herdr

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"github.com/zielus/herdr-woof-v2/internal/rpc"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func server(t *testing.T, reply string, hold bool) string {
	t.Helper()
	d, e := os.MkdirTemp("/tmp", "woof-herdr-")
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
		if _, err := io.WriteString(c, reply); err != nil {
			t.Error(err)
			return
		}
		if hold {
			b := make([]byte, 1)
			if _, err := c.Read(b); err == nil {
				t.Error("expected client cancellation to close the connection")
			}
		}
	}()
	return s
}
func TestCallUncertainty(t *testing.T) {
	for _, r := range []string{"", "bad\n", `{"result":{}}`, `{"error":{"code":"agent_prompt_stalled","message":"typed?"}}` + "\n", `{"error":{"code":"timeout","message":"later"}}` + "\n"} {
		c := New(server(t, r, false))
		if e := c.AgentPrompt(context.Background(), "worker", "hi"); !errors.Is(e, rpc.ErrLost) {
			t.Fatalf("%s: %v", r, e)
		}
	}
	c := New(server(t, `{"error":{"code":"agent_not_ready","message":"before typing"}}`+"\n", false))
	e := c.AgentPrompt(context.Background(), "w", "hi")
	if errors.Is(e, rpc.ErrLost) || ErrCode(e) != "agent_not_ready" {
		t.Fatal(e)
	}
}
func TestSubscriptionRequiresConfirmation(t *testing.T) {
	for _, r := range []string{"oops\n", `{"result":{"type":"something_else"}}` + "\n", `{"result":{"type":"subscription_started"}}`} {
		c := New(server(t, r, false))
		ch, e := c.Subscribe(context.Background(), nil)
		if e == nil || ch != nil {
			t.Fatal("accepted missing/invalid ack")
		}
	}
}
func TestSubscriptionFramingAndCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := New(server(t, "{\"result\":{\"type\":\"subscription_started\"}}\n{\"event\":\"pane_agent_detected\",\"data\":{}}\n", true))
	ch, e := c.Subscribe(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	select {
	case ev := <-ch:
		if ev.Name != "pane.agent_detected" {
			t.Fatal(ev)
		}
	case <-time.After(time.Second):
		t.Fatal("event missing")
	}
	cancel()
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("open channel")
		}
	case <-time.After(time.Second):
		t.Fatal("cancel leak")
	}
}
func TestAgentLaunchExplicitSocketAndRawArguments(t *testing.T) {
	d := t.TempDir()
	bin := filepath.Join(d, "herdr")
	out := filepath.Join(d, "args")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE\"\nprintf '%s\\n' \"SESSION=$HERDR_SESSION\" \"SOCKET=$HERDR_SOCKET_PATH\" >> \"$CAPTURE\"\nprintf '%s\\n' '{\"result\":{\"agent\":{\"pane_id\":\"w:p\",\"interactive_ready\":true}}}'\n"
	if e := os.WriteFile(bin, []byte(script), 0700); e != nil {
		t.Fatal(e)
	}
	t.Setenv("CAPTURE", out)
	t.Setenv("HERDR_BIN_PATH", bin)
	t.Setenv("HERDR_SESSION", "stale")
	t.Setenv("HERDR_SOCKET_PATH", "stale")
	p, e := New("/explicit/socket").AgentStart(context.Background(), "w", "codex", "w:p", []string{"--config", "a b", "$(no-shell)"})
	if e != nil || p.PaneID != "w:p" {
		t.Fatalf("%v %v", p, e)
	}
	b, e := os.ReadFile(out)
	if e != nil {
		t.Fatal(e)
	}
	s := string(b)
	if strings.Contains(s, "--socket\n") || !strings.Contains(s, "--\n--config\na b\n$(no-shell)\n") || !strings.Contains(s, "SESSION=\nSOCKET=/explicit/socket\n") {
		t.Fatal(s)
	}
}
func TestSubscriptionCancelBeforeAcknowledgment(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	c := New(server(t, "", true))
	ch, e := c.Subscribe(ctx, nil)
	if ch != nil || !errors.Is(e, context.DeadlineExceeded) {
		t.Fatalf("%v %v", ch, e)
	}
}
func TestSubscriptionRejectsTruncatedEvent(t *testing.T) {
	c := New(server(t, "{\"result\":{\"type\":\"subscription_started\"}}\n{\"event\":\"pane_exited\",\"data\":{}}", false))
	ch, e := c.Subscribe(context.Background(), nil)
	if e != nil {
		t.Fatal(e)
	}
	if ev, ok := <-ch; ok {
		t.Fatalf("truncated event accepted: %v", ev)
	}
}
func TestUnknownPromptErrorIsUncertain(t *testing.T) {
	c := New(server(t, "{\"error\":{\"code\":\"internal_error\",\"message\":\"after effect?\"}}\n", false))
	if e := c.AgentPrompt(context.Background(), "w", "hi"); !errors.Is(e, rpc.ErrLost) {
		t.Fatalf("unknown mutation error treated safe: %v", e)
	}
}
func TestSnapshotUsesSessionMethodAndDerivesCwd(t *testing.T) {
	d, e := os.MkdirTemp("/tmp", "woof-snapshot-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { checkTestError(t, os.RemoveAll(d)) })
	s := filepath.Join(d, "s")
	l, e := net.Listen("unix", s)
	if e != nil {
		t.Fatal(e)
	}
	defer closeTestResource(t, l)
	method := make(chan string, 1)
	go func() {
		c, e := l.Accept()
		if e != nil {
			return
		}
		defer closeTestResource(t, c)
		b, err := bufio.NewReader(c).ReadBytes('\n')
		if err != nil {
			t.Error(err)
			return
		}
		var r struct {
			Method string `json:"method"`
		}
		if err := json.Unmarshal(b, &r); err != nil {
			t.Error(err)
			return
		}
		method <- r.Method
		if _, err := io.WriteString(c, "{\"result\":{\"snapshot\":{\"workspaces\":[{\"workspace_id\":\"w1\",\"label\":\"one\"},{\"workspace_id\":\"w2\",\"worktree\":{\"checkout_path\":\"/worktree\"}}],\"panes\":[{\"pane_id\":\"w1:p1\",\"workspace_id\":\"w1\",\"cwd\":\"/workspace\"}]}}}\n"); err != nil {
			t.Error(err)
			return
		}
	}()
	snap, e := New(s).Snapshot(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if got := <-method; got != "session.snapshot" {
		t.Fatalf("wrong snapshot method %s", got)
	}
	if len(snap.Workspaces) != 2 || snap.Workspaces[0].Cwd != "/workspace" || snap.Workspaces[1].Cwd != "/worktree" {
		t.Fatalf("missing derived workspace cwd: %v", snap)
	}
}

func TestProcessInfoPreservesVersionedBinaryLaunchIdentity(t *testing.T) {
	c := New(server(t, `{"result":{"process_info":{"shell_pid":10,"tty":"/dev/ttys012","foreground_processes":[{"pid":20,"name":"2.1.288","argv0":"claude","argv":["claude","--model","opus"],"cmdline":"claude --model opus","cwd":"/work"}]}}}`+"\n", false))
	info, err := c.ProcessInfo(context.Background(), "w:p")
	if err != nil {
		t.Fatal(err)
	}
	if len(info.ForegroundProcesses) != 1 {
		t.Fatalf("missing process: %+v", info)
	}
	p := info.ForegroundProcesses[0]
	if p.Name != "2.1.288" || p.Argv0 != "claude" || len(p.Argv) != 3 || p.Argv[2] != "opus" || p.Cmdline != "claude --model opus" || p.Cwd != "/work" {
		t.Fatalf("process launch identity dropped: %+v", p)
	}
}

// Captured from protocol 22 agent.read on a Claude 2.1.288 idle editor. The
// placeholder has no SGR styling; its literal text must survive transport.
func TestAgentReadFaithfulClaudeANSIPayload(t *testing.T) {
	payload, err := os.ReadFile("testdata/agent-read-claude-ansi.json")
	if err != nil {
		t.Fatal(err)
	}
	got, err := New(server(t, string(payload), false)).AgentRead(context.Background(), "w1:p3", "ansi", 80)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "\x1b[0m\x1b[1m\x1b[38;5;2m") || !strings.Contains(got, "\r\n❯\u00a0Try \"write a test for <filepath>\"\r\n") {
		t.Fatalf("ANSI controls or literal editor text lost: %q", got)
	}
	if strings.Contains(got, `\u001b`) || strings.Contains(got, `\r\n`) {
		t.Fatalf("JSON controls not decoded: %q", got)
	}
}

func TestAgentReadDoesNotReinterpretLiteralEscapeText(t *testing.T) {
	// Actual text containing an escape spelling is distinct from JSON-encoded
	// controls. Reinterpreting this could turn user input into placeholder style.
	payload := `{"result":{"type":"pane_read","read":{"format":"ansi","text":"❯ \\u001b[2mTry \\\"refactor <filepath>\\\"\\u001b[0m"}}}` + "\n"
	got, err := New(server(t, payload, false)).AgentRead(context.Background(), "w:p", "ansi", 80)
	if err != nil {
		t.Fatal(err)
	}
	if got != `❯ \u001b[2mTry \"refactor <filepath>\"\u001b[0m` || strings.ContainsRune(got, '\x1b') {
		t.Fatalf("literal escape spellings reinterpreted: %q", got)
	}
}

func TestAgentReadExplicitlyPreservesAnsiStyling(t *testing.T) {
	for _, format := range []string{"ansi", "text"} {
		t.Run(format, func(t *testing.T) {
			d, err := os.MkdirTemp("/tmp", "woof-agent-read-")
			if err != nil {
				t.Fatal(err)
			}
			defer func() { checkTestError(t, os.RemoveAll(d)) }()
			path := filepath.Join(d, "s")
			listener, err := net.Listen("unix", path)
			if err != nil {
				t.Fatal(err)
			}
			defer closeTestResource(t, listener)
			request := make(chan map[string]any, 1)
			go func() {
				c, err := listener.Accept()
				if err != nil {
					return
				}
				defer closeTestResource(t, c)
				b, err := bufio.NewReader(c).ReadBytes('\n')
				if err != nil {
					t.Error(err)
					return
				}
				var r map[string]any
				if err := json.Unmarshal(b, &r); err != nil {
					t.Error(err)
					return
				}
				request <- r
				if _, err := io.WriteString(c, "{\"result\":{\"read\":{\"text\":\"❯ \"}}}\n"); err != nil {
					t.Error(err)
					return
				}
			}()
			if _, err := New(path).AgentRead(context.Background(), "w1:p3", format, 80); err != nil {
				t.Fatal(err)
			}
			r := <-request
			params, _ := r["params"].(map[string]any)
			if r["method"] != "agent.read" || params["target"] != "w1:p3" || params["source"] != "recent_unwrapped" || params["format"] != format || params["lines"] != float64(80) {
				t.Fatalf("unexpected read request: %+v", r)
			}
			strip, present := params["strip_ansi"]
			if format == "ansi" && (!present || strip != false) {
				t.Fatalf("ANSI request permits default stripping: %+v", params)
			}
			if format == "text" && present {
				t.Fatalf("text request overrides stripping default: %+v", params)
			}
		})
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

// Inject deadline failures without relying on a racing socket close to reproduce them.
type deadlineFailConn struct {
	net.Conn
	reader        *strings.Reader
	failAt        int
	deadlineCalls int
	deadlineErr   error
	cancel        context.CancelFunc
	closes        atomic.Int32
}

func (c *deadlineFailConn) Read(b []byte) (int, error)  { return c.reader.Read(b) }
func (c *deadlineFailConn) Write(b []byte) (int, error) { return len(b), nil }
func (c *deadlineFailConn) Close() error                { c.closes.Add(1); return nil }
func (c *deadlineFailConn) SetReadDeadline(time.Time) error {
	c.deadlineCalls++
	if c.deadlineCalls == c.failAt {
		if c.cancel != nil {
			c.cancel()
		}
		return c.deadlineErr
	}
	return nil
}
func TestSubscriptionDeadlineFailureClosesConnection(t *testing.T) {
	for _, tc := range []struct {
		name   string
		failAt int
		cancel bool
	}{
		{"set acknowledgment deadline", 1, false},
		{"clear acknowledgment deadline", 2, false},
		{"cancel while clearing deadline", 2, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			failure := errors.New("injected deadline failure")
			conn := &deadlineFailConn{reader: strings.NewReader("{\"result\":{\"type\":\"subscription_started\"}}\n"), failAt: tc.failAt, deadlineErr: failure}
			if tc.cancel {
				conn.cancel = cancel
			}
			ch, err := subscribe(ctx, conn, nil)
			if ch != nil || !errors.Is(err, failure) || !errors.Is(err, rpc.ErrLost) || errors.Is(err, rpc.ErrUnavailable) {
				t.Fatalf("subscription outcome: channel %v, error %v", ch, err)
			}
			if tc.cancel && !errors.Is(err, context.Canceled) {
				t.Fatalf("cancellation lost: %v", err)
			}
			if conn.closes.Load() == 0 {
				t.Fatal("failed subscription connection left open")
			}
		})
	}
}

// Expose an elapsed context deadline before Err() has been published by its timer.
type unpublishedDeadlineContext struct {
	context.Context
	deadline time.Time
}

func (c unpublishedDeadlineContext) Deadline() (time.Time, bool) { return c.deadline, true }
func TestSubscriptionTimeoutPreservesCallerDeadline(t *testing.T) {
	timeout := &net.DNSError{IsTimeout: true, Err: "injected socket timeout"}
	for _, tc := range []struct {
		name         string
		ctx          context.Context
		wantDeadline bool
	}{
		{"elapsed caller deadline", unpublishedDeadlineContext{context.Background(), time.Now().Add(-time.Second)}, true},
		{"future caller deadline", unpublishedDeadlineContext{context.Background(), time.Now().Add(time.Minute)}, false},
		{"independent acknowledgment deadline", context.Background(), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := subscriptionAckError(tc.ctx, timeout)
			if !errors.Is(err, rpc.ErrLost) || !errors.Is(err, timeout) || errors.Is(err, context.DeadlineExceeded) != tc.wantDeadline {
				t.Fatalf("timeout classification: %v", err)
			}
		})
	}
}

func TestNotifyReportsWhetherHerdrShowedIt(t *testing.T) {
	for reply, want := range map[string]NotifyResult{
		`{"result":{"type":"notification_show","shown":true,"reason":"shown"}}`:                 {Shown: true, Reason: "shown"},
		`{"result":{"type":"notification_show","shown":false,"reason":"disabled"}}`:             {Reason: "disabled"},
		`{"result":{"type":"notification_show","shown":false,"reason":"no_foreground_client"}}`: {Reason: "no_foreground_client"},
		`{"result":{}}`: {},
	} {
		got, err := New(server(t, reply+"\n", false)).Notify(context.Background(), "t", "b", true)
		if err != nil || got != want {
			t.Errorf("%s: %+v %v", reply, got, err)
		}
	}
	if got, err := New(server(t, `{"error":{"code":"internal","message":"x"}}`+"\n", false)).Notify(context.Background(), "t", "b", true); err == nil || got.Shown {
		t.Fatalf("error reported as shown: %+v %v", got, err)
	}
}

func TestAgentExplainRule(t *testing.T) {
	id, state, err := New(server(t, `{"result":{"type":"agent_explain","explain":{"state":"blocked","matched_rule":{"id":"bash_permission_prompt","priority":850,"state":"blocked"}}}}`+"\n", false)).AgentExplainRule(context.Background(), "w1:p1")
	if err != nil || id != "bash_permission_prompt" || state != "blocked" {
		t.Fatalf("%q %q %v", id, state, err)
	}
	id, state, err = New(server(t, `{"result":{"type":"agent_explain","explain":{"matched_rule":null}}}`+"\n", false)).AgentExplainRule(context.Background(), "w1:p1")
	if err != nil || id != "" || state != "" {
		t.Fatalf("%q %q %v", id, state, err)
	}
}
