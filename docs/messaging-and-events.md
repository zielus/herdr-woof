# Messaging and Events

## Goals

Messaging must be:

- durable,
- observable,
- scoped,
- addressable by logical worker identity,
- recoverable after daemon restart,
- usable by agents without polling SQLite directly.

## Message routing

Agents never communicate by directly calling another pane.

They call Woof:

```bash
woof send --to builder --body "Please re-check the failing test."
```

Woof resolves the logical recipient within the current/default scope.

The daemon:

1. persists the message,
2. resolves the current worker runtime location,
3. delivers or schedules wakeup,
4. records delivery state,
5. emits message events.

## Addressing

Preferred explicit forms:

```text
worker:<id>
worker-name:<name>
run:<id>
human
```

CLI may accept shorthand names within a sufficiently narrow scope.

Ambiguous names must fail rather than guess.

## Ask/reply

Preserve the useful `herdr-orch` model:

```bash
woof ask --to reviewer --question "Can this API change be accepted?"
```

The command may block waiting for a reply.

Reply:

```bash
woof reply --id m_123 --body "Yes."
```

The durable message remains canonical even if the waiting CLI disconnects.

## Delivery versus wakeup

Persisting a message does not mean the target agent saw it.

The daemon should separate:

```text
message persistence
message delivery
agent wakeup
```

Suggested behavior:

- if target is idle and safe to prompt:
  - deliver a short wakeup prompt,
- if target is working:
  - leave message queued/delivered in mailbox,
  - wake when worker returns idle if needed,
- never inject large message bodies blindly into an agent prompt,
- prefer prompts such as:
  - "You have Woof message m_123. Run `woof inbox`."

This keeps the DB as canonical content.

Scheduled messages and dispatches from the native time scheduler use these same paths and emit `schedule.*` events; see [scheduler.md](scheduler.md).

## Events

The daemon exposes a durable event stream.

CLI:

```bash
woof events follow
woof events follow --since 1842
woof events follow --run r_123
woof events follow --workspace ws_4
```

Output should be NDJSON when machine-readable.

Example:

```json
{"seq":1843,"type":"dispatch.settled","run_id":"r_17","worker_id":"w_9","created_at":1790998288443}
```

## Agent-friendly wait

Provide a blocking primitive:

```bash
woof wait \
  --events message.available,dispatch.settled,worker.observed \
  --timeout 20m
```

This should block on the daemon socket and return when the first matching event occurs.

Event filters use exact event names. `worker.observed` includes the current lifecycle
state; `dispatch.settled` means the report and corresponding turn-end evidence both exist.

No polling loop is required.

The implementation may share internals with the event subscription system.

## Replay

Every subscriber uses an event cursor.

After reconnect:

```bash
woof events follow --since <last_seq>
```

The daemon returns persisted events after that sequence and then switches to live streaming.

## Optional file projection

Some agent tooling can monitor files better than sockets/CLI processes.

Woof may expose an optional derived stream such as:

```text
~/.woof/watch/<scope>/events.ndjson
```

Rules:

- not canonical,
- safe to delete,
- rebuildable from DB,
- never used by daemon logic,
- append-only projection of selected events.

This is especially useful for Claude Code Monitor-like workflows.

## Watchdog

Watchdog ticks do not replace event delivery.

They repair liveness issues.

Examples:

```text
worker idle + active dispatch + no done report
→ send nudge

worker blocked too long
→ alert the requester once, then the human once

message requiring response not acknowledged
→ wake/nudge according to policy

pane disappeared
→ reconcile worker/dispatch
```

A block is reported per episode, with or without a dispatch: the first alert
after `--blocked-timeout` goes to the invoker of the run when one is available
and to the human otherwise; a block already reported to a worker is escalated
to the human once after `--blocked-escalation-timeout`. The event is
`dispatch.escalated` when the worker has an active dispatch and
`worker.escalated` otherwise, with `payload.reason` `continuously_blocked` or
`blocked_unresolved`. Alerts only inform; they never settle, fail, nudge or
redispatch. See [permissions-and-blocked-alerts.md](permissions-and-blocked-alerts.md).

## Mutation retry safety

Port the `herdr-orch` principle:

If an RPC connection is lost after a mutation may have been accepted, do not blindly resend it.

Return an explicit uncertain outcome and provide a read/check operation to resolve state.

Safe reads/subscriptions may reconnect automatically.
