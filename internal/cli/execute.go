package cli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/charmbracelet/x/term"
	"github.com/zielus/herdr-woof-v2/internal/artifacts"
	"github.com/zielus/herdr-woof-v2/internal/client"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/rpc"
	"github.com/zielus/herdr-woof-v2/internal/tui"
)

const Version = "0.1.0"

const Help = `Woof — durable coordination across Herdr sessions

Usage: woof COMMAND [OPTIONS]
       woof COMMAND --help

  session attach [--socket PATH --herdr-name NAME]   Register current Herdr session
  session list | workspace list | worktree list     Discover scope IDs
  worker start --name NAME [--profile NAME --cwd PATH --pane PANE --arg=VALUE ...]
  worker adopt --pane PANE --name NAME              Validate and adopt a live agent
  worker adopt --id WORKER --pane PANE               Re-adopt the same logical worker
  worker list | show ID | read ID | retain ID [--off]
  worker release ID | stop ID [--force]              Protect work and verify cleanup
  run create --title TITLE | run list | run show ID
  profile roster [--json] | profile show NAME

  send --to worker:ID --body TEXT [--artifact PATH]   Persist short text and file refs
  ask --to WORKER_OR_HUMAN --question TEXT [--timeout 20m --no-wait]
  reply --id QUESTION --body TEXT
  inbox [--id WORKER_OR_HUMAN --all]                  Read only; no implicit ack
  message show ID | ack ID | consume ID
  question wait ID [--timeout 20m]                   Resume an existing question

  dispatch --to WORKER --spec TEXT [--handoff PATH]
  dispatch show ID | check
  done --dispatch ID --attachment ID --body TEXT [--artifact PATH --failed]
  nudge --dispatch ID [--reason TEXT] | fail --dispatch ID --reason TEXT
  gate create --question TEXT [--options yes,no] | gate list | gate show ID
  gate resolve ID --decision OPTION
  operation list | show ID | resolve ID --resolution completed|failed --reason TEXT
  schedule add --name NAME --to WORKER (--cron EXPR | --every 30m) [--tz ZONE]
               (--body TEXT [--subject S] | --spec TEXT [--handoff PATH])
               [--missed latest|skip --disabled]    Durable native time trigger
  schedule list [--all] | show ID | history ID [--limit N]
  schedule enable ID | disable ID | remove ID | run ID
                                                    Manual run never resends uncertain work

  events list [--since SEQ] | events follow [--since SEQ]
  wait [--events message.persisted,dispatch.settled --since SEQ --timeout 20m]
  tui [--session ID --workspace ID --worktree ID --run ID]
                                                    Human monitor, inbox and decisions
  status | daemon stop | daemon restart | version

Scope: --session ID --workspace ID --worktree ID --run ID --worker-scope ID
       --global selects all scopes; explicit flags override inferred WOOF_* context.
Actor: --as-worker ID --as-attachment ID must be paired; replace inherited actor.
Launch: --herdr-workspace ID selects a raw Herdr workspace within the chosen session.
Output: --json prints machine-readable JSON; events follow always prints NDJSON.
Wait/follow default to the current head. To cover an action, capture event_cursor
with status before launching it, then use --since CURSOR for the subsequent wait.

An uncertain mutation must not be resent. Keep its operation ID and inspect state.
Completion requires an explicit report and evidence that the same worker turn ended.
`

func printValue(w io.Writer, value any, machine bool) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if !machine {
		enc.SetIndent("", "  ")
	}
	return enc.Encode(value)
}

// Run parses before touching state, so help and errors never start the daemon.
func Run(ctx context.Context, argv []string, stdout, stderr io.Writer) int {
	command, err := Parse(argv)
	if err != nil {
		writeError(stderr, err, containsJSON(argv))
		return 2
	}
	if command.Help {
		_, err = io.WriteString(stdout, Help)
		if err != nil {
			return 1
		}
		return 0
	}
	if command.Op == "version" {
		if err = printValue(stdout, map[string]any{"version": Version, "protocol": model.Protocol}, command.JSON); err != nil {
			return 1
		}
		return 0
	}
	if command.Op == "tui" {
		output, ok := stdout.(*os.File)
		if !ok || !term.IsTerminal(output.Fd()) || !term.IsTerminal(os.Stdin.Fd()) {
			writeError(stderr, fmt.Errorf("tui requires an interactive terminal on stdin and stdout; use status, inbox or events for scripts"), false)
			return 1
		}
		scope := model.Scope{Global: true}
		if command.HasScope {
			scope = command.Explicit
		}
		if err := tui.Run(ctx, scope, stdout); err != nil {
			writeError(stderr, err, false)
			return 1
		}
		return 0
	}
	c, err := client.New()
	if err == nil {
		err = Execute(ctx, c, command, stdout)
	}
	if err != nil {
		writeError(stderr, err, command.JSON)
		return 1
	}
	return 0
}
func containsJSON(argv []string) bool {
	for _, arg := range argv {
		if arg == "--json" || arg == "--json=true" {
			return true
		}
	}
	return false
}
func writeError(w io.Writer, err error, machine bool) {
	var me *model.Error
	if !errors.As(err, &me) {
		me = &model.Error{Code: "error", Message: err.Error()}
	} else if err != me {
		copy := *me
		copy.Message = err.Error()
		me = &copy
	}
	if machine {
		_ = printValue(w, map[string]any{"error": me}, true)
	} else {
		// Error output is best effort: the command already exits unsuccessfully.
		_, _ = fmt.Fprintf(w, "woof: %s\n", me.Error())
		if me.OperationID != "" {
			_, _ = fmt.Fprintf(w, "Operation: %s. Inspect `woof operation show --id %s`; do not resend.\n", me.OperationID, me.OperationID)
		}
	}
}

func Execute(ctx context.Context, c *client.Client, command Command, stdout io.Writer) error {
	local := *c
	local.Scope = command.ApplyScope(c.Scope)
	local.ScopeExplicit = command.HasScope
	if command.AsWorker != "" {
		local.Caller.WorkerID = command.AsWorker
		local.Caller.AttachmentID = command.AsAttachment
		if !command.HasScope {
			local.Scope = model.Scope{}
		}
	}
	a := command.Args
	if a.Cwd == "" && local.Caller.Cwd == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}
		local.Caller.Cwd = cwd
	}
	if command.Op == "session.attach" {
		if a.Socket == "" {
			a.Socket = local.Caller.HerdrSocket
		}
		if a.HerdrName == "" {
			a.HerdrName = os.Getenv("HERDR_SESSION")
		}
		if a.Socket == "" {
			return fmt.Errorf("session attach needs --socket or HERDR_SOCKET_PATH")
		}
	}
	if len(a.Artifacts) > 0 {
		refs, err := artifacts.Resolve(a.Artifacts, local.Caller.Cwd)
		if err != nil {
			return err
		}
		a.Artifacts = nil
		for _, ref := range refs {
			a.Artifacts = append(a.Artifacts, ref.Path)
		}
	}
	if a.Handoff != "" {
		refs, err := artifacts.Resolve([]string{a.Handoff}, local.Caller.Cwd)
		if err != nil {
			return err
		}
		a.Handoff = refs[0].Path
		if a.Spec == "" {
			a.Spec = "Read the handoff file and carry out its request."
		}
	}
	if command.Op == "daemon.stop" || command.Op == "daemon.restart" {
		return daemonControl(ctx, &local, command, stdout)
	}
	if command.Follow {
		return follow(ctx, &local, a, stdout)
	}
	if command.Op == "wait" || command.Op == "question.wait" {
		var result json.RawMessage
		if err := waitRead(ctx, &local, command.Op, a, &result); err != nil {
			return err
		}
		return printValue(stdout, result, command.JSON)
	}
	var result json.RawMessage
	if err := local.Call(ctx, command.Op, a, &result); err != nil {
		return err
	}
	if command.Op == "ask" && !command.NoWait {
		var receipt struct {
			Message model.Message `json:"message"`
		}
		if err := json.Unmarshal(result, &receipt); err != nil {
			return err
		}
		if receipt.Message.ID == "" {
			return fmt.Errorf("ask persisted without a question ID; inspect inbox before asking again")
		}
		var reply model.Message
		if err := waitRead(ctx, &local, "question.wait", Args{ID: receipt.Message.ID, Timeout: a.Timeout}, &reply); err != nil {
			return fmt.Errorf("question %s remains durable; use woof question wait --id %s or woof message show --id %s: %w", receipt.Message.ID, receipt.Message.ID, receipt.Message.ID, err)
		}
		return printValue(stdout, map[string]any{"question": receipt.Message, "reply": reply}, command.JSON)
	}
	// Pane output is readable text by default; JSON retains exact escapes.
	if command.Op == "worker.read" && !command.JSON {
		var text string
		if err := json.Unmarshal(result, &text); err != nil {
			return err
		}
		_, err := fmt.Fprintln(stdout, text)
		return err
	}
	return printValue(stdout, result, command.JSON)
}

func eventCursor(ctx context.Context, c *client.Client, a Args) (int64, error) {
	if a.Since != nil {
		return *a.Since, nil
	}
	var status struct {
		Cursor int64 `json:"event_cursor"`
	}
	err := c.Call(ctx, "status", nil, &status)
	return status.Cursor, err
}

func retryableRead(err error) bool {
	var me *model.Error
	return errors.Is(err, rpc.ErrLost) || errors.Is(err, rpc.ErrUnavailable) || (errors.As(err, &me) && me.Code == "slow_subscriber")
}

// Read retries retain one absolute deadline and one initial replay cursor. The
// server waits until cancellation rather than starting a fresh relative timeout.
func waitRead(ctx context.Context, c *client.Client, op string, a Args, out any) error {
	if a.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(a.Timeout)*time.Millisecond)
		defer cancel()
		a.Timeout = 0
	}
	if op == "wait" {
		cursor, err := eventCursor(ctx, c, a)
		if err != nil {
			return waitError(ctx, err)
		}
		a.Since = &cursor
	}
	for {
		err := c.Call(ctx, op, a, out)
		if ctx.Err() != nil || !retryableRead(err) {
			return waitError(ctx, err)
		}
		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return waitError(ctx, ctx.Err())
		case <-timer.C:
		}
	}
}

func waitError(ctx context.Context, err error) error {
	if ctx.Err() == context.DeadlineExceeded {
		return &model.Error{Code: "timeout", Message: "wait timed out; durable records remain available"}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

func follow(ctx context.Context, c *client.Client, a Args, w io.Writer) error {
	cursor, err := eventCursor(ctx, c, a)
	if err != nil {
		return err
	}
	for {
		a.Since = &cursor
		err := c.Stream(ctx, "events.follow", a, func(raw json.RawMessage) error {
			var ev model.Event
			if err := json.Unmarshal(raw, &ev); err != nil {
				return fmt.Errorf("invalid event: %w", err)
			}
			if ev.Seq <= cursor {
				return nil
			}
			if err := printValue(w, raw, true); err != nil {
				return err
			}
			cursor = ev.Seq
			return nil
		})
		if ctx.Err() != nil {
			return nil
		}
		if !retryableRead(err) {
			return err
		}
		timer := time.NewTimer(200 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
}

func daemonControl(ctx context.Context, c *client.Client, command Command, w io.Writer) error {
	var entropy [16]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return err
	}
	id := "op_" + hex.EncodeToString(entropy[:])
	req := model.Request{Version: model.Protocol, ID: id, Op: "daemon.stop", Scope: model.Scope{Global: true}, Args: json.RawMessage(`{}`)}
	var result json.RawMessage
	err := rpc.Call(ctx, c.Paths.Sock, req, &result)
	if errors.Is(err, rpc.ErrLost) {
		return &model.Error{Code: "outcome_unknown", OperationID: id, Message: "daemon stop may have applied; inspect the operation and daemon state before restarting"}
	}
	if err != nil && !errors.Is(err, rpc.ErrUnavailable) {
		return err
	}
	if command.Op == "daemon.stop" {
		if result == nil {
			result = json.RawMessage(`{"running":false}`)
		}
		return printValue(w, result, command.JSON)
	}
	waitCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var receipt struct {
		PID int `json:"pid"`
	}
	_ = json.Unmarshal(result, &receipt)
	err = waitDaemonDrain(waitCtx, receipt.PID, func(probeCtx context.Context) (int, error) {
		var ping struct {
			PID int `json:"pid"`
		}
		err := rpc.Call(probeCtx, c.Paths.Sock, model.Request{Version: model.Protocol, Op: "ping"}, &ping)
		return ping.PID, err
	})
	if err != nil {
		return err
	}
	if err = c.EnsureDaemon(waitCtx); err != nil {
		return err
	}
	var status json.RawMessage
	if err = c.Call(waitCtx, "status", nil, &status); err != nil {
		return err
	}
	return printValue(w, status, command.JSON)
}

func waitDaemonDrain(ctx context.Context, oldPID int, ping func(context.Context) (int, error)) error {
	for {
		if ctx.Err() != nil {
			return fmt.Errorf("daemon has not finished draining: %w", ctx.Err())
		}
		pid, err := ping(ctx)
		if errors.Is(err, rpc.ErrUnavailable) {
			return nil
		}
		// A follower may have bootstrapped a replacement between probes. Only
		// an acknowledged original PID and a successful different live PID prove
		// that transition; legacy receipts continue waiting for socket absence.
		if err == nil && oldPID > 0 && pid > 0 && pid != oldPID {
			return nil
		}
		// These are read probes after an acknowledged stop. A lost response
		// during drain is expected and never authorizes replaying the stop.
		if err != nil && !errors.Is(err, rpc.ErrLost) {
			return err
		}
		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fmt.Errorf("daemon has not finished draining: %w", ctx.Err())
		case <-timer.C:
		}
	}
}
