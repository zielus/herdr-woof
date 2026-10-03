// Package client discovers and bootstraps the single global Woof daemon.
// Adapted from herdr-orch (MIT, Copyright (c) 2026 Stephen Ellington).
package client

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/paths"
	"github.com/zielus/herdr-woof-v2/internal/rpc"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type Client struct {
	Paths         paths.Paths
	Caller        model.Caller
	Scope         model.Scope
	ScopeExplicit bool
}

func New() (*Client, error) {
	p, e := paths.Resolve()
	if e != nil {
		return nil, e
	}
	cwd, e := os.Getwd()
	if e != nil {
		return nil, e
	}
	return &Client{Paths: p, Caller: model.Caller{WorkerID: os.Getenv("WOOF_WORKER_ID"), AttachmentID: os.Getenv("WOOF_ATTACHMENT_ID"), HerdrSocket: os.Getenv("HERDR_SOCKET_PATH"), PaneID: os.Getenv("HERDR_PANE_ID"), ProcessID: os.Getpid(), Cwd: cwd}, Scope: model.Scope{SessionID: os.Getenv("WOOF_SESSION_ID"), WorkspaceID: os.Getenv("WOOF_WORKSPACE_ID"), WorktreeID: os.Getenv("WOOF_WORKTREE_ID"), RunID: os.Getenv("WOOF_RUN_ID"), WorkerID: os.Getenv("WOOF_WORKER_ID")}}, nil
}

var readOnly = map[string]bool{"check": true, "ping": true, "status": true, "session.list": true, "workspace.list": true, "worktree.list": true, "run.list": true, "run.show": true, "worker.list": true, "worker.show": true, "worker.read": true, "profile.roster": true, "profile.show": true, "inbox": true, "message.show": true, "dispatch.show": true, "gate.list": true, "gate.show": true, "operation.list": true, "operation.show": true, "events.list": true, "wait": true, "question.wait": true}

func (c *Client) request(op string, args any) (model.Request, error) {
	r := model.Request{Version: model.Protocol, Op: op, Caller: c.Caller, Scope: c.Scope, ScopeExplicit: c.ScopeExplicit}
	if args != nil {
		b, e := json.Marshal(args)
		if e != nil {
			return r, e
		}
		r.Args = b
	}
	if !readOnly[op] {
		var b [16]byte
		if _, e := rand.Read(b[:]); e != nil {
			return r, e
		}
		r.ID = "op_" + hex.EncodeToString(b[:])
	}
	return r, nil
}
func unknown(r model.Request, err error) error {
	return &model.Error{Code: "outcome_unknown", OperationID: r.ID, Message: fmt.Sprintf("%s may have been applied (%v). Do not resend; check `woof operation show --id %s` and the resulting state first.", r.Op, err, r.ID)}
}
func (c *Client) Call(ctx context.Context, op string, args, out any) error {
	r, e := c.request(op, args)
	if e != nil {
		return e
	}
	ctx, cancel, e := c.prepareWait(ctx, &r)
	defer cancel()
	if e != nil {
		return e
	}
	e = rpc.Call(ctx, c.Paths.Sock, r, out)
	if errors.Is(e, rpc.ErrLost) && !readOnly[op] {
		return unknown(r, e)
	}
	if !errors.Is(e, rpc.ErrUnavailable) && !errors.Is(e, rpc.ErrLost) {
		return e
	}
	if ctx.Err() != nil {
		return e
	}
	if er := c.EnsureDaemon(ctx); er != nil {
		return er
	}
	e = rpc.Call(ctx, c.Paths.Sock, r, out)
	if errors.Is(e, rpc.ErrLost) && !readOnly[op] {
		return unknown(r, e)
	}
	return e
}

// A disconnected blocking read is resumed from its original cursor/deadline,
// never from a newly captured head or a fresh relative server timeout.
func (c *Client) prepareWait(ctx context.Context, r *model.Request) (context.Context, context.CancelFunc, error) {
	cancel := context.CancelFunc(func() {})
	if r.Op != "wait" && r.Op != "question.wait" {
		return ctx, cancel, nil
	}
	var args map[string]json.RawMessage
	if len(r.Args) > 0 {
		if err := json.Unmarshal(r.Args, &args); err != nil {
			return ctx, cancel, err
		}
	}
	if args == nil {
		args = map[string]json.RawMessage{}
	}
	if raw, ok := args["timeout_ms"]; ok {
		var timeout int64
		if err := json.Unmarshal(raw, &timeout); err != nil {
			return ctx, cancel, err
		}
		if timeout > 0 {
			if timeout > int64((1<<63-1)/time.Millisecond) {
				return ctx, cancel, fmt.Errorf("wait timeout is too large")
			}
			ctx, cancel = context.WithTimeout(ctx, time.Duration(timeout)*time.Millisecond)
			args["timeout_ms"] = json.RawMessage("0")
		}
	}
	if r.Op == "wait" && (len(args["since"]) == 0 || string(args["since"]) == "null") {
		var status struct {
			Cursor *int64 `json:"event_cursor"`
		}
		if err := c.Call(ctx, "status", nil, &status); err != nil {
			return ctx, cancel, err
		}
		if status.Cursor == nil {
			return ctx, cancel, fmt.Errorf("status response missing event cursor")
		}
		args["since"], _ = json.Marshal(*status.Cursor)
	}
	var err error
	r.Args, err = json.Marshal(args)
	return ctx, cancel, err
}
func (c *Client) Stream(ctx context.Context, op string, args any, fn func(json.RawMessage) error) error {
	r, e := c.request(op, args)
	if e != nil {
		return e
	}
	e = rpc.Stream(ctx, c.Paths.Sock, r, fn)
	if !errors.Is(e, rpc.ErrUnavailable) {
		return e
	}
	if e = c.EnsureDaemon(ctx); e != nil {
		return e
	}
	return rpc.Stream(ctx, c.Paths.Sock, r, fn)
}
func (c *Client) ping(ctx context.Context) error {
	return rpc.Call(ctx, c.Paths.Sock, model.Request{Version: model.Protocol, Op: "ping"}, nil)
}
func pause(ctx context.Context) error {
	timer := time.NewTimer(50 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func (c *Client) EnsureDaemon(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if e := c.ping(ctx); e == nil {
		return nil
	} else if !retryableProbe(e) {
		return e
	}
	// A separate bootstrap lock serializes clients, leaving the canonical lock to woofd.
	f, e := os.OpenFile(filepath.Join(c.Paths.Dir, "bootstrap.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	for {
		e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if e == nil {
			break
		}
		if e != syscall.EWOULDBLOCK && e != syscall.EAGAIN {
			return e
		}
		if e = pause(ctx); e != nil {
			return e
		}
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	healthy, e := c.waitOwnership(ctx)
	if e != nil {
		return e
	}
	if healthy {
		return nil
	}
	if e = c.Spawn(); e != nil {
		return fmt.Errorf("daemon could not start: %w", e)
	}
	for {
		e = c.ping(ctx)
		if e == nil {
			return nil
		}
		if !retryableProbe(e) {
			return e
		}
		if er := pause(ctx); er != nil {
			return fmt.Errorf("daemon readiness (see %s): %w", c.Paths.Log, er)
		}
	}
}

// Framing/protocol errors need inspection. Only missing sockets and lost read
// transports are transient probes; these reads never replay a mutation.
func retryableProbe(err error) bool {
	if errors.Is(err, rpc.ErrUnavailable) {
		return true
	}
	if !errors.Is(err, rpc.ErrLost) {
		return false
	}
	var network *net.OpError
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) || errors.As(err, &network)
}

// The socket can disappear before the daemon has drained its writer. Probe
// ownership without opening SQLite; release the canonical lock before spawning.
func (c *Client) waitOwnership(ctx context.Context) (bool, error) {
	if c.Paths.Lock == "" {
		return false, fmt.Errorf("daemon ownership lock path required")
	}
	lock, err := os.OpenFile(c.Paths.Lock, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return false, err
	}
	defer lock.Close()
	for {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		if err := c.ping(ctx); err == nil {
			return true, nil
		} else if !retryableProbe(err) {
			return false, err
		}
		err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); err != nil {
				return false, err
			}
			return false, nil
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EAGAIN {
			return false, err
		}
		if err := pause(ctx); err != nil {
			return false, err
		}
	}
}
func DaemonBin() (string, error) {
	if b := os.Getenv("WOOF_DAEMON_BIN"); b != "" {
		return b, nil
	}
	exe, e := os.Executable()
	if e != nil {
		return "", e
	}
	exe, e = filepath.EvalSymlinks(exe)
	if e != nil {
		return "", e
	}
	b := filepath.Join(filepath.Dir(exe), "woofd")
	if _, e = os.Stat(b); e != nil {
		return "", fmt.Errorf("woofd not found next to %s: %w", exe, e)
	}
	return b, nil
}
func daemonEnv(p paths.Paths) []string {
	drop := map[string]bool{"HERDR_SESSION": true, "HERDR_SOCKET_PATH": true, "HERDR_PANE_ID": true, "HERDR_WORKSPACE_ID": true, "HERDR_TAB_ID": true, "WOOF_SESSION_ID": true, "WOOF_WORKSPACE_ID": true, "WOOF_WORKTREE_ID": true, "WOOF_RUN_ID": true, "WOOF_WORKER_ID": true, "WOOF_ATTACHMENT_ID": true, "WOOF_STATE_DIR": true, "WOOF_CONFIG": true}
	var out []string
	for _, s := range os.Environ() {
		k, _, _ := strings.Cut(s, "=")
		if !drop[k] {
			out = append(out, s)
		}
	}
	return append(out, "WOOF_STATE_DIR="+p.Dir, "WOOF_CONFIG="+p.Config)
}
func (c *Client) Spawn() error {
	b, e := DaemonBin()
	if e != nil {
		return e
	}
	f, e := os.OpenFile(c.Paths.Log, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	cmd := exec.Command(b)
	cmd.Dir = c.Paths.Dir
	cmd.Env = daemonEnv(c.Paths)
	cmd.Stdout = f
	cmd.Stderr = f
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if e = cmd.Start(); e != nil {
		return e
	}
	return cmd.Process.Release()
}
