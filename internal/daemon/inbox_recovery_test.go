package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zielus/herdr-woof/internal/herdr"
	"github.com/zielus/herdr-woof/internal/model"
	"github.com/zielus/herdr-woof/internal/store"
)

// The real transport loses exactly one precondition read. The normal fixture
// continues to own identity, prompt inspection and mutation responses.
func inboxReadFault(t *testing.T, e *Engine, w model.Worker, method string, block <-chan struct{}, entered chan<- struct{}) *atomic.Int32 {
	t.Helper()
	e.runtimeMu.Lock()
	upstream := e.sessions[w.SessionID].client.Socket
	sock := filepath.Join(filepath.Dir(upstream), "recovery.sock")
	e.sessions[w.SessionID].client = herdr.New(sock)
	e.runtimeMu.Unlock()
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { checkCleanup(t, ln.Close()) })
	calls := &atomic.Int32{}
	var once sync.Once
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = c.Close() }() // The peer may already have disconnected; cleanup is best effort.
				line, err := bufio.NewReader(c).ReadBytes('\n')
				if err != nil {
					return
				}
				var r struct {
					Method string `json:"method"`
				}
				if json.Unmarshal(line, &r) != nil {
					return
				}
				if r.Method == method {
					n := calls.Add(1)
					if n == 1 {
						return
					}
					if block != nil {
						once.Do(func() { entered <- struct{}{} })
						select {
						case <-block:
						case <-e.ctx.Done():
							return
						}
					}
				}
				remote, err := net.Dial("unix", upstream)
				if err != nil {
					return
				}
				defer func() { _ = remote.Close() }() // The peer may already have disconnected; cleanup is best effort.
				if _, err := remote.Write(line); err != nil {
					return
				}
				response, err := bufio.NewReader(remote).ReadBytes('\n')
				if err == nil {
					_, _ = c.Write(response)
				}
			}()
		}
	}()
	return calls
}

func seedUnattemptedInbox(t *testing.T, e *Engine, w model.Worker) model.Delivery {
	t.Helper()
	m := model.Message{ID: newID("msg"), ToKind: "worker", ToID: w.ID, Kind: "message", Body: "Readiness recovery test", SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, CreatedAt: e.now()}
	d := model.Delivery{ID: newID("delivery"), MessageID: m.ID, WorkerID: w.ID, SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, Status: "pending", WakeStatus: "queued", CreatedAt: e.now(), UpdatedAt: e.now()}
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		if err := tx.Put("messages", m.ID, m); err != nil {
			return err
		}
		return tx.Put("deliveries", d.ID, d)
	}); err != nil {
		t.Fatal(err)
	}
	return d
}

func inboxClock(e *Engine) *atomic.Int64 {
	now := &atomic.Int64{}
	now.Store(time.Now().UnixMilli())
	e.opts.Now = func() time.Time { return time.UnixMilli(now.Load()) }
	return now
}
func waitInboxState(t *testing.T, e *Engine, id, state string) model.Delivery {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	var d model.Delivery
	for time.Now().Before(deadline) {
		d, _ = get[model.Delivery](context.Background(), e.store, "deliveries", id)
		if d.WakeStatus == state {
			return d
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("delivery did not reach %s: %+v", state, d)
	return d
}

func TestInboxReadFailureRecoversWithoutLifecycleEvent(t *testing.T) {
	for _, method := range []string{"agent.get", "agent.read"} {
		t.Run(method, func(t *testing.T) {
			e, f, w := fixture(t)
			now := inboxClock(e)
			reads := inboxReadFault(t, e, w, method, nil, nil)
			d := seedUnattemptedInbox(t, e, w)
			e.processInbox(w.ID)
			held, _ := get[model.Delivery](context.Background(), e.store, "deliveries", d.ID)
			if !strings.HasPrefix(held.Error, "held: readiness read failed:") || held.AttemptID != "" || held.AttemptedAt != 0 {
				t.Fatalf("precondition read failure was not distinguished: %+v", held)
			}
			now.Add(1001)
			if err := e.watchdogOnce(context.Background()); err != nil {
				t.Fatal(err)
			}
			waitInboxState(t, e, d.ID, "sent")
			for i := 0; i < 4; i++ {
				now.Add(1001)
				if err := e.watchdogOnce(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			e.tasks.Wait()
			f.mu.Lock()
			count := len(f.prompts)
			f.mu.Unlock()
			if count != 1 || reads.Load() != 2 {
				t.Fatalf("prompts=%d reads=%d", count, reads.Load())
			}
		})
	}
}

func TestInboxReadRecoveryDoesNotReplayUncertainMutation(t *testing.T) {
	e, f, w := fixture(t)
	now := inboxClock(e)
	f.mu.Lock()
	f.uncertain = true
	f.mu.Unlock()
	reads := inboxReadFault(t, e, w, "agent.read", nil, nil)
	d := seedUnattemptedInbox(t, e, w)
	e.processInbox(w.ID)
	now.Add(1001)
	if err := e.watchdogOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitInboxState(t, e, d.ID, "uncertain")
	for i := 0; i < 4; i++ {
		now.Add(1001)
		if err := e.watchdogOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	e.tasks.Wait()
	f.mu.Lock()
	count := len(f.prompts)
	f.mu.Unlock()
	if count != 1 || reads.Load() != 2 {
		t.Fatalf("uncertain mutation replayed: prompts=%d reads=%d", count, reads.Load())
	}
}

func TestInboxReadRecoveryDeduplicatesBlockedWorkerAcrossTicks(t *testing.T) {
	e, f, w := fixture(t)
	now := inboxClock(e)
	release, entered := make(chan struct{}), make(chan struct{}, 1)
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	reads := inboxReadFault(t, e, w, "agent.read", release, entered)
	d := seedUnattemptedInbox(t, e, w)
	e.processInbox(w.ID)
	now.Add(1001)
	if err := e.watchdogOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("recovery never retried read")
	}
	for i := 0; i < 12; i++ {
		now.Add(1001)
		if err := e.watchdogOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if reads.Load() != 2 {
		t.Fatalf("ticks queued duplicate reads: %d", reads.Load())
	}
	if _, active := e.inFlight.Load("inbox-read-recovery:" + w.ID); !active {
		t.Fatal("blocked recovery did not retain one worker claim")
	}
	releaseOnce.Do(func() { close(release) })
	waitInboxState(t, e, d.ID, "sent")
	e.tasks.Wait()
	if _, active := e.inFlight.Load("inbox-read-recovery:" + w.ID); active {
		t.Fatal("finished recovery retained its worker claim")
	}
	f.mu.Lock()
	count := len(f.prompts)
	f.mu.Unlock()
	if count != 1 {
		t.Fatalf("prompts=%d", count)
	}
}

func TestInboxReadRecoverySkipsPositiveHoldsAndPriorMutationIntents(t *testing.T) {
	cases := []struct {
		name   string
		change func(*model.Delivery)
	}{
		{"draft", func(d *model.Delivery) { d.Error = "held: prompt draft or readiness unknown" }},
		{"busy", func(d *model.Delivery) { d.Error = "held: agent busy or not interactive" }},
		{"identity", func(d *model.Delivery) { d.Error = "held: live attachment unverified" }},
		{"sending", func(d *model.Delivery) { d.WakeStatus = "sending" }},
		{"uncertain", func(d *model.Delivery) { d.WakeStatus = "uncertain" }},
		{"accepted-intent", func(d *model.Delivery) { d.AttemptID = "wake_prior" }},
		{"attempted", func(d *model.Delivery) { d.AttemptedAt = 1 }},
		{"acknowledged", func(d *model.Delivery) { d.AcknowledgedAt = 1 }},
		{"consumed", func(d *model.Delivery) { d.ConsumedAt = 1 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, f, w := fixture(t)
			now := inboxClock(e)
			reads := inboxReadFault(t, e, w, "agent.get", nil, nil)
			d := seedUnattemptedInbox(t, e, w)
			d.Error = "held: readiness read failed: transient failure"
			tc.change(&d)
			if err := e.write(context.Background(), func(tx *store.Tx) error { return tx.Put("deliveries", d.ID, d) }); err != nil {
				t.Fatal(err)
			}
			now.Add(1001)
			if err := e.watchdogOnce(context.Background()); err != nil {
				t.Fatal(err)
			}
			e.tasks.Wait()
			f.mu.Lock()
			count := len(f.prompts)
			f.mu.Unlock()
			if count != 0 || reads.Load() != 0 {
				t.Fatalf("positive hold/prior intent was retried: prompts=%d reads=%d", count, reads.Load())
			}
		})
	}
}

func TestInboxReadRecoveryThrottlesUnchangedReadFailure(t *testing.T) {
	e, _, w := fixture(t)
	now := inboxClock(e)
	// Seed the durable read-failure marker, then make the first recovery read
	// fail too. No new lifecycle event or changed hold reason is generated.
	reads := inboxReadFault(t, e, w, "agent.get", nil, nil)
	d := seedUnattemptedInbox(t, e, w)
	d.Error = "held: readiness read failed: connection lost; request outcome unknown\nEOF"
	if err := e.write(context.Background(), func(tx *store.Tx) error { return tx.Put("deliveries", d.ID, d) }); err != nil {
		t.Fatal(err)
	}
	now.Add(1001)
	if err := e.watchdogOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	e.tasks.Wait()
	if reads.Load() != 1 {
		t.Fatalf("first recovery reads=%d", reads.Load())
	}
	for i := 0; i < 10; i++ {
		if err := e.watchdogOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	e.tasks.Wait()
	if reads.Load() != 1 {
		t.Fatal("unchanged read failure bypassed recovery throttle")
	}
	now.Add(1001)
	if err := e.watchdogOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitInboxState(t, e, d.ID, "sent")
}
