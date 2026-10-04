# Native time scheduler

Woof schedules durable messages and tracked dispatches to stable logical
workers. The scheduler runs inside the one global `woofd`, persists in the one
SQLite database (schema version 2), and is the only writer of its state. There
is no shell cron, per-session daemon or Life OS-specific scheduler. It is a
time trigger, not a workflow engine: one schedule fires one action at one worker.

Adapted from herdr-orch's scheduler (MIT); see
[`scheduler-plan.md`](scheduler-plan.md) for the donor-to-Woof adaptation.

## Commands

```sh
woof schedule add --name brief --to alice --cron "0 9 * * MON-FRI" --tz Europe/Warsaw \
  --body "Prepare the morning brief"
woof schedule add --name review --to reviewer --every 6h --spec "Review open PRs" --missed skip
woof schedule list [--all] | show ID | history ID [--limit N]
woof schedule enable ID | disable ID | remove ID | run ID
```

`ID` is a schedule ID (`sched_...`) or an active schedule name in the selected
scope. Every command accepts `--json` and the normal scope flags
(`--session`, `--workspace`, ...; explicit flags override inferred `WOOF_*`
context). Reads (`list`, `show`, `history`) are side-effect free and reconnect
safely. Mutations use request-ID receipts; an uncertain transport outcome
returns the operation ID and must be inspected with `woof operation show`, not
resent.

## Scope and target identity

`schedule add` requires a validated session and workspace. `--to` is resolved
once, at creation, within that workspace (ambiguous names fail). The schedule
stores the worker's Woof ID; it never stores or targets a Herdr pane. If the
worker is later released and a new worker reuses the alias, the schedule keeps
targeting the original (now terminal) worker and reports `target_terminal`
until it is disabled or removed. An explicit worker ID from another session or
workspace is refused (`invalid_scope`).

`list` is scoped like other Woof reads: a worker caller without explicit scope
sees schedules that target it (its inferred run/worktree do not narrow the
list); pass `--workspace`/`--session` or `--global` to
see more. `show`/`history`/mutations of a schedule outside the selected
session/workspace return `not_found`.

## Expressions

- Five-field cron: `minute hour day-of-month month day-of-week`. Lists, ranges,
  steps, `*`/`?`, month and weekday names (`JAN`, `MON-FRI`), weekday `0` or `7`
  for Sunday. When both day fields are restricted, a day matching either fires
  (classic cron OR rule).
- Descriptors: `@yearly`/`@annually`, `@monthly`, `@weekly`, `@daily`/`@midnight`,
  `@hourly`.
- `@every DURATION` (`--every 30m`), minimum 1s. The series is anchored at
  creation (or re-enable) time: `anchor + n × interval`. Elapsed time, so DST
  does not shift it.
- An optional `TZ=Zone ` / `CRON_TZ=Zone ` prefix is accepted for donor
  compatibility; it must agree with `--tz`.
- Expressions that never fire (for example `0 0 30 2 *`) are refused at creation.

## Time zones and daylight saving

Each schedule stores one IANA zone. `--tz` sets it; otherwise the daemon's zone
(`$TZ`, then the `/etc/localtime` link, then `/etc/timezone`, then `UTC`) is resolved and persisted at
creation, so later host changes do not move the schedule. Zone rules come from
the Go embedded time zone database, identical on every host.

Cron fields describe local wall-clock times in that zone:

- **Nonexistent time (spring forward):** a wall time inside the gap fires once,
  at the instant the clocks jump (for `30 2 * * *` in New York on 2026-03-08:
  03:00 EDT, 07:00Z).
- **Repeated time (fall back):** a wall time that occurs twice fires once, at
  its first occurrence. `0 * * * *` therefore fires once in the repeated hour.
- `@every` ignores wall clocks.

Persisted timestamps are UTC Unix milliseconds (`next_run_at`,
`scheduled_for`, ...). The `*_local` fields add RFC 3339 text with the UTC
offset in the schedule zone, for display only.

## Occurrences and history

Every occurrence is a durable `schedule_runs` row with a unique
`(schedule_id, occurrence_key)` (`t:<ms>` for time, `manual:<request-id>`,
`missed:<ms>`). The daemon claims an occurrence, records its intent and
advances the schedule in one transaction. Claims are serialized by the single
writer and re-check the schedule's due time inside the transaction; an
occurrence key that already exists (for example after a clock step back and
re-enable) is never claimed again, and the schedule still advances. The unique
index is a backstop. This is an at-most-one-claim guarantee per occurrence
key, not an exactly-once delivery claim.

| State | Meaning |
| --- | --- |
| `persisted` | Message action: the Woof message and its delivery were committed with the claim. Delivery/wakeup progress lives on the delivery; a delivered message is not completed work. |
| `claimed` | Dispatch action recorded; no attempt yet. |
| `dispatching` | An attempt receipt exists; a prompt may be in progress. |
| `dispatched` | The dispatch prompt was accepted and the dispatch has not finished. |
| `settled` | The dispatch settled: an explicit `done` report **and** matching turn-end evidence. `reason` is the reported outcome (`done` or `failed`). |
| `uncertain` | The dispatch prompt outcome is unknown. Never resent; inspect `dispatch show` and `operation show`, then resolve explicitly with `operation resolve`. |
| `failed` | Certain failure: the prompt was refused, the dispatch was failed or resolved as failed, or the target was invalid. |
| `blocked` | Nothing was sent; the reason is recorded and the attempt is retried. |
| `missed` | Coalesced occurrences that came due while the daemon was not running. |
| `cancelled` | A `claimed` or `blocked` occurrence when the schedule was disabled or removed. |

A dispatch occurrence follows its dispatch: the transaction that settles or
fails the dispatch also moves the occurrence to `settled`/`failed` and emits
the event. Resolving an uncertain attempt as `failed` frees the worker and
fails the occurrence; it is not retried, and the next occurrence starts fresh.
Resolving as `completed` records that the prompt landed, but the dispatch keeps
waiting for a report and turn end, so later occurrences stay blocked by
`dispatch_active` until it settles or is failed.

Overlap is coalesced: while an occurrence is `claimed`, `dispatching` or
`blocked`, later due times increment its `skipped_count`/`skipped_last` and
emit `schedule.run.skipped` instead of adding rows or queueing work.

`schedule history` lists occurrences newest first and joins the current
message, deliveries, dispatch and attempt receipt. `schedule show` adds the
next five occurrences. Events are append-only: `schedule.created`,
`schedule.enabled`, `schedule.disabled`, `schedule.removed` and
`schedule.run.<state>` (including `schedule.run.skipped` for coalesced
overlap), scoped to the schedule's session, workspace and target
worker (plus the dispatch run when known), so `woof events follow` and
`woof wait --events schedule.run.dispatched` observe them.

## Missed runs

The loop sleeps until the earliest due time or retry and wakes early for
schedule changes and worker lifecycle events. When it finds occurrences
already past (daemon stopped, machine asleep):

- `--missed latest` (default): fire the most recent past occurrence once, late;
  record all earlier ones as one `missed` row (`missed_count`, first and last).
- `--missed skip`: fire the most recent occurrence only if it is at most one
  minute late; otherwise record every past occurrence as one `missed` row.

The next occurrence is always the first one after now. Re-enabling a disabled
schedule starts a fresh series; disabled periods are not caught up.

## Busy, offline and blocked targets

- **Message action.** The message is persisted and queued in the worker's
  mailbox even when the worker is busy, offline or unverified; the existing
  safe prompt lane wakes it only when idle, interactive and verified. A busy
  agent is never interrupted. A terminal target blocks the occurrence
  (`target_terminal`).
- **Dispatch action.** The existing dispatch path is used unchanged: it
  requires a live verified attachment, an idle interactive agent, an empty
  prompt and no active or unresolved dispatch. When a precondition fails the
  occurrence becomes `blocked` with the refusal code (`worker_busy`,
  `dispatch_active`, `stale_attachment`, `subscription_not_ready`, ...) and
  nothing is sent. Offline/lost/terminal workers are recorded as
  `target_unavailable`/`target_terminal` without an attempt.
- Blocked occurrences retry with a backoff that grows with their age (30 s up
  to 15 min) and immediately when the target worker is observed idle. They stay visible until
  they run or the schedule is disabled/removed (→ `cancelled`).
- Starting stopped workers, granting permissions and answering startup dialogs
  are out of scope; the schedule only uses existing logical workers.

## Attempts, uncertainty and restart

Each dispatch attempt has its own operation receipt (`op: schedule.dispatch`).
The dispatch intent transaction links that receipt to the dispatch before any
prompt is sent. On restart, an interrupted attempt is classified from that
evidence:

- receipt without a linked dispatch → no prompt can have been sent →
  `blocked`, retried promptly;
- linked dispatch still `sending`/`uncertain` → `uncertain`, never resent (the
  watchdog also escalates the dispatch);
- linked dispatch active or settled → `dispatched`.

A `schedule run` request replayed with the same request ID returns its
receipt, which records the claimed occurrence; read the live outcome with
`schedule history`.

`woofd --scheduler=false` keeps schedules durable but does not fire them.

## Compatibility

The donor's `prompt` (direct Herdr `agent.prompt`) and `horch` (child CLI)
actions are deliberately not ported. A database migrated to schema version 2
is refused by older Woof binaries ("schema version 2 is newer"); back up
`woof.db` before upgrading if a rollback may be needed.
