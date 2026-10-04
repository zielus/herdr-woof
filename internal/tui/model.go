package tui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/colorprofile"
	"github.com/zielus/herdr-woof-v2/internal/model"
)

type loadMsg struct {
	generation uint64
	snapshot   Snapshot
	err        error
	epoch      uint64
}
type streamMsg struct {
	generation uint64
	update     StreamUpdate
	ended      bool
}
type refreshMsg struct{ generation uint64 }
type catalogueMsg struct {
	request    uint64
	generation uint64
	snapshot   Snapshot
	kind       string
	err        error
}
type actionMsg struct {
	result ActionResult
	err    error
	kind   string
}

// scheduleDetailMsg is a schedule.show result, accepted only for the current
// scope generation, the selected schedule ID and the latest detail request.
type scheduleDetailMsg struct {
	generation uint64
	request    uint64
	id         string
	detail     ScheduleDetail
	err        error
}

// scheduleTab is appended after Profiles; tabs 1-5 keep their keys.
const scheduleTab = 5

type operationMsg struct {
	operation model.Operation
	err       error
}
type quitRequest struct{}
type connectionState struct {
	mu    sync.Mutex
	epoch uint64
}
type pendingAction struct {
	done    chan struct{}
	receipt actionMsg
}

func (p *pendingAction) wait() actionMsg { <-p.done; return p.receipt }

type uiModel struct {
	backend               Backend
	root                  context.Context
	ctx                   context.Context
	cancel                context.CancelFunc
	scope                 model.Scope
	generation            uint64
	ready                 *atomic.Bool
	connection            *connectionState
	snapshot              Snapshot
	catalogue             Snapshot
	catalogueRequest      uint64
	tab                   int
	selected              [6]string
	filter                string
	filtering             bool
	width, height, scroll int
	detail, help          bool
	picker                *picker
	form                  *Form
	review                *Action
	loading               bool
	dirty                 bool
	refreshScheduled      bool
	following             bool
	busy                  bool
	quitting              bool
	retryDelay            time.Duration
	stream                chan streamMsg
	pending               *pendingAction
	result                ActionResult
	uncertain             []string
	err                   error
	notice                string
	shutdownMutationError error
	colors                bool
	noColor               bool
	// Schedule detail is read on demand (schedule.show) for the selected
	// schedule. state: "" needs a read, "loading", "stale" (a schedule event
	// arrived; a reload follows) or "done" (success or failure).
	scheduleDetail        *ScheduleDetail
	scheduleDetailID      string
	scheduleDetailRequest uint64
	scheduleDetailState   string
	scheduleDetailErr     error
}

func newModel(ctx context.Context, b Backend, scope model.Scope) *uiModel {
	reads, cancel := context.WithCancel(ctx)
	return &uiModel{noColor: os.Getenv("NO_COLOR") != "" || os.Getenv("TERM") == "dumb", backend: b, root: ctx, ctx: reads, cancel: cancel, scope: scope, generation: 1, ready: &atomic.Bool{}, connection: &connectionState{}, width: 100, height: 30, retryDelay: 250 * time.Millisecond}
}
func (m *uiModel) Init() tea.Cmd { return m.load() }
func (m *uiModel) load() tea.Cmd {
	if m.loading || m.quitting || m.backend == nil {
		return nil
	}
	m.loading = true
	m.dirty = false
	b, ctx, scope, g := m.backend, m.ctx, m.scope, m.generation
	m.connection.mu.Lock()
	epoch := m.connection.epoch
	m.connection.mu.Unlock()
	return func() tea.Msg {
		bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		s, err := b.Load(bounded, scope)
		return loadMsg{generation: g, snapshot: s, err: err, epoch: epoch}
	}
}
func (m *uiModel) schedule(delay time.Duration) tea.Cmd {
	if m.refreshScheduled || m.quitting {
		return nil
	}
	m.refreshScheduled = true
	g := m.generation
	return tea.Tick(delay, func(time.Time) tea.Msg { return refreshMsg{g} })
}
func (m *uiModel) listen() tea.Cmd {
	if !m.following || m.stream == nil {
		return nil
	}
	ctx, ch := m.ctx, m.stream
	return func() tea.Msg {
		select {
		case v := <-ch:
			return v
		case <-ctx.Done():
			return nil
		}
	}
}
func (m *uiModel) follow() tea.Cmd {
	if m.following || m.backend == nil || m.quitting {
		return nil
	}
	m.following = true
	m.stream = make(chan streamMsg, 64)
	b, ctx, scope, g, cursor, ch, ready := m.backend, m.ctx, m.scope, m.generation, m.snapshot.Cursor, m.stream, m.ready
	connection := m.connection
	invalidate := func() { connection.mu.Lock(); connection.epoch++; ready.Store(false); connection.mu.Unlock() }
	go func() {
		err := b.Follow(ctx, scope, cursor, func(v StreamUpdate) error {
			if v.Err != nil {
				invalidate()
			}
			select {
			case ch <- streamMsg{generation: g, update: v}:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		if ctx.Err() != nil {
			return
		}
		invalidate()
		if err == nil {
			err = errors.New("event stream ended")
		}
		select {
		case ch <- streamMsg{generation: g, update: StreamUpdate{Err: err}, ended: true}:
		case <-ctx.Done():
		}
	}()
	return m.listen()
}
func (m *uiModel) acceptSnapshot(s Snapshot) {
	newer := []model.Event{}
	for _, e := range m.snapshot.Events {
		if e.Seq > s.Cursor {
			newer = append(newer, e)
		}
	}
	m.snapshot = s
	for _, e := range newer {
		m.addEvent(e)
	}
	if len(m.snapshot.Events) > 500 {
		m.snapshot.Events = m.snapshot.Events[len(m.snapshot.Events)-500:]
	}
	for tab := range m.selected {
		rows := m.rowsFor(tab)
		if tab == m.tab {
			rows = m.rows()
		}
		found := false
		for _, r := range rows {
			if r.ID == m.selected[tab] {
				found = true
				break
			}
		}
		if !found {
			m.selected[tab] = ""
			if len(rows) > 0 {
				m.selected[tab] = rows[0].ID
			}
		}
	}
}
func (m *uiModel) addEvent(e model.Event) {
	for _, v := range m.snapshot.Events {
		if v.Seq == e.Seq {
			return
		}
	}
	m.snapshot.Events = append(m.snapshot.Events, e)
	sort.Slice(m.snapshot.Events, func(i, j int) bool { return m.snapshot.Events[i].Seq < m.snapshot.Events[j].Seq })
	if len(m.snapshot.Events) > 500 {
		m.snapshot.Events = m.snapshot.Events[len(m.snapshot.Events)-500:]
	}
}
func (m *uiModel) move(delta int) {
	rows := m.rows()
	if len(rows) == 0 {
		return
	}
	idx := 0
	for i, r := range rows {
		if r.ID == m.selected[m.tab] {
			idx = i
			break
		}
	}
	m.selected[m.tab] = rows[(idx+delta+len(rows))%len(rows)].ID
	m.scroll = 0
}
func (m *uiModel) setScope(scope model.Scope) tea.Cmd {
	m.cancel()
	m.ctx, m.cancel = context.WithCancel(m.root)
	m.scope = scope
	m.generation++
	m.ready = &atomic.Bool{}
	m.connection = &connectionState{}
	m.loading = false
	m.following = false
	m.refreshScheduled = false
	m.dirty = false
	m.retryDelay = 250 * time.Millisecond
	m.filter = ""
	m.detail = false
	m.scroll = 0
	m.snapshot = Snapshot{Scope: scope}
	m.selected = [6]string{}
	m.resetScheduleDetail()
	return m.load()
}
func (m *uiModel) pickCatalogue(kind string) tea.Cmd {
	m.catalogueRequest++
	request := m.catalogueRequest
	b, ctx, g := m.backend, m.ctx, m.generation
	if b == nil {
		return nil
	}
	return func() tea.Msg {
		bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		s, err := b.Load(bounded, model.Scope{Global: true})
		return catalogueMsg{generation: g, request: request, snapshot: s, kind: kind, err: err}
	}
}
func (m *uiModel) beginAction(a Action, err error) tea.Cmd {
	if err != nil {
		m.notice = err.Error()
		return nil
	}
	if !m.ready.Load() || m.busy || m.quitting {
		m.notice = "Actions unavailable while stale or submitting"
		return nil
	}
	m.form = nil
	m.review = nil
	m.scroll = 0
	m.catalogueRequest++
	if a.Kind == "ack" || a.Kind == "consume" || isScheduleKind(a.Kind) {
		m.review = &a
	} else {
		f := NewForm(a)
		m.form = &f
	}
	return nil
}
func (m *uiModel) submit() tea.Cmd {
	if m.review == nil || !m.ready.Load() || m.busy || m.quitting || m.help || m.width < 60 || m.height < 16 || m.picker != nil || m.form != nil {
		return nil
	}
	a, b := *m.review, m.backend
	m.busy = true
	m.review = nil
	m.form = nil
	m.pending = &pendingAction{done: make(chan struct{})}
	receipt := m.pending
	ctx, cancel := context.WithTimeout(context.WithoutCancel(m.root), 10*time.Second)
	go func() {
		defer cancel()
		v, err := b.Act(ctx, a)
		receipt.receipt = actionMsg{result: v, err: err, kind: a.Kind}
		close(receipt.done)
	}()
	return func() tea.Msg { return receipt.wait() }
}
func (m *uiModel) quit() tea.Cmd {
	m.quitting = true
	m.ready.Store(false)
	m.cancel()
	if m.busy {
		m.notice = "Waiting for mutation receipt (maximum 10s)…"
		return nil
	}
	return tea.Quit
}

// Update handles one message, then reads the selected schedule's detail when it
// is visible and not yet loaded for the current reload.
func (m *uiModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	next, cmd := m.update(msg)
	return next, tea.Batch(cmd, m.syncScheduleDetail())
}
func (m *uiModel) update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case tea.ColorProfileMsg:
		m.colors = !m.noColor && v.Profile >= colorprofile.ANSI
	case tea.WindowSizeMsg:
		m.width, m.height = v.Width, v.Height
		if m.form != nil {
			f, cmd := m.form.Update(v)
			m.form = &f
			return m, cmd
		}
	case quitRequest:
		return m, m.quit()
	case loadMsg:
		if v.generation != m.generation || m.quitting {
			return m, nil
		}
		m.loading = false
		if v.err != nil {
			m.err = v.err
			m.ready.Store(false)
			cmd := m.schedule(m.retryDelay)
			m.retryDelay = min(3*time.Second, m.retryDelay*2)
			return m, cmd
		}
		m.acceptSnapshot(v.snapshot)
		m.invalidateScheduleDetail()
		m.err = nil
		m.connection.mu.Lock()
		fresh := v.epoch == m.connection.epoch
		m.ready.Store(fresh)
		m.connection.mu.Unlock()
		if !fresh {
			m.dirty = true
		}
		m.retryDelay = 250 * time.Millisecond
		cmd := m.follow()
		if m.dirty {
			return m, tea.Batch(cmd, m.schedule(75*time.Millisecond))
		}
		return m, cmd
	case refreshMsg:
		if v.generation != m.generation || m.quitting {
			return m, nil
		}
		m.refreshScheduled = false
		if m.loading {
			m.dirty = true
			return m, nil
		}
		return m, m.load()
	case streamMsg:
		if v.generation != m.generation || m.quitting {
			return m, nil
		}
		if v.update.Err != nil {
			m.ready.Store(false)
			m.err = v.update.Err
			m.dirty = true
		}
		if v.update.Event != nil {
			m.addEvent(*v.update.Event)
			m.dirty = true
			if strings.HasPrefix(v.update.Event.Type, "schedule.") && m.scheduleDetailState == "done" {
				m.scheduleDetailState = "stale"
			}
		}
		var listener tea.Cmd
		if v.ended {
			m.following = false
		} else {
			listener = m.listen()
		}
		return m, tea.Batch(listener, m.schedule(75*time.Millisecond))
	case catalogueMsg:
		if v.generation != m.generation || v.request != m.catalogueRequest || m.quitting {
			return m, nil
		}
		if v.err != nil {
			m.notice = v.err.Error()
			return m, nil
		}
		m.catalogue = v.snapshot
		if v.kind == "scope" {
			m.picker = newPicker("Select scope", scopeChoices(v.snapshot), scopeID(m.scope))
		} else {
			cs := []choice{}
			for _, w := range v.snapshot.Workers {
				worker := w
				cs = append(cs, choice{ID: w.ID, Label: w.Name + " " + w.ID + " " + w.SessionID + " " + w.WorkspaceID, Worker: &worker})
			}
			m.picker = newPicker("Select recipient", cs, "")
			m.picker.recipientKind = v.kind
		}
		return m, nil
	case FormReviewMsg:
		if m.form == nil {
			return m, nil
		}
		a, err := m.form.Review()
		if err != nil {
			m.notice = err.Error()
			return m, nil
		}
		m.review = &a
		m.form = nil
		m.scroll = 0
		return m, nil
	case scheduleDetailMsg:
		if v.generation != m.generation || v.request != m.scheduleDetailRequest || v.id != m.scheduleDetailID || m.quitting {
			return m, nil
		}
		m.scheduleDetailState = "done"
		m.scheduleDetailErr = v.err
		if v.err == nil {
			detail := v.detail
			m.scheduleDetail = &detail
		}
		return m, nil
	case actionMsg:
		m.busy = false
		m.pending = nil
		m.result = v.result
		m.err = v.err
		if v.result.Uncertain {
			m.recordUncertain(v.result)
			m.notice = "Uncertain operation " + v.result.OperationID + "; i inspect; resolve with woof operation show --id " + v.result.OperationID
			if v.kind == "schedule.run" && v.err == nil {
				m.notice = scheduleActionNotice(v.kind, v.result.Value)
			}
		} else if v.err != nil {
			m.notice = v.err.Error()
		} else if isScheduleKind(v.kind) {
			m.notice = scheduleActionNotice(v.kind, v.result.Value)
		} else {
			m.notice = "Action accepted"
		}
		if m.quitting {
			m.shutdownMutationError = v.err
			return m, tea.Quit
		}
		return m, m.load()
	case operationMsg:
		if v.err != nil {
			m.notice = v.err.Error()
		} else {
			m.notice = fmt.Sprintf("Operation %s: %s; %s. Inspect with woof operation show --id %s", v.operation.ID, v.operation.State, v.operation.Error, v.operation.ID)
		}
		return m, nil
	case tea.KeyPressMsg:
		k := v.String()
		if k == "ctrl+c" {
			return m, m.quit()
		}
		if m.quitting {
			return m, nil
		}
		if m.width < 60 || m.height < 16 {
			switch k {
			case "q":
				return m, m.quit()
			case "esc":
				m.form = nil
				m.review = nil
				m.picker = nil
				m.help = false
				m.catalogueRequest++
			}
			return m, nil
		}
		if m.help {
			switch k {
			case "q":
				return m, m.quit()
			case "?", "esc":
				m.help = false
				m.scroll = 0
			case "down", "j":
				m.scroll++
			case "up", "k":
				m.scroll = max(0, m.scroll-1)
			case "pgdown":
				m.scroll += max(1, m.height-8)
			case "pgup":
				m.scroll = max(0, m.scroll-max(1, m.height-8))
			}
			return m, nil
		}
		if m.form != nil {
			if k == "esc" {
				m.form = nil
				return m, nil
			}
			f, cmd := m.form.Update(v)
			m.form = &f
			return m, cmd
		}
		if m.picker != nil {
			c, closePicker := m.picker.update(v)
			kind := m.picker.recipientKind
			if closePicker {
				m.picker = nil
			}
			if c != nil {
				if kind == "" {
					return m, m.setScope(c.Scope)
				}
				if c.Worker != nil {
					a, err := NewWorkerAction(kind, *c.Worker, m.browseScope())
					return m, m.beginAction(a, err)
				}
			}
			return m, nil
		}
		if m.review != nil {
			switch k {
			case "esc":
				m.review = nil
			case "enter":
				return m, m.submit()
			case "pgdown":
				m.scroll += max(1, m.height-8)
			case "pgup":
				m.scroll = max(0, m.scroll-max(1, m.height-8))
			case "down", "j":
				m.scroll++
			case "up", "k":
				m.scroll = max(0, m.scroll-1)
			}
			return m, nil
		}
		if m.filtering {
			switch k {
			case "esc":
				m.filtering = false
				m.filter = ""
			case "enter":
				m.filtering = false
			case "backspace":
				r := []rune(m.filter)
				if len(r) > 0 {
					m.filter = string(r[:len(r)-1])
				}
			default:
				if v.Text != "" {
					m.filter += safeText(v.Text)
				}
			}
			m.ensureSelection()
			return m, nil
		}
		switch k {
		case "q":
			return m, m.quit()
		case "?":
			m.help = !m.help
			m.scroll = 0
		case "esc":
			m.catalogueRequest++
			m.detail = false
			m.help = false
			m.filter = ""
			m.scroll = 0
		case "tab", "shift+tab", "1", "2", "3", "4", "5", "6":
			m.catalogueRequest++
			switch k {
			case "tab":
				m.tab = (m.tab + 1) % len(tabNames)
			case "shift+tab":
				m.tab = (m.tab + len(tabNames) - 1) % len(tabNames)
			default:
				m.tab = int(k[0] - '1')
			}
			m.detail = false
			m.scroll = 0
			m.filter = ""
			m.ensureSelection()
			if m.tab == 4 {
				return m, m.load()
			}
		case "/":
			m.filtering = true
		case "s":
			return m, m.pickCatalogue("scope")
		case "r":
			return m, m.load()
		case "i":
			if len(m.uncertain) > 0 {
				b, id := m.backend, m.uncertain[len(m.uncertain)-1]
				return m, func() tea.Msg {
					ctx, cancel := context.WithTimeout(context.WithoutCancel(m.root), 5*time.Second)
					defer cancel()
					op, err := b.Operation(ctx, id)
					return operationMsg{op, err}
				}
			}
		case "down", "j":
			if m.detail {
				m.scroll++
			} else {
				m.move(1)
			}
		case "up", "k":
			if m.detail {
				m.scroll = max(0, m.scroll-1)
			} else {
				m.move(-1)
			}
		case "pgdown":
			m.scroll += max(1, m.height-8)
		case "pgup":
			m.scroll = max(0, m.scroll-max(1, m.height-8))
		case "enter":
			if m.tab == 2 {
				for _, g := range m.snapshot.Gates {
					if g.ID == m.selected[m.tab] && g.Status == "open" && m.ready.Load() && !m.busy {
						a, err := NewGateAction(g)
						return m, m.beginAction(a, err)
					}
				}
			}
			m.detail = true
			m.scroll = 0
		case "n", "o":
			kind := "send"
			if k == "o" {
				kind = "ask"
			}
			switch m.tab {
			case 0:
				for _, w := range m.snapshot.Workers {
					if w.ID == m.selected[0] {
						a, err := NewWorkerAction(kind, w, m.browseScope())
						return m, m.beginAction(a, err)
					}
				}
			case 1:
				return m, m.pickCatalogue(kind)
			}
		case "e", "d", "u":
			if m.tab == scheduleTab {
				kind := map[string]string{"e": "schedule.enable", "d": "schedule.disable", "u": "schedule.run"}[k]
				for _, sc := range m.snapshot.Schedules {
					if sc.ID == m.selected[scheduleTab] {
						a, err := NewScheduleAction(kind, sc)
						return m, m.beginAction(a, err)
					}
				}
			}
		case "p", "a", "x":
			if m.tab == 1 {
				kind := map[string]string{"p": "reply", "a": "ack", "x": "consume"}[k]
				for _, e := range m.snapshot.Inbox {
					if e.Delivery.ID == m.selected[1] {
						a, err := NewMessageAction(kind, e)
						return m, m.beginAction(a, err)
					}
				}
			}
		}
	default:
		if m.form != nil {
			f, cmd := m.form.Update(msg)
			m.form = &f
			return m, cmd
		}
	}
	return m, nil
}
func (m *uiModel) browseScope() model.Scope {
	s := m.scope
	if s.RunID != "" {
		for _, r := range append(append([]model.Run{}, m.catalogue.Runs...), m.snapshot.Runs...) {
			if r.ID == s.RunID {
				s.SessionID = r.SessionID
				s.WorkspaceID = r.WorkspaceID
				break
			}
		}
	}
	return s
}
func (m *uiModel) ensureSelection() {
	rows := m.rows()
	for _, r := range rows {
		if r.ID == m.selected[m.tab] {
			return
		}
	}
	m.selected[m.tab] = ""
	if len(rows) > 0 {
		m.selected[m.tab] = rows[0].ID
	}
}
func (m *uiModel) rows() []row {
	all := m.rowsFor(m.tab)
	out := make([]row, 0, len(all))
	for _, r := range all {
		if strings.Contains(strings.ToLower(r.Label+" "+r.ID), strings.ToLower(m.filter)) {
			out = append(out, r)
		}
	}
	return out
}

func (m *uiModel) recordUncertain(result ActionResult) {
	if !result.Uncertain {
		return
	}
	for _, id := range m.uncertain {
		if id == result.OperationID {
			return
		}
	}
	m.uncertain = append(m.uncertain, result.OperationID)
}

func (m *uiModel) resetScheduleDetail() {
	m.scheduleDetailRequest++
	m.scheduleDetail = nil
	m.scheduleDetailID = ""
	m.scheduleDetailState = ""
	m.scheduleDetailErr = nil
}

// invalidateScheduleDetail discards any in-flight read and asks for a new one.
// Linked delivery and settlement progress arrives through non-schedule events,
// so every successful reload invalidates. The last detail stays visible.
func (m *uiModel) invalidateScheduleDetail() {
	m.scheduleDetailRequest++
	m.scheduleDetailState = ""
}

// syncScheduleDetail reads schedule.show at most once per selected ID and
// reload; a failed read waits for the next reload rather than polling.
func (m *uiModel) syncScheduleDetail() tea.Cmd {
	if m.backend == nil || m.quitting || m.tab != scheduleTab || (!m.detail && m.width < 100) {
		return nil
	}
	id := m.selected[scheduleTab]
	if id == "" || (id == m.scheduleDetailID && m.scheduleDetailState != "") {
		return nil
	}
	if id != m.scheduleDetailID {
		m.scheduleDetail = nil
		m.scheduleDetailErr = nil
	}
	m.scheduleDetailRequest++
	m.scheduleDetailID = id
	m.scheduleDetailState = "loading"
	b, ctx, scope, g, request := m.backend, m.ctx, m.scope, m.generation, m.scheduleDetailRequest
	return func() tea.Msg {
		bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		detail, err := b.ScheduleDetail(bounded, scope, id)
		return scheduleDetailMsg{generation: g, request: request, id: id, detail: detail, err: err}
	}
}

// scheduleActionNotice states what an accepted schedule mutation means. A
// persisted run is a queued message, not completed work; a dispatched run's
// settlement is tracked separately; an uncertain run is never resent.
func scheduleActionNotice(kind string, raw []byte) string {
	if kind != "schedule.run" {
		var sc model.Schedule
		if json.Unmarshal(raw, &sc) != nil || sc.ID == "" {
			return scheduleKinds[kind] + " accepted"
		}
		if !sc.Enabled {
			return fmt.Sprintf("Schedule %s (%s) disabled; claimed/blocked occurrences are cancelled", sc.Name, sc.ID)
		}
		return fmt.Sprintf("Schedule %s (%s) enabled; next run %s", sc.Name, sc.ID, orDash(sc.NextRunLocal))
	}
	var run model.ScheduleRun
	if json.Unmarshal(raw, &run) != nil || run.ID == "" {
		return "Run now accepted"
	}
	switch run.State {
	case "persisted":
		return fmt.Sprintf("Run now %s persisted: message %s queued for the worker (not completed work)", run.ID, orDash(run.MessageID))
	case "dispatched":
		return fmt.Sprintf("Run now %s dispatched: prompt accepted for dispatch %s; settlement shown separately", run.ID, orDash(run.DispatchID))
	case "uncertain":
		return fmt.Sprintf("Run now %s uncertain: dispatch prompt outcome unknown; never resent. i inspect; woof operation show --id %s", run.ID, orDash(run.AttemptID))
	case "settled":
		return fmt.Sprintf("Run now %s settled (%s): done report and turn-end evidence recorded", run.ID, orDash(run.Reason))
	case "blocked":
		return fmt.Sprintf("Run now %s blocked (%s): nothing sent; the daemon retries", run.ID, orDash(run.Reason))
	case "failed":
		return fmt.Sprintf("Run now %s failed: %s", run.ID, orDash(strings.TrimSpace(run.Error+" "+run.Reason)))
	}
	return fmt.Sprintf("Run now %s %s", run.ID, run.State)
}
