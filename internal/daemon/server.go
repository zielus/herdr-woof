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

	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/store"
)

// Run obtains exclusive ownership before opening SQLite. Every client accesses
// state via RPC; a second process never opens or migrates the canonical DB.
func Run(ctx context.Context, o Options) error {
	if o.Paths.Lock == "" || o.Paths.DB == "" || o.Paths.Sock == "" {
		return fmt.Errorf("daemon paths required")
	}
	lock, err := os.OpenFile(o.Paths.Lock, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("another woofd owns the global lock: %w", err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
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
	defer st.Close()
	ln, err := net.Listen("unix", o.Paths.Sock)
	if err != nil {
		return err
	}
	defer ln.Close()
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
		if x == nil && os.SameFile(owned, current) {
			_ = os.Remove(o.Paths.Sock)
		}
	}()
	// Lock content is diagnostic only, never ownership evidence.
	_ = lock.Truncate(0)
	_, _ = fmt.Fprintf(lock, "%d\n", os.Getpid())
	e := NewEngine(st, o)
	defer e.Close()
	e.startSessions()
	if o.WatchdogInterval > 0 {
		e.background(e.watchdog)
	}
	return Serve(ctx, ln, e)
}
func Serve(ctx context.Context, ln net.Listener, e *Engine) error {
	serverCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	drain := make(chan struct{})
	var once sync.Once
	go func() {
		select {
		case <-ctx.Done():
		case <-drain:
		case <-e.stopped:
		}
		ln.Close()
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
			defer conn.Close()
			handleConn(serverCtx, conn, e, func() { once.Do(func() { close(drain) }) })
		}()
	}
	// Cancel subscription/read waits while allowing bounded mutations to finish.
	cancel()
	wg.Wait()
	return nil
}
func handleConn(ctx context.Context, c net.Conn, e *Engine, stop func()) {
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
		writeResponse(c, nil, problem("invalid_request", "%v", err))
		return
	}
	// Disconnect cancels waits and streams. Mutations continue to a durable receipt.
	waitCtx, waitCancel := context.WithCancel(ctx)
	defer waitCancel()
	go func() { var b [1]byte; _, _ = c.Read(b[:]); waitCancel() }()
	if r.Op == "events.follow" {
		if r.Version != model.Protocol {
			writeResponse(c, nil, problem("protocol_mismatch", "unsupported protocol"))
			return
		}
		s, err := e.normalizeScope(waitCtx, r)
		if err != nil {
			writeResponse(c, nil, err)
			return
		}
		r.Scope = s
		var a Args
		if err = json.Unmarshal(r.Args, &a); err != nil {
			writeResponse(c, nil, err)
			return
		}
		err = e.follow(waitCtx, r, a, func(v any) error { return writeResponse(c, v, nil) })
		if err != nil && waitCtx.Err() == nil {
			_ = writeResponse(c, nil, err)
		}
		return
	}
	callCtx := e.ctx
	if isRead(r.Op) || r.Op == "operation.show" {
		callCtx = waitCtx
	}
	out, err := e.Handle(callCtx, r)
	_ = writeResponse(c, out, err)
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
