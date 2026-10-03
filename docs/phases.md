# Implementation Phases

## Phase 0 — Reference inspection

Before coding:

1. inspect local `herdr-orch`,
2. inspect local `herdr-projects`,
3. document candidate code to port/adapt,
4. identify assumptions tied to their current architectures.

Do not start by rewriting everything from memory.

## Phase 1 — Core runtime

Goal: replace the current Woof core with a durable global coordination layer.

Deliver:

- Herdr plugin manifest/bootstrap,
- one global `woofd`,
- one global SQLite database,
- Unix socket RPC,
- session attach/register,
- SessionManager for multiple live Herdr sockets,
- reconnect/reconciliation,
- scope inference,
- worker lifecycle,
- profile config,
- profile roster,
- messages,
- ask/reply,
- durable event log,
- `events follow`,
- `wait`,
- dispatch tracking,
- completion settlement,
- watchdog,
- safe release/stop.

Port/adapt aggressively from `herdr-orch`.

Keep Phase 1 small enough to finish.

## Phase 1.5 — Operator UX

After the core works:

- board/TUI,
- selected Web UI pieces,
- worker/event/inbox views,
- optional NDJSON event projection,
- diagnostics/doctor.

Do not let UI work block runtime correctness.

## Phase 2 — Dedicated workflow engine

Add only after Phase 1 is reliable.

Required properties:

- workflow definitions are reusable,
- workflow runs are durable,
- engine is event-driven,
- watchdog handles liveness,
- no mandatory coordinator agent,
- persistent role workers,
- logical role → worker binding,
- structured node outputs,
- deterministic transitions,
- loops allowed,
- gates supported,
- invoking session can observe/control the workflow,
- one workflow may own one shared workspace/worktree.

Example:

```text
implement
   ↓
review
   ├─ approved → verify
   └─ changes_requested → implement

verify
   ├─ passed → done
   └─ failed → implement
```

Do not model this as a dependency DAG that forbids cycles.

## Phase 3 — Optional advanced features

Only if needed:

- cross-machine routing,
- smarter profile resolver,
- dynamic resource scheduling,
- richer Web UI,
- workflow libraries,
- external integrations.
