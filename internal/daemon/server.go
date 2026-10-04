package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"sync"
	"syscall"
	"time"

	"github.com/zielus/herdr-woof/internal/model"
	"github.com/zielus/herdr-woof/internal/store"
)

// Run obtains exclusive ownership before opening SQLite. Every client accesses
// state via RPC; a second process never opens or migrates the canonical DB.
func Run(ctx context.Context, o Options) (runErr error) {
	if o.Paths.Lock == "" || o.Paths.DB == "" || o.Paths.Sock == "" {
		return fmt.Errorf("daemon paths required")
	}
	lock, err := os.OpenFile(o.Paths.Lock, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer func() {
		if err := lock.Close(); err != nil {
			runErr = errors.Join(runErr, fmt.Errorf("close ownership lock: %w", err))
		}
	}()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("another woofd owns the global lock: %w", err)
	}
	defer func() {
		if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); err != nil {
			runErr = errors.Join(runErr, fmt.Errorf("unlock daemon ownership: %w", err))
		}
	}()
	// The socket is stale only after ownership has been acquired.
	if existing, x := os.Lstat(o.Paths.Sock); x == nil {
		owner, ok := existing.Sys().(*syscall.Stat_t)
		if existing.Mode()&os.ModeSocket == 0 || !ok || int(owner.Uid) != os.Getuid() {
			return fmt.Errorf("refusing to remove unsafe socket path %s", o.Paths.Sock)
		}
		if err = os.Remove(o.Paths.Sock); err != nil {
			return err
		}
	} else if !os.IsNotExist(x) {
		return x
	}
	st, err := store.Open(o.Paths.DB)
	if err != nil {
		return err
	}
	defer func() {
		if err := st.Close(); err != nil {
			runErr = errors.Join(runErr, fmt.Errorf("close database: %w", err))
		}
	}()
	ln, err := net.Listen("unix", o.Paths.Sock)
	if err != nil {
		return err
	}
	defer func() {
		// Serve normally closes the listener to interrupt Accept.
		if err := ln.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			runErr = errors.Join(runErr, fmt.Errorf("close listener: %w", err))
		}
	}()
	if ul, ok := ln.(*net.UnixListener); ok {
		ul.SetUnlinkOnClose(false)
	}
	if err = os.Chmod(o.Paths.Sock, 0600); err != nil {
		return err
	}
	owned, err := os.Lstat(o.Paths.Sock)
	if err != nil {
		return err
	}
	defer func() {
		current, x := os.Lstat(o.Paths.Sock)
		if x != nil && !os.IsNotExist(x) {
			runErr = errors.Join(runErr, fmt.Errorf("inspect owned socket during cleanup: %w", x))
		} else if x == nil && os.SameFile(owned, current) {
			if err := os.Remove(o.Paths.Sock); err != nil && !os.IsNotExist(err) {
				runErr = errors.Join(runErr, fmt.Errorf("remove owned socket: %w", err))
			}
		}
	}()
	// Lock content is diagnostic only, never ownership evidence.
	if err := lock.Truncate(0); err != nil {
		log.Printf("write diagnostic lock PID: %v", err)
	} else if _, err := fmt.Fprintf(lock, "%d\n", os.Getpid()); err != nil {
		log.Printf("write diagnostic lock PID: %v", err)
	}
	e := NewEngine(st, o)
	defer e.Close()
	e.startSessions()
	if o.WatchdogInterval > 0 {
		e.background(e.watchdog)
	}
	if !o.SchedulerDisabled {
		e.background(e.scheduler)
	}
	return Serve(ctx, ln, e)
}
func Serve(ctx context.Context, ln net.Listener, e *Engine) error {
	serverCtx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	defer func() {
		// Every exit path drains RPC handlers before Run closes the engine/store.
		cancel()
		wg.Wait()
	}()
	drain := make(chan struct{})
	var once sync.Once
	go func() {
		select {
		case <-serverCtx.Done():
		case <-drain:
		case <-e.stopped:
		}
		if err := ln.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			log.Printf("close RPC listener: %v", err)
		}
	}()
	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) || ctx.Err() != nil {
				break
			}
			return err
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { _ = conn.Close() }() // A departed RPC peer needs only best-effort socket cleanup.
			handleConn(serverCtx, conn, e, func() { once.Do(func() { close(drain) }) })
		}()
	}
	return nil
}
func handleConn(ctx context.Context, c net.Conn, e *Engine, stop func()) {
	respond := func(out any, err error) {
		// An RPC response failure is terminal; durable mutations must not repeat.
		if writeErr := writeResponse(c, out, err); writeErr != nil {
			log.Printf("RPC response: %v", writeErr)
		}
	}
	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	reader := bufio.NewReaderSize(c, 1<<20)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return
	}
	if len(line) > 4<<20 {
		return
	}
	_ = c.SetReadDeadline(time.Time{})
	var r model.Request
	if err = json.Unmarshal(line, &r); err != nil {
		respond(nil, problem("invalid_request", "%v", err))
		return
	}
	// Disconnect cancels waits and streams. Mutations continue to a durable receipt.
	waitCtx, waitCancel := context.WithCancel(ctx)
	defer waitCancel()
	go func() { var b [1]byte; _, _ = c.Read(b[:]); waitCancel() }()
	if r.Op == "events.follow" {
		if r.Version != model.Protocol {
			respond(nil, problem("protocol_mismatch", "unsupported protocol"))
			return
		}
		s, err := e.normalizeScope(waitCtx, r)
		if err != nil {
			respond(nil, err)
			return
		}
		r.Scope = s
		var a Args
		if err = json.Unmarshal(r.Args, &a); err != nil {
			respond(nil, err)
			return
		}
		err = e.follow(waitCtx, r, a, func(v any) error { return writeResponse(c, v, nil) })
		if err != nil && waitCtx.Err() == nil {
			respond(nil, err)
		}
		return
	}
	callCtx := e.ctx
	if isRead(r.Op) || r.Op == "operation.show" {
		callCtx = waitCtx
	}
	out, err := e.Handle(callCtx, r)
	respond(out, err)
	if r.Op == "daemon.stop" && err == nil {
		stop()
	}
}
func writeResponse(w io.Writer, out any, err error) error {
	resp := model.Response{Version: model.Protocol, OK: err == nil}
	if err != nil {
		var me *model.Error
		if !errors.As(err, &me) {
			me = &model.Error{Code: "internal_error", Message: err.Error()}
		} else if err != me {
			// Retain the code/operation ID without hiding wrapper or joined cleanup
			// failures, and never alter an error owned by the engine/store.
			copy := *me
			copy.Message = err.Error()
			me = &copy
		}
		resp.Error = me
	} else {
		resp.Result, err = json.Marshal(out)
		if err != nil {
			return err
		}
	}
	if c, ok := w.(net.Conn); ok {
		_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	}
	return json.NewEncoder(w).Encode(resp)
}
func (e *Engine) watchdog() {
	ticker := time.NewTicker(e.opts.WatchdogInterval)
	defer ticker.Stop()
	for {
		select {
		case <-e.ctx.Done():
			return
		case <-ticker.C:
			if err := e.watchdogOnce(e.ctx); err != nil {
				log.Printf("watchdog: %v", err)
			}
		}
	}
}
