// Durable cursor and dropped-transport behavior adapt herdr-orch (MIT),
// internal/client/client.go and internal/daemon/plans.go. Woof remains one
// global daemon with an explicit human actor; see ../rpc/LICENSE.MIT.
package tui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/zielus/herdr-woof/internal/client"
	"github.com/zielus/herdr-woof/internal/model"
	"github.com/zielus/herdr-woof/internal/profiles"
	"github.com/zielus/herdr-woof/internal/rpc"
)

// NewRPCBackend creates an explicit human operator client. Herdr pane/socket and
// worker environment variables must never infer this UI's actor or browse scope.
func NewRPCBackend() (*RPCBackend, error) {
	c, err := client.New()
	if err != nil {
		return nil, err
	}
	c.Caller = model.Caller{ProcessID: c.Caller.ProcessID, Cwd: c.Caller.Cwd}
	c.Scope = model.Scope{Global: true}
	c.ScopeExplicit = true
	return &RPCBackend{Base: c}, nil
}

func (b *RPCBackend) scoped(scope model.Scope) *client.Client {
	c := *b.Base
	c.Caller = model.Caller{ProcessID: c.Caller.ProcessID, Cwd: c.Caller.Cwd}
	if scope == (model.Scope{}) {
		scope.Global = true
	}
	c.Scope = scope
	c.ScopeExplicit = true
	return &c
}

func connectionError(err error) error {
	if errors.Is(err, rpc.ErrLost) || errors.Is(err, rpc.ErrUnavailable) {
		return &ConnectionError{Err: err}
	}
	return err
}

// Load captures the replay boundary before any views. Reads can observe newer
// state than the boundary; follow replay invalidates it without losing commits.
func (b *RPCBackend) Load(ctx context.Context, scope model.Scope) (Snapshot, error) {
	c := b.scoped(scope)
	snap := Snapshot{Scope: c.Scope, ProfileDetails: map[string]profiles.Profile{}, Reports: map[string]MessageDetail{}, WorkerInboxes: map[string][]InboxEntry{}, Errors: map[string]string{}}
	var tail model.EventTail
	if err := c.Call(ctx, "events.tail", map[string]any{"limit": 500}, &tail); err != nil {
		return snap, connectionError(err)
	}
	snap.Cursor = tail.EventCursor
	snap.Events = tail.Events
	for _, read := range []struct {
		op  string
		out any
	}{
		{"session.list", &snap.Sessions}, {"workspace.list", &snap.Workspaces},
		{"worktree.list", &snap.Worktrees}, {"run.list", &snap.Runs},
		{"worker.list", &snap.Workers}, {"check", &snap.Dispatches}, {"gate.list", &snap.Gates},
	} {
		if err := c.Call(ctx, read.op, nil, read.out); err != nil {
			return snap, connectionError(err)
		}
	}
	if err := c.Call(ctx, "inbox", map[string]any{"id": "human", "all": true}, &snap.Inbox); err != nil {
		return snap, connectionError(err)
	}
	// Schedules are an isolated optional section: any failure, including a
	// transport loss or an older daemon, stays under "schedules" and never makes
	// the canonical snapshot or other tabs stale.
	if err := c.Call(ctx, "schedule.list", map[string]any{"all": false}, &snap.Schedules); err != nil {
		snap.Schedules = nil
		if ctx.Err() != nil {
			return snap, ctx.Err()
		}
		snap.Errors["schedules"] = scheduleSectionError(err)
	}

	// Detail failures leave the canonical monitor usable. Connection loss still
	// invalidates readiness, even if it first happens in an optional section.
	var mu sync.Mutex
	var transportErr error
	recordError := func(section string, err error) {
		mu.Lock()
		defer mu.Unlock()
		if errors.Is(err, rpc.ErrLost) || errors.Is(err, rpc.ErrUnavailable) || ctx.Err() != nil {
			if transportErr == nil {
				transportErr = connectionError(err)
			}
			return
		}
		if snap.Errors[section] == "" {
			snap.Errors[section] = err.Error()
		}
	}
	jobs := []func(){}
	for _, worker := range snap.Workers {
		jobs = append(jobs, func() {
			var entries []InboxEntry
			if err := c.Call(ctx, "inbox", map[string]any{"id": worker.ID, "all": true}, &entries); err != nil {
				recordError("worker_inboxes", fmt.Errorf("%s: %w", worker.ID, err))
				return
			}
			filtered := make([]InboxEntry, 0, len(entries))
			for _, entry := range entries {
				if inboxMatches(entry, c.Scope) {
					filtered = append(filtered, entry)
				}
			}
			mu.Lock()
			snap.WorkerInboxes[worker.ID] = filtered
			mu.Unlock()
		})
	}
	seen := map[string]bool{}
	for _, dispatch := range snap.Dispatches {
		id := dispatch.DoneMessageID
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		jobs = append(jobs, func() {
			var detail MessageDetail
			if err := c.Call(ctx, "message.show", map[string]any{"id": id}, &detail); err != nil {
				recordError("reports", fmt.Errorf("%s: %w", id, err))
				return
			}
			mu.Lock()
			snap.Reports[id] = detail
			mu.Unlock()
		})
	}
	if err := c.Call(ctx, "profile.roster", nil, &snap.Profiles); err != nil {
		recordError("profiles", err)
	}
	for _, summary := range snap.Profiles {
		jobs = append(jobs, func() {
			var detail profiles.Profile
			if err := c.Call(ctx, "profile.show", map[string]any{"id": summary.Name}, &detail); err != nil {
				recordError("profiles", fmt.Errorf("%s: %w", summary.Name, err))
				return
			}
			mu.Lock()
			snap.ProfileDetails[summary.Name] = detail
			mu.Unlock()
		})
	}
	// Four reads at once keep large catalogues from opening one socket per worker.
	queue := make(chan func())
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			for job := range queue {
				if ctx.Err() == nil {
					job()
				}
			}
		})
	}
	for _, job := range jobs {
		select {
		case queue <- job:
		case <-ctx.Done():
		}
	}
	close(queue)
	wg.Wait()
	if ctx.Err() != nil {
		return snap, ctx.Err()
	}
	return snap, transportErr
}

// scheduleSectionError explains an older daemon that predates schedules: it
// answers the read with request_id_required (unknown op treated as a mutation)
// or unknown_operation.
func scheduleSectionError(err error) string {
	var problem *model.Error
	if errors.As(err, &problem) && (problem.Code == "request_id_required" || problem.Code == "unknown_operation") {
		return "daemon lacks schedules; run `woof daemon restart` after upgrading"
	}
	return err.Error()
}

func inboxMatches(entry InboxEntry, scope model.Scope) bool {
	if scope.Global {
		return true
	}
	m := entry.Message
	return (scope.SessionID == "" || m.SessionID == scope.SessionID) &&
		(scope.WorkspaceID == "" || m.WorkspaceID == scope.WorkspaceID) &&
		(scope.WorktreeID == "" || m.WorktreeID == scope.WorktreeID) &&
		(scope.RunID == "" || m.RunID == scope.RunID) &&
		(scope.WorkerID == "" || m.FromWorkerID == scope.WorkerID || entry.Delivery.WorkerID == scope.WorkerID)
}

// Follow uses the donor's durable replay cursor and Woof's cancellable NDJSON
// transport. A lost stream is reported before retrying, so the UI remains stale
// until a separate canonical reload succeeds. No mutation is retried here.
func (b *RPCBackend) Follow(ctx context.Context, scope model.Scope, cursor int64, emit func(StreamUpdate) error) error {
	if cursor < 0 {
		return fmt.Errorf("event cursor must be nonnegative")
	}
	c := b.scoped(scope)
	delay := 100 * time.Millisecond
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		args, err := json.Marshal(map[string]any{"since": cursor})
		if err != nil {
			return err
		}
		req := model.Request{Version: model.Protocol, Op: "events.follow", Caller: c.Caller, Scope: c.Scope, ScopeExplicit: true, Args: args}
		var consumerErr error
		err = rpc.Stream(ctx, c.Paths.Sock, req, func(raw json.RawMessage) error {
			var event model.Event
			if err := json.Unmarshal(raw, &event); err != nil {
				consumerErr = err
				return err
			}
			if event.Seq <= 0 {
				consumerErr = fmt.Errorf("stream event is missing a positive sequence")
				return consumerErr
			}
			if event.Seq <= cursor {
				return nil
			}
			if consumerErr = emit(StreamUpdate{Event: &event}); consumerErr != nil {
				return consumerErr
			}
			cursor = event.Seq
			delay = 100 * time.Millisecond
			return nil
		})
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if consumerErr != nil {
			return consumerErr
		}
		if err == nil {
			err = io.EOF
		}
		if emitErr := emit(StreamUpdate{Err: &ConnectionError{Err: err}}); emitErr != nil {
			return emitErr
		}
		var daemonErr *model.Error
		recoverable := errors.Is(err, rpc.ErrLost) || errors.Is(err, rpc.ErrUnavailable) || errors.Is(err, io.EOF) || (errors.As(err, &daemonErr) && daemonErr.Code == "slow_subscriber")
		if !recoverable {
			return err
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		delay = min(delay*2, 2*time.Second)
	}
}

// ScheduleDetail reads schedule.show in the browse scope. It is side-effect free;
// the UI fences late results by scope generation, schedule ID and request.
func (b *RPCBackend) ScheduleDetail(ctx context.Context, scope model.Scope, id string) (ScheduleDetail, error) {
	var detail ScheduleDetail
	err := b.scoped(scope).Call(ctx, "schedule.show", map[string]any{"id": id}, &detail)
	return detail, connectionError(err)
}

// ScheduleRun finds one occurrence's current state through schedule.history
// (a human global read), joined with its message, dispatch and attempt receipt.
func (b *RPCBackend) ScheduleRun(ctx context.Context, scheduleID, runID string) (ScheduleRunView, error) {
	var runs []ScheduleRunView
	if err := b.scoped(model.Scope{Global: true}).Call(ctx, "schedule.history", map[string]any{"id": scheduleID, "limit": 100}, &runs); err != nil {
		return ScheduleRunView{}, connectionError(err)
	}
	for _, v := range runs {
		if v.Run.ID == runID {
			return v, nil
		}
	}
	return ScheduleRunView{}, fmt.Errorf("occurrence %s not found in recent history of %s", runID, scheduleID)
}

func (b *RPCBackend) Operation(ctx context.Context, id string) (model.Operation, error) {
	var operation model.Operation
	err := b.scoped(model.Scope{Global: true}).Call(ctx, "operation.show", map[string]any{"id": id}, &operation)
	return operation, connectionError(err)
}
