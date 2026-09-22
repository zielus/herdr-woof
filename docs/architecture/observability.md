# Observability and future interfaces

## One source of run meaning

The engine exposes current state and incremental updates. Herdr, Claude Code,
logs and the Web UI consume that contract; a future TUI can do the same.
Consumers must not infer stages or success by reading prompts, scraping
terminals, or interpreting UI labels. Observability works when the Herdr Woof
plugin is absent.

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

The current publisher emits compact `$woof` and `$woof-role` pane tokens as
described in [plugin surfaces](../integrations/plugins.md). Separate kind, model,
stage and checkout tokens are [proposed but not implemented](../design/proposals.md).
Detailed inspection retains stage totals and round/attempt counters.

Metadata is a view of the engine state. Losing a sidebar update cannot change a
gate decision. Keep visual layout and keybindings in the host's presentation
layer, and keep notification delivery separate from event generation. Attention
should focus on blocks, failures and completion rather than every activity change.

## TUI readiness

The future TUI needs run listing, snapshots, incremental updates, artifact
retrieval, and defined control operations such as cancellation. It should be
possible to build it without modifying workflow definitions. No TUI, rendering
library, WebSocket server or specific database is required. The current Web UI
uses the same snapshot, event and cancellation contracts over local HTTP and SSE.

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

- **`liveness.owner` is always `"unhosted"` in p2** (p2; superseded by p4,
  see [Implemented now (p4)](#implemented-now-p4)). There is no run-owner
  process to be reachable, so every snapshot says so explicitly rather than
  claiming `"active"`. (p4 widens this to a real run-owner probe — see
  "Implemented now (p4)" below.) `liveness.runtime` stays `"not_observed"` in every
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
  3). Stronger `chmod` or `chflags` enforcement was rejected as friction, not
  as a same-user security boundary; Woof detects later changes instead.

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
  dropped-stale/dropped-duplicate counts. No sample is journaled, and none
  affects a derived snapshot. A Herdr sample is lossy, and journaling every
  poll would make replay depend on sampling cadence and wall clock. What the
  scheduler does journal is the _change_ between samples — see
  [Implemented now (activity records)](#implemented-now-activity-records).

- **The Herdr CLI runtime adapter and its scripted test double enforce
  narrow contracts.** `createHerdrCliRuntime`'s `inspect` runs only a
  read-only allowlist — `agent list`, `agent get <target>`, `pane get <id>`,
  `pane list` and `workspace list` — and refuses everything else as
  `invalid_request` without spawning. Its `waitFor` returns `unsupported`
  without spawning whenever the requested states include `gone` or `unknown`
  (Herdr cannot wait for either). `stop` gives up the closed pane's ownership
  immediately once `pane close` succeeds, before it even verifies the agent
  is gone. Any exit-0 Herdr response is treated as `protocol_error`, not
  success, unless it carries both a non-empty string request `id` and an
  object `result`. `createScriptedRuntime`, the deterministic in-memory
  double for the same contract shipped from the `herdr-woof/testing`
  subpath so a test double cannot be mistaken for a supported runtime, enforces
  its own edge cases: `advance`
  throws a TypeError for a negative or non-integer step count, construction
  throws a TypeError for an empty `afterDeliver` sequence (flat or nested),
  and a scripted `started` delivery is checked like the Herdr adapter's own —
  if the observation right after delivery is not `working` or `blocked`, the
  outcome is downgraded to `ambiguous/protocol_error` (the call is still
  logged as `sent`).

- **Gate evaluation, blocking/unblocking and delivery reconciliation are
  implemented (p3).** See "Implemented now (p3)" below for the snapshot and
  event shapes. A cancellation request distinct from termination, host
  lifecycle and observation loss/recovery are journaled too — see
  [Implemented now (lifecycle records)](#implemented-now-lifecycle-records).

## Implemented now (p3)

Real shipped behavior for the scheduler's snapshot/event additions and
terminal outcome — not design intent. Source: `src/state/{snapshot,
result}.ts`, `src/journal/control-records.ts`, `src/scheduler/driver.ts`.

- **`gates: SnapshotGate[]`** (ordered): each entry carries `seq, at, gate`
  (stage or check id), `kind: "stage"|"check"`, `subject` (the accepted
  submission it decided on), `decision: "pass"|"reject"`, `reason`, `verdict`
  (stage gates only), `round`, `next` (`{stageId}` or `{outcome}`),
  `revision` (the fresh repository fingerprint at record time), `reviewed`
  (the revision the accepted attempt was dispatched against, for a
  revision-bound stage gate; `null` otherwise) and `check` (the command,
  exit code, signal, timeout flag and evidence reference, for check gates
  only).
- **`attention.blocked: SnapshotBlocked | null`** — `{seq, agentId, reason,
requiredAction, since, observed, attempt}`, reachable and non-null exactly
  while a `run.blocked` is unresolved; this is the stated change from p2's
  "no always-null field" rule. `attention.ambiguousDeliveries` excludes any
  dispatch that has since been reconciled.
- **Attempt fields:** `cause: "initial"|"format_repair"|"work_retry"`
  (derived by the reducer from the previous attempt of the visit, never
  recorded directly); `dispatch: {seq, at, reason}|null`; `request:
{path, sha256, bytes}|null`; `target: {terminalId, sessionId}|null`;
  `revision: Revision|null` (the dispatch-time fingerprint); `reconciliation:
{seq, resolution, evidence, at}|null`; `rejectionLog` (every rejection
  journaled against the attempt, `owner_mismatch` included — the snapshot
  shape is unchanged; a format-repair request quotes this list minus any
  `owner_mismatch` entries, see
  [domain model](domain-model.md#implemented-now-p3)); `accepted.seq`/`outcome.seq`
  for correlating a gate to the acceptance and termination it followed.
- **New counters:** `rounds`, `gatesByDecision {pass, reject}`,
  `gatesByGate {id: n}`, `formatRepairsByVisit {"stage/visit": n}`,
  `workRetriesByVisit {"stage/visit": n}`, `blocks`, `reconciliations
{delivered, abandoned}` — alongside p2's existing counters.
- **`checks: string[] | null`** (the plan's declared engine-run check ids;
  `null` for a plan without any, a plan-less run, **and an explicit empty
  `checks: []`** — all three report `null`, never `[]`), `input:
{path, sha256, bytes} | null` (the run's persisted `input.json`, written
  `0444` on the still-open file descriptor with `fchmodSync` after write and
  `fsync` — the mode does not depend on the process umask), and
  `agents[].args: string[] | null` (resolved launch arguments) round out
  the run plan projected onto the snapshot.
- **`RunResult` (`deriveRunResult(snapshot, {runDir, repository})`, pure over
  the snapshot).** Terminal summary: `outcome, reason, limit, location,
repository {path, revision}, counters, blocked, artifacts
{completion, review, verification, lastAcceptedByStage}`. Every field is
  derived generically — no stage name appears in `deriveRunResult` itself:
  `artifacts.review` is the subject of the last stage gate that carried a
  `reviewed` revision, and is `null` on any outcome except `completed`, so a
  passing gate from an earlier revision is never reported as approval of
  newer work even though it stays visible in `lastAcceptedByStage`.
- **Per-key maps in results and snapshots are null-prototype objects.**
  `RunSnapshot.counters`' id-keyed maps (`visitsByStage`, `attemptsByVisit`,
  `rejectionsByReason`, `replacementsByAgent`, `gatesByGate`,
  `formatRepairsByVisit`, `workRetriesByVisit`) and `RunResult.artifacts.
lastAcceptedByStage` are built with `Object.create(null)` (`src/state/
reducer.ts`'s `dict()` helper, `src/state/result.ts`), so a stage id or
  reason such as `constructor` is always an ordinary own key, never shadowed
  by `Object.prototype`. Their JSON is identical to an ordinary object's, but
  `node:util.isDeepStrictEqual`/`assert.deepStrictEqual` compares prototypes
  too and reports a mismatch against a plain-object value with the same
  keys. Compare a `RunResult` or snapshot with a parsed CLI line or file in
  JSON form (`JSON.parse(JSON.stringify(...))`, or field-by-field), not with
  deep-strict equality.
- **The scheduler reads only what an observer reads.** `decide()` (D1) is a
  pure function of the same `RunSnapshot` that `readSnapshot`/`woof run
show`/`readEvents` project, so "an external observer agrees with the
  engine's state" holds by construction — there is no separate in-process
  state the scheduler consults instead.
- **`liveness.owner` stays `"unhosted"` for a foreground scheduler
  (unchanged).** `woof run build-review`/`--host foreground` run the
  scheduler in this process: a killed one leaves a non-terminal run, and the
  only resolution is `woof run cancel <run-dir>` (which records the
  termination a live scheduler would otherwise have written). p4 adds a real
  owner and liveness for `woof run start`'s pane-hosted runs — see
  "Implemented now (p4)" below; there is still no daemon or crash-resume
  path.

## Implemented now (p4)

Real shipped behavior for run-host liveness and the inspection CLI — not
design intent. Source: `src/host/{claim,probe,metadata}.ts`,
`src/state/snapshot.ts`, `src/inspect/{status,runs}.ts`,
`src/commands/{status,runs,events,config,doctor}.ts`.

- **`liveness.owner` widens to `"unhosted" | "alive" | "lost" | "exited"`.**
  `readSnapshot` probes `<runDir>/host.json` (the exclusive claim a run host
  creates once and never rewrites, with a heartbeat that touches its mtime
  every `heartbeatMs`, default 2000 ms) and `<runDir>/host-exit.json` (a
  second, separately exclusive marker a clean exit creates, which the probe
  applies first). No claim file and no marker is `"unhosted"`. A claim whose
  recorded host is this machine and whose pid is gone, or whose heartbeat is
  stale by more than 5× `heartbeatMs`, is `"lost"` (on a terminated run a
  merely stale heartbeat is `"exited"` instead, never `"lost"`). `host-exit.
json` is itself engine-owned: `woof run start` refuses `run_exists` for a
  run directory that already holds one, and its `pid` is a required positive
  integer. It completes a claim into `"exited"` only when it names the
  **same** pid as a `"hosting"` claim. A marker with no claim, an invalid or
  non-regular marker, or a marker next to a non-hosting (`"exited"`/
  `"abandoned"`) claim all fail closed as `"lost"`, `host: null`, with
  `liveness.claimProblem` naming the problem. A marker naming a **different**
  pid next to a live `"hosting"` claim does not override that claim: the
  probe reports the claim's own liveness (`"alive"` while its own heartbeat
  is fresh and its own pid lives, otherwise `"lost"`, never `"exited"`)
  alongside the same `claimProblem`, so a forged or stale marker next to a
  genuinely live host cannot make the host disappear. A claim or marker path
  that exists but does not parse (a torn write, a FIFO, a symlink) is
  re-read up to three times, 50 ms apart, before it counts. `deriveSnapshot`
  (no I/O) still always reports
  `"unhosted"`/`null`; only `readSnapshot`, which already does file I/O,
  probes. `RunSnapshot.liveness` is `{owner, runtime, host: HostInfo | null,
claimProblem?}`; `OverlaidSnapshot` keeps the same fields alongside its own
  `runtime: "observed"|"not_observed"`.
- **A `"hosting"` claim must carry everything `claimHost` writes to be
  valid.** `parseHostInfo` requires a positive integer `pid`, a non-empty
  `hostname`, a non-empty `startedAt` and a positive integer `heartbeatMs`
  for `state: "hosting"` — without any one of them nothing could tell a
  dead host from a live one, so the claim parses as invalid rather than as a
  host with an unknown pid. An incomplete hosting claim therefore reads
  `owner: "lost"`, `host: null`, with `liveness.claimProblem` "host.json
  exists but is not a valid run host claim" (after the usual re-reads),
  **never `"alive"`**. `"abandoned"` and `"exited"` claims still allow
  `pid: null`.
- **`woof status <run-dir> [--wait]`** (`src/inspect/status.ts`,
  `RunStatusView`) is the read-only wait primitive: `liveness`, the run's
  `activeAttempts`, `lastGate`, `attention`, `counters`, `config: {sha256} |
null` and `cursor`, plus `result` (`deriveRunResult`) once terminal.
  Without `--wait`: exit 0, or 3 on `run_dir_invalid|journal_corrupt|
journal_replaced`. With `--wait` (poll every `--poll-ms`, default 1000;
  `--timeout-ms`, default 540 000 — one Bash call stays under its own
  600 000 ms cap): a recorded terminal outcome always wins first (**0/4/5/6**
  completed/failed/exhausted/cancelled); otherwise an unresolved
  `attention.blocked` is **9** (unless `--allow-blocked`); otherwise **8**
  means the owner is gone with no recorded outcome — either `lost`,
  confirmed on two probes at least `2 × heartbeatMs` apart, or `exited` with
  no terminal journal record (a host interrupted, e.g. by a signal, before
  the run recorded its own end; the CLI re-reads once more first, so a host
  that exits just after its final journal write is not caught mid-write). In
  the `exited` case `woof status`'s printed line also carries `hostOutcome`,
  the host's own `outcome.json`, when that file exists (a foreground host
  has none, so its exit 8 carries no `hostOutcome` — only the exit code
  already visible in `liveness.host.exitCode`); `hostOutcome` is a CLI-only
  addition to the printed JSON, not part of the `RunStatusView` type itself.
  Otherwise the timeout elapsing is **7**. The last line printed is always
  the status at return time.
- **`woof runs [--runs-dir <dir>] [--project <dir>] [--all] [--limit <n>]`**
  (`src/inspect/runs.ts`) lists run directories under a runs directory
  (`--runs-dir` → the user setting `defaults.runsDir` → `~/.woof/runs`;
  project scope is refused for this setting): every non-terminal run plus the
  20 most recent terminal runs by default, sorted by `openedAt` descending.
  `--project` filters by the run's recorded `config.json` project root
  (`realpath`); a p3 run with no `config.json` shows `project: null` and is
  excluded by `--project`. A missing runs directory is `{"exists":false,
"runs":[]}`, exit 0; an unreadable one exits 3. It takes no lock and loads
  no workflow definition.
- **`woof events <run-dir> … [--stats]`** streams the run's `RunEvent`s as
  NDJSON, ending with `{"kind":"woof.events.end","cursor","terminal",
"reason"}` (`0` end/terminated, `7` timeout, `2` resync_required, `3`
  error, `130` SIGINT). `--follow` never takes the journal lock: it passes
  `subscribeEvents`'s optional `lockFree: true` (default `false`, so the
  SDK's own documented one-locked-read decision for a persistent torn tail
  is unchanged unless a caller opts in), so a final journal line that stays
  partial and unchanged for `tornTailGraceMs` (default 2000 ms) ends the
  follow with `{"type":"error","reason":"journal_corrupt"}`, the `error` end
  line, and exit 3, rather than the one locked read that decides it by
  default. Resumed with `--after <cursor>` at a terminated run's last
  cursor, `--follow` ends at once with `{"terminal":true,
"reason":"terminated"}` (exit 0) instead of waiting out `--timeout-ms`
  (a hosted run first waits, bounded, for its host's `host.exited`: see
  [lifecycle records](#implemented-now-lifecycle-records)); an
  earlier cursor still delivers the `run.terminated` event through the
  subscription first. `--stats` prints
  `{"kind":"woof.events.stats","polls","maxProjectionMs","pollMs","method":
"iterator step wall time beyond the poll interval"}` to stderr — an
  estimate from the iterator's own step time, not a measurement taken inside
  `subscribeEvents` (carry-over C4 stays deferred: `woof events --follow` is
  its first real consumer).
- **`woof watch [<run-dir>]`** is the human view of the same stream, the
  presentation of [run output](../design/run-output.md), from the pure
  renderer `src/observe/render.ts` (`createRunRenderer({snapshot, status,
input, repository?, graph?, options})`; the run host prints the same lines
  from the same facts, see below). From one `readRunStatus` read plus the
  run's `input.json` and `config.json` it prints an opening block — `woof /
<workflow>  <repo> · <branch>`, run id and version, the `~`-shortened run
  directory, an AGENTS roster (kind, model or `provider default`, assigned
  stages, the role when it differs from the name), a STEPS & GATES map drawn
  from the built-in workflow's edge table when the plan's stages match it
  (main path, `reject ↘` routes back to it, check commands, which gate binds a
  revision) or else the plan's stage and check list, a `limits:` line and an
  input preview (task title and criteria count by default, `--input json` for
  indented JSON cut after 24 lines with an explicit `… (N more lines, …)`
  marker) — then one row per meaningful event, `HH:MM:SS mark participant
stage message`, the participant an agent id, `gate` or `run`, wrapped under
  the message column (usable at 80 columns). Rows use the design's
  vocabulary (`Agent started · claude / sonnet`, `Task dispatched · same
agent`, `· visit 2`, `Completion report accepted`, `Review received · changes
requested`, `Checks failed → repair`, `Approved → completed`, `Result rejected:
<reason> · <field>`, `Fixing result format · attempt 2`, `Retrying work ·
attempt 2`, `Delivery unconfirmed · checking`, `Blocked: <reason>` plus the
  required action and tab, `Host lost · outcome unknown`); a blank line
  separates stage visits, `run.terminated` and `host.claimed` are left to the
  summary, and an unknown record type is a subdued `· <type>` row, never
  dropped (the lifecycle and activity records render by their type string and
  only when they say something: one `Waiting for agent to become ready` and one
  `Agent ready` per readiness cycle, `Running checks · <cmd>` by `run`, no row
  for a revision check or a check end the gate row already judges, `Agent not
ready · <result>`, `Revision check failed`, `Checks aborted · <result>` when
  the run ended around them, and an `Agent working` within 2 s of the dispatch
  subdued as the expected pickup). A terminated run
  ends with a summary — `✓ Completed · <reason>`, `! Failed · <reason>`, `!
Exhausted · <limit>`, `· Cancelled · <reason>` — with duration, `N reviews ·
M repairs` and ARTIFACTS (completion, review, verification from
  `deriveRunResult`, relative to the run directory). An observer that stops
  first prints the current block with `supported action: woof run cancel …`
  when there is one and `-- observer stopped (<reason>); the run continues`.
  Replayed history uses the same rows as live events (state folds from the
  events, seqs dedupe), so attaching never invents or repeats narrative.
  Colors sit on the mark and message only (SGR when stdout is a TTY and
  `NO_COLOR` is unset or empty); `--ascii`, or a `LANG`/`LC_CTYPE`/`LC_ALL`
  without UTF-8, uses `+ -> v ~ ! .`. **`woof watch --plain`** (and **`woof
events --pretty`**, the same output) keeps the technical projection from
  `src/observe/format.ts`: a header (run, workflow, active attempts,
  `liveness.owner`, each agent's role, kind, model and assigned pane, the
  outcome once recorded), one line per event (local `HH:MM:SS`, `#seq`,
  type, subject and a type-specific summary; an unknown type prints its data
  as compact JSON) and a `-- end (<reason>) cursor <cursor>` line. Both views
  share the read and follow loop of `woof events`, so the exit codes are
  identical, and both sanitize journal strings (control characters become
  spaces). `woof status --pretty` prints the technical header instead of the
  JSON line.
- **`woof config show`**, **`woof status`**, **`woof runs`**, **`woof
events`**, **`woof watch`** and **`woof run show`** are read-only and never take the journal
  lock or contact Herdr; see
  [configuration](configuration.md#implemented-now-p4). **`woof doctor
[--json]`** is not part of that guarantee: it is non-mutating, but it
  probes the Herdr and Claude executables for diagnostics — JSON mode
  spawns the configured Herdr binary with `--version` and `claude
--version`; human mode runs `herdr status` and `claude --version`
  (`src/commands/doctor.ts`). Both modes resolve the Herdr executable the
  same way, through `herdrBin()` (`WOOF_HERDR_BIN`, else `herdr`) — human
  mode is not a special case that resolves `herdr` from `PATH` on its own,
  and a configured executable that is missing is reported "herdr status:
  not found" rather than silently falling back to a different `herdr` on
  `PATH`. Each external probe, in either mode, is bounded at 10 s
  (`PROBE_TIMEOUT_MS`); a probe that times out is reported as failed rather
  than hanging the command.
- **The run host prints the human view of its own run.** `woof run host`
  (the pane host `run start` types into the root pane of the host's tab) and
  `--host foreground`/`run build-review` print to their stdout exactly what
  `woof watch <run-dir> --follow` prints — the opening block once the run is
  open, one history row per fact as the journal records land, the outcome
  summary — followed by the result JSON line. The host follows its OWN
  journal through the observe stream (`streamEvents` on the run directory:
  read-only, lock-free, the same follow `woof watch` uses; `src/host/view.ts`
  and the shared `src/observe/run-view.ts`), never the driver's callbacks, so
  the host's pane and a separate observer agree by construction. The follow
  never delays the host: when the scheduler returns, the host aborts it,
  prints the rows it had not read yet from one direct read and renders the
  summary from the final snapshot, and only then journals `host.exited`. The
  technical log — the scheduler's actions (`dispatch build visit 1 attempt 1
(initial) to builder`, `gate review pass (approved)`, `waiting (…)`),
  configuration warnings and metadata-report failures — goes to
  `<run-dir>/host.log`, one ISO-timestamped line per entry, appended as it
  happens; `--plain` prints that log to stdout instead of the human view
  (`--ascii` and `--input summary|json` shape the view like `woof watch`'s).
  Errors that abort the host still go to stderr; nothing else does, so a
  Herdr pane shows one coherent view. `outcome.json`, exit codes,
  `host-exit.json`, `host.claimed`/`host.exited` and `woof status --wait` are
  unchanged and do not depend on the host's stdout. There is no separate
  watch pane any more: one pane per run.
- **Metadata is a display-only projection, never a source.** The run host
  reports pane metadata tokens and notifications (`herdr pane
report-metadata`, `herdr notification show`); nothing in Woof reads a
  token back, the journal stays authoritative, and a failed report is logged
  to `host.log` and never affects the run. Reports are bounded: the host sends
  at most one metadata report at a time (`createCoalescer`), so a Herdr
  invocation slower than the poll interval never queues up an unbounded
  backlog of report calls behind it — a refresh requested while one is in
  flight coalesces with every other such request into exactly one follow-up
  report, which reads the snapshot afresh, so the latest state always wins
  and no stale report is ever sent late. At termination the host stops
  requesting further reports and waits only for the one in flight (each
  Herdr call itself capped at 5 s) before sending the final report, so
  finalizing stays prompt even when Herdr is slow to respond. See
  [plugins](../integrations/plugins.md#herdr-plugin).
- **Still not covered:** crash resume or re-hosting a lost run (a `lost`
  owner is reported and only ever cancelled) and parallel scheduling.

## Implemented now (lifecycle records)

Real shipped behavior — not design intent. Source:
`src/journal/lifecycle-records.ts`, `src/state/{reducer,store,snapshot}.ts`,
`src/host/run.ts`, `src/scheduler/driver.ts`, `src/observe/format.ts`. Every
record below is an ordinary journal record and therefore an event, one-to-one;
all are additive at `schemaVersion: 1`, and a journal without them reads
unchanged. They are transitions, never poll samples.

- **`run.cancel_requested {source, reason}`** — who asked, distinct from the
  termination it leads to. `source` is `cli` (`woof run cancel`), `web` (the
  UI's cancel route), `herdr_action` (`woof herdr cancel`), `signal` (a run
  host's SIGINT/SIGTERM) or `abort_signal` (`runWorkflow({signal})`, the
  default; `cancelSource` overrides it). All of them go through
  `cancelRun`, which appends the request and then
  `run.terminated{outcome:"cancelled"}` under **one** journal lock, so no
  other writer comes between the two. It prints/returns the termination as
  `record` plus `cancelRequest` and `hostLost`. `terminateRun` with
  `outcome: "cancelled"` still works and writes no request.
- **`host.claimed {pid, hostname, startedAt, heartbeatMs, paneId,
workspaceId, tabId?}`** — written by the run host together with `run.opened`, under
  **one** journal lock (`openRun({host})`, returned as `hostClaimed`), so a
  cancel racing the open can never close the run before its host is on
  record and thereby suppress `host.exited` (the claim file itself precedes
  the journal); read back from its own `host.json`. The optional `tabId` is
  the host tab the launcher created (it reaches the host as
  `WOOF_HOST_TAB_ID`); `agent.assigned` likewise carries an optional `tabId`,
  the tab opened for that agent, projected as `agents[].assignment.tabId`
  (null when absent). Both are additive at schemaVersion 1: journals written
  before them read unchanged. **`host.exited {pid, exitCode, reason}`** — written by the
  host on every awaited exit path, before it writes `host-exit.json`;
  `reason` is the run outcome or `rejected:<reason>`. It is the one record
  the reducer allows after `run.terminated`, because a host exits after the
  run it hosted ended. A host records the termination, drains, and only then
  journals its exit, so a follower (`woof events --follow`, `woof watch
--follow`, the Web UI's SSE stream — all one `streamEvents` loop) does not
  end at `run.terminated`: it ends when the journal holds no `host.claimed`,
  or the host's `host.exited`/`host.lost` is recorded, or the read-time probe
  no longer sees a live host (exit marker, dead pid, stale heartbeat, no
  claim file). A host that still looks alive is waited for at most three of
  its heartbeats, so a host killed right after the termination never makes a
  follower hang; `--timeout-ms` or a signal only cuts that wait short, and
  the follow still ends `terminated` with exit 0. A late `submission.rejected`
  between the two is delivered with the exit, never on its own. `--follow --after <cursor
at or past the termination>` applies the same rule: it delivers the exit
  whether it was written before or after the follower started. `woof status
--wait` still returns on the recorded outcome at once — `host.exited` may
  follow, and resuming from its `status.cursor` delivers it. The synchronous second-signal
  exit (130) cannot take the journal lock and leaves only `host-exit.json`.
  A refused or failed host record is logged and never affects the run. A
  scheduler driven without a host (`runWorkflow` from the SDK) journals no
  host record.
- **`host.lost {pid, heartbeatAt, reason, detectedBy}`** — a dead host cannot
  write it, and inspectors never write anything: `cancelRun` (the only
  mutating path that acts on a lost run) probes the host under the lock and,
  when the probe says `lost` and the journal holds no `host.exited`/
  `host.lost` yet, appends the evidence first — `host_process_gone`,
  `heartbeat_stale` or `claim_invalid: <problem>` (`probeHostEvidence`) — then
  the request and the termination. A `host.claimed` is not required (a host
  can die before journaling it); a later `host.exited` is still accepted,
  since `host.lost` records a suspicion.
- **`observation.lost {agentId, code, message, terminalId}`** /
  **`observation.recovered {agentId, lostSeq, terminalId}`** — the scheduler
  writes `lost` at the first failed observe of an outage (the point where its
  observation stops being current: the first timeout of a streak, or the
  runtime error that fails the run at once) and `recovered` at the next
  successful observe. One record per outage: the second and third timeouts
  of a streak write nothing, and the third then fails the run with the
  unresolved loss still in the snapshot. Which losses are unresolved is
  read from the snapshot's `lifecycle.observationLost`, never from the
  scheduler's memory: a scheduler that meets a loss it did not write pairs
  its recovery with that record and writes no second loss. Individual
  samples stay unjournaled.
- **Snapshot: `lifecycle {host, cancelRequested, observationLost}`** —
  `host` is the last journaled host fact (`{state: "claimed"|"exited"|"lost",
seq, at, pid, exitCode, reason}` or `null`), `cancelRequested` the latest
  request (`{seq, at, source, reason}` or `null`), `observationLost` every
  loss no recovery resolved. It is derived by the one reducer, so
  `foldEvents` reproduces it; `liveness` stays the separate read-time probe.
- **Reducer refusals:** `host_exists`, `host_unknown`, `host_gone`,
  `observation_lost`, `observation_not_lost`, plus `run_closed` for every
  lifecycle record but `host.exited`.
- **Still not covered:** format repair and work retry are not records of
  their own: the reducer derives an attempt's `cause`. Per-agent runtime
  lifecycle transitions and engine activity are journaled since
  [Implemented now (activity records)](#implemented-now-activity-records);
  individual observation samples still are not. The journaled
  `tabId`s say which tabs a run opened, not whether they are still open: the
  run host closes its agent tabs when the run ends, so a host that was killed
  leaves them open, `host.lost` and `woof run cancel` close nothing, and no
  record says a tab was closed.

## Implemented now (activity records)

Real shipped behavior — not design intent. Source:
`src/journal/activity-records.ts`, `src/state/{reducer,store,snapshot}.ts`,
`src/scheduler/driver.ts`, `src/observe/{events,format}.ts`. Both records are
ordinary journal records and therefore events, one-to-one, with a `subject`
(the agent, and the stage/visit/attempt where present); both are additive at
`schemaVersion: 1`, so a journal without them reads unchanged. They are
written on **change**, never per poll: `woof watch`, the Web UI and the run
host all read the same rows because there is nothing else to read.

- **`agent.lifecycle_changed {agentId, from, to, terminalId, raw?, replaced?}`**
  — written by the scheduler when a tracked observation's lifecycle
  (`ready | working | blocked | unknown | gone`, the runtime enum) differs
  from the agent's **last journaled** lifecycle (`from`; `null` for the first
  transition). "Last journaled" is read from the snapshot
  (`agents[].lifecycle`), never from the scheduler's memory, so a repeated
  sample across any number of polls writes nothing. A pane occupant
  replacement (the tracker's `replaced`) is a transition even to the same
  lifecycle and carries `replaced: true`. `raw` is the runtime status behind
  `to` when the runtime reported one (a `gone` agent has none). After a
  started delivery the transition is written **after** its
  `request.dispatched`, so the dispatch fact precedes the working state it
  observed.
- **`run.activity {kind, phase, agentId?, stageId?, visit?, attempt?, detail?,
result?}`** — engine work with noticeable duration, one `started` when it
  begins and one `ended` when it finishes, on the same kind and subject
  (`stageId`/`visit`/`attempt` come together or not at all; `result` only on
  `ended`). Exactly four kinds: `readiness_wait` (the scheduler waits for an
  agent to become ready for a dispatch; `agentId`; ends `ready`),
  `revision_check` (the repository fingerprint for a stage gate; subject is
  the gated attempt, `detail` the gate id, `result` `tree <object id>`),
  `check_run` (a verification command; subject is the gated attempt, `detail`
  the argv joined by spaces, `result` `exit <code>`, `signal <name>` or
  `timed out`) and `delivery_check` (an ambiguous delivery under
  reconciliation, from right after its `request.dispatched` to right after
  its `delivery.reconciled`; `detail` the ambiguous code, `result`
  `<resolution> (<evidence>)`). The dispatch-time fingerprint and a
  revision-bound gate's re-fingerprint are not activities of their own. A
  failure end is still `ended`: every activity the journal still holds open
  when the scheduler records a termination (`completed`, `failed`,
  `exhausted`, `cancelled`, including its engine-failure path) is ended with
  the outcome word as `result` **under the same journal lock** as
  `run.terminated` (`terminateRun`/`cancelRun` with `endOpenActivities:
true`, returned as `activitiesEnded`), so no other record comes between the
  ends and the termination and nothing is open once the run is closed. An
  activity its writer could not end (a killed host) is closed by the
  termination on read; see the reducer rules.
- **Best effort:** both records are observability, not control flow. An
  append the store refuses or cannot complete (`journal_busy` after the
  retries, `journal_write_failed`, `lifecycle_mismatch`, `activity_open`, ...)
  is reported through `runWorkflow({onWarning})` as `{record, reason,
message}` and changes nothing else: the fingerprint, check, gate or dispatch
  it described still runs and is recorded, and the run's outcome never names
  it. A `run_closed` refusal means someone else ended the run, and the
  scheduler stops trying. An activity whose `ended` could not be written stays
  open until the termination closes it. A pane replacement observed during a
  delivery (the dispatch is refused `assignment_mismatch`) is journaled, best
  effort, before the `agent_replaced` termination, so the journal shows who
  occupied the pane when the run ended.
- **Reducer rules:** `agent.lifecycle_changed` is refused after termination
  (`run_closed`), for an unplanned (`agent_unknown`) or unassigned
  (`agent_unassigned`) agent, when `from` is not the journaled lifecycle
  (`lifecycle_mismatch`) and when `to` equals `from` without `replaced`
  (`lifecycle_unchanged`). `run.activity` is refused after termination, as a
  second `started` for a kind and subject still open (`activity_open`) and as
  an `ended` for one that is not (`activity_not_open`) — two consecutive
  starts are an impossible transition, not a warning. `run.terminated` closes
  every activity still open (an `ended` for it afterwards is `run_closed`), so
  a journal written by a host that was killed mid-activity never reads as
  engine work in progress after the run ended.
- **Snapshot:** `agents[].lifecycle: {state, since, seq, terminalId} | null`
  (the last journaled transition; `null` when none) and `activity: {open:
[{seq, since, kind, agentId, attempt, detail}]}` (open activities in start
  order), plus the counters `lifecycleChangesByAgent {id: n}` and
  `activitiesByKind {kind: n}` (starts only). All derived by the one reducer,
  so `foldEvents(base, events)` reproduces them; `agents[].runtime` stays the
  separate, non-journaled overlay. Old journals: `lifecycle: null`,
  `activity.open: []`; a terminated run: `activity.open: []`, whoever wrote
  the journal (the `started` events remain).
- **Human formatter (`woof watch`, `--pretty`):** `agent.lifecycle_changed`
  prints `<from|-> -> <to> (<raw>) terminal <id> [pane occupant replaced]`,
  colored as attention only for `blocked`, `gone` or a replacement;
  `run.activity` prints `<kind> <phase>: <detail> -> <result>` dimmed.
- **Scripted-runtime caveat:** the test double reuses `stateChangeSeq`
  across deliveries, so an agent's second dispatch yields `stale` samples and
  journals no transition; Herdr's sequence is monotonic, so a live run does.
  The `readiness_wait` around a dispatch to an already-ready agent lasts one
  poll (the scheduler needs two consecutive ready samples) and is journaled
  as such: it is a true, short wait, and a renderer may collapse it.

## Implemented now (central index)

Real shipped behavior for finding runs across directories and streaming all of
them — not design intent. Source: `src/inspect/{locator,runs,reindex,target}.ts`,
`src/inspect/all-events.ts`, `src/observe/format-all.ts`, `src/state/locator.ts`, `src/contracts/index-dir.ts`, `src/commands/{all,target,runs}.ts`.

- **The per-run journal stays the only source of truth.** Nothing here stores
  status or events a second time. The run index is a set of locators; the
  cross-run stream reads each run's own `journal.jsonl` through `readEvents`
  and the single-run follow loop.
- **Locator index.** `<index>/runs/<runId>.json`, where `<index>` is
  `WOOF_INDEX_DIR` when set, else `~/.woof/index`. A locator is
  `{schemaVersion: 1, kind: "woof.run.locator", runId, runDir, projectRoot,
workflow, openedAt, registeredAt}` — `runDir` absolute and symlink-resolved,
  `projectRoot` and `workflow` `null` for a plan-less run — and never carries
  status or events. It is written when `run.opened` is recorded (`openRun`,
  and the implicit plan-less open of `openAttempt`) through a `*.tmp` file and
  a `rename`; readers ignore `*.tmp`. A failed index write is one stderr line
  and never fails the run. A later run with the same id does not take over a
  locator that still leads to its run at another directory: the first locator
  stays, the newcomer is one stderr line, its open succeeds, and it remains
  reachable by its directory and by a runs-directory scan. A locator that no
  longer leads to its run is replaced.
- **Readers never trust a locator as state.** Status always comes from
  `readSnapshot(runDir)`. The locator's `runDir` is resolved (`realpath`) on
  every load. A locator whose directory is gone (`run_dir_missing`) or cannot
  be resolved right now (`run_dir_unavailable`), whose journal cannot be read
  (the snapshot's own reason, e.g. `run_dir_invalid`) or whose journal records
  another run id (`run_id_mismatch`) is reported under `skipped` with its
  `runId`, and a locator file that does not parse, or whose `runDir` is not an
  absolute path, as `locator_invalid` — never as a run. A relative `runDir` is
  never followed against the inspector's working directory.
- **`listRuns({runsDir, indexDir})` is the union** of the runs-directory scan
  and the index, listed once per resolved directory. `woof runs` with no
  `--runs-dir` passes the index (its output gains `indexDir`), so a run opened
  with its own `--run-dir` or `--runs-dir` is listed; an explicit `--runs-dir`
  lists that directory only. `--project`, `--all` and `--limit` apply to the
  union. `woof ui` follows the same rule for `/api/runs` and for resolving a
  run id. There is no `GET /api/events` for all runs.
- **`woof runs --reindex`** is the only inspection command that writes: it
  writes a locator for each readable run under the runs directory that has
  none (or one whose directory holds no such run) and prints
  `{"outcome":"reindexed","written","pruned","unavailable","kept","conflicts",
"skipped"}`. A locator whose run directory cannot be reached is listed under
  `unavailable` (`run_dir_missing` or `run_dir_unavailable`) and **kept**: a
  volume that is not mounted right now must not lose its runs. Only
  `--reindex --prune` removes the locators whose directory does not exist. A
  run id already indexed at another directory that holds that run — or, without
  `--prune`, at a directory that cannot be reached — is left alone and listed
  under `conflicts`. It never touches a run directory.
- **Run addressing by id.** `woof status|events|watch|run show|run cancel`
  resolve their argument: an existing directory always wins; else, for a bare
  run id, the locator (which must still lead to that run) and `<runs-dir>/<id>`
  are both looked at. When both hold a run with that id at different real
  directories the id is rejected as `run_id_ambiguous` (exit 3, the message
  names both directories) — `run cancel` never picks one of two runs — and the
  run directory still works. Directories under the runs directory whose name
  differs from the run id they record are not searched by the CLI (`woof runs`
  and the Web API, which read every journal, do see them).
  A bare id found nowhere is `run_dir_invalid` (exit 3). Any other path that
  does not exist is still treated as a run directory, so `events --follow` keeps
  waiting for a directory that is about to be created.
- **`woof events --all [--follow] [--project <dir>] [--since <iso>]`** emits the
  unchanged `RunEvent`s of every known run. Each run is introduced once, before
  its first event, by `{"kind":"woof.events.run","runId","runDir","project"}`.
  Recorded events are merged by `ts`, then `runId`, then `seq`. With `--follow`
  each run is then followed from the cursor its backlog ended at, and runs
  that appear later (a new locator or runs-directory entry, checked at least
  every 500 ms) are followed from their start; live lines of different runs
  are not re-ordered against each other. `--timeout-ms` (exit 7) and SIGINT
  (130) bound it. The follow is bounded: at most `--max-runs <n>` runs
  (default 64) are polled at a time, runs that have not ended and the most
  recently opened first; a follower is dropped as soon as its run has
  terminated (and its `host.exited` was delivered or given up on), and a run
  that was already terminal with no live host when the stream started is not
  polled at all. A run that has to wait for a free follower is reported once as
  `{"kind":"woof.events.skipped","runId","runDir","project","reason":
"follow_cap","message"}` and is followed from where it stood (its backlog
  cursor, or its start) once a follower ends — delayed, never silently dropped. A run's `resync_required`/`error` item, or an entry that
  holds no readable run (`type: "skipped"`), is printed with `runId` and
  `runDir` and does not end the stream. The last line is
  `{"kind":"woof.events.end","scope":"all","runs","cursor":null,"terminal":
false,"reason"}`. There is no cross-run cursor: `--after` is single-run only.
- **`woof watch --all`** (and `events --all --pretty`) is the human projection
  of that stream: a `== <short id>  run <id>  <run-dir>` line per run and the
  single-run event line behind the short run id (the id, or `~` and its last 11
  characters).
