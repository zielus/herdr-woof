package daemon

import (
	"context"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/store"
)

// blockedCase drives block episodes of the fixture worker on a fake clock.
// Quiet and idle timeouts are an hour so only blocked alerts can fire.
type blockedCase struct {
	t     *testing.T
	e     *Engine
	f     *fakeAgent
	w     model.Worker
	clock *atomic.Int64
	seq   uint64
}

const blockedBase = int64(1800000000000)

func newBlockedCase(t *testing.T) *blockedCase {
	t.Helper()
	e, f, w := fixture(t)
	c := &blockedCase{t: t, e: e, f: f, w: w, clock: &atomic.Int64{}, seq: 10}
	c.clock.Store(blockedBase)
	e.opts.Now = func() time.Time { return time.UnixMilli(c.clock.Load()) }
	e.opts.BlockedTimeout = 20 * time.Second
	e.opts.BlockedEscalationTimeout = 5 * time.Minute
	e.opts.QuietTimeout = time.Hour
	e.opts.IdleTimeout = time.Hour
	return c
}

func (c *blockedCase) observe(status string, at time.Duration) {
	c.t.Helper()
	c.clock.Store(blockedBase + at.Milliseconds())
	c.seq++
	setObservation(c.t, c.e, c.f, c.w, status, c.seq, c.w.CompletionSeq)
}

// tick runs one watchdog pass and waits for its notifications to be sent.
func (c *blockedCase) tick(at time.Duration) {
	c.t.Helper()
	c.clock.Store(blockedBase + at.Milliseconds())
	if err := c.e.watchdogOnce(context.Background()); err != nil {
		c.t.Fatal(err)
	}
	c.e.tasks.Wait()
}

// expect asserts the persisted escalations, oldest first, and the Herdr
// notifications so far.
func (c *blockedCase) expect(escalations, notifications int) []model.Message {
	c.t.Helper()
	all, err := list[model.Message](context.Background(), c.e.store, "messages", model.Scope{})
	if err != nil {
		c.t.Fatal(err)
	}
	got := []model.Message{}
	for _, m := range all {
		if m.Kind == "escalation" {
			got = append(got, m)
		}
	}
	sort.SliceStable(got, func(i, j int) bool { return got[i].CreatedAt < got[j].CreatedAt })
	c.f.mu.Lock()
	notes := append([]string{}, c.f.notes...)
	c.f.mu.Unlock()
	if len(got) != escalations || len(notes) != notifications {
		c.t.Fatalf("want %d escalations and %d notifications, got %+v and %q", escalations, notifications, got, notes)
	}
	return got
}

func (c *blockedCase) worker() model.Worker {
	c.t.Helper()
	w, err := get[model.Worker](context.Background(), c.e.store, "workers", c.w.ID)
	if err != nil {
		c.t.Fatal(err)
	}
	return w
}

// invoker stores a requesting worker and a run it invoked. The run is bound to
// the dispatch when one is given and to the blocked worker itself otherwise.
func (c *blockedCase) invoker(state string, d *model.Dispatch) model.Worker {
	c.t.Helper()
	boss := model.Worker{ID: "worker_boss", SessionID: c.w.SessionID, WorkspaceID: c.w.WorkspaceID, Name: "boss", AttachmentID: "att_boss", State: state, RawStatus: state}
	err := c.e.write(context.Background(), func(tx *store.Tx) error {
		if err := tx.Put("workers", boss.ID, boss); err != nil {
			return err
		}
		if d != nil {
			run, err := txGet[model.Run](tx, "runs", d.RunID)
			if err != nil {
				return err
			}
			run.InvokerWorkerID = boss.ID
			return tx.Put("runs", run.ID, run)
		}
		if err := tx.Put("runs", "run_boss", model.Run{ID: "run_boss", SessionID: c.w.SessionID, WorkspaceID: c.w.WorkspaceID, InvokerWorkerID: boss.ID, Status: "active"}); err != nil {
			return err
		}
		w, err := txGet[model.Worker](tx, "workers", c.w.ID)
		if err != nil {
			return err
		}
		w.RunID = "run_boss"
		return tx.Put("workers", w.ID, w)
	})
	if err != nil {
		c.t.Fatal(err)
	}
	return boss
}

func eventTypes(t *testing.T, e *Engine) string {
	t.Helper()
	events, err := e.store.Events(context.Background(), 0, model.Scope{}, nil, 1000)
	if err != nil {
		t.Fatal(err)
	}
	types := []string{}
	for _, event := range events {
		types = append(types, event.Type)
	}
	return strings.Join(types, " ")
}

func TestBlockedWorkerWithoutDispatchAlertsHumanOncePerEpisode(t *testing.T) {
	c := newBlockedCase(t)
	c.observe("blocked", 0)
	c.tick(19 * time.Second)
	c.expect(0, 0)
	c.tick(20 * time.Second)
	m := c.expect(1, 1)[0]
	if m.ToKind != "human" || m.DispatchID != "" || m.WorkspaceID != c.w.WorkspaceID {
		t.Fatalf("routing: %+v", m)
	}
	for _, want := range []string{"Worker alice (worker_a) needs attention", "Herdr has reported it blocked for 20s", "approval or question UI", "workspace ws_a", "woof worker read --id worker_a"} {
		if !strings.Contains(m.Body, want) {
			t.Fatalf("body misses %q: %s", want, m.Body)
		}
	}
	if strings.Contains(strings.ToLower(m.Body), "permission") || strings.Contains(m.Body, "woof dispatch show") {
		t.Fatalf("body claims an unproven reason or a dispatch: %s", m.Body)
	}
	c.f.mu.Lock()
	note := c.f.notes[0]
	c.f.mu.Unlock()
	if note != "Worker alice (worker_a) is blocked; workspace ws_a. woof worker read --id worker_a" {
		t.Fatalf("notification: %q", note)
	}
	// Many ticks, including past the agent escalation timeout, add nothing.
	for at := 21 * time.Second; at < 12*time.Minute; at += 13 * time.Second {
		c.tick(at)
	}
	c.expect(1, 1)
	if w := c.worker(); w.BlockedAlertedAt == 0 || w.BlockedEscalatedAt == 0 || w.BlockedAlertDeliveryID != "" {
		t.Fatalf("episode state: %+v", w)
	}
	c.observe("working", 13*time.Minute)
	if w := c.worker(); w.BlockedAt != 0 || w.BlockedAlertedAt != 0 || w.BlockedEscalatedAt != 0 {
		t.Fatalf("episode survived leaving blocked: %+v", w)
	}
	c.observe("blocked", 14*time.Minute)
	c.tick(14*time.Minute + 19*time.Second)
	c.expect(1, 1)
	c.tick(14*time.Minute + 20*time.Second)
	c.tick(14*time.Minute + 21*time.Second)
	c.expect(2, 2)
	if types := eventTypes(t, c.e); strings.Count(types, "worker.escalated") != 2 || strings.Contains(types, "dispatch.escalated") {
		t.Fatalf("events: %s", types)
	}
	if len(c.f.prompts) != 0 {
		t.Fatalf("alerting prompted an agent: %q", c.f.prompts)
	}
}

func TestBlockedShorterThanDebounceNeverAlerts(t *testing.T) {
	c := newBlockedCase(t)
	d := mustDispatch(t, c.e, c.w)
	c.observe("blocked", 0)
	c.tick(19 * time.Second)
	c.observe("working", 19500*time.Millisecond)
	c.tick(time.Minute)
	c.observe("blocked", 2*time.Minute)
	c.observe("working", 2*time.Minute+19*time.Second)
	c.tick(10 * time.Minute)
	c.expect(0, 0)
	if got, _ := get[model.Dispatch](context.Background(), c.e.store, "dispatches", d.ID); len(got.Alerts) != 0 {
		t.Fatalf("transient block alerted: %+v", got)
	}
}

func TestBlockedDispatchAlertsInvokerThenHumanOncePerEpisode(t *testing.T) {
	c := newBlockedCase(t)
	d := mustDispatch(t, c.e, c.w)
	boss := c.invoker("working", &d)
	prompts := len(c.f.prompts)
	c.observe("blocked", 0)
	before, _ := get[model.Dispatch](context.Background(), c.e.store, "dispatches", d.ID)
	c.tick(20 * time.Second)
	m := c.expect(1, 1)[0]
	if m.ToKind != "worker" || m.ToID != boss.ID || m.DispatchID != d.ID || m.RunID != d.RunID {
		t.Fatalf("routing: %+v", m)
	}
	for _, want := range []string{"Worker alice (worker_a) needs attention", "dispatch " + d.ID, "woof worker read --id worker_a; woof dispatch show --id " + d.ID} {
		if !strings.Contains(m.Body, want) {
			t.Fatalf("body misses %q: %s", want, m.Body)
		}
	}
	c.f.mu.Lock()
	note := c.f.notes[0]
	c.f.mu.Unlock()
	if note != "Worker alice (worker_a) is blocked; workspace ws_a; dispatch "+d.ID+". woof worker read --id worker_a" {
		t.Fatalf("notification: %q", note)
	}
	// The same episode stays silent until the escalation timeout, then tells
	// the human exactly once and never again.
	for at := 21 * time.Second; at < 20*time.Second+5*time.Minute; at += 7 * time.Second {
		c.tick(at)
	}
	c.expect(1, 1)
	for at := 20*time.Second + 5*time.Minute; at < 30*time.Minute; at += 41 * time.Second {
		c.tick(at)
	}
	human := c.expect(2, 2)[1]
	if human.ToKind != "human" || human.DispatchID != d.ID || !strings.HasPrefix(human.Body, "Still blocked after worker worker_boss was notified. Worker alice (worker_a) needs attention") {
		t.Fatalf("human escalation: %+v", human)
	}
	// A second block in the same dispatch is a new episode for the invoker.
	c.observe("working", 31*time.Minute)
	c.observe("blocked", 32*time.Minute)
	c.tick(32*time.Minute + 19*time.Second)
	c.expect(2, 2)
	c.tick(32*time.Minute + 20*time.Second)
	c.tick(32*time.Minute + 30*time.Second)
	if again := c.expect(3, 3)[2]; again.ToID != boss.ID {
		t.Fatalf("new episode routing: %+v", again)
	}
	after, _ := get[model.Dispatch](context.Background(), c.e.store, "dispatches", d.ID)
	if after.Status != before.Status || !activeDispatch(after) || after.TurnEnded || after.DoneAt != 0 || after.Attempt != before.Attempt || after.Nudges != before.Nudges {
		t.Fatalf("alerting changed the dispatch: before %+v after %+v", before, after)
	}
	if len(c.f.prompts) != prompts {
		t.Fatalf("alerting prompted an agent: %q", c.f.prompts)
	}
	if w := c.worker(); w.State != "blocked" {
		t.Fatalf("alerting changed the worker: %+v", w)
	}
	if types := eventTypes(t, c.e); strings.Count(types, "dispatch.escalated") != 3 || strings.Contains(types, "worker.escalated") {
		t.Fatalf("events: %s", types)
	}
}

// Seen live: with the default 90s quiet timeout a blocked dispatch was reported
// a second time as no_activity, on top of its block alert.
func TestBlockedDispatchIsNotAlsoReportedAsInactive(t *testing.T) {
	c := newBlockedCase(t)
	c.e.opts.QuietTimeout = 90 * time.Second
	d := mustDispatch(t, c.e, c.w)
	c.observe("working", 0)
	c.observe("blocked", time.Second)
	for at := 2 * time.Second; at < 30*time.Minute; at += 13 * time.Second {
		c.tick(at)
	}
	if m := c.expect(1, 1)[0]; m.ToKind != "human" || !strings.Contains(m.Body, "blocked for") {
		t.Fatalf("block alert: %+v", m)
	}
	after, _ := get[model.Dispatch](context.Background(), c.e.store, "dispatches", d.ID)
	if after.Alerts["no_activity"] || !after.Alerts["continuously_blocked"] {
		t.Fatalf("alerts: %+v", after.Alerts)
	}
	// Once it works again without progress, inactivity is reported as before.
	c.observe("working", 31*time.Minute)
	c.tick(31*time.Minute + 89*time.Second)
	c.expect(1, 1)
	c.tick(31*time.Minute + 90*time.Second)
	if m := c.expect(2, 2)[1]; !strings.Contains(m.Body, "needs attention: no_activity") {
		t.Fatalf("inactivity after the block: %+v", m)
	}
}

func TestBlockedUnblockedBeforeEscalationTimeoutNeverReachesHuman(t *testing.T) {
	c := newBlockedCase(t)
	d := mustDispatch(t, c.e, c.w)
	c.invoker("working", &d)
	c.observe("blocked", 0)
	c.tick(20 * time.Second)
	c.observe("working", 5*time.Minute)
	for at := 5 * time.Minute; at < 20*time.Minute; at += time.Minute {
		c.tick(at)
	}
	if m := c.expect(1, 1)[0]; m.ToKind != "worker" {
		t.Fatalf("routing: %+v", m)
	}
}

func TestBlockedRoutesToRunInvokerWithoutDispatchAndToHumanOtherwise(t *testing.T) {
	for _, tc := range []struct {
		name, state string
		self        bool
		toWorker    bool
	}{
		{name: "available run invoker", state: "idle", toWorker: true},
		{name: "offline invoker", state: "offline"},
		{name: "lost invoker", state: "lost"},
		{name: "released invoker", state: "released"},
		{name: "worker invoked its own run", state: "idle", self: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newBlockedCase(t)
			boss := c.invoker(tc.state, nil)
			if tc.self {
				if err := c.e.write(context.Background(), func(tx *store.Tx) error {
					return tx.Put("runs", "run_boss", model.Run{ID: "run_boss", SessionID: c.w.SessionID, InvokerWorkerID: c.w.ID})
				}); err != nil {
					t.Fatal(err)
				}
			}
			c.observe("blocked", 0)
			c.tick(20 * time.Second)
			c.tick(21 * time.Second)
			m := c.expect(1, 1)[0]
			if tc.toWorker != (m.ToKind == "worker" && m.ToID == boss.ID) || !tc.toWorker && m.ToKind != "human" {
				t.Fatalf("routing: %+v", m)
			}
			if m.RunID != "run_boss" || m.DispatchID != "" {
				t.Fatalf("scope: %+v", m)
			}
			// Only an alert that went to a worker owes the human an escalation.
			c.tick(20*time.Second + 5*time.Minute)
			c.tick(21*time.Second + 5*time.Minute)
			want := 1
			if tc.toWorker {
				want = 2
			}
			c.expect(want, want)
		})
	}
}

func TestBlockedDispatchWithUnavailableInvokerAlertsHuman(t *testing.T) {
	c := newBlockedCase(t)
	d := mustDispatch(t, c.e, c.w)
	c.invoker("offline", &d)
	c.observe("blocked", 0)
	for at := 20 * time.Second; at < 12*time.Minute; at += 29 * time.Second {
		c.tick(at)
	}
	if m := c.expect(1, 1)[0]; m.ToKind != "human" || m.DispatchID != d.ID {
		t.Fatalf("routing: %+v", m)
	}
}

// The unreachable-invoker fallback and the still-blocked escalation both speak
// to the human about one episode; whichever fires first is the only one.
func TestBlockedUnreachableInvokerFallbackIsTheOnlyHumanEscalation(t *testing.T) {
	for _, quiet := range []time.Duration{90 * time.Second, 10 * time.Minute} {
		c := newBlockedCase(t)
		c.e.opts.QuietTimeout = quiet
		c.invoker("working", nil) // never subscription-ready, so its delivery stays queued
		c.observe("blocked", 0)
		c.tick(20 * time.Second)
		c.expect(1, 1)
		for at := 21 * time.Second; at < 40*time.Minute; at += 17 * time.Second {
			c.tick(at)
		}
		// The fallback is a durable message only; the still-blocked escalation
		// also notifies.
		notifications := 1
		if quiet > 5*time.Minute {
			notifications = 2
		}
		ms := c.expect(2, notifications)
		fallback := strings.HasPrefix(ms[1].Body, "Escalation could not reach invoking worker. Worker alice")
		if ms[1].ToKind != "human" || fallback != (quiet < 5*time.Minute) {
			t.Fatalf("quiet=%s human escalation: %+v", quiet, ms[1])
		}
		if w := c.worker(); w.BlockedEscalatedAt == 0 {
			t.Fatalf("episode not marked escalated: %+v", w)
		}
	}
}

// Restart keeps both the debounce timer and the alerted episode: the block
// timer and alert state live on the worker record, not in the engine.
func TestBlockedEpisodeSurvivesEngineRestartAndReobservation(t *testing.T) {
	c := newBlockedCase(t)
	d := mustDispatch(t, c.e, c.w)
	c.invoker("working", &d)
	c.observe("blocked", 0)
	c.tick(10 * time.Second)
	restart := func() {
		t.Helper()
		opts := c.e.opts
		runtime := c.e.sessions[c.w.SessionID]
		c.e.Close()
		c.e = NewEngine(c.e.store, opts)
		t.Cleanup(c.e.Close)
		c.e.sessions[c.w.SessionID] = runtime
	}
	restart()
	c.tick(19 * time.Second)
	c.expect(0, 0)
	c.tick(20 * time.Second)
	c.expect(1, 1)
	alerted := c.worker()
	restart()
	// Reconnect re-reads the still blocked agent without a state change.
	c.clock.Store(blockedBase + (2 * time.Minute).Milliseconds())
	c.f.mu.Lock()
	p := c.f.p
	c.f.mu.Unlock()
	for _, recovery := range []bool{false, true} {
		if err := c.e.observeWorker(context.Background(), c.worker(), p, true, recovery); err != nil {
			t.Fatal(err)
		}
	}
	if w := c.worker(); w.BlockedAt != alerted.BlockedAt || w.BlockedAlertedAt != alerted.BlockedAlertedAt || w.BlockedAlertDeliveryID != alerted.BlockedAlertDeliveryID {
		t.Fatalf("re-observation reset the episode: %+v", w)
	}
	for at := 2 * time.Minute; at < 20*time.Second+5*time.Minute; at += 11 * time.Second {
		c.tick(at)
	}
	c.expect(1, 1)
	// The escalation deadline also survives: one human escalation, once.
	c.tick(20*time.Second + 5*time.Minute)
	restart()
	c.tick(6 * time.Minute)
	c.tick(30 * time.Minute)
	if ms := c.expect(2, 2); ms[1].ToKind != "human" {
		t.Fatalf("human escalation: %+v", ms[1])
	}
	if got, _ := get[model.Dispatch](context.Background(), c.e.store, "dispatches", d.ID); !activeDispatch(got) {
		t.Fatalf("restart settled or failed the dispatch: %+v", got)
	}
}

func TestBlockedEpisodeSurvivesSessionReconnect(t *testing.T) {
	e := sessionEngine(t)
	e.opts.BlockedTimeout = time.Millisecond
	f := newSessionFixture(t, "a")
	s := attachFixture(t, e, f, "a")
	w := seedSessionWorker(t, e, s, f)
	state := func(want string) model.Worker {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for {
			now, _ := get[model.Worker](context.Background(), e.store, "workers", w.ID)
			if now.State == want {
				return now
			}
			if time.Now().After(deadline) {
				t.Fatalf("worker state want %s got %+v", want, now)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	alerts := func() (int, int) {
		t.Helper()
		time.Sleep(5 * time.Millisecond)
		for i := 0; i < 3; i++ {
			if err := e.watchdogOnce(context.Background()); err != nil {
				t.Fatal(err)
			}
		}
		ms, err := list[model.Message](context.Background(), e.store, "messages", model.Scope{})
		if err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(2 * time.Second)
		for {
			f.mu.Lock()
			shown := strings.Count(strings.Join(f.methods, " "), "notification.show")
			f.mu.Unlock()
			if shown >= len(ms) || time.Now().After(deadline) {
				return len(ms), shown
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	f.event(t, "blocked", 3)
	blocked := state("blocked")
	if messages, shown := alerts(); messages != 1 || shown != 1 {
		t.Fatalf("first alert: %d messages, %d notifications", messages, shown)
	}
	f.stop()
	eventuallySession(t, e, s.ID, "offline")
	state("offline")
	if messages, _ := alerts(); messages != 1 {
		t.Fatalf("offline worker alerted again: %d", messages)
	}
	f.start(t)
	eventuallySession(t, e, s.ID, "online")
	if now := state("blocked"); now.BlockedAt != blocked.BlockedAt || now.BlockedAlertedAt == 0 {
		t.Fatalf("reconnect reset the episode: %+v", now)
	}
	if err := e.refreshSession(context.Background(), s.ID, true); err != nil {
		t.Fatal(err)
	}
	if messages, shown := alerts(); messages != 1 || shown != 1 {
		t.Fatalf("reconnect duplicated the alert: %d messages, %d notifications", messages, shown)
	}
}

func TestBlockedEpisodeAcrossReadoption(t *testing.T) {
	for _, tc := range []struct {
		prior     string
		continue_ bool
	}{{"blocked", true}, {"lost", false}} {
		e, f, w := workerFixture(t, false)
		w.State, w.RawStatus, w.BlockedAt, w.BlockedAlertedAt, w.BlockedEscalatedAt = tc.prior, "blocked", 1000, 2000, 2000
		if err := e.write(context.Background(), func(tx *store.Tx) error { return tx.Put("workers", w.ID, w) }); err != nil {
			t.Fatal(err)
		}
		f.mu.Lock()
		f.pane.AgentStatus = "blocked"
		f.mu.Unlock()
		v, err := workerCall(t, e, "worker.adopt", model.Scope{WorkspaceID: w.WorkspaceID}, Args{ID: w.ID, Pane: w.PaneID, Name: w.Name})
		if err != nil {
			t.Fatal(err)
		}
		got := v.(model.Worker)
		if tc.continue_ != (got.BlockedAt == 1000 && got.BlockedAlertedAt == 2000 && got.BlockedEscalatedAt == 2000) {
			t.Fatalf("prior %s: %+v", tc.prior, got)
		}
		// A worker that was not observed blocked starts a fresh, debounced episode.
		if !tc.continue_ && (got.BlockedAt <= 2000 || got.BlockedAlertedAt != 0 || got.BlockedEscalatedAt != 0) {
			t.Fatalf("prior %s: %+v", tc.prior, got)
		}
		if err := e.watchdogOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
		ms, _ := list[model.Message](context.Background(), e.store, "messages", model.Scope{})
		if len(ms) != 0 {
			t.Fatalf("prior %s: re-adoption alerted: %+v", tc.prior, ms)
		}
	}
}
