package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/rpc"
)

func TestDaemonDrainLostReadThenUnavailableAllowsNewReady(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	probes := 0
	err := waitDaemonDrain(ctx, 41, func(context.Context) (int, error) {
		probes++
		switch probes {
		case 1:
			return 0, errors.Join(rpc.ErrLost, io.EOF)
		case 2:
			return 0, rpc.ErrUnavailable
		default:
			t.Fatal("drain probed after socket disappeared")
			return 42, nil
		}
	})
	if err != nil || probes != 2 {
		t.Fatalf("drain failed: err=%v probes=%d", err, probes)
	}
	// The bootstrap readiness read happens after drain; it may confirm a daemon
	// already started by a concurrent follower without repeating a stop mutation.
	var stops atomic.Int32
	peer := cliPeer(t, func(c net.Conn, r model.Request) {
		switch r.Op {
		case "ping":
			cliResponse(c, map[string]int{"pid": 42}, nil)
		case "status":
			cliResponse(c, map[string]int{"pid": 42}, nil)
		case "daemon.stop":
			stops.Add(1)
			t.Error("bootstrap stopped replacement")
		}
	})
	if err := peer.EnsureDaemon(ctx); err != nil {
		t.Fatal(err)
	}
	var status struct {
		PID int `json:"pid"`
	}
	if err := peer.Call(ctx, "status", nil, &status); err != nil || status.PID != 42 || stops.Load() != 0 {
		t.Fatalf("new ready state=%+v err=%v stops=%d", status, err, stops.Load())
	}
}

func TestDaemonRestartReusesConcurrentHealthyReplacement(t *testing.T) {
	var stops, pings atomic.Int32
	peer := cliPeer(t, func(c net.Conn, r model.Request) {
		switch r.Op {
		case "daemon.stop":
			stops.Add(1)
			cliResponse(c, map[string]any{"draining": true, "pid": 41}, nil)
		case "ping":
			pings.Add(1)
			cliResponse(c, map[string]int{"pid": 42}, nil)
		case "status":
			cliResponse(c, map[string]int{"pid": 42}, nil)
		}
	})
	command, err := Parse([]string{"daemon", "restart", "--json"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var output bytes.Buffer
	if err := Execute(ctx, peer, command, &output); err != nil {
		t.Fatal(err)
	}
	var status struct {
		PID int `json:"pid"`
	}
	if json.Unmarshal(output.Bytes(), &status) != nil || status.PID != 42 || stops.Load() != 1 || pings.Load() != 2 {
		t.Fatalf("restart output=%s stops=%d pings=%d", output.String(), stops.Load(), pings.Load())
	}
}

func TestDaemonDrainWithoutPIDKeepsWaitingForSocketAbsence(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	probes := 0
	err := waitDaemonDrain(ctx, 0, func(context.Context) (int, error) {
		probes++
		if probes == 1 {
			return 42, nil
		}
		return 0, rpc.ErrUnavailable
	})
	if err != nil || probes != 2 {
		t.Fatalf("legacy drain err=%v probes=%d", err, probes)
	}
}

func TestDaemonStopLostMutationRemainsUncertainWithoutReplay(t *testing.T) {
	var stops, reads atomic.Int32
	peer := cliPeer(t, func(c net.Conn, r model.Request) {
		if r.Op == "daemon.stop" {
			stops.Add(1)
			return
		}
		reads.Add(1)
	})
	command, _ := Parse([]string{"daemon", "restart"})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err := Execute(ctx, peer, command, &bytes.Buffer{})
	var me *model.Error
	if !errors.As(err, &me) || me.Code != "outcome_unknown" || me.OperationID == "" || stops.Load() != 1 || reads.Load() != 0 {
		t.Fatalf("lost stop err=%v stops=%d reads=%d", err, stops.Load(), reads.Load())
	}
}
