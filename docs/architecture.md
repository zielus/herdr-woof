# Architecture

## Overview

```text
                    ┌────────────────────┐
                    │       woofd        │
                    │ global daemon      │
                    └─────────┬──────────┘
                              │
                       single writer
                              │
                    ┌─────────▼──────────┐
                    │      woof.db       │
                    └────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
    Herdr session A     Herdr session B     Herdr session C
      herdr.sock          herdr.sock          herdr.sock
          │                   │                   │
    workspaces/panes     workspaces/panes     workspaces/panes
```

`woofd` owns all durable state and all Herdr session connections.

## Herdr plugin startup

Herdr may invoke plugin startup once per Herdr session.

That startup process must be a short-lived registration/bootstrap command, not the daemon itself.

Conceptually:

```text
Herdr session startup
       │
       ▼
woof session attach
       │
       ├─ ensure woofd is running
       ├─ register session_id + HERDR_SOCKET_PATH
       └─ exit
```

`woofd` then owns the long-lived subscription to that session.

## Session manager

`woofd` maintains an in-memory registry:

```text
SessionRuntime
- woof_session_id
- herdr_session_name
- socket_path
- connected
- last_seen
- herdr_client
- subscription state
```

Session registration is durable in SQLite.

On daemon restart:

1. load known sessions,
2. probe their Herdr sockets,
3. reconnect live sessions,
4. mark unavailable sessions detached/offline,
5. reconcile workers against live Herdr state.

## Single-writer persistence

Only `woofd` writes to SQLite.

CLI/TUI/Web clients talk to `woofd` through a Unix socket.

Benefits:

- no DB multi-writer coordination,
- one ordering point for events,
- easy monotonically increasing event sequence,
- consistent recovery semantics,
- no per-session DB aggregation.

## Runtime relationships

```text
session
  └─ workspace
      ├─ worktree?    (logical registry entry; path may equal workspace cwd)
      ├─ worker
      ├─ worker
      └─ run
```

Woof IDs are canonical.

Herdr IDs are references stored on runtime records.

Examples:

```text
woof worker id: w_01J...
herdr pane id:  w4:p2

woof workspace id: ws_01J...
herdr workspace id: w4
```

Never use a Herdr pane ID as the durable worker identity.

## Scope inference

When Woof creates or adopts a pane/worker, it injects enough context for the CLI to infer scope.

Suggested variables:

```text
WOOF_SESSION_ID
WOOF_WORKSPACE_ID
WOOF_WORKTREE_ID
WOOF_RUN_ID
WOOF_WORKER_ID
```

The daemon always validates IDs against DB state.

Explicit CLI flags win over inferred scope.

## Worker routing

Application-level recipient:

```text
worker:w_123
```

Routing:

```text
worker id
   ↓
worker record
   ↓
session id + current Herdr pane id
   ↓
SessionManager
   ↓
Herdr API
```

If the pane changes during recovery, callers do not need to know.

## Event path

```text
Herdr event / Woof mutation
          │
          ▼
        woofd
          │
          ├── persist event in DB
          │
          ├── update materialized state
          │
          └── fan out to live subscribers
```

The persisted event log is canonical for replay/audit.

Live subscribers are an optimization.

## Watchdog

The watchdog periodically checks only liveness/recovery concerns:

- worker idle without required report,
- blocked worker,
- delivery not acknowledged,
- session disconnected,
- pane gone,
- stale active dispatch,
- future workflow node timeout.

Normal progression is event-driven.

## Scheduler

The native time scheduler is a loop inside `woofd`, not a separate process or shell cron.

```text
schedule mutation / worker lifecycle event / timer
          │
          ▼
   scheduler loop (woofd)
          │
          ├── claim occurrence + advance schedule (one transaction)
          │
          └── message → mailbox    dispatch → existing dispatch path
```

- The loop sleeps until the earliest due time or retry (capped at 30 s to bound wall-clock jumps) and wakes early on schedule changes and worker lifecycle observations, rather than polling on a fixed interval.
- External calls run off the loop in tracked background tasks.
- Actions use the existing message and dispatch paths, so delivery, wakeup and settlement rules are unchanged.
- The watchdog is unchanged; it does not drive schedules.
- `woofd --scheduler=false` keeps schedules durable but does not fire them.

See [scheduler.md](scheduler.md).

## Worktree model

Phase 1 must not force "one worktree per worker".

A worker can be started:

- in an existing workspace/pane,
- in an existing worktree,
- in a new tab of the current workspace.

Phase 2 workflows may own one workspace/worktree shared by multiple role workers.

This is an explicit design requirement.
