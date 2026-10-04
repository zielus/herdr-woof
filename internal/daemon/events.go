package daemon

import (
	"context"
	"errors"
	"github.com/zielus/herdr-woof/internal/model"
	"time"
)

// Subscription precedes replay. Wakeups are hints; SQLite supplies ordered,
// filtered pages, making a reconnect cursor sufficient even after overflow.
func (e *Engine) follow(ctx context.Context, r model.Request, a Args, emit func(any) error) error {
	ch, unsubscribe := e.hub.subscribe()
	defer unsubscribe()
	cursor, err := e.store.Head(ctx)
	if err != nil {
		return err
	}
	if a.Since != nil {
		cursor = *a.Since
	}
	if cursor < 0 {
		return problem("invalid_cursor", "cursor must be nonnegative")
	}
	for {
		events, err := e.store.Events(ctx, cursor, r.Scope, a.Events, 256)
		if err != nil {
			return err
		}
		for _, ev := range events {
			if err = emit(ev); err != nil {
				return err
			}
			cursor = ev.Seq
		}
		if len(events) == 256 {
			continue
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case _, ok := <-ch:
			if !ok {
				return problem("slow_subscriber", "subscriber overflow; reconnect with last cursor")
			}
		}
	}
}
func (e *Engine) wait(ctx context.Context, r model.Request, a Args) (any, error) {
	if a.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(a.Timeout)*time.Millisecond)
		defer cancel()
	}
	var result model.Event
	sentinel := problem("matched", "event matched")
	// Capture head only once. Re-subscribing must not skip commits that arrived
	// between overflow and the replacement subscription.
	if a.Since == nil {
		cursor, err := e.store.Head(ctx)
		if err != nil {
			return nil, err
		}
		a.Since = &cursor
	}
	for {
		err := e.follow(ctx, r, a, func(v any) error { result = v.(model.Event); return sentinel })
		if err == sentinel {
			return result, nil
		}
		if ctx.Err() == context.DeadlineExceeded {
			return nil, problem("timeout", "wait timed out")
		}
		var me *model.Error
		if ctx.Err() != nil || !errors.As(err, &me) || me.Code != "slow_subscriber" {
			return nil, err
		}
	}
}
func (e *Engine) questionWait(ctx context.Context, r model.Request, a Args) (any, error) {
	if a.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(a.Timeout)*time.Millisecond)
		defer cancel()
	}
	for {
		result, err := e.questionSubscription(ctx, a)
		if ctx.Err() == context.DeadlineExceeded {
			return nil, problem("timeout", "question wait timed out; question remains durable")
		}
		var me *model.Error
		if !errors.As(err, &me) || me.Code != "slow_subscriber" {
			return result, err
		}
	}
}

// Each attempt releases its subscription before the next is allocated, keeping
// cleanup bounded through repeated hub overflow.
func (e *Engine) questionSubscription(ctx context.Context, a Args) (any, error) {
	ch, unsub := e.hub.subscribe()
	defer unsub()
	for {
		m, err := get[model.Message](ctx, e.store, "messages", a.ID)
		if err != nil {
			return nil, err
		}
		if m.Kind != "question" {
			return nil, problem("invalid_args", "not a question")
		}
		ms, err := list[model.Message](ctx, e.store, "messages", model.Scope{RunID: m.RunID})
		if err != nil {
			return nil, err
		}
		for _, reply := range ms {
			if reply.ReplyToMessageID == m.ID {
				return reply, nil
			}
		}
		select {
		case <-ctx.Done():
			if ctx.Err() == context.DeadlineExceeded {
				return nil, problem("timeout", "question wait timed out; question remains durable")
			}
			return nil, ctx.Err()
		case _, ok := <-ch:
			if !ok {
				return nil, problem("slow_subscriber", "question subscription overflow; replay durable replies")
			}
		}
	}
}
