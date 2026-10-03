package daemon

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/paths"
	"github.com/zielus/herdr-woof-v2/internal/rpc"
)

func serverPaths(t *testing.T) paths.Paths {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "woof-server-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return paths.Paths{Dir: dir, DB: filepath.Join(dir, "woof.db"), Sock: filepath.Join(dir, "woof.sock"), Lock: filepath.Join(dir, "woof.lock")}
}
func TestOwnershipLockPrecedesDatabaseOpen(t *testing.T) {
	p := serverPaths(t)
	f, err := os.OpenFile(p.Lock, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	if err = Run(context.Background(), Options{Paths: p}); err == nil {
		t.Fatal("second owner acquired DB")
	}
	if _, err = os.Stat(p.DB); !os.IsNotExist(err) {
		t.Fatal("losing owner opened database")
	}
}
func TestGlobalDaemonRestartPreservesReceiptAndSocket(t *testing.T) {
	p := serverPaths(t)
	start := func() (context.CancelFunc, chan error) {
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- Run(ctx, Options{Paths: p}) }()
		deadline := time.Now().Add(2 * time.Second)
		for {
			err := rpc.Call(context.Background(), p.Sock, model.Request{Version: model.Protocol, Op: "ping"}, nil)
			if err == nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("daemon unavailable %v", err)
			}
			time.Sleep(5 * time.Millisecond)
		}
		return cancel, done
	}
	cancel, done := start()
	defer cancel()
	a, _ := json.Marshal(Args{Question: "Ship?"})
	req := model.Request{Version: model.Protocol, ID: "op_persist", Op: "gate.create", Scope: model.Scope{Global: true}, Args: a}
	var first model.Gate
	if err := rpc.Call(context.Background(), p.Sock, req, &first); err != nil {
		t.Fatal(err)
	}
	if err := Run(context.Background(), Options{Paths: p}); err == nil {
		t.Fatal("two daemon owners")
	}
	if conn, err := net.Dial("unix", p.Sock); err != nil {
		t.Fatal("losing owner removed healthy socket")
	} else {
		conn.Close()
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	cancel2, done2 := start()
	defer cancel2()
	var second model.Gate
	if err := rpc.Call(context.Background(), p.Sock, req, &second); err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID {
		t.Fatal("restart replay duplicated mutation")
	}
	cancel2()
	if err := <-done2; err != nil {
		t.Fatal(err)
	}
}
