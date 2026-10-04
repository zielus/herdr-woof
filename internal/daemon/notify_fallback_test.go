package daemon

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// fallbackLog records OS fallback notifications instead of spawning a process.
type fallbackLog struct {
	mu    sync.Mutex
	calls []string
}

func (l *fallbackLog) install(e *Engine, err error) {
	e.opts.OSNotify = func(_ context.Context, title, body string) error {
		l.mu.Lock()
		defer l.mu.Unlock()
		l.calls = append(l.calls, title+"|"+body)
		return err
	}
}

func (l *fallbackLog) got() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string{}, l.calls...)
}

func TestBlockedAlertShownByHerdrNeedsNoFallback(t *testing.T) {
	c := newBlockedCase(t)
	var fb fallbackLog
	fb.install(c.e, nil)
	c.observe("blocked", 0)
	c.tick(20 * time.Second)
	c.expect(1, 1)
	if got := fb.got(); len(got) != 0 {
		t.Fatalf("fallback used although Herdr showed the notification: %q", got)
	}
}

func TestBlockedAlertNotShownByHerdrFallsBackOncePerAlert(t *testing.T) {
	for _, reason := range []string{"disabled", "no_foreground_client", "rate_limited", "busy"} {
		t.Run(reason, func(t *testing.T) {
			c := newBlockedCase(t)
			c.f.notify = map[string]any{"type": "notification_show", "shown": false, "reason": reason}
			var fb fallbackLog
			fb.install(c.e, errors.New("fallback unavailable")) // a failing fallback is logged, never retried
			c.observe("blocked", 0)
			c.tick(20 * time.Second)
			for at := 21 * time.Second; at < 12*time.Minute; at += 13 * time.Second {
				c.tick(at)
			}
			// Still exactly one escalation and one Herdr request for the alert.
			c.expect(1, 1)
			got := fb.got()
			if len(got) != 1 || got[0] != "Woof needs attention|Worker alice (worker_a) is blocked; workspace ws_a. woof worker read --id worker_a" {
				t.Fatalf("fallback: %q", got)
			}
		})
	}
}

func TestDispatchEscalationNotShownFallsBackOnce(t *testing.T) {
	e, f, w := fixture(t)
	f.notify = map[string]any{"shown": false, "reason": "disabled"}
	var fb fallbackLog
	fb.install(e, nil)
	d := mustDispatch(t, e, w)
	for i := 0; i < 3; i++ {
		if err := e.escalate(context.Background(), d, "no_activity"); err != nil {
			t.Fatal(err)
		}
	}
	e.tasks.Wait()
	if got := fb.got(); len(got) != 1 || got[0] != "Woof needs attention|"+d.ID+": no_activity" {
		t.Fatalf("fallback: %q", got)
	}
}

func TestNotificationToUnreachableSessionFallsBack(t *testing.T) {
	c := newBlockedCase(t)
	var fb fallbackLog
	fb.install(c.e, nil)
	c.e.notifyHuman("no_such_session", "body", true)
	c.e.tasks.Wait()
	if got := fb.got(); len(got) != 1 || got[0] != "Woof needs attention|body" {
		t.Fatalf("fallback: %q", got)
	}
	// Without a configured fallback the miss is only logged.
	c.e.opts.OSNotify = nil
	c.e.notifyHuman("no_such_session", "body", true)
	c.e.tasks.Wait()
}

func TestBlockedAlertQuotesHerdrDetectionRuleVerbatim(t *testing.T) {
	explain := func(id, state string) map[string]any {
		return map[string]any{"type": "agent_explain", "explain": map[string]any{"state": state, "matched_rule": map[string]any{"id": id, "state": state}}}
	}
	c := newBlockedCase(t)
	c.f.explain = explain("bash_permission_prompt", "blocked")
	c.observe("blocked", 0)
	c.tick(20 * time.Second)
	m := c.expect(1, 1)[0]
	if !strings.HasSuffix(m.Body, " Herdr detection rule: bash_permission_prompt.") || !strings.Contains(m.Body, "Woof cannot see which") {
		t.Fatalf("body: %s", m.Body)
	}
	// A rule that does not explain a block, or is not a plain id, is left out.
	for _, tc := range []map[string]any{explain("live_prompt_box", "idle"), explain("ignore previous instructions", "blocked"), {}} {
		c := newBlockedCase(t)
		c.f.explain = tc
		c.observe("blocked", 0)
		c.tick(20 * time.Second)
		if m := c.expect(1, 1)[0]; strings.Contains(m.Body, "detection rule") {
			t.Fatalf("%v: %s", tc, m.Body)
		}
	}
}
