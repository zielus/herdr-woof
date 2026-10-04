package tui

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	tea "charm.land/bubbletea/v2"
	"github.com/zielus/herdr-woof-v2/internal/model"
)

// Run owns the terminal lifecycle. The CLI validates a real TTY before calling.
func Run(ctx context.Context, scope model.Scope, stdout io.Writer) error {
	backend, err := NewRPCBackend()
	if err != nil {
		return err
	}
	return runWithBackend(ctx, backend, scope, stdout, tea.WithInput(os.Stdin))
}
func runWithBackend(ctx context.Context, backend Backend, scope model.Scope, stdout io.Writer, options ...tea.ProgramOption) error {
	return runModel(ctx, newModel(ctx, backend, scope), stdout, options...)
}
func runModel(ctx context.Context, m *uiModel, stdout io.Writer, options ...tea.ProgramOption) error {
	defer m.cancel()
	opts := append([]tea.ProgramOption{tea.WithOutput(stdout), tea.WithoutSignalHandler()}, options...)
	p := tea.NewProgram(m, opts...)
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-signals:
			p.Send(quitRequest{})
		case <-ctx.Done():
			p.Send(quitRequest{})
		case <-done:
		}
	}()
	_, err := p.Run()
	// Run has restored the terminal here. Even an unexpected renderer shutdown
	// must preserve the receipt of the independently bounded mutation.
	if m.pending != nil {
		receipt := m.pending.wait()
		m.result = receipt.result
		m.recordUncertain(receipt.result)
		if receipt.err != nil && err == nil {
			err = receipt.err
		}
	}
	if m.shutdownMutationError != nil {
		err = errors.Join(err, m.shutdownMutationError)
	}
	for _, id := range m.uncertain {
		if _, printErr := fmt.Fprintf(stdout, "Uncertain operation %s. Inspect: woof operation show --id %s\n", inline(id), inline(id)); err == nil {
			err = printErr
		}
	}
	return err
}
