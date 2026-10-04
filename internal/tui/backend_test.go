package tui

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/zielus/herdr-woof-v2/internal/client"
	"github.com/zielus/herdr-woof-v2/internal/daemon"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/paths"
	"github.com/zielus/herdr-woof-v2/internal/profiles"
	"github.com/zielus/herdr-woof-v2/internal/rpc"
	"github.com/zielus/herdr-woof-v2/internal/store"
)

func testPaths(t *testing.T) paths.Paths {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "woof-tui-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	return paths.Paths{Dir: dir, DB: filepath.Join(dir, "db"), Sock: filepath.Join(dir, "sock"), Lock: filepath.Join(dir, "lock")}
}

func TestNewRPCBackendIsolatesHumanActorAndGlobalScope(t *testing.T) {
	t.Setenv("WOOF_STATE_DIR", t.TempDir())
	for k, v := range map[string]string{"WOOF_WORKER_ID": "w_inherited", "WOOF_ATTACHMENT_ID": "a_stale", "WOOF_SESSION_ID": "s_inherited", "WOOF_WORKSPACE_ID": "ws_inherited", "WOOF_WORKTREE_ID": "wt_inherited", "WOOF_RUN_ID": "r_inherited", "HERDR_SOCKET_PATH": "/stale/socket", "HERDR_PANE_ID": "w9:p9"} {
		t.Setenv(k, v)
	}
	b, err := NewRPCBackend()
	if err != nil {
		t.Fatal(err)
	}
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if b.Base.Caller != (model.Caller{ProcessID: os.Getpid(), Cwd: cwd}) || b.Base.Scope != (model.Scope{Global: true}) || !b.Base.ScopeExplicit {
		t.Fatalf("inherited actor escaped: %+v", b.Base)
	}
}

func TestRPCBackendLoadCanonicalScopedAndGlobalViews(t *testing.T) {
	p := testPaths(t)
	st, err := store.Open(p.DB)
	if err != nil {
		t.Fatal(err)
	}
	_, err = st.Write(context.Background(), func(tx *store.Tx) error {
		recs := []struct {
			kind, id string
			value    any
		}{
			{"sessions", "s_a", model.Session{ID: "s_a", Status: "offline"}},
			{"sessions", "s_b", model.Session{ID: "s_b", Status: "offline"}},
			{"workspaces", "ws_a", model.Workspace{ID: "ws_a", SessionID: "s_a"}},
			{"workspaces", "ws_b", model.Workspace{ID: "ws_b", SessionID: "s_b"}},
			{"worktrees", "wt_a", model.Worktree{ID: "wt_a", SessionID: "s_a", WorkspaceID: "ws_a", Path: "/a"}},
			{"runs", "r_a", model.Run{ID: "r_a", SessionID: "s_a", WorkspaceID: "ws_a", WorktreeID: "wt_a"}},
			{"workers", "w_a", model.Worker{ID: "w_a", SessionID: "s_a", WorkspaceID: "ws_a", WorktreeID: "wt_a", RunID: "r_a", Name: "builder", State: "stopped"}},
			{"workers", "w_b", model.Worker{ID: "w_b", SessionID: "s_b", WorkspaceID: "ws_b", Name: "builder", State: "stopped"}},
			{"messages", "m_report", model.Message{ID: "m_report", SessionID: "s_a", WorkspaceID: "ws_a", WorktreeID: "wt_a", RunID: "r_a", ToKind: "human", Body: "report", Kind: "done", Artifacts: []model.Artifact{{Path: "/missing/report"}}}},
			{"messages", "m_else", model.Message{ID: "m_else", SessionID: "s_b", WorkspaceID: "ws_b", ToKind: "human", Body: "else"}},
			{"messages", "m_worker", model.Message{ID: "m_worker", SessionID: "s_a", WorkspaceID: "ws_a", WorktreeID: "wt_a", RunID: "r_a", ToKind: "worker", ToID: "w_a", Body: "worker"}},
			{"messages", "m_worker_else", model.Message{ID: "m_worker_else", SessionID: "s_b", WorkspaceID: "ws_b", ToKind: "worker", ToID: "w_a", Body: "cross scope"}},
			{"deliveries", "dl_report", model.Delivery{ID: "dl_report", MessageID: "m_report", SessionID: "s_a", WorkspaceID: "ws_a", RunID: "r_a", Human: true, ConsumedAt: 123, Status: "consumed"}},
			{"deliveries", "dl_else", model.Delivery{ID: "dl_else", MessageID: "m_else", SessionID: "s_b", WorkspaceID: "ws_b", Human: true}},
			{"deliveries", "dl_worker", model.Delivery{ID: "dl_worker", MessageID: "m_worker", WorkerID: "w_a", SessionID: "s_a", WorkspaceID: "ws_a", RunID: "r_a"}},
			{"deliveries", "dl_worker_else", model.Delivery{ID: "dl_worker_else", MessageID: "m_worker_else", WorkerID: "w_a", SessionID: "s_b", WorkspaceID: "ws_b"}},
			{"dispatches", "d_a", model.Dispatch{ID: "d_a", SessionID: "s_a", WorkspaceID: "ws_a", WorktreeID: "wt_a", RunID: "r_a", WorkerID: "w_a", DoneMessageID: "m_report", Status: "settled", TurnEnded: true}},
			{"gates", "g_a", model.Gate{ID: "g_a", SessionID: "s_a", WorkspaceID: "ws_a", RunID: "r_a", Question: "Ship?"}},
			{"operations", "op_a", model.Operation{ID: "op_a", State: "uncertain", Op: "send"}},
		}
		for _, rec := range recs {
			if err := tx.Put(rec.kind, rec.id, rec.value); err != nil {
				return err
			}
		}
		if err := tx.Event("worker.observed", model.Scope{SessionID: "s_a", WorkspaceID: "ws_a", WorktreeID: "wt_a", RunID: "r_a"}, "human", "", nil); err != nil {
			return err
		}
		return tx.Event("worker.observed", model.Scope{SessionID: "s_b"}, "human", "", nil)
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	cfg := profiles.Config{Profiles: map[string]profiles.Profile{"literal": {Agent: "claude", Args: []string{"--model", "literal value", "$(must remain literal)"}, Description: "test", Tags: []string{"code"}}}}
	serverCtx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- daemon.Run(serverCtx, daemon.Options{Paths: p, Config: cfg, WatchdogInterval: time.Hour})
	}()
	t.Cleanup(func() {
		stop()
		if err := <-done; err != nil {
			t.Error(err)
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	for {
		if err := rpc.Call(ctx, p.Sock, model.Request{Version: model.Protocol, Op: "ping"}, nil); err == nil {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("daemon unavailable")
		case <-time.After(time.Millisecond):
		}
	}
	b := &RPCBackend{Base: &client.Client{Paths: p}}
	snap, err := b.Load(ctx, model.Scope{WorktreeID: "wt_a"})
	if err != nil {
		t.Fatal(err)
	}
	if snap.Cursor < 2 || len(snap.Events) != 1 || len(snap.Sessions) != 1 || len(snap.Workspaces) != 1 || len(snap.Worktrees) != 1 || len(snap.Runs) != 1 || len(snap.Workers) != 1 || snap.Workers[0].ID != "w_a" || len(snap.Dispatches) != 1 || len(snap.Gates) != 1 {
		t.Fatalf("scoped canonical views: %+v", snap)
	}
	if len(snap.Inbox) != 1 || snap.Inbox[0].Delivery.ConsumedAt != 123 || !snap.Inbox[0].Delivery.Human {
		t.Fatalf("human all-receipts inbox: %+v", snap.Inbox)
	}
	if len(snap.WorkerInboxes["w_a"]) != 1 || snap.WorkerInboxes["w_a"][0].Message.ID != "m_worker" {
		t.Fatalf("worker scope leak: %+v", snap.WorkerInboxes)
	}
	if len(snap.Reports) != 1 || snap.Reports["m_report"].Message.Body != "report" || len(snap.Reports["m_report"].Artifacts) != 1 || snap.Reports["m_report"].Artifacts[0].Exists || len(snap.Reports["m_report"].Deliveries) != 1 {
		t.Fatalf("report detail: %+v", snap.Reports)
	}
	if len(snap.Profiles) != 1 || snap.Profiles[0].Description != "test" || !reflect.DeepEqual(snap.ProfileDetails["literal"].Args, []string{"--model", "literal value", "$(must remain literal)"}) {
		t.Fatalf("profiles: %+v", snap)
	}
	all, err := b.Load(ctx, model.Scope{Global: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(all.Sessions) != 2 || len(all.Workspaces) != 2 || len(all.Workers) != 2 || len(all.Inbox) != 2 || len(all.Events) < 2 || len(all.WorkerInboxes["w_a"]) != 2 {
		t.Fatalf("global catalogue incomplete: %+v", all)
	}
	op, err := b.Operation(ctx, "op_a")
	if err != nil || op.ID != "op_a" || op.State != "uncertain" {
		t.Fatalf("operation: %+v %v", op, err)
	}
}

// Dropped Unix connections adapt herdr-orch's fakeDaemon/uncertain request
// fixture (MIT). Real framing and client cancellation are retained.
func streamFixture(t *testing.T, handler func(net.Conn, model.Request)) paths.Paths {
	t.Helper()
	p := testPaths(t)
	ln, err := net.Listen("unix", p.Sock)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer func() {
					if err := c.Close(); err != nil {
						t.Error(err)
					}
				}()
				line, err := bufio.NewReader(c).ReadBytes('\n')
				if err != nil {
					t.Error(err)
					return
				}
				var req model.Request
				if err := json.Unmarshal(line, &req); err != nil {
					t.Error(err)
					return
				}
				handler(c, req)
			}()
		}
	}()
	t.Cleanup(func() {
		if err := ln.Close(); err != nil {
			t.Error(err)
		}
		<-stopped
		wg.Wait()
	})
	return p
}
func streamReply(t *testing.T, c net.Conn, result any) {
	t.Helper()
	raw, err := json.Marshal(result)
	if err != nil {
		t.Error(err)
		return
	}
	if err := json.NewEncoder(c).Encode(model.Response{Version: model.Protocol, OK: true, Result: raw}); err != nil {
		t.Error(err)
	}
}

func TestRPCBackendFollowReconnectsAcceptedCursorAndNotifiesLoss(t *testing.T) {
	requests := make(chan model.Request, 4)
	var mu sync.Mutex
	attempt := 0
	p := streamFixture(t, func(c net.Conn, r model.Request) {
		requests <- r
		mu.Lock()
		attempt++
		n := attempt
		mu.Unlock()
		if n == 1 {
			streamReply(t, c, model.Event{Seq: 11, Type: "first"})
			return
		}
		streamReply(t, c, model.Event{Seq: 13, Type: "second"})
	})
	b := &RPCBackend{Base: &client.Client{Paths: p, Caller: model.Caller{WorkerID: "stale", PaneID: "w:p"}, Scope: model.Scope{RunID: "stale"}}}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	sentinel := errors.New("stop consumer")
	var events []int64
	losses := 0
	err := b.Follow(ctx, model.Scope{SessionID: "s_a"}, 7, func(u StreamUpdate) error {
		if u.Err != nil {
			var ce *ConnectionError
			if !errors.As(u.Err, &ce) {
				t.Fatalf("loss untyped: %v", u.Err)
			}
			losses++
			return nil
		}
		events = append(events, u.Event.Seq)
		if u.Event.Seq == 13 {
			return sentinel
		}
		return nil
	})
	if !errors.Is(err, sentinel) || !reflect.DeepEqual(events, []int64{11, 13}) || losses != 1 {
		t.Fatalf("follow events=%v losses=%d err=%v", events, losses, err)
	}
	for _, want := range []int64{7, 11} {
		r := <-requests
		var args struct {
			Since int64 `json:"since"`
		}
		if err := json.Unmarshal(r.Args, &args); err != nil {
			t.Fatal(err)
		}
		if args.Since != want || r.ID != "" || r.Op != "events.follow" || r.Scope != (model.Scope{SessionID: "s_a"}) || !r.ScopeExplicit || r.Caller.WorkerID != "" || r.Caller.PaneID != "" {
			t.Fatalf("reconnect request: %+v args=%+v", r, args)
		}
	}
	select {
	case r := <-requests:
		t.Fatalf("consumer error retried: %+v", r)
	default:
	}
}

func TestRPCBackendFollowCancellationClosesIdleStream(t *testing.T) {
	entered := make(chan struct{})
	closed := make(chan struct{})
	p := streamFixture(t, func(c net.Conn, r model.Request) {
		close(entered)
		_, err := io.Copy(io.Discard, c)
		if err != nil {
			t.Error(err)
		}
		close(closed)
	})
	b := &RPCBackend{Base: &client.Client{Paths: p}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- b.Follow(ctx, model.Scope{Global: true}, 0, func(StreamUpdate) error { return fmt.Errorf("unexpected update") })
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		cancel()
		t.Fatal("stream never opened")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("idle stream ignored cancellation")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("transport leaked")
	}
}

func TestRPCBackendFollowCancellationDuringReconnectBackoff(t *testing.T) {
	p := streamFixture(t, func(net.Conn, model.Request) {})
	b := &RPCBackend{Base: &client.Client{Paths: p}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	losses := 0
	started := time.Now()
	err := b.Follow(ctx, model.Scope{Global: true}, 0, func(u StreamUpdate) error {
		if u.Err != nil {
			losses++
			cancel()
		}
		return nil
	})
	if !errors.Is(err, context.Canceled) || losses != 1 || time.Since(started) > time.Second {
		t.Fatalf("cancel during retry: loss=%d err=%v elapsed=%v", losses, err, time.Since(started))
	}
}

func TestRPCBackendSnapshotCursorPrecedesViewReads(t *testing.T) {
	var mu sync.Mutex
	tailSeen := false
	viewReads := 0
	p := streamFixture(t, func(c net.Conn, r model.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.Op {
		case "events.tail":
			tailSeen = true
			streamReply(t, c, model.EventTail{EventCursor: 5, Events: []model.Event{}})
		case "events.follow":
			var a struct {
				Since int64 `json:"since"`
			}
			if err := json.Unmarshal(r.Args, &a); err != nil {
				t.Error(err)
			}
			if a.Since != 5 {
				t.Errorf("race lost boundary: %d", a.Since)
			}
			streamReply(t, c, model.Event{Seq: 6, Type: "worker.observed"})
		default:
			if !tailSeen {
				t.Error("view read before replay boundary captured")
			}
			viewReads++
			streamReply(t, c, []any{})
		}
	})
	b := &RPCBackend{Base: &client.Client{Paths: p}}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	snap, err := b.Load(ctx, model.Scope{Global: true})
	if err != nil {
		t.Fatal(err)
	}
	if snap.Cursor != 5 || viewReads == 0 {
		t.Fatalf("snapshot %+v", snap)
	}
	sentinel := errors.New("received raced event")
	err = b.Follow(ctx, snap.Scope, snap.Cursor, func(u StreamUpdate) error {
		if u.Event == nil || u.Event.Seq != 6 {
			t.Fatalf("raced event: %+v", u)
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
}

func TestRPCBackendOptionalDetailFailuresRemainVisible(t *testing.T) {
	p := streamFixture(t, func(c net.Conn, r model.Request) {
		switch r.Op {
		case "events.tail":
			streamReply(t, c, model.EventTail{EventCursor: 8, Events: []model.Event{}})
		case "check":
			streamReply(t, c, []model.Dispatch{{ID: "d_a", DoneMessageID: "m_missing"}})
		case "worker.list":
			streamReply(t, c, []model.Worker{{ID: "w_a"}})
		case "profile.roster", "message.show":
			if err := json.NewEncoder(c).Encode(model.Response{Version: model.Protocol, OK: false, Error: &model.Error{Code: "not_found", Message: "optional detail unavailable"}}); err != nil {
				t.Error(err)
			}
		case "inbox":
			var a struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(r.Args, &a); err != nil {
				t.Error(err)
			}
			if a.ID == "human" {
				streamReply(t, c, []InboxEntry{{Message: model.Message{ID: "m_a"}, Delivery: model.Delivery{Human: true}}})
			} else {
				if err := json.NewEncoder(c).Encode(model.Response{Version: model.Protocol, OK: false, Error: &model.Error{Code: "not_found", Message: "missing worker"}}); err != nil {
					t.Error(err)
				}
			}
		default:
			streamReply(t, c, []any{})
		}
	})
	b := &RPCBackend{Base: &client.Client{Paths: p}}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	snap, err := b.Load(ctx, model.Scope{Global: true})
	if err != nil || len(snap.Inbox) != 1 || len(snap.Workers) != 1 || snap.Cursor != 8 {
		t.Fatalf("optional failure blanked canonical views: %+v %v", snap, err)
	}
	for _, section := range []string{"profiles", "reports", "worker_inboxes"} {
		if snap.Errors[section] == "" {
			t.Fatalf("missing visible error in %s: %+v", section, snap.Errors)
		}
	}
}

func TestRPCBackendFollowConsumerFailureDoesNotRetry(t *testing.T) {
	p := streamFixture(t, func(c net.Conn, _ model.Request) { streamReply(t, c, model.Event{Seq: 7, Type: "worker.observed"}) })
	b := &RPCBackend{Base: &client.Client{Paths: p}}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	sentinel := errors.New("consumer rejected event")
	callbacks := 0
	err := b.Follow(ctx, model.Scope{Global: true}, 0, func(StreamUpdate) error { callbacks++; return sentinel })
	if !errors.Is(err, sentinel) || callbacks != 1 {
		t.Fatalf("callback failure retried: %d %v", callbacks, err)
	}
}
