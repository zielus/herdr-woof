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
  subpath (never the main entry), enforces its own edge cases: `advance`
  throws a TypeError for a negative or non-integer step count, construction
  throws a TypeError for an empty `afterDeliver` sequence (flat or nested),
  and a scripted `started` delivery is checked like the Herdr adapter's own —
  if the observation right after delivery is not `working` or `blocked`, the
  outcome is downgraded to `ambiguous/protocol_error` (the call is still
  logged as `sent`).

- **Gate evaluation, blocking/unblocking and delivery reconciliation are
  implemented (p3).** See "Implemented now (p3)" below for the snapshot and
  event shapes. **Still not covered:** a cancellation request distinct from
  plain termination (`runWorkflow({signal})` and `woof run cancel` both
  produce the same `run.terminated{outcome:"cancelled"}`), and observation
  loss/owner liveness recovery (still needs a run owner, which does not
  exist — every snapshot's `liveness.owner` stays `"unhosted"` (p2;
  superseded by p4, see [Implemented now (p4)](#implemented-now-p4))).

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
"reason":"terminated"}` (exit 0) instead of waiting out `--timeout-ms`; an
  earlier cursor still delivers the `run.terminated` event through the
  subscription first. `--stats` prints
  `{"kind":"woof.events.stats","polls","maxProjectionMs","pollMs","method":
"iterator step wall time beyond the poll interval"}` to stderr — an
  estimate from the iterator's own step time, not a measurement taken inside
  `subscribeEvents` (carry-over C4 stays deferred: `woof events --follow` is
  its first real consumer).
- **`woof watch [<run-dir>]`** (and **`woof events --pretty`**, the same
  output) is a human projection of the same stream, from the pure formatter
  `src/observe/format.ts`: a header from one `readRunStatus` read (run,
  workflow, active attempts, `liveness.owner`, each agent's role, kind,
  model and assigned pane, the outcome once recorded), then one line per
  event (local `HH:MM:SS`, `#seq`, type, subject and a type-specific
  summary; an unknown type prints its data as compact JSON) and a
  `-- end (<reason>) cursor <cursor>` line. It shares the read and follow
  loop of `woof events`, so its exit codes are identical. Journal strings
  are sanitized (control characters become spaces), and SGR colors are
  added only when stdout is a TTY and `NO_COLOR` is unset or empty.
  `woof status --pretty` prints that header instead of the JSON line.
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
- **Metadata is a display-only projection, never a source.** The run host
  reports pane metadata tokens and notifications (`herdr pane
report-metadata`, `herdr notification show`); nothing in Woof reads a
  token back, the journal stays authoritative, and a failed report is logged
  to stderr and never affects the run. Reports are bounded: the host sends
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
  owner is reported and only ever cancelled), parallel scheduling, and a
  second built-in workflow.
