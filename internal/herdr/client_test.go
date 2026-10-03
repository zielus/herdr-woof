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
	"testing"
	"time"
)

func server(t *testing.T, reply string, hold bool) string {
	t.Helper()
	d, e := os.MkdirTemp("/tmp", "woof-herdr-")
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
	go func() {
		c, e := l.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		bufio.NewReader(c).ReadBytes('\n')
		io.WriteString(c, reply)
		if hold {
			b := make([]byte, 1)
			c.Read(b)
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
	t.Cleanup(func() { os.RemoveAll(d) })
	s := filepath.Join(d, "s")
	l, e := net.Listen("unix", s)
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	method := make(chan string, 1)
	go func() {
		c, e := l.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		b, _ := bufio.NewReader(c).ReadBytes('\n')
		var r struct {
			Method string `json:"method"`
		}
		json.Unmarshal(b, &r)
		method <- r.Method
		io.WriteString(c, "{\"result\":{\"snapshot\":{\"workspaces\":[{\"workspace_id\":\"w1\",\"label\":\"one\"},{\"workspace_id\":\"w2\",\"worktree\":{\"checkout_path\":\"/worktree\"}}],\"panes\":[{\"pane_id\":\"w1:p1\",\"workspace_id\":\"w1\",\"cwd\":\"/workspace\"}]}}}\n")
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
			defer os.RemoveAll(d)
			path := filepath.Join(d, "s")
			listener, err := net.Listen("unix", path)
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			request := make(chan map[string]any, 1)
			go func() {
				c, err := listener.Accept()
				if err != nil {
					return
				}
				defer c.Close()
				b, _ := bufio.NewReader(c).ReadBytes('\n')
				var r map[string]any
				json.Unmarshal(b, &r)
				request <- r
				io.WriteString(c, "{\"result\":{\"read\":{\"text\":\"❯ \"}}}\n")
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
