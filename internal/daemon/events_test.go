package daemon

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/store"
)

func eventsEngine(t *testing.T) *Engine {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "woof.db"))
	if err != nil {
		t.Fatal(err)
	}
	e := NewEngine(st, Options{})
	t.Cleanup(func() { e.Close(); checkCleanup(t, st.Close()) })
	return e
}
func eventsSubscriberCount(e *Engine) int {
	e.hub.mu.Lock()
	defer e.hub.mu.Unlock()
	return len(e.hub.subs)
}

func TestWaitRecoversSlowHubSubscriberFromDurableCursor(t *testing.T) {
	e := eventsEngine(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	entered := make(chan struct{})
	release := make(chan struct{})
	txDone := make(chan error, 1)
	go func() {
		_, err := e.store.Write(ctx, func(*store.Tx) error { close(entered); <-release; return nil })
		txDone <- err
	}()
	<-entered
	zero := int64(0)
	type result struct {
		value any
		err   error
	}
	done := make(chan result, 1)
	go func() {
		v, err := e.wait(ctx, model.Request{Scope: model.Scope{Global: true}}, Args{Since: &zero, Events: []string{"message.persisted"}, Timeout: 2000})
		done <- result{v, err}
	}()
	deadline := time.Now().Add(time.Second)
	for eventsSubscriberCount(e) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if eventsSubscriberCount(e) == 0 {
		close(release)
		t.Fatal("wait did not subscribe")
	}
	// Store access is blocked, so a real hub overflow deterministically disconnects
	// this subscriber. No event is lost: a later commit remains replayable in SQLite.
	e.hub.publish(make([]model.Event, 257))
	close(release)
	if err := <-txDone; err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(time.Second)
	for eventsSubscriberCount(e) == 0 && time.Now().Before(deadline) {
		select {
		case r := <-done:
			t.Fatalf("wait failed on a recoverable hub overflow: %v", r.err)
		default:
		}
		time.Sleep(time.Millisecond)
	}
	if err := e.write(ctx, func(tx *store.Tx) error {
		return tx.Event("message.persisted", model.Scope{Global: true}, "human", "", map[string]string{"message_id": "msg_test"})
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case r := <-done:
		if r.err != nil {
			t.Fatal(r.err)
		}
		ev := r.value.(model.Event)
		if ev.Seq != 1 || ev.Type != "message.persisted" {
			t.Fatalf("event=%+v", ev)
		}
	case <-ctx.Done():
		t.Fatal("wait did not recover")
	}
	if eventsSubscriberCount(e) != 0 {
		t.Fatal("wait leaked its final subscription")
	}
}

func TestWaitTimeoutDoesNotResetAfterOverflow(t *testing.T) {
	e := eventsEngine(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	zero := int64(0)
	done := make(chan error, 1)
	go func() {
		_, err := e.wait(ctx, model.Request{Scope: model.Scope{Global: true}}, Args{Since: &zero, Timeout: 60})
		done <- err
	}()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(250 * time.Millisecond)
	defer deadline.Stop()
	for {
		select {
		case err := <-done:
			var me *model.Error
			if !errors.As(err, &me) || me.Code != "timeout" {
				t.Fatalf("overflow escaped as error: %v", err)
			}
			return
		case <-ticker.C:
			e.hub.publish(make([]model.Event, 1000))
		case <-deadline.C:
			t.Fatal("overflow restarted the original wait timeout")
		}
	}
}

func TestQuestionWaitRepeatedOverflowReplaysReplyAndReleasesSubscription(t *testing.T) {
	e := eventsEngine(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	question := model.Message{ID: "msg_question", Kind: "question", ToKind: "human", ToID: "human", Body: "Approve?"}
	if err := e.write(ctx, func(tx *store.Tx) error { return tx.Put("messages", question.ID, question) }); err != nil {
		t.Fatal(err)
	}
	type result struct {
		value any
		err   error
	}
	done := make(chan result, 1)
	go func() {
		v, err := e.questionWait(ctx, model.Request{}, Args{ID: question.ID, Timeout: 2000})
		done <- result{v, err}
	}()
	for i := 0; i < 8; i++ {
		deadline := time.Now().Add(time.Second)
		for eventsSubscriberCount(e) == 0 && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		if eventsSubscriberCount(e) != 1 {
			t.Fatalf("attempt %d subscription count=%d", i, eventsSubscriberCount(e))
		}
		entered, release := make(chan struct{}), make(chan struct{})
		txDone := make(chan error, 1)
		go func() {
			_, err := e.store.Write(ctx, func(*store.Tx) error { close(entered); <-release; return nil })
			txDone <- err
		}()
		<-entered
		e.hub.publish(make([]model.Event, 257))
		close(release)
		if err := <-txDone; err != nil {
			t.Fatal(err)
		}
	}
	reply := model.Message{ID: "msg_reply", Kind: "reply", ToKind: "human", ToID: "human", Body: "Approved", ReplyToMessageID: question.ID}
	if err := e.write(ctx, func(tx *store.Tx) error {
		if err := tx.Put("messages", reply.ID, reply); err != nil {
			return err
		}
		return tx.Event("message.persisted", model.Scope{Global: true}, "human", "", reply)
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case r := <-done:
		if r.err != nil {
			t.Fatal(r.err)
		}
		if r.value.(model.Message).ID != reply.ID {
			t.Fatalf("reply=%+v", r.value)
		}
	case <-ctx.Done():
		t.Fatal("question did not replay durable reply after overflow")
	}
	if eventsSubscriberCount(e) != 0 {
		t.Fatal("question wait leaked its final subscription")
	}
}
