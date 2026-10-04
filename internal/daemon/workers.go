package daemon

// Launch, adoption, unsaved-work and verified-close patterns adapted from
// herdr-orch/internal/daemon/workers.go (MIT, Stephen Ellington). Woof adds
// durable intent, incarnation checks and conservative uncertain transport.
import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/zielus/herdr-woof-v2/internal/herdr"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/profiles"
	"github.com/zielus/herdr-woof-v2/internal/store"
)

var workerAlias = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

type CloseResult struct {
	Worker      model.Worker `json:"worker"`
	ArchivePath string       `json:"archive_path,omitempty"`
	PIDs        []int        `json:"pids"`
	Killed      []int        `json:"killed,omitempty"`
	Survivors   []int        `json:"survivors,omitempty"`
}

func (e *Engine) workerResource(tx *store.Tx, requestID, workerID string) error {
	op, err := txGet[model.Operation](tx, "operations", requestID)
	if err != nil {
		return err
	}
	op.ResourceKind = "workers"
	op.ResourceID = workerID
	op.UpdatedAt = e.now()
	w, err := txGet[model.Worker](tx, "workers", workerID)
	if err != nil {
		return err
	}
	w.OperationID = requestID
	if err := tx.Put("workers", workerID, w); err != nil {
		return err
	}
	return tx.Put("operations", op.ID, op)
}

func (e *Engine) workerMutation(ctx context.Context, r model.Request, a Args) (any, error) {
	if r.Op == "worker.spawn" || r.Op == "worker.adopt" {
		return e.bindWorker(ctx, r, a)
	}
	ref := a.ID
	if ref == "" {
		ref = r.Caller.WorkerID
	}
	if ref == "" {
		ref = r.Scope.WorkerID
	}
	w, err := e.resolveWorker(ctx, ref, r.Scope)
	if err != nil {
		return nil, err
	}
	lane := e.lane(w.ID)
	lane.Lock()
	defer lane.Unlock()
	w, err = get[model.Worker](ctx, e.store, "workers", w.ID)
	if err != nil {
		return nil, err
	}
	w.OperationID = r.ID
	if r.Op == "worker.retain" {
		err = e.write(ctx, func(tx *store.Tx) error {
			w.Retained = a.Retained
			w.UpdatedAt = e.now()
			if err := tx.Put("workers", w.ID, w); err != nil {
				return err
			}
			if err := e.workerResource(tx, r.ID, w.ID); err != nil {
				return err
			}
			if err := tx.Event("worker.retained", workerScope(w), "worker", r.Caller.WorkerID, w); err != nil {
				return err
			}
			return e.finishTx(tx, r.ID, w, nil, "completed")
		})
		return w, err
	}
	if w.State == "released" || w.State == "stopped" || w.State == "failed" {
		return nil, problem("worker_not_live", "worker is %s", w.State)
	}
	ds, err := list[model.Dispatch](ctx, e.store, "dispatches", model.Scope{WorkerID: w.ID})
	if err != nil {
		return nil, err
	}
	if r.Op == "worker.release" && !a.Force {
		for _, d := range ds {
			if activeDispatch(d) {
				return nil, problem("worker_busy", "worker has active dispatch %s", d.ID)
			}
		}
	}
	dir := w.Cwd
	if w.WorktreeID != "" {
		tree, err := get[model.Worktree](ctx, e.store, "worktrees", w.WorktreeID)
		if err != nil {
			return nil, err
		}
		dir = tree.Path
	}
	if !a.Force {
		checked := []string{}
		for _, path := range []string{dir, w.Cwd} {
			duplicate := false
			for _, prior := range checked {
				if sameCwd(prior, path) {
					duplicate = true
					break
				}
			}
			if duplicate {
				continue
			}
			reasons, err := worktreeUnsaved(ctx, path)
			if err != nil {
				return nil, problem("unsaved_work", "cannot verify worktree safety for %s: %v", path, err)
			}
			if len(reasons) > 0 {
				return nil, problem("unsaved_work", "%s: %s; commit and publish or explicitly force", path, strings.Join(reasons, "; "))
			}
			checked = append(checked, path)
		}
	}
	c, err := e.sessionClient(w.SessionID)
	if err != nil {
		return nil, err
	}
	if err = e.write(ctx, func(tx *store.Tx) error { return e.workerResource(tx, r.ID, w.ID) }); err != nil {
		return nil, err
	}
	p, err := c.AgentGet(ctx, w.PaneID)
	if err != nil {
		if herdr.ErrCode(err) == "agent_not_found" || herdr.ErrCode(err) == "pane_not_found" {
			return e.retireAbsentWorker(ctx, r, w, c)
		}
		return nil, err
	}
	if !e.verifyAttachment(ctx, w, p, c) {
		return e.retireAbsentWorker(ctx, r, w, c)
	}
	if !a.Force && (!idle(p.AgentStatus) || p.InteractiveReady == nil || !*p.InteractiveReady) {
		return nil, problem("worker_busy", "worker is not verified idle and interactive; use force to stop or release intentionally")
	}
	if liveDir := paneCwd(p); !a.Force && liveDir != "" && !sameCwd(dir, liveDir) {
		reasons, err := worktreeUnsaved(ctx, liveDir)
		if err != nil || len(reasons) > 0 {
			return nil, problem("unsaved_work", "live worker cwd %s has unverified or unpublished work: %v %v", liveDir, reasons, err)
		}
	}
	info, err := c.ProcessInfo(ctx, w.PaneID)
	if err != nil {
		return nil, problem("identity_unverified", "cannot inspect worker processes: %v", err)
	}
	identities, agent, err := processEvidence(info, w.AgentKind)
	if err != nil {
		return nil, err
	}
	if agent == nil {
		return nil, problem("identity_unverified", "foreground agent process birth could not be verified")
	}
	if w.AgentProcess != nil {
		matched := false
		for _, id := range identities {
			if id.PID == w.AgentProcess.PID {
				matched = id.Birth == w.AgentProcess.Birth && (w.AgentProcess.TTY == "" || id.TTY == w.AgentProcess.TTY)
			}
		}
		if !matched {
			return nil, problem("stale_process", "saved agent process birth no longer matches; no process was signaled")
		}
	}
	if err = e.write(ctx, func(tx *store.Tx) error { return e.workerResource(tx, r.ID, w.ID) }); err != nil {
		return nil, err
	}
	res := CloseResult{Worker: w, PIDs: []int{}}
	for _, id := range identities {
		res.PIDs = append(res.PIDs, id.PID)
	}
	if r.Op == "worker.release" && e.opts.Paths.Archive != "" {
		text, err := c.PaneRead(ctx, w.PaneID, 10000)
		if err != nil {
			return res, problem("archive_failed", "cannot preserve worker output: %v", err)
		}
		if err := os.MkdirAll(e.opts.Paths.Archive, 0700); err != nil {
			return res, err
		}
		archiveHash := sha256.Sum256([]byte(r.ID))
		res.ArchivePath = filepath.Join(e.opts.Paths.Archive, fmt.Sprintf("%s-%x.txt", w.ID, archiveHash[:12]))
		if err := os.WriteFile(res.ArchivePath, []byte(text), 0600); err != nil {
			return res, err
		}
	}
	// Re-read after Git/archive/process checks so cleanup never trusts an old pane
	// identity. Agent process birth is also rechecked immediately before close.
	live, err := c.AgentGet(ctx, w.PaneID)
	if err != nil || !e.verifyAttachment(ctx, w, live, c) {
		return res, problem("stale_attachment", "worker changed during cleanup checks")
	}
	if !a.Force && (!idle(live.AgentStatus) || live.InteractiveReady == nil || !*live.InteractiveReady) {
		return res, problem("worker_busy", "worker became busy during cleanup checks")
	}
	if !originalProcessAlive(*agent) {
		return res, problem("stale_process", "agent exited or changed during cleanup checks")
	}
	closeErr := c.PaneClose(ctx, w.PaneID)
	if closeErr != nil {
		state := "offline"
		code := "cleanup_failed"
		if isUncertain(closeErr) {
			code = "uncertain"
		}
		w.State = state
		w.Ready = false
		w.Error = "pane close outcome requires inspection: " + closeErr.Error()
		w.UpdatedAt = e.now()
		res.Worker = w
		saveErr := e.write(context.Background(), func(tx *store.Tx) error {
			if err := tx.Put("workers", w.ID, w); err != nil {
				return err
			}
			return tx.Event("worker.cleanup_uncertain", workerScope(w), "daemon", "", w)
		})
		if saveErr != nil {
			return res, problem("uncertain", "close result could not be persisted: %v", saveErr)
		}
		// A close with uncertain outcome is never repeated and never authorizes
		// unverified follow-up signaling. The caller can inspect then resolve it.
		return res, problem(code, "%s", w.Error)
	}
	res.Survivors = waitOriginalProcesses(ctx, identities, 2*time.Second)
	for _, sig := range []syscall.Signal{syscall.SIGTERM, syscall.SIGKILL} {
		if len(res.Survivors) == 0 {
			break
		}
		for _, id := range identities {
			if originalProcessAlive(id) {
				if err := signalOriginalProcess(id, sig); err == nil {
					res.Killed = append(res.Killed, id.PID)
				}
			}
		}
		res.Survivors = waitOriginalProcesses(ctx, identities, time.Second)
	}
	// Only pane-not-found or a demonstrably different terminal proves that the
	// original pane is absent. Read failures keep cleanup observable as uncertain.
	remaining, checkErr := c.PaneGet(ctx, w.PaneID)
	gone := herdr.ErrCode(checkErr) == "pane_not_found" || (checkErr == nil && remaining.TerminalID != "" && remaining.TerminalID != w.TerminalID)
	if len(res.Survivors) > 0 || !gone {
		w.State = "offline"
		w.Ready = false
		w.Error = fmt.Sprintf("cleanup unverified: original pane gone=%v; surviving original processes=%v", gone, res.Survivors)
		res.Worker = w
		_ = e.write(context.Background(), func(tx *store.Tx) error {
			if err := tx.Put("workers", w.ID, w); err != nil {
				return err
			}
			return tx.Event("worker.cleanup_failed", workerScope(w), "daemon", "", res)
		})
		if checkErr != nil && herdr.ErrCode(checkErr) != "pane_not_found" {
			return res, problem("uncertain", "%s", w.Error)
		}
		return res, problem("cleanup_failed", "%s", w.Error)
	}
	final := "released"
	if r.Op == "worker.stop" {
		final = "stopped"
	}
	w.State = final
	clearNativeRecovery(&w)
	w.Ready = false
	w.UpdatedAt = e.now()
	w.Error = ""
	res.Worker = w
	err = e.write(context.Background(), func(tx *store.Tx) error {
		if err := e.fenceWorkerTx(tx, w.ID, "worker "+final); err != nil {
			return err
		}
		if err := tx.Put("workers", w.ID, w); err != nil {
			return err
		}
		if err := tx.Event("worker."+final, workerScope(w), "worker", r.Caller.WorkerID, res); err != nil {
			return err
		}
		return e.finishTx(tx, r.ID, res, nil, "completed")
	})
	if err != nil {
		return res, problem("uncertain", "cleanup succeeded but durable receipt failed: %v", err)
	}
	return res, nil
}

// Retirement is an explicit database-only lifecycle operation after fresh
// inspection proves the old pane and process are gone. It never closes or
// signals a replacement and never replays an earlier uncertain close.
func (e *Engine) retireAbsentWorker(ctx context.Context, r model.Request, w model.Worker, c *herdr.Client) (any, error) {
	pane, err := c.PaneGet(ctx, w.PaneID)
	absent := herdr.ErrCode(err) == "pane_not_found"
	replaced := err == nil && w.TerminalID != "" && pane.TerminalID != "" && pane.TerminalID != w.TerminalID
	if err != nil && !absent {
		return nil, err
	}
	if !absent && !replaced {
		return nil, problem("stale_attachment", "old terminal still exists; inspect and re-adopt; no pane was closed or process signaled")
	}
	if w.AgentProcess == nil || w.AgentProcess.PID <= 0 || w.AgentProcess.Birth == "" {
		return nil, problem("cleanup_unverified", "retirement requires recorded agent process birth; inspect and re-adopt or retain the unresolved worker")
	}
	live, err := birthIdentity(w.AgentProcess.PID)
	if err != nil && !errors.Is(err, os.ErrNotExist) && !errors.Is(err, syscall.ESRCH) {
		return nil, problem("cleanup_unverified", "cannot prove old agent process exited: %v", err)
	}
	if err == nil && live.Birth == w.AgentProcess.Birth {
		return nil, problem("cleanup_unverified", "recorded agent process still lives; no pane was closed or process signaled")
	}
	result := CloseResult{Worker: w, PIDs: []int{w.AgentProcess.PID}}
	final := "released"
	if r.Op == "worker.stop" {
		final = "stopped"
	}
	err = e.write(ctx, func(tx *store.Tx) error {
		current, err := txGet[model.Worker](tx, "workers", w.ID)
		if err != nil {
			return err
		}
		if !sameSessionBinding(w, current) {
			return problem("stale_attachment", "worker binding changed during retirement inspection")
		}
		if err = e.fenceWorkerTx(tx, w.ID, "worker "+final+" after verified disappearance"); err != nil {
			return err
		}
		current.State = final
		clearNativeRecovery(&current)
		current.Ready = false
		current.Error = ""
		current.OperationID = r.ID
		current.UpdatedAt = e.now()
		result.Worker = current
		if err = tx.Put("workers", current.ID, current); err != nil {
			return err
		}
		if err = e.workerResource(tx, r.ID, current.ID); err != nil {
			return err
		}
		if err = tx.Event("worker."+final, workerScope(current), "worker", r.Caller.WorkerID, result); err != nil {
			return err
		}
		return e.finishTx(tx, r.ID, result, nil, "completed")
	})
	return result, err
}

func (e *Engine) fenceWorkerTx(tx *store.Tx, workerID, reason string) error {
	ds, err := txList[model.Dispatch](tx, "dispatches", model.Scope{WorkerID: workerID})
	if err != nil {
		return err
	}
	for _, d := range ds {
		if activeDispatch(d) {
			d.Status = "failed"
			d.Outcome = reason
			d.SettledAt = e.now()
			if err := tx.Put("dispatches", d.ID, d); err != nil {
				return err
			}
			if err := e.settleRunTx(tx, d); err != nil {
				return err
			}
			if err := tx.Event("dispatch.fenced", dispatchScope(d), "daemon", "", d); err != nil {
				return err
			}
			if err := e.syncScheduleRunTx(tx, d, "daemon", ""); err != nil {
				return err
			}
		}
	}
	return nil
}

func (e *Engine) bindWorker(ctx context.Context, r model.Request, a Args) (any, error) {
	if len(a.ExtraArgs) > 0 {
		if r.Op != "worker.spawn" {
			return nil, problem("invalid_args", "extra_args require worker.spawn")
		}
		for _, arg := range a.ExtraArgs {
			if strings.ContainsRune(arg, 0) {
				return nil, problem("invalid_args", "extra_args cannot contain NUL")
			}
		}
	}
	if a.Workspace != "" {
		if r.Scope.SessionID == "" {
			return nil, problem("scope_required", "native workspace selection requires a selected or inferred session")
		}
		workspaces, err := list[model.Workspace](ctx, e.store, "workspaces", model.Scope{SessionID: r.Scope.SessionID})
		if err != nil {
			return nil, err
		}
		selected := ""
		for _, workspace := range workspaces {
			if workspace.HerdrWorkspaceID == a.Workspace {
				if selected != "" {
					return nil, problem("ambiguous_workspace", "native workspace %s has multiple mappings in selected session", a.Workspace)
				}
				selected = workspace.ID
			}
		}
		if selected == "" {
			return nil, problem("workspace_not_found", "native workspace %s is not registered in selected session; explicitly select another session for cross-session targets", a.Workspace)
		}
		if r.ScopeExplicit && r.Scope.WorkspaceID != "" && r.Scope.WorkspaceID != selected {
			return nil, problem("invalid_scope", "explicit Woof workspace and native Herdr workspace conflict")
		}
		r.Scope.WorkspaceID = selected
		if !r.ScopeExplicit {
			r.Scope.WorktreeID = ""
			r.Scope.RunID = ""
			r.Scope.WorkerID = ""
		}
	}
	if r.Scope.WorkspaceID == "" || r.Scope.SessionID == "" {
		return nil, problem("scope_required", "select an existing workspace/session")
	}
	ws, err := get[model.Workspace](ctx, e.store, "workspaces", r.Scope.WorkspaceID)
	if err != nil {
		return nil, err
	}
	c, err := e.sessionClient(ws.SessionID)
	if err != nil {
		return nil, err
	}
	var profile profiles.Profile
	var cfg profiles.Config
	if r.Op == "worker.spawn" {
		cfg, err = e.config()
		if err != nil {
			return nil, err
		}
		profile, err = cfg.Resolve(a.Profile)
		if err != nil {
			return nil, problem("bad_profile", "%v", err)
		}
	}
	treePath := ""
	if r.Scope.WorktreeID != "" {
		tree, err := get[model.Worktree](ctx, e.store, "worktrees", r.Scope.WorktreeID)
		if err != nil {
			return nil, err
		}
		treePath = tree.Path
	}
	cwd := ""
	if r.Op == "worker.spawn" {
		cwd, err = resolveSpawnCwd(a.Cwd, treePath, profile.Cwd, ws.Cwd)
		if err != nil {
			return nil, err
		}
	}
	id := newID("worker")
	attachment := newID("attachment")
	name := a.Name
	if name == "" {
		name = "worker-" + id[len(id)-12:]
	}
	if !workerAlias.MatchString(name) {
		return nil, problem("bad_name", "worker alias must match [a-z][a-z0-9_-]{0,31}")
	}
	w := model.Worker{ID: id, OperationID: r.ID, SessionID: ws.SessionID, WorkspaceID: ws.ID, WorktreeID: r.Scope.WorktreeID, RunID: r.Scope.RunID, Name: name, Cwd: cwd, State: "starting", AttachmentID: attachment, Generation: 1, Retained: a.Retained, CreatedAt: e.now(), UpdatedAt: e.now()}
	var p herdr.Pane
	if r.Op == "worker.adopt" {
		if a.Pane == "" {
			return nil, problem("invalid_args", "adoption requires an explicit pane")
		}
		if a.ID != "" {
			prior, err := get[model.Worker](ctx, e.store, "workers", a.ID)
			if err != nil {
				return nil, err
			}
			lane := e.lane(prior.ID)
			lane.Lock()
			defer lane.Unlock()
			w.ID = prior.ID
			w.Generation = prior.Generation + 1
			w.CreatedAt = prior.CreatedAt
			w.Retained = prior.Retained
			// Re-adopting a worker observed blocked continues its block episode.
			if prior.State == "blocked" {
				w.BlockedAt, w.BlockedAlertedAt, w.BlockedAlertDeliveryID, w.BlockedEscalatedAt = prior.BlockedAt, prior.BlockedAlertedAt, prior.BlockedAlertDeliveryID, prior.BlockedEscalatedAt
			}
			if a.Name == "" {
				w.Name = prior.Name
			}
		}
		p, err = c.AgentGet(ctx, a.Pane)
		if err != nil {
			return nil, err
		}
		if err := e.captureBinding(ctx, &w, p, c, ws.HerdrWorkspaceID); err != nil {
			return nil, err
		}
		actual := paneCwd(p)
		if actual == "" {
			return nil, problem("bad_cwd", "live agent cwd is unavailable")
		}
		if (a.Cwd != "" && !sameCwd(a.Cwd, actual)) || (treePath != "" && !sameCwd(treePath, actual)) {
			return nil, problem("bad_cwd", "explicit worker directory conflicts with live agent cwd %s", actual)
		}
		w.Cwd = actual
		err = e.write(ctx, func(tx *store.Tx) error {
			workers, err := txList[model.Worker](tx, "workers", model.Scope{SessionID: ws.SessionID})
			if err != nil {
				return err
			}
			for _, existing := range workers {
				if existing.ID != w.ID && existing.PaneID == w.PaneID && existing.TerminalID == w.TerminalID && existing.State != "released" && existing.State != "stopped" && existing.State != "failed" {
					return problem("already_adopted", "live pane already belongs to worker %s", existing.ID)
				}
			}
			if err := e.fenceWorkerTx(tx, w.ID, "attachment explicitly changed"); err != nil {
				return err
			}
			if err := tx.Put("workers", w.ID, w); err != nil {
				return err
			}
			if err := e.workerResource(tx, r.ID, w.ID); err != nil {
				return err
			}
			if err := tx.Event("worker.adopted", workerScope(w), "worker", r.Caller.WorkerID, w); err != nil {
				return err
			}
			return e.finishTx(tx, r.ID, w, nil, "completed")
		})
		if err != nil {
			return w, err
		}
		e.background(func() { _ = e.refreshSession(e.ctx, w.SessionID) })
		return w, nil
	}
	w.ProfileName = a.Profile
	if w.ProfileName == "" {
		w.ProfileName = cfg.Defaults.WorkerProfile
	}
	w.AgentKind = profile.Agent
	w.Args = append(append([]string(nil), profile.Args...), a.ExtraArgs...)
	if cfg.Defaults.PermissionsEnabled() {
		// Recorded on the worker, so `worker show` and events carry the effective launch.
		w.Args = append(workerPermissionArgs(w.AgentKind, w.Args, e.opts.Paths.Sock), w.Args...)
	}
	w.AgentName = "woof-" + w.ID[len(w.ID)-20:]
	if a.Pane != "" {
		p, err = c.PaneGet(ctx, a.Pane)
		if err != nil {
			return nil, err
		}
		if p.WorkspaceID != ws.HerdrWorkspaceID || p.TerminalID == "" {
			return nil, problem("identity_unverified", "existing pane workspace/terminal is not verified")
		}
		if p.Agent != nil && *p.Agent != "" {
			return nil, problem("pane_busy", "existing pane already contains an agent")
		}
		w.PaneID = p.PaneID
		w.TerminalID = p.TerminalID
		actual := paneCwd(p)
		if actual == "" {
			return nil, problem("bad_cwd", "existing pane cwd is unavailable")
		}
		if !sameCwd(w.Cwd, actual) {
			return nil, problem("bad_cwd", "existing pane cwd differs from resolved worker directory")
		}
		w.Cwd = actual
	}
	err = e.write(ctx, func(tx *store.Tx) error {
		if err := tx.Put("workers", w.ID, w); err != nil {
			return err
		}
		if err := e.workerResource(tx, r.ID, w.ID); err != nil {
			return err
		}
		return tx.Event("worker.starting", workerScope(w), "worker", r.Caller.WorkerID, w)
	})
	if err != nil {
		return w, err
	}
	if a.Pane == "" {
		env := map[string]string{"WOOF_WORKER_ID": w.ID, "WOOF_ATTACHMENT_ID": w.AttachmentID, "WOOF_SESSION_ID": w.SessionID, "WOOF_WORKSPACE_ID": w.WorkspaceID, "WOOF_WORKTREE_ID": w.WorktreeID, "WOOF_RUN_ID": w.RunID}
		if e.opts.Paths.Dir != "" {
			env["WOOF_STATE_DIR"] = e.opts.Paths.Dir
		}
		if e.opts.Paths.Config != "" {
			env["WOOF_CONFIG"] = e.opts.Paths.Config
		}
		if exe, err := os.Executable(); err == nil {
			if real, err := filepath.EvalSymlinks(exe); err == nil {
				exe = real
			}
			env["PATH"] = filepath.Dir(exe) + ":" + os.Getenv("PATH")
		}
		p, err = c.NewTab(ctx, ws.HerdrWorkspaceID, w.Cwd, w.Name, env)
		if err != nil {
			return e.launchFailure(w, err)
		}
		if p.PaneID == "" || p.TerminalID == "" || p.WorkspaceID != ws.HerdrWorkspaceID {
			return e.launchFailure(w, problem("uncertain", "created pane identity is incomplete; inspect session before continuing"))
		}
		w.PaneID = p.PaneID
		w.TerminalID = p.TerminalID
		if err = e.write(context.Background(), func(tx *store.Tx) error { return tx.Put("workers", w.ID, w) }); err != nil {
			return w, problem("uncertain", "created pane routing could not be persisted: %v", err)
		}
	}
	if err := waitShellReady(ctx, c, w, ws.HerdrWorkspaceID, 5*time.Second); err != nil {
		return e.launchFailure(w, err)
	}
	_, startErr := c.AgentStart(ctx, w.AgentName, w.AgentKind, w.PaneID, w.Args)
	// Inspection may resolve a slow/uncertain launch, but the launch is never
	// replayed. An unrelated or unready agent cannot be mistaken for completion.
	live, getErr := c.AgentGet(ctx, w.PaneID)
	if getErr == nil && live.Name != nil && *live.Name == w.AgentName && live.Agent != nil && *live.Agent == w.AgentKind && live.TerminalID == w.TerminalID {
		if err = e.captureBinding(ctx, &w, live, c, ws.HerdrWorkspaceID); err != nil {
			return e.launchFailure(w, problem("uncertain", "agent started but identity evidence unavailable: %v", err))
		}
		if startErr != nil && (live.InteractiveReady == nil || !*live.InteractiveReady) && live.AgentStatus != "blocked" {
			return e.launchFailure(w, problem("uncertain", "agent launch is present but readiness remains unverified"))
		}
	} else {
		if startErr != nil {
			return e.launchFailure(w, startErr)
		}
		return e.launchFailure(w, problem("uncertain", "launch accepted but live identity could not be confirmed: %v", getErr))
	}
	err = e.write(context.Background(), func(tx *store.Tx) error {
		if err := tx.Put("workers", w.ID, w); err != nil {
			return err
		}
		if err := tx.Event("worker.started", workerScope(w), "worker", r.Caller.WorkerID, w); err != nil {
			return err
		}
		return e.finishTx(tx, r.ID, w, nil, "completed")
	})
	if err != nil {
		return w, problem("uncertain", "launch completed but receipt failed: %v", err)
	}
	e.background(func() { _ = e.refreshSession(e.ctx, w.SessionID) })
	return w, nil
}

func resolveSpawnCwd(cli, tree, profile, workspace string) (string, error) {
	if cli != "" && tree != "" && !sameCwd(cli, tree) {
		return "", problem("bad_cwd", "explicit worker directory conflicts with selected worktree path")
	}
	cwd := cli
	if cwd == "" {
		cwd = tree
	}
	if cwd == "" {
		cwd = profile
	}
	if cwd == "" {
		cwd = workspace
	}
	if cwd == "" {
		return "", nil
	}
	var err error
	cwd, err = filepath.Abs(cwd)
	if err != nil {
		return "", problem("bad_cwd", "resolve worker directory: %v", err)
	}
	st, err := os.Stat(cwd)
	if err != nil || !st.IsDir() {
		return "", problem("bad_cwd", "%s is not an accessible directory", cwd)
	}
	dir, err := os.Open(cwd)
	if err != nil {
		return "", problem("bad_cwd", "%s is not an accessible directory: %v", cwd, err)
	}
	if err := dir.Close(); err != nil {
		return "", problem("bad_cwd", "inspect worker directory %s: %v", cwd, err)
	}
	return cwd, nil
}

// waitShellReady only inspects the reserved terminal. Fresh shells may execute
// startup commands before becoming available; launching during that interval is
// rejected by Herdr. Two consecutive foreground-shell snapshots reduce that race.
// The server remains the final launch gate: this is not permission to retry a
// rejected, timed-out, or uncertain AgentStart.
func waitShellReady(ctx context.Context, c *herdr.Client, w model.Worker, workspaceID string, timeout time.Duration) error {
	deadline, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	previousShell := 0
	for {
		p, err := c.PaneGet(deadline, w.PaneID)
		if err != nil {
			return problem("shell_not_ready", "agent was not launched: cannot inspect reserved shell: %v", err)
		}
		if p.PaneID != w.PaneID || p.TerminalID != w.TerminalID || p.WorkspaceID != workspaceID {
			return problem("stale_attachment", "agent was not launched: reserved shell identity changed")
		}
		if p.Agent != nil && *p.Agent != "" {
			return problem("pane_busy", "agent was not launched: reserved pane contains an agent")
		}
		info, err := c.ProcessInfo(deadline, w.PaneID)
		if err != nil {
			return problem("shell_not_ready", "agent was not launched: shell foreground inspection failed: %v", err)
		}
		ready := info.ShellPID > 0 && len(info.ForegroundProcesses) > 0
		for _, process := range info.ForegroundProcesses {
			if process.PID != info.ShellPID {
				ready = false
			}
		}
		if ready && previousShell == info.ShellPID {
			return nil
		}
		previousShell = 0
		if ready {
			previousShell = info.ShellPID
		}
		timer := time.NewTimer(75 * time.Millisecond)
		select {
		case <-deadline.Done():
			timer.Stop()
			return problem("shell_not_ready", "agent was not launched: foreground shell readiness was not observed before deadline: %v", deadline.Err())
		case <-timer.C:
		}
	}
}

func (e *Engine) launchFailure(w model.Worker, launchErr error) (any, error) {
	w.Ready = false
	w.Error = launchErr.Error()
	w.UpdatedAt = e.now()
	if isUncertain(launchErr) {
		w.State = "starting"
	} else {
		w.State = "failed"
	}
	err := e.write(context.Background(), func(tx *store.Tx) error {
		if err := tx.Put("workers", w.ID, w); err != nil {
			return err
		}
		return tx.Event("worker.launch_failed", workerScope(w), "daemon", "", w)
	})
	if err != nil {
		return w, problem("uncertain", "launch outcome could not be persisted: %v", err)
	}
	return w, launchErr
}

func (e *Engine) captureBinding(ctx context.Context, w *model.Worker, p herdr.Pane, c *herdr.Client, workspaceID string) error {
	clearNativeRecovery(w)
	if p.PaneID == "" || p.TerminalID == "" || p.WorkspaceID != workspaceID || p.Agent == nil || *p.Agent == "" || p.Name == nil || *p.Name == "" {
		return problem("identity_unverified", "live pane requires workspace, terminal, named agent and agent kind evidence")
	}
	fresh, err := c.PaneGet(ctx, p.PaneID)
	if err != nil || fresh.PaneID != p.PaneID || fresh.TerminalID != p.TerminalID || fresh.WorkspaceID != workspaceID {
		return problem("identity_unverified", "pane changed during identity inspection")
	}
	info, infoErr := c.ProcessInfo(ctx, p.PaneID)
	var agent *model.ProcessIdentity
	if infoErr == nil {
		_, agent, err = processEvidence(info, *p.Agent)
		if err != nil && p.AgentSession == nil {
			return err
		}
	}
	if p.AgentSession == nil && (agent == nil || infoErr != nil) {
		return problem("identity_unverified", "adoption requires native session or verified foreground agent birth; pane ID alone is insufficient")
	}
	w.PaneID = p.PaneID
	w.TerminalID = p.TerminalID
	w.AgentKind = *p.Agent
	w.AgentName = *p.Name
	w.NativeSession = p.AgentSession
	w.AgentProcess = agent
	w.RawStatus = p.AgentStatus
	w.State = p.AgentStatus
	if w.State == "" {
		w.State = "starting"
	}
	w.Revision = p.Revision
	w.StateSeq = p.StateChangeSeq
	w.CompletionSeq = p.CompletionSeq
	w.Ready = p.InteractiveReady != nil && *p.InteractiveReady
	w.LastSeenAt = e.now()
	w.UpdatedAt = e.now()
	if w.State != "blocked" {
		clearBlocked(w)
	} else if w.BlockedAt == 0 {
		w.BlockedAt = e.now()
	}
	return nil
}

// clearBlocked ends the block episode so a later block alerts again.
func clearBlocked(w *model.Worker) {
	w.BlockedAt, w.BlockedAlertedAt, w.BlockedAlertDeliveryID, w.BlockedEscalatedAt = 0, 0, "", 0
}

// birthIdentity captures OS process start evidence. Linux additionally uses the
// kernel start tick and boot ID; macOS uses kernel start time with microseconds. Zombie processes have
// exited and must not be treated as surviving cleanup targets.
func birthIdentity(pid int) (model.ProcessIdentity, error) {
	if pid <= 0 {
		return model.ProcessIdentity{}, fmt.Errorf("invalid process PID %d", pid)
	}
	cmd := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "lstart=", "-o", "tty=", "-o", "stat=")
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	out, err := cmd.Output()
	if err != nil {
		if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			return model.ProcessIdentity{}, os.ErrNotExist
		}
		return model.ProcessIdentity{}, fmt.Errorf("cannot inspect birth of process %d: %w", pid, err)
	}
	fields := strings.Fields(string(out))
	if len(fields) < 7 {
		return model.ProcessIdentity{}, fmt.Errorf("unrecognized process birth output for %d", pid)
	}
	if strings.HasPrefix(fields[6], "Z") {
		return model.ProcessIdentity{}, os.ErrNotExist
	}
	birth, err := kernelBirth(pid)
	if err != nil {
		return model.ProcessIdentity{}, err
	}
	return model.ProcessIdentity{PID: pid, Birth: birth, TTY: fields[5]}, nil
}

func processEvidence(info herdr.ProcessInfo, kind string) ([]model.ProcessIdentity, *model.ProcessIdentity, error) {
	identities := []model.ProcessIdentity{}
	var agent *model.ProcessIdentity
	for _, pid := range info.PIDs() {
		id, err := birthIdentity(pid)
		if err != nil {
			return nil, nil, problem("identity_unverified", "process %d birth is unverifiable: %v", pid, err)
		}
		if info.TTY != "" && strings.TrimPrefix(info.TTY, "/dev/") != strings.TrimPrefix(id.TTY, "/dev/") {
			return nil, nil, problem("identity_unverified", "process %d does not belong to the recorded terminal", pid)
		}
		identities = append(identities, id)
		for _, fg := range info.ForegroundProcesses {
			if fg.PID == pid && pid != info.ShellPID && matchesAgentProcess(kind, fg.Name, fg.Argv0, fg.Argv) {
				copy := id
				agent = &copy
			}
		}
	}
	return identities, agent, nil
}
func matchesAgentProcess(kind, name, argv0 string, argv []string) bool {
	candidates := []string{name, argv0}
	if len(argv) > 0 {
		candidates = append(candidates, argv[0])
	}
	for _, candidate := range candidates {
		base := strings.ToLower(filepath.Base(candidate))
		if base == kind || strings.HasPrefix(base, kind+"-") || strings.HasSuffix(base, "/"+kind) {
			return true
		}
		if kind == "claude" && base == "node" && len(argv) > 1 && strings.Contains(strings.ToLower(argv[1]), "claude") {
			return true
		}
	}
	return false
}
func originalProcessAlive(expected model.ProcessIdentity) bool {
	live, err := birthIdentity(expected.PID)
	if err != nil {
		return !errors.Is(err, os.ErrNotExist)
	}
	return err == nil && live.Birth == expected.Birth
}

func signalOriginalProcess(expected model.ProcessIdentity, signal syscall.Signal) error {
	live, err := birthIdentity(expected.PID)
	if err != nil {
		return err
	}
	if live.Birth != expected.Birth || (expected.TTY != "" && live.TTY != expected.TTY) {
		return problem("stale_process", "process %d incarnation changed; signal refused", expected.PID)
	}
	return syscall.Kill(expected.PID, signal)
}
func waitOriginalProcesses(ctx context.Context, identities []model.ProcessIdentity, duration time.Duration) []int {
	end := time.Now().Add(duration)
	for {
		survivors := []int{}
		for _, id := range identities {
			if originalProcessAlive(id) {
				survivors = append(survivors, id.PID)
			}
		}
		if len(survivors) == 0 || time.Now().After(end) {
			return survivors
		}
		select {
		case <-ctx.Done():
			return survivors
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func worktreeUnsaved(ctx context.Context, dir string) ([]string, error) {
	if dir == "" {
		return nil, fmt.Errorf("working directory is unknown")
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return nil, fmt.Errorf("working directory is inaccessible")
	}
	git := func(args ...string) (string, error) {
		cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		return strings.TrimSpace(string(out)), err
	}
	inside, err := git("rev-parse", "--is-inside-work-tree")
	if err != nil {
		if strings.Contains(inside, "not a git repository") {
			return nil, nil
		}
		return nil, fmt.Errorf("git checkout detection failed: %s", inside)
	}
	if inside != "true" {
		return nil, fmt.Errorf("working directory is not a verifiable checkout")
	}
	status, err := git("status", "--porcelain=v1", "--untracked-files=all")
	if err != nil {
		return nil, fmt.Errorf("git status failed: %s", status)
	}
	reasons := []string{}
	if status != "" {
		reasons = append(reasons, "uncommitted or untracked work")
	}
	if _, err := git("rev-parse", "--verify", "HEAD"); err != nil {
		// A fresh repo can safely be closed only when its status contains no work.
		if branch, branchErr := git("symbolic-ref", "-q", "HEAD"); branchErr == nil && branch != "" {
			return reasons, nil
		}
		return nil, fmt.Errorf("cannot verify HEAD")
	}
	count, err := git("rev-list", "--count", "HEAD", "--not", "--remotes")
	if err != nil {
		return nil, fmt.Errorf("cannot verify published commits: %s", count)
	}
	n, err := strconv.Atoi(count)
	if err != nil {
		return nil, fmt.Errorf("invalid Git publication count")
	}
	if n > 0 {
		reasons = append(reasons, fmt.Sprintf("%d commit(s) absent from every remote ref", n))
	}
	return reasons, nil
}

func paneCwd(p herdr.Pane) string {
	if p.ForegroundCwd != nil && *p.ForegroundCwd != "" {
		return *p.ForegroundCwd
	}
	if p.Cwd != nil {
		return *p.Cwd
	}
	return ""
}
func sameCwd(a, b string) bool {
	if resolved, err := filepath.EvalSymlinks(a); err == nil {
		a = resolved
	}
	if resolved, err := filepath.EvalSymlinks(b); err == nil {
		b = resolved
	}
	return filepath.Clean(a) == filepath.Clean(b)
}
