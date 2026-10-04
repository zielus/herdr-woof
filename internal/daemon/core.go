package daemon

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/zielus/herdr-woof-v2/internal/artifacts"
	"github.com/zielus/herdr-woof-v2/internal/herdr"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/paths"
	"github.com/zielus/herdr-woof-v2/internal/profiles"
	"github.com/zielus/herdr-woof-v2/internal/store"
)

// Args is the CLI/RPC command payload; identity and scope travel separately.
type Args struct {
	ID         string   `json:"id,omitempty"`
	Name       string   `json:"name,omitempty"`
	Profile    string   `json:"profile,omitempty"`
	Pane       string   `json:"pane,omitempty"`
	Socket     string   `json:"socket,omitempty"`
	HerdrName  string   `json:"herdr_name,omitempty"`
	Cwd        string   `json:"cwd,omitempty"`
	Workspace  string   `json:"workspace,omitempty"`
	Worktree   string   `json:"worktree,omitempty"`
	To         string   `json:"to,omitempty"`
	Subject    string   `json:"subject,omitempty"`
	Body       string   `json:"body,omitempty"`
	Question   string   `json:"question,omitempty"`
	Kind       string   `json:"kind,omitempty"`
	Title      string   `json:"title,omitempty"`
	Spec       string   `json:"spec,omitempty"`
	Handoff    string   `json:"handoff,omitempty"`
	Dispatch   string   `json:"dispatch,omitempty"`
	Attachment string   `json:"attachment,omitempty"`
	Outcome    string   `json:"outcome,omitempty"`
	Reason     string   `json:"reason,omitempty"`
	Decision   string   `json:"decision,omitempty"`
	Resolution string   `json:"resolution,omitempty"`
	Artifacts  []string `json:"artifacts,omitempty"`
	ExtraArgs  []string `json:"extra_args,omitempty"`
	Options    []string `json:"options,omitempty"`
	Events     []string `json:"events,omitempty"`
	Retained   bool     `json:"retained,omitempty"`
	Force      bool     `json:"force,omitempty"`
	All        bool     `json:"all,omitempty"`
	Since      *int64   `json:"since,omitempty"`
	Limit      int      `json:"limit,omitempty"`
	Lines      int      `json:"lines,omitempty"`
	Timeout    int64    `json:"timeout_ms,omitempty"`
	Cron       string   `json:"cron,omitempty"`
	Timezone   string   `json:"timezone,omitempty"`
	Missed     string   `json:"missed,omitempty"`
	Disabled   bool     `json:"disabled,omitempty"`
	// scheduleRun links a daemon-originated dispatch to its occurrence. It is
	// never decoded from RPC input.
	scheduleRun string
}

type Options struct {
	Paths                                     paths.Paths
	Config                                    profiles.Config
	WatchdogInterval                          time.Duration
	IdleTimeout, QuietTimeout, BlockedTimeout time.Duration
	Now                                       func() time.Time
	HerdrFactory                              func(string) *herdr.Client
	SchedulerDisabled                         bool
}

type sessionRuntime struct {
	client           *herdr.Client
	cancel           context.CancelFunc
	generation       int64
	ready            map[string]bool
	readyAttachments map[string]string
}
type Engine struct {
	store     *store.Store
	opts      Options
	hub       *hub
	mu        sync.Mutex // serializes commits and fan-out, never external calls
	runtimeMu sync.Mutex
	sessions  map[string]*sessionRuntime
	lanes     sync.Map
	inFlight  sync.Map
	ctx       context.Context
	cancel    context.CancelFunc
	stopped   chan struct{}
	stopOnce  sync.Once
	tasksMu   sync.Mutex
	tasks     sync.WaitGroup
	closing   bool
	// scheduleKick wakes the scheduler loop; kicked names workers whose
	// lifecycle changed so their blocked occurrences retry immediately.
	scheduleKick chan struct{}
	kickMu       sync.Mutex
	kicked       map[string]bool
}

func NewEngine(st *store.Store, o Options) *Engine {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.HerdrFactory == nil {
		o.HerdrFactory = herdr.New
	}
	if o.IdleTimeout == 0 {
		o.IdleTimeout = 3 * time.Minute
	}
	if o.QuietTimeout == 0 {
		o.QuietTimeout = 90 * time.Second
	}
	if o.BlockedTimeout == 0 {
		o.BlockedTimeout = 20 * time.Second
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Engine{store: st, opts: o, hub: newHub(), sessions: map[string]*sessionRuntime{}, ctx: ctx, cancel: cancel, stopped: make(chan struct{}), scheduleKick: make(chan struct{}, 1), kicked: map[string]bool{}}
}
func (e *Engine) Close() {
	e.stopOnce.Do(func() {
		e.tasksMu.Lock()
		e.closing = true
		e.cancel()
		close(e.stopped)
		e.tasksMu.Unlock()
		// Keep the writer and ownership lock alive until interrupted external
		// attempts have persisted their conservative outcomes.
		e.tasks.Wait()
	})
}

func (e *Engine) background(fn func()) {
	e.tasksMu.Lock()
	if e.closing {
		e.tasksMu.Unlock()
		return
	}
	e.tasks.Add(1)
	e.tasksMu.Unlock()
	go func() { defer e.tasks.Done(); fn() }()
}
func (e *Engine) now() int64 { return e.opts.Now().UnixMilli() }
func newID(prefix string) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return prefix + "_" + hex.EncodeToString(b[:])
}
func problem(code, format string, a ...any) error {
	return &model.Error{Code: code, Message: fmt.Sprintf(format, a...)}
}
func get[T any](ctx context.Context, st *store.Store, kind, id string) (T, error) {
	var v T
	err := st.Get(ctx, kind, id, &v)
	return v, err
}
func list[T any](ctx context.Context, st *store.Store, kind string, s model.Scope) ([]T, error) {
	var v []T
	err := st.List(ctx, kind, s, &v)
	if v == nil {
		v = []T{}
	}
	return v, err
}
func txGet[T any](tx *store.Tx, kind, id string) (T, error) {
	var v T
	err := tx.Get(kind, id, &v)
	return v, err
}
func txList[T any](tx *store.Tx, kind string, s model.Scope) ([]T, error) {
	var v []T
	err := tx.List(kind, s, &v)
	return v, err
}
func (e *Engine) write(ctx context.Context, fn func(*store.Tx) error) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	events, err := e.store.Write(ctx, fn)
	if err == nil {
		e.hub.publish(events)
	}
	return err
}
func workerScope(w model.Worker) model.Scope {
	return model.Scope{SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, WorktreeID: w.WorktreeID, RunID: w.RunID, WorkerID: w.ID}
}
func dispatchScope(d model.Dispatch) model.Scope {
	return model.Scope{SessionID: d.SessionID, WorkspaceID: d.WorkspaceID, WorktreeID: d.WorktreeID, RunID: d.RunID, WorkerID: d.WorkerID}
}
func (e *Engine) lane(id string) *sync.Mutex {
	v, _ := e.lanes.LoadOrStore(id, &sync.Mutex{})
	return v.(*sync.Mutex)
}
func (e *Engine) sessionClient(id string) (*herdr.Client, error) {
	e.runtimeMu.Lock()
	defer e.runtimeMu.Unlock()
	r := e.sessions[id]
	if r == nil {
		return nil, problem("offline", "session %s has no live connection", id)
	}
	return r.client, nil
}
func (e *Engine) subscriptionReady(w model.Worker) bool {
	e.runtimeMu.Lock()
	defer e.runtimeMu.Unlock()
	r := e.sessions[w.SessionID]
	return r != nil && r.ready[w.ID] && r.readyAttachments[w.ID] == w.AttachmentID
}

// Adopted agents inherit Herdr context rather than injected Woof variables.
// A saved pane reference selects a candidate only; fresh incarnation evidence
// must verify its current routing before assigning actor identity.
func (e *Engine) validatedCaller(ctx context.Context, c model.Caller) (model.Caller, error) {
	if c.WorkerID != "" || c.HerdrSocket == "" || c.PaneID == "" {
		return c, nil
	}
	ss, err := list[model.Session](ctx, e.store, "sessions", model.Scope{})
	if err != nil {
		return c, err
	}
	var candidates []model.Worker
	for _, s := range ss {
		if !sameHerdrSocket(s.SocketPath, c.HerdrSocket) {
			continue
		}
		ws, err := list[model.Worker](ctx, e.store, "workers", model.Scope{SessionID: s.ID})
		if err != nil {
			return c, err
		}
		for _, w := range ws {
			matches := w.PaneID == c.PaneID
			for _, alias := range w.PaneAliases {
				matches = matches || alias == c.PaneID
			}
			if matches && sessionActive(w) {
				candidates = append(candidates, w)
			}
		}
	}
	if len(candidates) == 0 {
		return c, nil
	}
	// A reused current pane and another worker's historical alias are equally
	// plausible routing hints. Process ancestry must distinguish all candidates.
	requireAncestry := len(candidates) > 1 || candidates[0].PaneID != c.PaneID
	var verified []model.Worker
	var failure error
	var unavailable error
	for _, w := range candidates {
		if requireAncestry {
			if err := proveHistoricalCaller(ctx, c.ProcessID, w.AgentProcess); err != nil {
				failure = err
				continue
			}
		}
		hc, err := e.sessionClient(w.SessionID)
		if err != nil {
			unavailable = err
			continue
		}
		p, err := hc.AgentGet(ctx, w.PaneID)
		if err != nil {
			unavailable = err
			continue
		}
		ok, err := e.verifyAttachmentEvidence(ctx, w, p, hc)
		if err != nil {
			unavailable = err
			continue
		}
		if !ok {
			failure = problem("stale_attachment", "caller pane no longer matches registered agent")
			continue
		}
		verified = append(verified, w)
	}
	// An unavailable candidate with proven ancestry cannot be eliminated safely.
	if unavailable != nil {
		return c, problem("precondition_unavailable", "cannot verify caller: %v", unavailable)
	}
	if len(verified) == 1 {
		c.WorkerID = verified[0].ID
		c.AttachmentID = verified[0].AttachmentID
		return c, nil
	}
	if len(verified) > 1 {
		return c, problem("stale_attachment", "caller incarnation matches multiple worker bindings; inspect the current worker binding and supply paired --as-worker ID --as-attachment ID")
	}
	return c, problem("stale_attachment", "pane reference cannot prove caller incarnation (%v); inspect the current worker binding and supply paired --as-worker ID --as-attachment ID", failure)
}
func (e *Engine) normalizeScope(ctx context.Context, r model.Request) (model.Scope, error) {
	var err error
	r.Caller, err = e.validatedCaller(ctx, r.Caller)
	if err != nil {
		return r.Scope, err
	}
	s := r.Scope
	// Actor identity is independent of selected scope; explicit flags cannot
	// authorize an obsolete attachment to impersonate the current worker.
	if r.Caller.WorkerID != "" {
		w, err := get[model.Worker](ctx, e.store, "workers", r.Caller.WorkerID)
		if err != nil {
			return s, err
		}
		if !isRead(r.Op) && (r.Caller.AttachmentID == "" || r.Caller.AttachmentID != w.AttachmentID) {
			return s, problem("stale_attachment", "caller attachment is missing or stale")
		}
		if !isRead(r.Op) && (w.State == "released" || w.State == "stopped" || w.State == "failed" || w.State == "lost") {
			return s, problem("stale_attachment", "caller worker is not live")
		}
	}
	if r.Caller.WorkerID != "" && !r.ScopeExplicit {
		s = model.Scope{}
	}
	if s.Global {
		return model.Scope{Global: true}, nil
	}
	explicit := s.SessionID != "" || s.WorkspaceID != "" || s.WorktreeID != "" || s.RunID != "" || s.WorkerID != ""
	if !explicit && r.Caller.WorkerID != "" {
		w, err := get[model.Worker](ctx, e.store, "workers", r.Caller.WorkerID)
		if err != nil {
			return s, err
		}
		if !isRead(r.Op) && r.Caller.AttachmentID != "" && r.Caller.AttachmentID != w.AttachmentID {
			return s, problem("stale_attachment", "caller attachment is stale")
		}
		s = workerScope(w)
		ds, _ := list[model.Dispatch](ctx, e.store, "dispatches", model.Scope{WorkerID: w.ID})
		for _, d := range ds {
			if activeDispatch(d) {
				s = dispatchScope(d)
			}
		}
	}
	if !explicit && s.SessionID == "" && r.Caller.HerdrSocket != "" {
		ss, err := list[model.Session](ctx, e.store, "sessions", model.Scope{})
		if err != nil {
			return s, err
		}
		for _, x := range ss {
			if sameHerdrSocket(x.SocketPath, r.Caller.HerdrSocket) {
				s.SessionID = x.ID
			}
		}
	}
	merge := func(dst *string, v, label string) error {
		if v == "" {
			return nil
		}
		if *dst != "" && *dst != v {
			return problem("invalid_scope", "%s relationship conflicts", label)
		}
		*dst = v
		return nil
	}
	if s.WorkerID != "" {
		w, err := get[model.Worker](ctx, e.store, "workers", s.WorkerID)
		if err != nil {
			return s, err
		}
		if err = merge(&s.SessionID, w.SessionID, "worker/session"); err != nil {
			return s, err
		}
		dispatchBinding := false
		if s.RunID != "" {
			ds, err := list[model.Dispatch](ctx, e.store, "dispatches", model.Scope{WorkerID: w.ID, RunID: s.RunID})
			if err != nil {
				return s, err
			}
			for _, d := range ds {
				if activeDispatch(d) && d.WorkspaceID == s.WorkspaceID && d.WorktreeID == s.WorktreeID {
					dispatchBinding = true
				}
			}
		}
		if !dispatchBinding {
			if err = merge(&s.WorkspaceID, w.WorkspaceID, "worker/workspace"); err != nil {
				return s, err
			}
			if err = merge(&s.WorktreeID, w.WorktreeID, "worker/worktree"); err != nil {
				return s, err
			}
		}
	}
	if s.RunID != "" {
		v, err := get[model.Run](ctx, e.store, "runs", s.RunID)
		if err != nil {
			return s, err
		}
		if err = merge(&s.SessionID, v.SessionID, "run/session"); err != nil {
			return s, err
		}
		if err = merge(&s.WorkspaceID, v.WorkspaceID, "run/workspace"); err != nil {
			return s, err
		}
		if err = merge(&s.WorktreeID, v.WorktreeID, "run/worktree"); err != nil {
			return s, err
		}
	}
	if s.WorktreeID != "" {
		v, err := get[model.Worktree](ctx, e.store, "worktrees", s.WorktreeID)
		if err != nil {
			return s, err
		}
		if err = merge(&s.SessionID, v.SessionID, "worktree/session"); err != nil {
			return s, err
		}
		if err = merge(&s.WorkspaceID, v.WorkspaceID, "worktree/workspace"); err != nil {
			return s, err
		}
	}
	if s.WorkspaceID != "" {
		v, err := get[model.Workspace](ctx, e.store, "workspaces", s.WorkspaceID)
		if err != nil {
			return s, err
		}
		if err = merge(&s.SessionID, v.SessionID, "workspace/session"); err != nil {
			return s, err
		}
	}
	if s.SessionID != "" {
		if _, err := get[model.Session](ctx, e.store, "sessions", s.SessionID); err != nil {
			return s, err
		}
	}
	return s, nil
}
func activeDispatch(d model.Dispatch) bool {
	return d.Status != "settled" && d.Status != "failed" && d.Status != "cancelled"
}

func requestFingerprint(r model.Request) string {
	// A CLI process is ephemeral transport evidence, not part of the durable
	// mutation payload or logical actor identity.
	r.Caller.ProcessID = 0
	b, _ := json.Marshal(struct {
		Op       string
		Scope    model.Scope
		Caller   model.Caller
		Explicit bool
		Args     json.RawMessage
	}{r.Op, r.Scope, r.Caller, r.ScopeExplicit, r.Args})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
func receiptResult(o model.Operation, fp string) (any, error) {
	if o.Fingerprint != fp {
		return nil, problem("request_conflict", "request ID already belongs to another payload")
	}
	if o.State == "completed" {
		var out any
		err := json.Unmarshal(o.Result, &out)
		return out, err
	}
	if o.State == "failed" {
		return nil, &model.Error{Code: o.ErrorCode, Message: o.Error, OperationID: o.ID}
	}
	return nil, &model.Error{Code: "uncertain", Message: "operation already submitted; inspect and explicitly resolve before further action", OperationID: o.ID}
}
func (e *Engine) Handle(ctx context.Context, r model.Request) (any, error) {
	if r.Version != model.Protocol && r.Version != model.ExtraArgsProtocol {
		return nil, problem("protocol_mismatch", "Woof protocol %d required", model.Protocol)
	}
	var a Args
	if len(r.Args) > 0 {
		if err := json.Unmarshal(r.Args, &a); err != nil {
			return nil, problem("invalid_args", "%v", err)
		}
	}
	if len(a.ExtraArgs) > 0 && (r.Op != "worker.spawn" || r.Version != model.ExtraArgsProtocol) {
		return nil, problem("protocol_mismatch", "extra_args require worker.spawn protocol %d", model.ExtraArgsProtocol)
	}
	if r.Version == model.ExtraArgsProtocol && (r.Op != "worker.spawn" || len(a.ExtraArgs) == 0) {
		return nil, problem("protocol_mismatch", "protocol %d is reserved for worker.spawn extra_args", model.ExtraArgsProtocol)
	}
	if r.Op == "operation.show" {
		return get[model.Operation](ctx, e.store, "operations", a.ID)
	}
	if r.Op == "operation.list" {
		// Diagnostic receipts stay accessible even when inherited attachment
		// context has expired during recovery.
		return list[model.Operation](ctx, e.store, "operations", model.Scope{})
	}
	mutation := !isRead(r.Op)
	fp := requestFingerprint(r)
	if mutation {
		if r.ID == "" {
			return nil, problem("request_id_required", "mutations require a stable request ID")
		}
		if o, err := get[model.Operation](ctx, e.store, "operations", r.ID); err == nil {
			return receiptResult(o, fp)
		}
	}
	caller, err := e.validatedCaller(ctx, r.Caller)
	if err != nil {
		return nil, err
	}
	r.Caller = caller
	s, err := e.normalizeScope(ctx, r)
	if err != nil {
		return nil, err
	}
	r.Scope = s
	if r.Caller.WorkerID == "" && !r.ScopeExplicit && s.WorkerID != "" {
		w, err := get[model.Worker](ctx, e.store, "workers", s.WorkerID)
		if err != nil {
			return nil, err
		}
		r.Caller.WorkerID = w.ID
		r.Caller.AttachmentID = w.AttachmentID
	}
	if !mutation {
		return e.read(ctx, r, a)
	}
	if _, loaded := e.inFlight.LoadOrStore(r.ID, true); loaded {
		return nil, &model.Error{Code: "uncertain", Message: "operation is in flight; inspect receipt", OperationID: r.ID}
	}
	defer e.inFlight.Delete(r.ID)
	var prior model.Operation
	exists := false
	err = e.write(ctx, func(tx *store.Tx) error {
		o, x := txGet[model.Operation](tx, "operations", r.ID)
		if x == nil {
			prior = o
			exists = true
			return nil
		}
		var me *model.Error
		if !errors.As(x, &me) || me.Code != "not_found" {
			return x
		}
		return tx.Put("operations", r.ID, model.Operation{ID: r.ID, Op: r.Op, Fingerprint: fp, State: "accepted", CreatedAt: e.now(), UpdatedAt: e.now()})
	})
	if err != nil {
		return nil, err
	}
	if exists {
		return receiptResult(prior, fp)
	}
	out, err := e.mutate(ctx, r, a)
	if err != nil && isUncertain(err) {
		err = &model.Error{Code: "uncertain", Message: err.Error(), OperationID: r.ID}
	}
	current, x := get[model.Operation](context.Background(), e.store, "operations", r.ID)
	if x == nil && (current.State == "completed" || current.State == "failed") {
		return out, err
	}
	state := "completed"
	if err != nil {
		state = "failed"
		if isUncertain(err) {
			state = "uncertain"
		}
	}
	if saveErr := e.write(context.Background(), func(tx *store.Tx) error { return e.finishTx(tx, r.ID, out, err, state) }); saveErr != nil {
		return nil, &model.Error{Code: "uncertain", Message: "operation result could not be persisted: " + saveErr.Error(), OperationID: r.ID}
	}
	return out, err
}
func (e *Engine) finishTx(tx *store.Tx, id string, out any, err error, state string) error {
	o, x := txGet[model.Operation](tx, "operations", id)
	if x != nil {
		return x
	}
	if o.State == "completed" || o.State == "failed" {
		return nil
	}
	o.State = state
	o.UpdatedAt = e.now()
	if err != nil {
		var me *model.Error
		o.Error = err.Error()
		o.ErrorCode = "operation_failed"
		if errors.As(err, &me) {
			o.ErrorCode = me.Code
		}
	} else {
		o.Result, x = json.Marshal(out)
		if x != nil {
			return x
		}
	}
	return tx.Put("operations", id, o)
}
func isRead(op string) bool {
	switch op {
	case "ping", "status", "session.list", "workspace.list", "worktree.list", "run.list", "run.show", "worker.list", "worker.show", "worker.read", "profile.roster", "profile.show", "inbox", "message.show", "dispatch.show", "check", "gate.list", "gate.show", "operation.list", "operation.show", "events.list", "events.tail", "events.follow", "question.wait", "wait", "schedule.list", "schedule.show", "schedule.history":
		return true
	}
	return false
}
func (e *Engine) read(ctx context.Context, r model.Request, a Args) (any, error) {
	s := r.Scope
	switch r.Op {
	case "ping":
		return map[string]any{"protocol": model.Protocol, "pid": os.Getpid()}, nil
	case "status":
		ss, err := list[model.Session](ctx, e.store, "sessions", s)
		head, _ := e.store.Head(ctx)
		return map[string]any{"sessions": ss, "event_cursor": head, "database": e.opts.Paths.DB, "socket": e.opts.Paths.Sock, "pid": os.Getpid()}, err
	case "session.list":
		return list[model.Session](ctx, e.store, "sessions", s)
	case "workspace.list":
		return list[model.Workspace](ctx, e.store, "workspaces", s)
	case "worktree.list":
		return list[model.Worktree](ctx, e.store, "worktrees", s)
	case "run.list":
		return list[model.Run](ctx, e.store, "runs", s)
	case "run.show":
		return get[model.Run](ctx, e.store, "runs", a.ID)
	case "worker.list":
		return list[model.Worker](ctx, e.store, "workers", s)
	case "worker.show":
		return e.resolveWorker(ctx, a.ID, s)
	case "worker.read":
		w, err := e.resolveWorker(ctx, a.ID, s)
		if err != nil {
			return nil, err
		}
		c, err := e.sessionClient(w.SessionID)
		if err != nil {
			return nil, err
		}
		return c.PaneRead(ctx, w.PaneID, a.Lines)
	case "profile.roster":
		cfg, err := e.config()
		return profiles.Roster(cfg), err
	case "profile.show":
		cfg, err := e.config()
		if err != nil {
			return nil, err
		}
		return cfg.Inspect(a.ID)
	case "inbox":
		return e.inbox(ctx, r, a)
	case "message.show":
		m, err := get[model.Message](ctx, e.store, "messages", a.ID)
		if err != nil {
			return nil, err
		}
		ds, err := list[model.Delivery](ctx, e.store, "deliveries", model.Scope{})
		if err != nil {
			return nil, err
		}
		receipts := []model.Delivery{}
		for _, d := range ds {
			if d.MessageID == m.ID {
				receipts = append(receipts, d)
			}
		}
		return map[string]any{"message": m, "deliveries": receipts, "artifacts": artifacts.Status(m.Artifacts)}, nil
	case "dispatch.show":
		return get[model.Dispatch](ctx, e.store, "dispatches", a.ID)
	case "check":
		return list[model.Dispatch](ctx, e.store, "dispatches", s)
	case "gate.list":
		return list[model.Gate](ctx, e.store, "gates", s)
	case "gate.show":
		return get[model.Gate](ctx, e.store, "gates", a.ID)
	case "events.tail":
		return e.store.EventTail(ctx, s, a.Events, a.Limit)
	case "events.list":
		since := int64(0)
		if a.Since != nil {
			since = *a.Since
		}
		return e.store.Events(ctx, since, s, a.Events, a.Limit)
	case "schedule.list", "schedule.show", "schedule.history":
		return e.scheduleRead(ctx, r, a)
	case "wait":
		return e.wait(ctx, r, a)
	case "question.wait":
		return e.questionWait(ctx, r, a)
	}
	return nil, problem("unknown_operation", "%s", r.Op)
}
func (e *Engine) config() (profiles.Config, error) {
	if e.opts.Paths.Config != "" {
		return profiles.Load(e.opts.Paths.Config)
	}
	return e.opts.Config, nil
}
func (e *Engine) resolveWorker(ctx context.Context, id string, s model.Scope) (model.Worker, error) {
	id = strings.TrimPrefix(strings.TrimPrefix(id, "worker:"), "worker-name:")
	if w, err := get[model.Worker](ctx, e.store, "workers", id); err == nil {
		return w, nil
	}
	// Name resolution is filtered; explicit IDs remain globally addressable.
	s.WorkerID = ""
	s.RunID = ""
	s.WorktreeID = ""
	ws, err := list[model.Worker](ctx, e.store, "workers", s)
	if err != nil {
		return model.Worker{}, err
	}
	var matches []model.Worker
	for _, w := range ws {
		if w.Name == id && w.State != "released" && w.State != "stopped" && w.State != "failed" {
			matches = append(matches, w)
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	if len(matches) > 1 {
		return model.Worker{}, problem("ambiguous_worker", "%q matches %d workers; use ID or workspace scope", id, len(matches))
	}
	return model.Worker{}, problem("not_found", "worker %q", id)
}

func sameHerdrSocket(a, b string) bool {
	x, err := canonicalHerdrSocket(a)
	if err != nil {
		return false
	}
	y, err := canonicalHerdrSocket(b)
	return err == nil && x == y
}
