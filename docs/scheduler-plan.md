# Native time scheduler: donor-to-Woof adaptation plan

Scope authorized on 2026-10-04: a focused time scheduler inside the global
`woofd`. This is not a workflow engine, task DAG or Life OS-specific scheduler.

## Donor inventory (herdr-orch, MIT, Stephen Ellington)

| Donor | What it does | Woof decision |
| --- | --- | --- |
| `internal/daemon/schedule.go` | `cron.ParseStandard` (robfig/cron v3, MIT) + `schedule.add/list/rm/run/enable`; `fire` stamps, runs, finishes | Keep op set and semantics (add/list/remove/enable/disable/manual run/history). Replace action layer and firing. |
| robfig/cron `parser.go`, `spec.go` | 5-field cron, names, ranges/steps, descriptors, `@every`, `TZ=` prefix, DOM/DOW OR rule | Port the field parser (attributed) into `internal/schedule`. Replace `Next` with a civil-time search using explicit DST rules. Fix the `TZ=` without-space panic and the zero-time "never fires" loop. |
| `internal/store/schedules.go` + DDL | `schedules`, `schedule_runs`; `StartScheduleRun` = two separate statements | Use Woof record tables (`schedules`, `schedule_runs`) through schema migration 2. Claim, history row and schedule advance commit in **one** transaction with a unique `(schedule_id, occurrence_key)` index. |
| `internal/daemon/server.go` loop | 15 s poll, serial synchronous fire on the ticker goroutine | Event/timer-driven loop: sleeps until the earliest due time or retry, woken early by schedule mutations and worker lifecycle observations. External calls run off the loop in tracked background tasks. |
| `cmd/horch/main.go` | `schedule add --cron (--horch ... | --prompt-to --prompt)`, JSON-only | `woof schedule add/list/show/history/enable/disable/remove/run` with `--json`, scope flags and request-ID receipts. |
| `TestScheduleHorchAction` | runs a child CLI, checks history, rejects bad cron | Adapted as `TestScheduleManualRunHistoryAndInvalidCron` (Woof message action instead of a child process), then extended. |

## Mismatches fixed rather than copied

- **Action layer.** Donor `prompt` calls `agent.prompt` on a Herdr target and
  `horch` executes a child CLI. Woof actions are only `message` (durable Woof
  message through the mailbox) and `dispatch` (tracked dispatch through the
  existing dispatch path). No Herdr prompt injection, no child processes.
- **Targets.** Donor targets a Herdr name/pane. Woof resolves the name once at
  creation within the validated session/workspace and stores the logical worker
  ID. Later alias reuse never retargets the schedule.
- **Non-atomic stamping.** Replaced by one claim transaction (occurrence row +
  intent + schedule advance + event). Concurrent loop/manual/restart claims meet
  the unique occurrence index.
- **Next computed from fire time.** Donor drifts (`next = Next(now)`). Woof cron
  series are wall-clock aligned; `@every` is anchored (`anchor + n*interval`).
- **Disabled schedules overwritten / impossible specs firing forever / silent
  failures.** Explicit validation, persisted history for every outcome.

## Occurrence model

`schedule_runs` row = durable occurrence identity. Keys: `t:<unix-ms>` for time
occurrences, `manual:<request-id>` for manual runs, `missed:<unix-ms>` for a
coalesced missed range.

States: `persisted` (message action committed atomically with the claim),
`claimed` → `dispatching` → `dispatched` | `uncertain` | `failed`, `blocked`
(no external effect; retried), `missed`, `cancelled`; a dispatch occurrence
follows its dispatch to `settled`/`failed`. Overlap is coalesced onto the
outstanding occurrence (`skipped_count`) rather than stored as rows (review fix).

Dispatch execution: each attempt has its own operation receipt. The existing
dispatch intent transaction links the receipt to the dispatch before any prompt.
A receipt without a linked dispatch proves no prompt was sent (safe retry). A
linked dispatch in `sending`/`uncertain` is surfaced as `uncertain` and never
resent; operators resolve it with the existing `operation resolve` flow.

## Implementation slices (separate commits)

1. Plan (this file).
2. `internal/schedule`: parser, DST-aware next-time, `@every`, missed-range enumeration, tests.
3. Store migration 2 (tables, indexes, selectors) + v1→v2 migration test.
4. Daemon schedule ops, claim/execute/recover loop, kick hooks, `woofd --scheduler`.
5. Daemon tests (deterministic clock): due/not due, enable/disable/remove/manual,
   missed, duplicate claims, restart recovery, busy/offline/stale identity,
   uncertain delivery, two-session isolation.
6. CLI, client read set, help, integration scenario.
7. Docs: `docs/scheduler.md`, README, usage skill, provenance, notices, acceptance.
8. Independent review fixes.

## Shared contract

Model: `model.Schedule`, `model.ScheduleRun` (`internal/model/model.go`).
`Message.ScheduleRunID` and `Dispatch.ScheduleRunID` record provenance.

RPC ops (scope = normal Woof request scope):

| Op | Kind | Args |
| --- | --- | --- |
| `schedule.add` | mutation | `name`, `to`, `cron` (5-field, descriptor or `@every D`), `timezone`, `missed` (`latest`\|`skip`), `body`+`subject` (message) or `spec`+`handoff` (dispatch), `disabled` |
| `schedule.list` | read | `all` (include removed) |
| `schedule.show` | read | `id` (ID or name in scope) → `{schedule, upcoming[], runs[]}` |
| `schedule.history` | read | `id`, `limit` → runs newest first with linked message/delivery/dispatch |
| `schedule.enable` / `schedule.disable` / `schedule.remove` | mutation | `id` |
| `schedule.run` | mutation | `id` → manual occurrence (executed synchronously) |

CLI: `woof schedule add --name N --to WORKER (--cron EXPR | --every DUR) [--tz ZONE]
(--body TEXT [--subject S] | --spec TEXT [--handoff PATH]) [--missed latest|skip]
[--disabled]`; `woof schedule list [--all]`, `show ID`, `history ID [--limit N]`,
`enable ID`, `disable ID`, `remove ID`, `run ID`. `--every 30m` sends
`cron: "@every 30m"`.

Events: `schedule.created`, `schedule.enabled`, `schedule.disabled`,
`schedule.removed`, and occurrence events `schedule.run.<state>` for
`persisted`, `claimed`, `dispatching`, `dispatched`, `uncertain`, `failed`,
`blocked`, `skipped` (coalesced overlap), `missed`, `cancelled`, `settled`. Scope: schedule session/workspace,
target worker (and its worktree), plus the dispatch run when known.
