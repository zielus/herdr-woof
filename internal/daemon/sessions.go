package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/zielus/herdr-woof-v2/internal/herdr"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/rpc"
	"github.com/zielus/herdr-woof-v2/internal/store"
)

// Session ownership and subscription recovery adapt Orch's subscription loop.
// Woof isolates each session and replaces confirmed streams with generation fencing.
func (e *Engine) attachSession(ctx context.Context, r model.Request, a Args) (any, error) {
	socket := a.Socket
	if socket == "" {
		socket = r.Caller.HerdrSocket
	}
	if socket == "" {
		return nil, problem("socket_required", "select the Herdr socket explicitly")
	}
	var err error
	socket, err = canonicalHerdrSocket(socket)
	if err != nil {
		return nil, err
	}
	name := a.HerdrName
	if name == "" {
		name = "default"
		dir := filepath.Dir(socket)
		if filepath.Base(filepath.Dir(dir)) == "sessions" {
			name = filepath.Base(dir)
		}
	}
	var s model.Session
	err = e.write(ctx, func(tx *store.Tx) error {
		ss, x := txList[model.Session](tx, "sessions", model.Scope{})
		if x != nil {
			return x
		}
		for _, v := range ss {
			canonical, canonicalErr := canonicalHerdrSocket(v.SocketPath)
			if canonicalErr == nil && canonical == socket {
				s = v
				break
			}
		}
		id := a.ID
		if id == "" && r.ScopeExplicit {
			id = r.Scope.SessionID
		}
		if id != "" {
			s, x = txGet[model.Session](tx, "sessions", id)
			if x != nil {
				return x
			}
			for _, v := range ss {
				canonical, canonicalErr := canonicalHerdrSocket(v.SocketPath)
				if canonicalErr == nil && canonical == socket && v.ID != s.ID {
					return problem("session_conflict", "socket belongs to another session")
				}
			}
		}
		if s.ID == "" {
			s = model.Session{ID: newID("session"), CreatedAt: e.now(), Status: "offline"}
		}
		s.HerdrName = name
		s.SocketPath = socket
		if x = tx.Put("sessions", s.ID, s); x != nil {
			return x
		}
		if x = tx.Event("session.registered", model.Scope{SessionID: s.ID}, "daemon", "", s); x != nil {
			return x
		}
		// Registration and receipt are atomic. Connectivity is separately observable.
		return e.finishTx(tx, r.ID, s, nil, "completed")
	})
	if err != nil {
		return nil, err
	}
	_ = e.refreshSession(ctx, s.ID)
	return s, nil
}

// Resolve existing ancestors too: an offline socket may have been removed while
// its directory still has aliases (/tmp on macOS, or a caller-created symlink).
func canonicalHerdrSocket(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	ancestor := abs
	var tail []string
	for {
		resolved, err := filepath.EvalSymlinks(ancestor)
		if err == nil {
			for i := len(tail) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, tail[i])
			}
			return resolved, nil
		}
		if !errors.Is(err, os.ErrNotExist) || filepath.Dir(ancestor) == ancestor {
			return "", err
		}
		tail = append(tail, filepath.Base(ancestor))
		ancestor = filepath.Dir(ancestor)
	}
}

func (e *Engine) startSessions() {
	ss, err := list[model.Session](e.ctx, e.store, "sessions", model.Scope{})
	if err != nil {
		return
	}
	for _, s := range ss {
		e.background(func() { _ = e.refreshSession(e.ctx, s.ID) })
	}
}
func sessionActive(w model.Worker) bool {
	return w.State != "released" && w.State != "stopped" && w.State != "failed" && w.State != "lost"
}
func (e *Engine) currentSession(id string, generation int64) bool {
	e.runtimeMu.Lock()
	defer e.runtimeMu.Unlock()
	r := e.sessions[id]
	return r != nil && r.generation == generation
}

// refreshSession is a synchronous subscription barrier. The old stream remains
// live until the replacement is acknowledged; callbacks and replacement share a lane.
func (e *Engine) refreshSession(ctx context.Context, id string, readOnly ...bool) error {
	quiet := len(readOnly) == 1 && readOnly[0]
	lane := e.lane("session:" + id)
	lane.Lock()
	defer lane.Unlock()
	if e.ctx.Err() != nil {
		return e.ctx.Err()
	}
	s, err := get[model.Session](ctx, e.store, "sessions", id)
	if err != nil {
		return err
	}
	c := e.opts.HerdrFactory(s.SocketPath)
	bounded, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	pong, err := c.Ping(bounded)
	if err == nil && !slices.Contains(herdr.SupportedProtocols, pong.Protocol) {
		err = problem("protocol_mismatch", "Herdr protocol %d unsupported; expected %v", pong.Protocol, herdr.SupportedProtocols)
	}
	if err != nil {
		return e.failedSessionLocked(id, c, pong.Protocol, err)
	}
	snap, err := c.Snapshot(bounded)
	if err != nil {
		return e.failedSessionLocked(id, c, pong.Protocol, err)
	}
	workspaceIDs, err := e.syncSessionSnapshot(bounded, id, snap)
	if err != nil {
		return err
	}
	workers, err := list[model.Worker](bounded, e.store, "workers", model.Scope{SessionID: id})
	if err != nil {
		return err
	}
	subs := []herdr.Subscription{{"type": "pane.created"}, {"type": "pane.closed"}, {"type": "pane.exited"}, {"type": "pane.moved"}, {"type": "pane.agent_detected"}, {"type": "worktree.created"}, {"type": "worktree.opened"}, {"type": "worktree.removed"}, {"type": "workspace.created"}, {"type": "workspace.updated"}}
	candidates := map[string]herdr.Pane{}
	ambiguous := map[string]bool{}
	// Snapshot agents also occur in panes; count distinct live routing targets.
	panesByID := map[string]herdr.Pane{}
	for _, p := range append(append([]herdr.Pane{}, snap.Panes...), snap.Agents...) {
		if p.PaneID != "" {
			panesByID[p.PaneID] = p
		}
	}
	seen := map[string]bool{}
	for _, w := range workers {
		if !sessionActive(w) {
			continue
		}
		p, duplicate := sessionCandidate(w, panesByID)
		ambiguous[w.ID] = duplicate
		candidates[w.ID] = p
		if p.PaneID != "" && !seen[p.PaneID] {
			seen[p.PaneID] = true
			subs = append(subs, herdr.Subscription{"type": "pane.agent_status_changed", "pane_id": p.PaneID})
		}
	}
	sctx, scancel := context.WithCancel(e.ctx)
	// Caller cancellation can interrupt setup without owning the durable subscription.
	stop := context.AfterFunc(bounded, scancel)
	ch, err := c.Subscribe(sctx, subs)
	stop()
	if err != nil {
		scancel()
		return e.failedSessionLocked(id, c, pong.Protocol, err)
	}
	e.runtimeMu.Lock()
	old := e.sessions[id]
	generation := s.Generation + 1
	if old != nil && generation <= old.generation {
		generation = old.generation + 1
	}
	runtime := &sessionRuntime{client: c, cancel: scancel, generation: generation, ready: map[string]bool{}, readyAttachments: map[string]string{}}
	e.sessions[id] = runtime
	e.runtimeMu.Unlock()
	if old != nil && old.cancel != nil {
		old.cancel()
	}
	err = e.write(bounded, func(tx *store.Tx) error {
		v, x := txGet[model.Session](tx, "sessions", id)
		if x != nil {
			return x
		}
		changed := v.Status != "online"
		v.Status = "online"
		v.Protocol = pong.Protocol
		v.Generation = generation
		v.LastSeenAt = e.now()
		v.Error = ""
		if x = tx.Put("sessions", id, v); x != nil {
			return x
		}
		if changed {
			return tx.Event("session.online", model.Scope{SessionID: id}, "daemon", "", v)
		}
		return nil
	})
	if err != nil {
		scancel()
		return e.failedSessionLocked(id, c, pong.Protocol, err)
	}
	needsRefresh := false
	for _, w := range workers {
		if !sessionActive(w) {
			continue
		}
		latest, x := get[model.Worker](bounded, e.store, "workers", w.ID)
		if x != nil || !sessionActive(latest) {
			continue
		}
		if !sameSessionBinding(w, latest) {
			// Launch/adoption may complete while the server acknowledges this
			// stream. It cannot inherit filters built from an obsolete binding.
			needsRefresh = true
			continue
		}
		if ambiguous[w.ID] {
			if x := e.ambiguousSessionWorker(bounded, w); x != nil {
				return x
			}
			continue
		}
		p := candidates[w.ID]
		if p.PaneID == "" {
			if w.State == "starting" && w.PaneID == "" {
				// The launch intent is durable before a pane exists. It will
				// establish its own barrier once binding is committed.
				continue
			}
			_ = e.observeWorker(bounded, w, herdr.Pane{}, true)
			continue
		}
		fresh, x := c.AgentGet(bounded, p.PaneID)
		if x != nil {
			if missingHerdr(x) {
				current, checkErr := get[model.Worker](bounded, e.store, "workers", w.ID)
				if checkErr == nil && sameSessionBinding(w, current) {
					_ = e.observeWorker(bounded, w, herdr.Pane{}, true)
				} else {
					needsRefresh = true
				}
				continue
			}
			if herdr.ErrCode(x) == "agent_not_ready" {
				fresh, x = c.PaneGet(bounded, p.PaneID)
			}
			if x != nil {
				scancel()
				return e.failedSessionLocked(id, c, pong.Protocol, x)
			}
		}
		latest, x = get[model.Worker](bounded, e.store, "workers", w.ID)
		if x != nil || !sameSessionBinding(w, latest) {
			needsRefresh = true
			continue
		}
		if x = e.observeWorker(bounded, w, fresh, true, quiet); x != nil {
			scancel()
			return e.failedSessionLocked(id, c, pong.Protocol, x)
		}
		observed, x := get[model.Worker](bounded, e.store, "workers", w.ID)
		if x != nil {
			continue
		}
		if observed.State != "lost" && strings.HasPrefix(observed.Error, "session offline:") {
			x = e.write(bounded, func(tx *store.Tx) error {
				v, err := txGet[model.Worker](tx, "workers", w.ID)
				if err != nil {
					return err
				}
				if strings.HasPrefix(v.Error, "session offline:") {
					v.Error = ""
					return tx.Put("workers", v.ID, v)
				}
				return nil
			})
			if x != nil {
				scancel()
				return e.failedSessionLocked(id, c, pong.Protocol, x)
			}
		}
		if target := workspaceIDs[fresh.WorkspaceID]; target != "" && target != observed.WorkspaceID && observed.State != "lost" {
			x = e.write(bounded, func(tx *store.Tx) error {
				v, err := txGet[model.Worker](tx, "workers", w.ID)
				if err != nil {
					return err
				}
				if !sameSessionBinding(observed, v) {
					needsRefresh = true
					return nil
				}
				if err = e.renameMovedAlias(tx, &v, target); err != nil {
					return err
				}
				v.WorkspaceID = target
				if v.WorktreeID != "" {
					wt, er := txGet[model.Worktree](tx, "worktrees", v.WorktreeID)
					if er != nil || wt.WorkspaceID != target {
						v.WorktreeID = ""
					}
				}
				if err = tx.Put("workers", v.ID, v); err != nil {
					return err
				}
				return tx.Event("worker.moved", workerScope(v), "daemon", "", v)
			})
			if x != nil {
				scancel()
				return e.failedSessionLocked(id, c, pong.Protocol, x)
			}
		}
		current, x := get[model.Worker](bounded, e.store, "workers", w.ID)
		if x == nil && current.RecoveryHeld && current.RecoveryPaneID == fresh.PaneID && sameSessionBinding(observed, current) {
			// The acknowledged filters already include this recovery target.
			// Preserve the old binding and retry only evidence, not the stream.
			e.runtimeMu.Lock()
			if e.sessions[id] == runtime {
				runtime.ready[w.ID] = false
				runtime.readyAttachments[w.ID] = current.AttachmentID
			}
			e.runtimeMu.Unlock()
			continue
		}
		if x != nil || current.AttachmentID != observed.AttachmentID || current.PaneID != fresh.PaneID || current.SessionID != id {
			needsRefresh = true
			continue
		}
		e.runtimeMu.Lock()
		if e.sessions[id] == runtime {
			runtime.ready[w.ID] = current.State != "lost" && current.State != "offline"
			runtime.readyAttachments[w.ID] = current.AttachmentID
		}
		e.runtimeMu.Unlock()
		if !quiet {
			e.background(func() { e.processInbox(w.ID) })
		}
	}
	e.background(func() { e.followSession(sctx, id, generation, ch) })
	if needsRefresh {
		e.background(func() { e.reconnectSession(sctx, id, generation) })
	}
	return nil
}

func sameSessionBinding(a, b model.Worker) bool {
	return a.SessionID == b.SessionID && a.WorkspaceID == b.WorkspaceID && a.PaneID == b.PaneID && a.TerminalID == b.TerminalID && a.AttachmentID == b.AttachmentID && a.AgentKind == b.AgentKind && a.AgentName == b.AgentName && reflect.DeepEqual(a.NativeSession, b.NativeSession) && reflect.DeepEqual(a.AgentProcess, b.AgentProcess)
}

func sessionCandidate(w model.Worker, panes map[string]herdr.Pane) (herdr.Pane, bool) {
	// Terminal identity survives a pane move. A recycled pane reference cannot
	// outweigh it, and native continuity is the final recovery fallback.
	for _, p := range panes {
		if w.TerminalID != "" && p.TerminalID == w.TerminalID && sameAttachment(w, p) {
			return p, false
		}
	}
	if p, ok := panes[w.PaneID]; ok && sameAttachment(w, p) {
		return p, false
	}
	if w.NativeSession != nil {
		var match herdr.Pane
		for _, p := range panes {
			if p.AgentSession != nil && *p.AgentSession == *w.NativeSession && p.Agent != nil && *p.Agent == w.AgentKind {
				if match.PaneID != "" {
					return herdr.Pane{}, true
				}
				match = p
			}
		}
		if match.PaneID != "" {
			return match, false
		}
	}
	// Observe the recycled target to expose verified identity loss.
	return panes[w.PaneID], false
}

func (e *Engine) ambiguousSessionWorker(ctx context.Context, w model.Worker) error {
	return e.write(ctx, func(tx *store.Tx) error {
		current, err := txGet[model.Worker](tx, "workers", w.ID)
		if err != nil || !sameSessionBinding(w, current) || !sessionActive(current) {
			return err
		}
		current.State = "lost"
		current.Ready = false
		current.Error = "ambiguous native session matches; explicit re-adoption required"
		current.UpdatedAt = e.now()
		if err = tx.Put("workers", current.ID, current); err != nil {
			return err
		}
		return tx.Event("worker.identity_lost", workerScope(current), "daemon", "", current)
	})
}

func (e *Engine) renameMovedAlias(tx *store.Tx, w *model.Worker, target string) error {
	workers, err := txList[model.Worker](tx, "workers", model.Scope{WorkspaceID: target})
	if err != nil {
		return err
	}
	reserved := map[string]bool{}
	for _, other := range workers {
		if other.ID != w.ID && other.State != "released" && other.State != "stopped" && other.State != "failed" {
			reserved[other.Name] = true
		}
	}
	if !reserved[w.Name] {
		return nil
	}
	previous := w.Name
	suffix := w.ID
	if len(suffix) > 8 {
		suffix = suffix[len(suffix)-8:]
	}
	base := previous
	if len(base) > 23 {
		base = base[:23]
	}
	w.Name = base + "-" + suffix
	for n := 2; reserved[w.Name]; n++ {
		w.Name = fmt.Sprintf("%s-%s-%d", base, suffix, n)
	}
	w.Error = fmt.Sprintf("alias %q renamed to %q after workspace move collision", previous, w.Name)
	return tx.Event("worker.alias_changed", model.Scope{SessionID: w.SessionID, WorkspaceID: target, WorkerID: w.ID}, "daemon", "", map[string]any{"worker_id": w.ID, "previous_alias": previous, "alias": w.Name, "reason": "workspace move collision"})
}
func missingHerdr(err error) bool {
	code := herdr.ErrCode(err)
	return code == "pane_not_found" || code == "agent_not_found" || code == "not_found"
}

func (e *Engine) syncSessionSnapshot(ctx context.Context, id string, snap herdr.Snapshot) (map[string]string, error) {
	ids := map[string]string{}
	err := e.write(ctx, func(tx *store.Tx) error {
		ws, err := txList[model.Workspace](tx, "workspaces", model.Scope{SessionID: id})
		if err != nil {
			return err
		}
		trees, err := txList[model.Worktree](tx, "worktrees", model.Scope{SessionID: id})
		if err != nil {
			return err
		}
		for _, native := range snap.Workspaces {
			var w model.Workspace
			for _, old := range ws {
				if old.HerdrWorkspaceID == native.ID {
					w = old
					break
				}
			}
			created := w.ID == ""
			if created {
				w = model.Workspace{ID: newID("workspace"), SessionID: id, HerdrWorkspaceID: native.ID, CreatedAt: e.now()}
			}
			changed := created || w.Cwd != native.Cwd || w.Name != native.Label
			w.Cwd = native.Cwd
			w.Name = native.Label
			w.UpdatedAt = e.now()
			if err = tx.Put("workspaces", w.ID, w); err != nil {
				return err
			}
			ids[native.ID] = w.ID
			if changed {
				if err = tx.Event("workspace.observed", model.Scope{SessionID: id, WorkspaceID: w.ID}, "daemon", "", w); err != nil {
					return err
				}
			}
			if native.Worktree != nil && native.Worktree.CheckoutPath != "" {
				var wt model.Worktree
				for _, old := range trees {
					if old.WorkspaceID == w.ID && old.Path == native.Worktree.CheckoutPath {
						wt = old
						break
					}
				}
				if wt.ID == "" {
					wt = model.Worktree{ID: newID("worktree"), SessionID: id, WorkspaceID: w.ID, Path: native.Worktree.CheckoutPath, OwnershipKind: "external", CreatedAt: e.now(), UpdatedAt: e.now()}
					if err = tx.Put("worktrees", wt.ID, wt); err != nil {
						return err
					}
					if err = tx.Event("worktree.observed", model.Scope{SessionID: id, WorkspaceID: w.ID, WorktreeID: wt.ID}, "daemon", "", wt); err != nil {
						return err
					}
				}
			}
		}
		return nil
	})
	return ids, err
}

// Callers hold the per-session lane. Outages retain turn baselines and incarnation evidence.
func (e *Engine) failedSessionLocked(id string, c *herdr.Client, protocol int, cause error) error {
	e.runtimeMu.Lock()
	old := e.sessions[id]
	generation := int64(1)
	if old != nil {
		generation = old.generation + 1
	}
	ctx, cancel := context.WithCancel(e.ctx)
	e.sessions[id] = &sessionRuntime{client: c, cancel: cancel, generation: generation, ready: map[string]bool{}, readyAttachments: map[string]string{}}
	e.runtimeMu.Unlock()
	if old != nil && old.cancel != nil {
		old.cancel()
	}
	_ = e.offlineSession(id, protocol, cause)
	e.background(func() { e.reconnectSession(ctx, id, generation) })
	return cause
}
func (e *Engine) offlineSession(id string, protocol int, cause error) error {
	return e.write(e.ctx, func(tx *store.Tx) error {
		s, err := txGet[model.Session](tx, "sessions", id)
		if err != nil {
			return err
		}
		changed := s.Status != "offline" || s.Error != cause.Error()
		s.Status = "offline"
		s.Error = cause.Error()
		if protocol != 0 {
			s.Protocol = protocol
		}
		if err = tx.Put("sessions", id, s); err != nil {
			return err
		}
		workers, err := txList[model.Worker](tx, "workers", model.Scope{SessionID: id})
		if err != nil {
			return err
		}
		for _, w := range workers {
			if !sessionActive(w) {
				continue
			}
			w.State = "offline"
			w.Ready = false
			w.Error = "session offline: " + cause.Error()
			w.UpdatedAt = e.now()
			if err = tx.Put("workers", w.ID, w); err != nil {
				return err
			}
		}
		if changed {
			return tx.Event("session.offline", model.Scope{SessionID: id}, "daemon", "", s)
		}
		return nil
	})
}
func (e *Engine) reconnectSession(ctx context.Context, id string, generation int64) {
	timer := time.NewTimer(300 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return
	case <-timer.C:
	}
	if !e.currentSession(id, generation) {
		return
	}
	_ = e.refreshSession(e.ctx, id)
}
func (e *Engine) followSession(ctx context.Context, id string, generation int64, ch <-chan herdr.Event) {
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-ch:
			if !ok {
				lane := e.lane("session:" + id)
				lane.Lock()
				if e.currentSession(id, generation) && e.ctx.Err() == nil {
					e.runtimeMu.Lock()
					e.sessions[id].ready = map[string]bool{}
					e.sessions[id].readyAttachments = map[string]string{}
					e.runtimeMu.Unlock()
					_ = e.offlineSession(id, 0, errors.New("herdr event subscription disconnected"))
					e.background(func() { e.reconnectSession(ctx, id, generation) })
				}
				lane.Unlock()
				return
			}
			e.sessionEvent(ctx, id, generation, ev)
		}
	}
}
func (e *Engine) sessionEvent(ctx context.Context, id string, generation int64, ev herdr.Event) {
	lane := e.lane("session:" + id)
	lane.Lock()
	defer lane.Unlock()
	if !e.currentSession(id, generation) || ctx.Err() != nil {
		return
	}
	if ev.Name != "pane.agent_status_changed" {
		if strings.HasPrefix(ev.Name, "pane.") || strings.HasPrefix(ev.Name, "workspace.") || strings.HasPrefix(ev.Name, "worktree.") {
			e.background(func() { _ = e.refreshSession(e.ctx, id) })
		}
		return
	}
	var data struct {
		PaneID string `json:"pane_id"`
	}
	if json.Unmarshal(ev.Data, &data) != nil || data.PaneID == "" {
		return
	}
	workers, err := list[model.Worker](ctx, e.store, "workers", model.Scope{SessionID: id})
	if err != nil {
		return
	}
	c, err := e.sessionClient(id)
	if err != nil {
		return
	}
	for _, w := range workers {
		if (w.PaneID != data.PaneID && (!w.RecoveryHeld || w.RecoveryPaneID != data.PaneID)) || !sessionActive(w) {
			continue
		}
		p, err := c.AgentGet(ctx, data.PaneID)
		if err != nil {
			if missingHerdr(err) {
				_ = e.observeWorker(ctx, w, herdr.Pane{}, false)
			} else if errors.Is(err, rpc.ErrUnavailable) || errors.Is(err, rpc.ErrLost) {
				_ = e.failedSessionLocked(id, c, 0, fmt.Errorf("agent refresh: %w", err))
			}
			return
		}
		_ = e.observeWorker(ctx, w, p, false)
	}
}
