package main

import (
	"context"
	"flag"
	"fmt"
	"github.com/zielus/herdr-woof-v2/internal/daemon"
	"github.com/zielus/herdr-woof-v2/internal/paths"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	flags := flag.NewFlagSet("woofd", flag.ExitOnError)
	interval := flags.Duration("watchdog", time.Second, "liveness watchdog interval; 0 disables it")
	idle := flags.Duration("idle-timeout", 3*time.Minute, "idle dispatch without report escalation delay")
	quiet := flags.Duration("quiet-timeout", 90*time.Second, "unobserved dispatch or uncertain delivery escalation delay")
	blocked := flags.Duration("blocked-timeout", 20*time.Second, "persistent blocked prompt escalation delay")
	blockedEscalation := flags.Duration("blocked-escalation-timeout", 5*time.Minute, "delay before a block already reported to a worker is escalated once to the human")
	scheduler := flags.Bool("scheduler", true, "run due native time schedules; false keeps schedules durable but idle")
	// ExitOnError terminates on parse errors; there is no recoverable error here.
	_ = flags.Parse(os.Args[1:])
	if flags.NArg() != 0 || *interval < 0 || *idle <= 0 || *quiet <= 0 || *blocked <= 0 || *blockedEscalation <= 0 {
		fmt.Fprintln(os.Stderr, "woofd: invalid arguments or timeout; use --help")
		os.Exit(2)
	}
	p, err := paths.Resolve()
	if err != nil {
		fmt.Fprintln(os.Stderr, "woofd:", err)
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err = daemon.Run(ctx, daemon.Options{Paths: p, WatchdogInterval: *interval, IdleTimeout: *idle, QuietTimeout: *quiet, BlockedTimeout: *blocked, BlockedEscalationTimeout: *blockedEscalation, SchedulerDisabled: !*scheduler, OSNotify: daemon.OSNotify}); err != nil {
		fmt.Fprintln(os.Stderr, "woofd:", err)
		os.Exit(1)
	}
}
