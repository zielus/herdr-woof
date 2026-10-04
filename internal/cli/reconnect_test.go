package cli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zielus/herdr-woof/internal/client"
	"github.com/zielus/herdr-woof/internal/model"
	"github.com/zielus/herdr-woof/internal/paths"
)

// A real Unix wire peer isolates disconnect windows while exercising the actual
// CLI, client retry classification, framing, cursors and context cancellation.
func cliPeer(t *testing.T, handle func(net.Conn, model.Request)) *client.Client {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "woof-cli-")
	if err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(dir, "s")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		_ = os.RemoveAll(dir) // Best effort after fixture startup already failed.
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := ln.Close(); err != nil {
			t.Error(err)
		}
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				// The peer deliberately disconnects; closing has no pending writes.
				defer func() { _ = c.Close() }()
				line, err := bufio.NewReader(c).ReadBytes('\n')
				if err != nil {
					return
				}
				var req model.Request
				if json.Unmarshal(line, &req) != nil {
					return
				}
				handle(c, req)
			}()
		}
	}()
	return &client.Client{Paths: paths.Paths{Sock: sock}, Caller: model.Caller{Cwd: dir}}
}
func cliResponse(c net.Conn, value any, err *model.Error) {
	raw, _ := json.Marshal(value)
	_ = json.NewEncoder(c).Encode(model.Response{Version: model.Protocol, OK: err == nil, Result: raw, Error: err})
}

func TestWaitReconnectKeepsCursorCapturedBeforeFirstEvent(t *testing.T) {
	var waits atomic.Int32
	peer := cliPeer(t, func(c net.Conn, r model.Request) {
		switch r.Op {
		case "ping":
			cliResponse(c, map[string]bool{"ready": true}, nil)
		case "status":
			cliResponse(c, map[string]int{"event_cursor": 10}, nil)
		case "wait":
			if waits.Add(1) == 1 {
				return
			}
			var a Args
			_ = json.Unmarshal(r.Args, &a)
			if a.Since == nil || *a.Since != 10 {
				cliResponse(c, nil, &model.Error{Code: "timeout", Message: "event before reconnect was skipped"})
				return
			}
			cliResponse(c, model.Event{Seq: 11, Type: "gate.created"}, nil)
		}
	})
	command, err := Parse([]string{"wait", "--timeout", "1s", "--json"})
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := Execute(ctx, peer, command, &out); err != nil {
		t.Fatal(err)
	}
	var event model.Event
	if err := json.Unmarshal(out.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	if event.Seq != 11 {
		t.Fatalf("missed replay: %s", out.String())
	}
}

func TestWaitReconnectHonorsOriginalDeadline(t *testing.T) {
	var waits atomic.Int32
	peer := cliPeer(t, func(c net.Conn, r model.Request) {
		switch r.Op {
		case "ping":
			cliResponse(c, map[string]bool{"ready": true}, nil)
		case "wait":
			if waits.Add(1) == 1 {
				time.Sleep(150 * time.Millisecond)
				return
			}
			time.Sleep(120 * time.Millisecond)
			cliResponse(c, model.Event{Seq: 1, Type: "too.late"}, nil)
		}
	})
	command, err := Parse([]string{"wait", "--since", "0", "--timeout", "200ms", "--json"})
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err = Execute(ctx, peer, command, &out)
	var me *model.Error
	if !errors.As(err, &me) || me.Code != "timeout" || out.Len() != 0 {
		t.Fatalf("wait restarted deadline: err=%v output=%s", err, out.String())
	}
}

type cancelOutput struct {
	bytes.Buffer
	cancel context.CancelFunc
}

func (w *cancelOutput) Write(p []byte) (int, error) {
	n, err := w.Buffer.Write(p)
	w.cancel()
	return n, err
}
func TestFollowReconnectBeforeFirstEventPreservesHead(t *testing.T) {
	var follows atomic.Int32
	peer := cliPeer(t, func(c net.Conn, r model.Request) {
		switch r.Op {
		case "ping":
			cliResponse(c, map[string]bool{"ready": true}, nil)
		case "status":
			cliResponse(c, map[string]int{"event_cursor": 10}, nil)
		case "events.follow":
			if follows.Add(1) == 1 {
				return
			}
			var a Args
			_ = json.Unmarshal(r.Args, &a)
			if a.Since != nil && *a.Since == 10 {
				cliResponse(c, model.Event{Seq: 11, Type: "gate.created"}, nil)
			}
		}
	})
	command, _ := Parse([]string{"events", "follow"})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	out := &cancelOutput{cancel: cancel}
	if err := Execute(ctx, peer, command, out); err != nil {
		t.Fatal(err)
	}
	var event model.Event
	if err := json.Unmarshal(out.Bytes(), &event); err != nil {
		t.Fatalf("no replay before first event: %q: %v", out.String(), err)
	}
	if event.Seq != 11 {
		t.Fatalf("missed event: %+v", event)
	}
}

func TestExecuteDistinguishesExplicitFromInheritedScope(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		t.Run(map[bool]string{false: "inherited", true: "explicit"}[explicit], func(t *testing.T) {
			requests := make(chan model.Request, 1)
			peer := cliPeer(t, func(c net.Conn, r model.Request) {
				requests <- r
				cliResponse(c, map[string]int{"event_cursor": 0}, nil)
			})
			peer.Caller.WorkerID = "w_identity"
			peer.Scope = model.Scope{WorkspaceID: "ws_stale"}
			argv := []string{"status", "--json"}
			if explicit {
				argv = append(argv, "--workspace", "ws_selected")
			}
			command, err := Parse(argv)
			if err != nil {
				t.Fatal(err)
			}
			if err := Execute(context.Background(), peer, command, &bytes.Buffer{}); err != nil {
				t.Fatal(err)
			}
			r := <-requests
			if r.ScopeExplicit != explicit || r.Caller.WorkerID != "w_identity" {
				t.Fatalf("request=%+v", r)
			}
			want := "ws_stale"
			if explicit {
				want = "ws_selected"
			}
			if r.Scope.WorkspaceID != want {
				t.Fatalf("workspace=%q want=%q", r.Scope.WorkspaceID, want)
			}
		})
	}
}

func TestExplicitActorOverridesCallerAndClearsInheritedScope(t *testing.T) {
	for _, scoped := range []bool{false, true} {
		t.Run(map[bool]string{false: "inferred", true: "selected"}[scoped], func(t *testing.T) {
			requests := make(chan model.Request, 1)
			peer := cliPeer(t, func(c net.Conn, r model.Request) { requests <- r; cliResponse(c, nil, nil) })
			peer.Caller.WorkerID, peer.Caller.AttachmentID = "worker_stale", "attachment_stale"
			peer.Scope = model.Scope{WorkerID: "worker_stale", WorkspaceID: "workspace_inherited"}
			argv := []string{"status", "--as-worker", "worker_actor", "--as-attachment", "attachment_live"}
			if scoped {
				argv = append(argv, "--worker-scope", "worker_selected")
			}
			command, err := Parse(argv)
			if err != nil {
				t.Fatal(err)
			}
			if err = Execute(context.Background(), peer, command, &bytes.Buffer{}); err != nil {
				t.Fatal(err)
			}
			r := <-requests
			if r.Caller.WorkerID != "worker_actor" || r.Caller.AttachmentID != "attachment_live" || r.ScopeExplicit != scoped {
				t.Fatalf("actor request=%+v", r)
			}
			want := ""
			if scoped {
				want = "worker_selected"
			}
			if r.Scope.WorkerID != want {
				t.Fatalf("worker scope=%q want=%q", r.Scope.WorkerID, want)
			}
			if !scoped && r.Scope != (model.Scope{}) {
				t.Fatalf("old actor scope survived: %+v", r.Scope)
			}
			if peer.Caller.WorkerID != "worker_stale" || peer.Scope.WorkerID != "worker_stale" {
				t.Fatal("mutated shared client")
			}
		})
	}
}
