# Acceptance Criteria

## Phase 1 core

### Daemon and session registry

- [ ] Only one `woofd` instance owns the main database.
- [ ] Starting/attaching a second Herdr session does not start a second long-lived Woof daemon.
- [ ] Multiple Herdr sessions can be registered concurrently.
- [ ] Restarting `woofd` preserves state.
- [ ] Live sessions reconnect after daemon restart.
- [ ] Dead sessions become visible as offline/stale rather than silently disappearing.

### Database

- [ ] There is one canonical SQLite DB.
- [ ] All session/workspace/run/worker scope is represented in rows.
- [ ] Only `woofd` writes the DB.
- [ ] Events are append-only and have a monotonic replay cursor.

### Profiles

- [ ] Profiles are loaded from one global config.
- [ ] Each profile supports at least:
  - name,
  - agent,
  - raw args,
  - description,
  - tags.
- [ ] Multiple workers can use the same profile.
- [ ] `woof profile roster --json` exposes metadata usable by a lead.
- [ ] Phase 1 does not require a generic provider/model/effort mapper.

### Workers

- [ ] Workers have stable Woof IDs.
- [ ] Messages and dispatches address Woof worker IDs/names, not pane IDs.
- [ ] Pane references may be reconciled after restart.
- [ ] Worker start can target an existing workspace/cwd/worktree.
- [ ] Worker release protects unsaved work unless explicitly forced.
- [ ] A worker becoming idle does not by itself mark work complete.

### Messaging

- [ ] Messages are persisted before delivery attempt.
- [ ] `ask` / `reply` works durably.
- [ ] Agent-to-agent messaging always passes through Woof.
- [ ] Ambiguous worker names fail rather than route unpredictably.
- [ ] Delivery/wakeup state is observable.

### Events and monitoring

- [ ] `woof events follow` streams events.
- [ ] `--since <seq>` replays missed events.
- [ ] `woof wait` blocks until a selected event occurs or timeout.
- [ ] No agent needs to inspect SQLite directly.
- [ ] Optional file monitor projection, if implemented, is rebuildable and non-canonical.

### Watchdog

- [ ] Idle worker with active dispatch and no report is nudged/escalated.
- [ ] Blocked workers are surfaced.
- [ ] Missing panes are reconciled.
- [ ] Watchdog is not required for normal happy-path progression.

### Mutation safety

- [ ] Reads/subscriptions may reconnect safely.
- [ ] Mutations are not blindly replayed after uncertain transport failure.
- [ ] Clients can query resulting state after an uncertain outcome.

## Phase 2 readiness

Phase 1 is considered workflow-ready when:

- [ ] run records can own/refer to workspace/worktree,
- [ ] workers can persist for the lifetime of a run,
- [ ] messages/events are run-scoped,
- [ ] one run can coordinate multiple workers in one worktree,
- [ ] event subscriptions can observe one run,
- [ ] no Phase 1 schema forces workflow transitions to be an acyclic task DAG.
