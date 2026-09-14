# Observability and future interfaces

## One source of run meaning

The engine exposes current state and incremental updates. Herdr, Claude Code,
logs, a future TUI, and a future Web UI consume that contract. Consumers must not
infer stages or success by reading prompts, scraping terminals, or interpreting
UI labels. Observability works when the Herdr Woof plugin is absent.

## Snapshot contract

A snapshot needs enough information to answer what is happening, who owns the
work, what is waiting, and how the run can end:

| Area      | Required information                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Identity  | Run ID, workflow identity/version, project context, schema version and snapshot revision.                                         |
| Progress  | Run status, current stage/visit/attempt, round counters, start/update/completion times.                                           |
| Agents    | Logical name, role, kind/model, runtime target, session identity when available, current assignment and observed lifecycle state. |
| Control   | Gate outcomes, active limits and consumed counters, retries and format repairs.                                                   |
| Attention | Block reason, owning agent, required action, failure or exhaustion reason.                                                        |
| Outputs   | Accepted artifact references by visit, latest accepted result and terminal envelope when present.                                 |
| Liveness  | Whether the run owner is reachable and whether runtime observation is current.                                                    |

Do not place whole review or research bodies in every snapshot. References let
consumers retrieve the canonical artifact when needed.

## Event contract

Expose run admission and termination, agent assignment and lifecycle changes,
stage/attempt start and completion, artifact acceptance, submission rejection,
format repair, work retry, gate evaluation, blocking/unblocking, cancellation,
limit exhaustion, and observation loss/recovery.

Each event carries schema version, run identity, timestamp and a monotonic
per-run sequence. Include agent, stage, visit and attempt identity where relevant.
Event names are an API design choice; the required facts are independent of their
spelling.

A consumer must be able to obtain a snapshot and continue with later updates
without missing transitions between those operations. Define duplicate handling,
reconnection and a stale-cursor response. A bounded replay window with an explicit
resnapshot path is sufficient; indefinite event retention is not implied.

Publish state changes only after they are recorded. A journal/reducer design is
recommended if it can reproduce the snapshot exactly. Otherwise document the
actual authoritative state and test snapshot/event consistency rather than
claiming event replay that the stored data cannot support.

Herdr exposes a snapshot and event subscriptions for runtime clients. Its runtime
events are inputs to the SDK; Woof supplies workflow events such as review gates
and repair rounds. [Herdr socket API](https://herdr.dev/docs/socket-api/).

## Human-facing projection

The Herdr adapter can publish role, model, task, workflow, stage, round, and state
metadata. A useful display might read:

```text
builder · configured model
task-123 · build-review · repair · round 2
working
```

Metadata is a view of the engine state. Losing a sidebar update cannot change a
gate decision. Keep visual layout and keybindings in the host's presentation
layer, and keep notification delivery separate from event generation. Attention
should focus on blocks, failures and completion rather than every activity change.

## TUI readiness

The future TUI needs run listing, snapshots, incremental updates, artifact
retrieval, and defined control operations such as cancellation. It should be
possible to build it without modifying workflow definitions. No TUI, Web UI,
rendering library, WebSocket server, or specific database is required now.

Verify this with an external consumer that follows an active run, disconnects,
reconnects, and reaches the same visible state as a fresh snapshot. Include a
blocked run and a terminated runtime, not just successful completion.

## Implemented now (p2)

Real shipped behavior for run snapshots, events and runtime observation — not
design intent. Source: `src/state/snapshot.ts`,
`src/observe/{cursor,events,subscribe}.ts`,
`src/runtime/{adapter,tracker,overlay}.ts`, and `woof run show`
(`src/cli.ts`).

- **Snapshot shape.** `readSnapshot(runDir)` / `woof run show <run-dir>`
  return a `RunSnapshot` (`schemaVersion: 1`, `kind: "woof.run.snapshot"`):
  `runId`, `revision` (seq of the last complete journal record), `cursor`,
  `journal {records, tailPending}`, `workflow` (`null` for plan-less runs),
  `status`, `openedAt`/`updatedAt`, `outcome` (`null` until termination),
  `limits` (`null` for plan-less runs), `counters`, `agents[]` (identity,
  latest assignment, active open attempt, `runtime: null` unless overlaid),
  `stages[]` (per stage, per visit, per attempt: status, delivery,
  rejection counts by reason, and the accepted artifact reference if any),
  `attention.ambiguousDeliveries`, `outputs.latestAcceptedByStage`,
  `liveness`, and `integrity.artifacts` (`"unchecked"` by default). It never
  embeds artifact bodies or review/research prose, only references.
  `readSnapshot` takes no journal lock and works after a run has ended.
  `run_dir_invalid` now means only that the journal is missing or holds no
  records. `readSnapshot` and `readEvents` both re-read the journal when its
  line 1 changes during a read, at most three reads in all; if line 1 still
  changed on the third read, they return the distinct reason
  `journal_replaced` ("the journal's line 1 changed during each of 3
  consecutive reads") rather than `run_dir_invalid`. `woof run show` exits
  `3` for any of the three: `{"outcome":"rejected","reason":"run_dir_invalid"
| "journal_corrupt" | "journal_replaced",…}`.

- **An event is its journal record, one-to-one.** A `RunEvent`
  (`schemaVersion: 1`, `kind: "woof.run.event"`) carries the same `type`
  name as its journal record, a `subject` (agent/stage/visit/attempt, where
  applicable — a `submission.duplicate`'s subject is resolved from the
  acceptance record it names), and `data` (the record's own fields, minus
  the four journal/event metadata fields `schemaVersion`, `seq`, `ts` and
  `type`). There are no synthetic events: `readEvents` and
  `subscribeEvents` project the journal directly, so an event and its
  record can never drift apart. `foldEvents` does not trust an incoming
  event's `subject`: it recomputes the canonical subject from the parsed
  record (for a duplicate, from the acceptance it names) and fails closed
  with `journal_corrupt` when the two differ — with or without a base, and
  for a repeated seq as well as a new one.

- **Cursor `v1.<seq>.<anchor>`.** `anchor` is the first 12 hex characters of
  sha256 over journal line 1 (the `run.opened` bytes). A cursor whose
  anchor does not match the journal at that path belongs to another run
  (`cursor_foreign`); a seq past the current head means the journal was
  truncated or replaced (`cursor_ahead`); a cursor that does not parse is
  `cursor_malformed`. `cursor_expired` is reserved for when the journal can
  be compacted — p2 never compacts, so it is never produced.

- **Every resync reason means "take a fresh snapshot."** Each
  `CursorProblem` (`cursor_ahead | cursor_foreign | cursor_malformed |
cursor_expired`) and every `subscribeEvents` `resync_required` item
  carries one of them. There is no partial-recovery path — only resnapshot
  and resubscribe.

- **At-least-once delivery across reconnects.** Within one `subscribeEvents`
  call, each seq is yielded exactly once, in order. Across a dropped and
  resumed subscription (a fresh call from a stored cursor) delivery is
  at-least-once, not exactly-once: a consumer that stores the cursor of the
  last event it handled and dedupes by `seq` cannot miss or double-apply a
  transition. `foldEvents(base, events)` (`RunProjection = {snapshot,
records}`) is the proof of this by construction: it re-derives the
  snapshot from the kept record list with the same reducer (there is no
  second reducer). For every event it first checks the envelope itself —
  `schemaVersion !== 1` or `kind !== "woof.run.event"` is `journal_corrupt`,
  before its cursor is even read. With no base, an envelope `runId` other
  than the first `run.opened` event's `data.runId` is also `journal_corrupt`,
  and — with or without a base — any `data.runId` naming a different run is
  `journal_corrupt` too. A foreign anchor (another run at the same path) is
  `resync_required`; once the anchor matches, a cursor whose seq does not
  equal the event's own seq is `journal_corrupt`. An event's `data` carrying
  one of the envelope fields (`schemaVersion`, `seq`, `ts`, `type`), an event
  that does not otherwise parse as a valid record, or one the reducer
  refuses as an impossible transition, is `journal_corrupt` — matching
  `readJournal`'s own fail-closed behavior. A repeated seq at or below what
  is already folded is skipped only when it is the identical record already
  held there; a conflicting repeat is `journal_corrupt`, not a silent
  overwrite. Only a genuine gap in `seq` past the kept records, or folding
  with no base and no events at all, is `resync_required`.

- **Tail-pending semantics.** A snapshot or event read never takes the
  journal lock; a final journal line without its trailing newline (a write
  in flight) is excluded and reported as `journal.tailPending: true` /
  `readEvents`' `tailPending: true`, using the previous complete revision.
  A live subscription that sees the same torn tail persist for
  `tornTailGraceMs` (default 2000 ms) performs exactly one **locked**
  `readJournal`: under the lock no append is in flight, so a line still
  torn there is persisted corruption (`error/journal_corrupt`), not a slow
  writer. This applies before any event is yielded, too: a partial first
  `run.opened` line (the journal has been created but its first line is
  still being written) is normally a write in flight, but if it stays torn
  past the same grace period the subscription ends with
  `error/journal_corrupt` rather than waiting forever. A subscription also
  detects the journal being replaced at its
  path — an inode change (rename into place) or a changed line 1 at the
  same inode, including at identical length — via a device/inode and
  line-1-bytes check on every incremental read, ending with
  `resync_required/cursor_foreign` instead of silently mixing two runs'
  records. It does not detect an in-place rewrite that keeps the same inode
  and the same line 1 while replacing later bytes with a different valid
  continuation.

- **Subscription startup.** `subscribeEvents` waits — polling, never
  failing — while the run directory or its journal does not exist yet (an
  ENOENT on either is "not created yet"). It ends at once with
  `{type: "error", reason: "run_dir_invalid"}` only when the failure can
  never resolve on its own: the run-directory path exists but is not a
  directory, or inspecting it or the journal path fails for any other
  reason (`EACCES`, `EPERM`, `ENOTDIR`). If the very first read (before any
  event is yielded) finds the journal's line 1 already changed — a fresh
  subscription racing a replacement — it ends with
  `resync_required/cursor_foreign` rather than waiting or retrying.

- **`liveness.owner` is always `"unhosted"` in p2.** There is no run-owner
  process to be reachable, so every snapshot says so explicitly rather than
  claiming `"active"`. `liveness.runtime` stays `"not_observed"` in every
  derived snapshot; only an explicit, non-journaled overlay step
  (`overlayRuntime`) can report `"observed"`, and only when it actually laid
  an observation over at least one agent. `overlayRuntime` uses an
  agent's last tracked observation only when the assignment's `terminalId`
  is null or equals the observation's terminal; otherwise that agent's
  `runtime` stays `null` and the agent is listed in the result's `skipped`
  (`{agentId, runtimeName, assignedTerminalId, observedTerminalId}`) instead
  of being silently overlaid with another terminal's occupant.

- **`--verify-artifacts`** (`woof run show --verify-artifacts`,
  `readSnapshot(runDir, {verifyArtifacts: true})`) re-hashes every accepted
  copy against its journal record and reports `integrity.artifacts =
{checked, altered: [{receiptId, acceptedPath, problem}]}`. This detects
  tampering or loss after acceptance; it does not prevent it (same-user
  write access to `accepted/` is unchanged), and a downstream consumer that
  must trust an artifact before use still has to verify it itself (phase
  3).

- **Runtime observation is pull-based and lossy.** A runtime adapter's
  `observe`/`waitFor` return point-in-time samples; transitions between two
  reads are never seen. An observation tracker classifies each new sample
  against the last one for that runtime name as `new`, `duplicate`
  (identical terminal, sequence, lifecycle and raw status), `stale` (a
  lower sequence number, or an equal one with a lower revision — but only
  within the same _known_, non-null terminal id), or `replaced` (the pane's
  terminal id changed — the occupant changed and is surfaced, never merged
  into the old occupant's history). An unknown terminal id on either side
  is never `stale`: sequence and revision comparison is skipped and
  classification falls back to receipt order (`new` unless the terminal,
  lifecycle and raw status all repeat, which is `duplicate`). A bounded
  watch helper yields only `new`/`replaced` items and exposes
  dropped-stale/dropped-duplicate counts. None of this is
  journaled, and none of it affects a derived snapshot.

- **Not covered yet (documented, not silently missing):** gate evaluation,
  blocking/unblocking and delivery reconciliation. Related domain _result
  shapes_ exist (`GateResult`, `GateDecision`, `BlockInfo`,
  `DeliveryResolution`), but their journal record types, writers, readers,
  events and behavior are not implemented — no p2 code path parses, writes,
  reads or emits a `gate.recorded`, `run.blocked`, `run.unblocked` or
  `delivery.reconciled` record. Also not covered: agent runtime lifecycle
  changes (overlay only, never an event), format repair and work retry (no
  loop exists yet), a cancellation request distinct from plain termination,
  and observation loss/recovery (needs a run owner, which does not exist in
  p2).
