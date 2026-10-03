// Adapted from herdr-orch (MIT, Copyright (c) 2026 Stephen Ellington).
// Package herdr talks to the herdr server over its unix socket.
//
// Wire format (protocol 22): newline-delimited JSON, one request per connection.
// events.subscribe keeps its connection open and streams one event per line.
package herdr

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/rpc"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"time"
)

// SupportedProtocols lists the herdr API protocols this plugin was built against.
var SupportedProtocols = []int{22}

// Error is an error response from herdr.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Client calls the herdr API.
type Client struct {
	Socket  string
	Timeout time.Duration
	seq     atomic.Uint64
}

func New(socket string) *Client {
	return &Client{Socket: socket, Timeout: 30 * time.Second}
}

// Call sends one request and decodes the result into out (if non-nil).
func (c *Client) Call(ctx context.Context, method string, params any, out any) error {
	if params == nil {
		params = map[string]any{}
	}
	if _, ok := ctx.Deadline(); !ok && c.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.Timeout)
		defer cancel()
	}
	if c.Socket == "" {
		return errors.Join(rpc.ErrUnavailable, errors.New("explicit Herdr socket required"))
	}
	req, err := json.Marshal(map[string]any{"id": fmt.Sprintf("woof-%d", c.seq.Add(1)), "method": method, "params": params})
	if err != nil {
		return err
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", c.Socket)
	if err != nil {
		return errors.Join(rpc.ErrUnavailable, err)
	}
	// Closure only releases this transport; it cannot change the observed
	// request outcome, and cancellation may already have closed it.
	closeConn := func() { _ = conn.Close() }
	defer closeConn()
	stop := context.AfterFunc(ctx, closeConn)
	defer stop()
	n, err := conn.Write(append(req, '\n'))
	if err != nil || n != len(req)+1 {
		if err == nil {
			err = errors.New("short request write")
		}
		if n == 0 {
			return errors.Join(rpc.ErrUnavailable, err)
		}
		return errors.Join(rpc.ErrLost, err, ctx.Err())
	}
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return errors.Join(rpc.ErrLost, err, ctx.Err())
	}
	var resp struct {
		Result json.RawMessage `json:"result"`
		Error  *Error          `json:"error"`
	}
	if err = json.Unmarshal(line, &resp); err != nil {
		return errors.Join(rpc.ErrLost, err)
	}
	if resp.Error != nil {
		if method == "ping" || method == "pane.get" || method == "agent.get" || method == "pane.process_info" || method == "pane.read" || method == "agent.read" || method == "session.snapshot" {
			return resp.Error
		}
		return classify(resp.Error)
	}
	if len(resp.Result) == 0 {
		return errors.Join(rpc.ErrLost, errors.New("missing result"))
	}
	if out != nil {
		if err = json.Unmarshal(resp.Result, out); err != nil {
			return errors.Join(rpc.ErrLost, err)
		}
	}
	return nil
}

// ErrCode returns the herdr error code of err, or "".
func ErrCode(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

type Pong struct {
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
}

func (c *Client) Ping(ctx context.Context) (Pong, error) {
	var p Pong
	err := c.Call(ctx, "ping", nil, &p)
	return p, err
}

// Pane is the subset of herdr's pane info we use.
type Pane struct {
	TerminalID       string               `json:"terminal_id"`
	Revision         uint64               `json:"revision"`
	StateChangeSeq   uint64               `json:"state_change_seq"`
	CompletionSeq    *uint64              `json:"completion_seq"`
	AgentSession     *model.NativeSession `json:"agent_session"`
	PaneID           string               `json:"pane_id"`
	WorkspaceID      string               `json:"workspace_id"`
	TabID            string               `json:"tab_id"`
	Agent            *string              `json:"agent"`
	AgentStatus      string               `json:"agent_status"`
	Name             *string              `json:"name"`
	InteractiveReady *bool                `json:"interactive_ready"` // set by agent.get once the agent accepts prompts
	Cwd              *string              `json:"cwd"`
	ForegroundCwd    *string              `json:"foreground_cwd"`
}

func (c *Client) PaneGet(ctx context.Context, paneID string) (Pane, error) {
	var r struct {
		Pane Pane `json:"pane"`
	}
	err := c.Call(ctx, "pane.get", map[string]any{"pane_id": paneID}, &r)
	return r.Pane, err
}

func (c *Client) AgentGet(ctx context.Context, target string) (Pane, error) {
	var r struct {
		Agent Pane `json:"agent"`
	}
	err := c.Call(ctx, "agent.get", map[string]any{"target": target}, &r)
	return r.Agent, err
}

type ProcessInfo struct {
	ShellPID            int    `json:"shell_pid"`
	TTY                 string `json:"tty"`
	ForegroundProcesses []struct {
		PID     int      `json:"pid"`
		Name    string   `json:"name"`
		Argv0   string   `json:"argv0"`
		Argv    []string `json:"argv"`
		Cmdline string   `json:"cmdline"`
		Cwd     string   `json:"cwd"`
	} `json:"foreground_processes"`
}

// PIDs returns the shell pid and every foreground pid, deduplicated.
func (p ProcessInfo) PIDs() []int {
	seen := map[int]bool{}
	var out []int
	add := func(pid int) {
		if pid > 0 && !seen[pid] {
			seen[pid] = true
			out = append(out, pid)
		}
	}
	add(p.ShellPID)
	for _, f := range p.ForegroundProcesses {
		add(f.PID)
	}
	return out
}

func (c *Client) ProcessInfo(ctx context.Context, paneID string) (ProcessInfo, error) {
	var r struct {
		ProcessInfo ProcessInfo `json:"process_info"`
	}
	err := c.Call(ctx, "pane.process_info", map[string]any{"pane_id": paneID}, &r)
	return r.ProcessInfo, err
}

func (c *Client) PaneRead(ctx context.Context, paneID string, lines int) (string, error) {
	var r struct {
		Read struct {
			Text string `json:"text"`
		} `json:"read"`
	}
	params := map[string]any{"pane_id": paneID, "source": "recent_unwrapped", "format": "text"}
	if lines > 0 {
		params["lines"] = lines
	}
	err := c.Call(ctx, "pane.read", params, &r)
	return r.Read.Text, err
}

func (c *Client) PaneClose(ctx context.Context, paneID string) error {
	return c.Call(ctx, "pane.close", map[string]any{"pane_id": paneID}, nil)
}

// AgentPrompt submits text to a herdr-recognised agent without waiting.
func (c *Client) AgentPrompt(ctx context.Context, target, text string) error {
	return c.Call(ctx, "agent.prompt", map[string]any{"target": target, "text": text}, nil)
}

func (c *Client) Notify(ctx context.Context, title, body string, urgent bool) error {
	sound := "done"
	if urgent {
		sound = "request"
	}
	return c.Call(ctx, "notification.show", map[string]any{"title": title, "body": body, "sound": sound}, nil)
}

// NewTab creates a tab and returns its root pane.
func (c *Client) NewTab(ctx context.Context, workspaceID, cwd, label string, env map[string]string) (Pane, error) {
	params := map[string]any{"focus": false}
	if len(env) > 0 {
		params["env"] = env
	}
	if workspaceID != "" {
		params["workspace_id"] = workspaceID
	}
	if cwd != "" {
		params["cwd"] = cwd
	}
	if label != "" {
		params["label"] = label
	}
	var r struct {
		RootPane Pane `json:"root_pane"`
	}
	err := c.Call(ctx, "tab.create", params, &r)
	return r.RootPane, err
}

// AgentStart starts an agent through the herdr CLI. The raw agent.start call returns
// before the agent is interactive and refuses a shell that is still starting up; the CLI
// waits for both (see docs/herdr-api-notes.md).
func (c *Client) AgentStart(ctx context.Context, name, kind, paneID string, args []string) (Pane, error) {
	bin := os.Getenv("HERDR_BIN_PATH")
	if bin == "" {
		bin = "herdr"
	}
	argv := []string{"agent", "start", name, "--kind", kind, "--pane", paneID, "--timeout", "60000"}
	if len(args) > 0 {
		argv = append(append(argv, "--"), args...)
	}
	cctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, bin, argv...)
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if key != "HERDR_SOCKET_PATH" && key != "HERDR_SESSION" && key != "HERDR_MACHINE" && key != "HERDR_REMOTE" {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	cmd.Env = append(cmd.Env, "HERDR_SOCKET_PATH="+c.Socket)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if c.Socket == "" {
		return Pane{}, errors.Join(rpc.ErrUnavailable, errors.New("explicit Herdr socket required"))
	}
	if err := cmd.Start(); err != nil {
		return Pane{}, errors.Join(rpc.ErrUnavailable, err)
	}
	runErr := cmd.Wait()
	var resp struct {
		Result struct {
			Agent Pane `json:"agent"`
		} `json:"result"`
		Error *Error `json:"error"`
	}
	for _, out := range [][]byte{stdout.Bytes(), stderr.Bytes()} {
		if json.Unmarshal(bytes.TrimSpace(out), &resp) == nil && (resp.Error != nil || resp.Result.Agent.PaneID != "") {
			break
		}
	}
	if resp.Error != nil {
		return Pane{}, errors.Join(rpc.ErrLost, resp.Error)
	}
	if runErr != nil {
		return Pane{}, errors.Join(rpc.ErrLost, fmt.Errorf("herdr agent start: %v: %s", runErr, bytes.TrimSpace(stderr.Bytes())), cctx.Err())
	}
	if resp.Result.Agent.PaneID == "" {
		return Pane{}, errors.Join(rpc.ErrLost, errors.New("missing agent launch result"))
	}
	return resp.Result.Agent, nil
}

// Event is one line from an events.subscribe stream. Name is normalised to dotted form
// (herdr sends both "pane_exited" and "pane.agent_status_changed").
type Event struct {
	Name string
	Data json.RawMessage
}

// Subscription describes one events.subscribe entry.
type Subscription map[string]any

// Subscribe opens a subscription and delivers events on the returned channel until ctx is
// cancelled or the connection drops (the channel is then closed).
func (c *Client) Subscribe(ctx context.Context, subs []Subscription) (<-chan Event, error) {
	if c.Socket == "" {
		return nil, errors.Join(rpc.ErrUnavailable, errors.New("explicit Herdr socket required"))
	}
	dctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(dctx, "unix", c.Socket)
	if err != nil {
		return nil, errors.Join(rpc.ErrUnavailable, err)
	}
	return subscribe(ctx, conn, subs)
}

func subscribe(ctx context.Context, conn net.Conn, subs []Subscription) (<-chan Event, error) {
	// Closure only releases a failed or finished subscription. Cancellation may
	// already have closed the connection, so cleanup is deliberately best effort.
	closeConn := func() { _ = conn.Close() }
	stop := context.AfterFunc(ctx, closeConn)
	cleanup := func() { stop(); closeConn() }
	req, err := json.Marshal(map[string]any{"id": "sub", "method": "events.subscribe", "params": map[string]any{"subscriptions": subs}})
	if err != nil {
		cleanup()
		return nil, err
	}
	n, err := conn.Write(append(req, '\n'))
	if err != nil || n != len(req)+1 {
		cleanup()
		if err == nil {
			err = errors.New("short subscription write")
		}
		if n == 0 {
			return nil, errors.Join(rpc.ErrUnavailable, err)
		}
		return nil, errors.Join(rpc.ErrLost, err)
	}
	deadline := time.Now().Add(5 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := conn.SetReadDeadline(deadline); err != nil {
		cleanup()
		return nil, errors.Join(rpc.ErrLost, fmt.Errorf("subscription acknowledgment deadline: %w", err), ctx.Err())
	}
	r := bufio.NewReaderSize(conn, 1<<20)
	first, err := r.ReadBytes('\n')
	if err != nil {
		cleanup()
		return nil, subscriptionAckError(ctx, err)
	}
	var ack struct {
		Result struct {
			Type string `json:"type"`
		} `json:"result"`
		Error *Error `json:"error"`
	}
	if err = json.Unmarshal(first, &ack); err != nil {
		cleanup()
		return nil, errors.Join(rpc.ErrLost, err)
	}
	if ack.Error != nil {
		cleanup()
		return nil, classify(ack.Error)
	}
	if ack.Result.Type != "subscription_started" {
		cleanup()
		return nil, errors.Join(rpc.ErrLost, errors.New("subscription not confirmed"))
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		cleanup()
		return nil, errors.Join(rpc.ErrLost, fmt.Errorf("clear subscription acknowledgment deadline: %w", err), ctx.Err())
	}
	ch := make(chan Event, 256)
	go func() {
		defer close(ch)
		defer cleanup()
		for {
			line, err := r.ReadBytes('\n')
			if err != nil {
				return
			}
			var env struct {
				Event string          `json:"event"`
				Data  json.RawMessage `json:"data"`
			}
			if json.Unmarshal(line, &env) != nil || env.Event == "" {
				return
			}
			select {
			case ch <- Event{Name: NormalizeEvent(env.Event), Data: env.Data}:
			case <-ctx.Done():
				return
			}
		}
	}()
	return ch, nil
}

// A socket deadline can fire before the context timer publishes its error.
// Preserve the caller's expired deadline without treating the independent
// acknowledgment timeout as caller cancellation.
func subscriptionAckError(ctx context.Context, err error) error {
	contextErr := ctx.Err()
	var timeout net.Error
	if contextErr == nil && errors.As(err, &timeout) && timeout.Timeout() {
		if deadline, ok := ctx.Deadline(); ok && !time.Now().Before(deadline) {
			contextErr = context.DeadlineExceeded
		}
	}
	return errors.Join(rpc.ErrLost, err, contextErr)
}

// NormalizeEvent maps "pane_agent_detected" → "pane.agent_detected" and leaves dotted names alone.
func NormalizeEvent(name string) string {
	for i := 0; i < len(name); i++ {
		if name[i] == '.' {
			return name
		}
		if name[i] == '_' {
			return name[:i] + "." + name[i+1:]
		}
	}
	return name
}

// classify preserves pretyping refusals but treats execution stalls as uncertain.
func classify(e *Error) error {
	switch e.Code {
	case "agent_not_ready", "agent_not_found", "pane_not_found", "invalid_params", "invalid_request", "method_not_found", "unknown_method", "unsupported_agent", "agent_busy":
		return e
	}
	return errors.Join(rpc.ErrLost, e)
}
func (c *Client) AgentRead(ctx context.Context, target, format string, lines int) (string, error) {
	params := map[string]any{"target": target, "source": "recent_unwrapped", "format": format}
	if format == "ansi" {
		// Protocol 22 defaults strip_ansi to true independently of format.
		params["strip_ansi"] = false
	}
	if lines > 0 {
		params["lines"] = lines
	}
	var r struct {
		Read struct {
			Text string `json:"text"`
		} `json:"read"`
	}
	err := c.Call(ctx, "agent.read", params, &r)
	return r.Read.Text, err
}

type Workspace struct {
	Worktree *struct {
		CheckoutPath string `json:"checkout_path"`
	} `json:"worktree"`
	ID    string `json:"workspace_id"`
	Label string `json:"label"`
	Cwd   string `json:"cwd"`
	Panes []Pane `json:"panes"`
}
type Snapshot struct {
	Workspaces []Workspace `json:"workspaces"`
	Agents     []Pane      `json:"agents"`
	Panes      []Pane      `json:"panes"`
}

func (c *Client) Snapshot(ctx context.Context) (Snapshot, error) {
	var r struct {
		Snapshot Snapshot `json:"snapshot"`
	}
	err := c.Call(ctx, "session.snapshot", nil, &r)
	if err == nil {
		for i := range r.Snapshot.Workspaces {
			w := &r.Snapshot.Workspaces[i]
			if w.Cwd == "" && w.Worktree != nil {
				w.Cwd = w.Worktree.CheckoutPath
			}
			if w.Cwd == "" {
				for _, p := range r.Snapshot.Panes {
					if p.WorkspaceID == w.ID && p.Cwd != nil {
						w.Cwd = *p.Cwd
						break
					}
				}
			}
		}
	}
	return r.Snapshot, err
}
