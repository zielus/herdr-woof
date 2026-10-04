package tui

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/zielus/herdr-woof-v2/internal/model"
)

func TestRunQuitRestoresAlternateScreen(t *testing.T) {
	var out bytes.Buffer
	err := runWithBackend(context.Background(), &uiBackend{}, model.Scope{Global: true}, &out, tea.WithInput(strings.NewReader("q")), tea.WithEnvironment([]string{"TERM=xterm-256color"}), tea.WithWindowSize(100, 30))
	if err != nil {
		t.Fatal(err)
	}
	output := out.String()
	enter := strings.Index(output, "\x1b[?1049h")
	leave := strings.LastIndex(output, "\x1b[?1049l")
	if enter < 0 || leave <= enter {
		t.Fatalf("alternate screen not restored: %q", output)
	}
}
func TestRunExternalCancellationCancelsReads(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	input, writer := io.Pipe()
	defer func() { _ = input.Close() }()
	defer func() { _ = writer.Close() }()
	b := &cancelReadBackend{started: make(chan struct{}), cancelled: make(chan struct{})}
	done := make(chan error, 1)
	go func() {
		done <- runWithBackend(ctx, b, model.Scope{Global: true}, io.Discard, tea.WithInput(input), tea.WithoutRenderer())
	}()
	select {
	case <-b.started:
	case <-time.After(time.Second):
		t.Fatal("load did not start")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not quit UI")
	}
	select {
	case <-b.cancelled:
	case <-time.After(time.Second):
		t.Fatal("read context was not canceled")
	}
}

type cancelReadBackend struct {
	uiBackend
	started, cancelled chan struct{}
}

func (b *cancelReadBackend) Load(ctx context.Context, _ model.Scope) (Snapshot, error) {
	close(b.started)
	<-ctx.Done()
	close(b.cancelled)
	return Snapshot{}, ctx.Err()
}

type streamHarness struct {
	uiBackend
	updates  chan StreamUpdate
	accepted chan struct{}
}

func (b *streamHarness) Follow(ctx context.Context, _ model.Scope, _ int64, accept func(StreamUpdate) error) error {
	for {
		select {
		case update := <-b.updates:
			if err := accept(update); err != nil {
				return err
			}
			b.accepted <- struct{}{}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
func TestCallbackImmediatelyDisablesActionsBeforeUIProcessesError(t *testing.T) {
	b := &streamHarness{updates: make(chan StreamUpdate), accepted: make(chan struct{})}
	m := newModel(context.Background(), b, model.Scope{Global: true})
	defer m.cancel()
	m.ready.Store(true)
	listen := m.follow()
	b.updates <- StreamUpdate{Err: errors.New("disconnected")}
	<-b.accepted
	if m.ready.Load() {
		t.Fatal("stream callback left mutation readiness enabled")
	}
	if _, ok := listen().(streamMsg); !ok {
		t.Fatal("callback error not delivered")
	}
}

func TestQuitDrainsDetachedMutationThenPrintsReceiptAfterRestore(t *testing.T) {
	input, writer := io.Pipe()
	defer func() { _ = input.Close() }()
	defer func() { _ = writer.Close() }()
	b := &heldMutationBackend{started: make(chan context.Context, 1), release: make(chan struct{})}
	m := newModel(context.Background(), b, model.Scope{Global: true})
	m.ready.Store(true)
	a := Action{Kind: "send", To: "worker:w1", Body: "body"}
	m.review = &a
	var out bytes.Buffer
	done := make(chan error, 1)
	go func() {
		done <- runModel(context.Background(), m, &out, tea.WithInput(input), tea.WithEnvironment([]string{"TERM=xterm-256color"}), tea.WithWindowSize(100, 30))
	}()
	if _, err := io.WriteString(writer, "\r"); err != nil {
		t.Fatal(err)
	}
	var mutationCtx context.Context
	select {
	case mutationCtx = <-b.started:
	case <-time.After(time.Second):
		t.Fatal("mutation did not start")
	}
	if _, err := io.WriteString(writer, "q"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-m.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("quit did not cancel reads")
	}
	if mutationCtx.Err() != nil {
		t.Fatal("quit canceled mutation before receipt")
	}
	deadline, ok := mutationCtx.Deadline()
	if !ok || time.Until(deadline) > 10*time.Second {
		t.Fatal("mutation lacks bounded deadline")
	}
	close(b.release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("pending mutation did not drain")
	}
	output := out.String()
	restore := strings.LastIndex(output, "\x1b[?1049l")
	receipt := strings.LastIndex(output, "Uncertain operation op_uncertain")
	if restore < 0 || receipt <= restore {
		t.Fatalf("receipt printed before terminal restored: %q", output)
	}
}

type heldMutationBackend struct {
	uiBackend
	started chan context.Context
	release chan struct{}
}

func (b *heldMutationBackend) Act(ctx context.Context, _ Action) (ActionResult, error) {
	b.started <- ctx
	select {
	case <-b.release:
		return ActionResult{OperationID: "op_uncertain", Uncertain: true}, nil
	case <-ctx.Done():
		return ActionResult{}, ctx.Err()
	}
}

func TestShutdownReceiptReturnsOnlyPendingMutationFailure(t *testing.T) {
	rejection := errors.New("definite rejection during drain")
	for _, quitMode := range []string{"q", "cancel"} {
		for _, outcome := range []string{"rejected", "success", "uncertain"} {
			t.Run(quitMode+"/"+outcome, func(t *testing.T) {
				input, writer := io.Pipe()
				defer func() { _ = input.Close() }()
				defer func() { _ = writer.Close() }()
				b := &shutdownResultBackend{started: make(chan struct{}), release: make(chan struct{})}
				if outcome == "rejected" {
					b.err = rejection
				}
				if outcome == "uncertain" {
					b.result = ActionResult{OperationID: "op_shutdown", Uncertain: true}
				}
				m := newModel(context.Background(), b, model.Scope{Global: true})
				m.ready.Store(true)
				a := Action{Kind: "send", To: "worker:w1", Body: "hello"}
				m.review = &a
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				var output bytes.Buffer
				done := make(chan error, 1)
				go func() {
					done <- runModel(ctx, m, &output, tea.WithInput(input), tea.WithWindowSize(100, 30), tea.WithEnvironment([]string{"TERM=xterm-256color"}))
				}()
				if _, err := io.WriteString(writer, "\r"); err != nil {
					t.Fatal(err)
				}
				select {
				case <-b.started:
				case <-time.After(time.Second):
					t.Fatal("mutation did not start")
				}
				if quitMode == "q" {
					if _, err := io.WriteString(writer, "q"); err != nil {
						t.Fatal(err)
					}
				} else {
					cancel()
				}
				select {
				case <-m.ctx.Done():
				case <-time.After(time.Second):
					t.Fatal("quit did not cancel reads")
				}
				close(b.release)
				select {
				case err := <-done:
					if outcome == "rejected" && !errors.Is(err, rejection) {
						t.Fatalf("shutdown rejection lost: %v", err)
					}
					if outcome != "rejected" && err != nil {
						t.Fatal(err)
					}
				case <-time.After(time.Second):
					t.Fatal("receipt did not drain")
				}
				if !strings.Contains(output.String(), "\x1b[?1049l") {
					t.Fatal("terminal not restored before returning")
				}
				if outcome == "uncertain" && strings.LastIndex(output.String(), "Uncertain operation op_shutdown") < strings.LastIndex(output.String(), "\x1b[?1049l") {
					t.Fatal("uncertain ID printed before restore")
				}
			})
		}
	}
}
func TestCleanQuitDoesNotReturnHistoricalReadOrDisplayedActionError(t *testing.T) {
	for _, oldKind := range []string{"read", "action"} {
		t.Run(oldKind, func(t *testing.T) {
			m := newModel(context.Background(), &uiBackend{}, model.Scope{Global: true})
			if oldKind == "read" {
				m.err = errors.New("old read error")
			} else {
				m.Update(actionMsg{err: errors.New("old displayed action error")})
			}
			if err := runModel(context.Background(), m, io.Discard, tea.WithInput(strings.NewReader("q")), tea.WithoutRenderer()); err != nil {
				t.Fatalf("clean quit returned historical error: %v", err)
			}
		})
	}
}

type shutdownResultBackend struct {
	uiBackend
	started, release chan struct{}
	result           ActionResult
	err              error
}

func (b *shutdownResultBackend) Act(context.Context, Action) (ActionResult, error) {
	close(b.started)
	<-b.release
	return b.result, b.err
}
