# Acceptance Criteria

Phase 1 verified on 2026-10-03. Every checked item is backed by the Woof-specific
tests, final command results or live scenarios in [verification.md](verification.md).
Linux cross-build passed; Linux runtime remains unverified. Optional file
projections are deferred and not required for this core acceptance.

## Phase 1 core

### Daemon and session registry

Evidence: verification ownership/session tests, final CLI integration, live scenarios 1, 7 and 8.

- [x] Only one `woofd` instance owns the main database.
- [x] Starting/attaching a second Herdr session does not start a second long-lived Woof daemon.
- [x] Multiple Herdr sessions can be registered concurrently.
- [x] Restarting `woofd` preserves state.
- [x] Live sessions reconnect after daemon restart.
- [x] Dead sessions become visible as offline/stale rather than silently disappearing.

### Database

Evidence: verification persistence tests and daemon ownership tests; clients use RPC only.

- [x] There is one canonical SQLite DB.
- [x] All session/workspace/run/worker scope is represented in rows.
- [x] Only `woofd` writes the DB.
- [x] Events are append-only and have a monotonic replay cursor.

### Profiles

Evidence: verification profile tests, metadata-only roster integration and live scenario 1.

- [x] Profiles are loaded from one global config.
- [x] Each profile supports at least:
  - name,
  - agent,
  - raw args,
  - description,
  - tags.
- [x] Multiple workers can use the same profile.
- [x] `woof profile roster --json` exposes metadata usable by a lead.
- [x] Phase 1 does not require a generic provider/model/effort mapper.

### Workers

Evidence: verification identity/adoption, existing-pane, settlement and protected-release tests; live scenarios 6, 7 and 10.

- [x] Workers have stable Woof IDs.
- [x] Messages and dispatches address Woof worker IDs/names, not pane IDs.
- [x] Pane references may be reconciled after restart.
- [x] Worker start can target an existing workspace/cwd/worktree.
- [x] Worker release protects unsaved work unless explicitly forced.
- [x] A worker becoming idle does not by itself mark work complete.

### Messaging

Evidence: verification inbox/ask/reply/broadcast tests; live scenarios 3, 4 and 5.

- [x] Messages are persisted before delivery attempt.
- [x] `ask` / `reply` works durably.
- [x] Agent-to-agent messaging always passes through Woof.
- [x] Ambiguous worker names fail rather than route unpredictably.
- [x] Delivery/wakeup state is observable.

### Events and monitoring

Evidence: replay/reconnect/slow-reader tests, active-follower integration and live settlement waits.

- [x] `woof events follow` streams events.
- [x] `--since <seq>` replays missed events.
- [x] `woof wait` blocks until a selected event occurs or timeout.
- [x] No agent needs to inspect SQLite directly.
- [x] Optional file monitor projection, if implemented, is rebuildable and non-canonical — not implemented; caller-owned artifacts are references, not projections.

### Watchdog

Evidence: verification escalation and held-recovery tests; live scenarios 2 and 10 ran with the watchdog disabled.

- [x] Idle worker with active dispatch and no report is nudged/escalated.
- [x] Blocked workers are surfaced.
- [x] Missing panes are reconciled.
- [x] Watchdog is not required for normal happy-path progression.

### Mutation safety

Evidence: verification uncertainty/crash-boundary tests and inspected, explicitly resolved live launch in scenario 9.

- [x] Reads/subscriptions may reconnect safely.
- [x] Mutations are not blindly replayed after uncertain transport failure.
- [x] Clients can query resulting state after an uncertain outcome.

## Phase 2 readiness

Phase 1 is considered workflow-ready when:

Evidence: shared-run/worktree and adhoc membership tests, scoped event replay and the inspected schema. A focused time scheduler (`schedules`, `schedule_runs`; schema version 2) was explicitly authorized on 2026-10-04; no workflow/node/edge tables or task-DAG constraints were added.

- [x] run records can own/refer to workspace/worktree,
- [x] workers can persist for the lifetime of a run,
- [x] messages/events are run-scoped,
- [x] one run can coordinate multiple workers in one worktree,
- [x] event subscriptions can observe one run,
- [x] no Phase 1 schema forces workflow transitions to be an acyclic task DAG.

## Native time scheduler (authorized 2026-10-04)

Behavior is specified in [scheduler.md](scheduler.md). This is a time trigger, not the Phase 2 workflow engine.

Evidence: pending final verification.

- [ ] Recurring cron and `@every` schedules support add, list, show, enable, disable, remove, manual run and history.
- [ ] Timezone, DST (nonexistent and repeated times) and missed-run behavior are defined and tested.
- [ ] Schedules live in the single daemon and database; v1 to v2 migration is transactional and safe.
- [ ] Targets are stable worker IDs resolved in validated scope; no pane targets and no silent retargeting.
- [ ] Messages and dispatches use Woof's durable paths; dispatch settlement is unchanged (report plus turn end).
- [ ] Occurrences are claimed atomically with a durable occurrence identity; concurrent, manual and restart paths never claim one twice.
- [ ] Uncertain outcomes are inspectable and never resent.
- [ ] Busy, offline and blocked target behavior is explicit and never interrupts a busy agent.
- [ ] CLI/RPC reads are scoped, support JSON and history, and schedule events are append-only.
- [ ] The TUI shows a schedules view.
