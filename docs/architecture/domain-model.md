# Domain model and execution state

Status: semantic contract. Exact type names and serialized spellings are proposed.

## Vocabulary

| Term          | Meaning                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| Role/profile  | Reusable configuration for a responsibility, including agent kind, model preferences, instructions and permissions. |
| Agent         | A named instance assigned to a run, associated with a Herdr agent and native session identity where available.      |
| Workflow      | A reusable definition of work, input/output contracts, transitions and limits.                                      |
| Run           | One execution of a workflow with resolved input, configuration and owned work.                                      |
| Stage/step    | A named unit of work. These terms describe the same concept; use `stage` consistently in the initial design.        |
| Visit         | One entry into a stage, including entries reached through a loop.                                                   |
| Round         | A workflow-defined cycle, such as a review followed by repair. It is not automatically every visit to every stage.  |
| Attempt       | One execution attempt within a stage visit. Retrying actual work creates a new attempt.                             |
| Format repair | A bounded request to correct an invalid output contract without automatically repeating the substantive work.       |
| Artifact      | The substantive output: review, plan, research, or a completion report associated with repository changes.          |
| Envelope      | Small validated control data identifying the outcome and referencing artifacts.                                     |
| Gate          | A routing decision based on accepted structured control data.                                                       |

The same `builder` performs `build` and `repair`. Creating a `fixer` automatically
would lose the intended continuity. Record the mapping from logical agent to
Herdr target and native session; a replacement must be explicit and observable.

## Separate runtime state from workflow state

Herdr's lifecycle observation describes the agent process. A Woof stage describes
the work assigned to it. A reviewer can finish a valid review whose verdict is
`fail`: the stage completed, the review gate rejected the work, and the run
continues to repair. These are different facts.

Recommended run states are `created`, `starting`, `running`, `blocked`, and
terminal `completed`, `failed`, `cancelled`, or `exhausted`. A lost runtime is a
separate liveness condition until a recovery policy classifies it.

| Condition                    | Required behavior                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| Valid artifact and envelope  | Accept the stage result and evaluate its declared transition.                      |
| Invalid or missing output    | Record rejection; request bounded format repair if policy allows.                  |
| Gate rejection               | Follow the workflow's rejection edge; do not label it a runtime crash.             |
| Permission or question block | Expose the reason, owning agent, and required action; wait within a finite budget. |
| Worker failure               | Record the failure and apply the declared retry policy or terminate.               |
| Ambiguous delivery           | Suspend dependent dispatch and reconcile; do not assume the work never started.    |
| Exhausted limit              | Stop with the limit name, counters, last accepted artifacts and reason.            |
| Cancellation                 | Stop scheduling, settle owned work according to policy, and reject late results.   |

An accepted result closes one attempt. Identical duplicate submission returns
the prior receipt; conflicting or stale submission is rejected. A later idle
signal cannot reopen or complete an already closed attempt.

## Bounds and ownership

Every repeating path must encounter a finite bound. Keep work attempts, format
repairs, review rounds, and total stage visits distinct so authors can understand
what consumed a limit. Bound readiness waits, blocked waits, observation recovery,
and the overall run as well. Resetting a local counter must not permit an
unbounded global loop.

Each request belongs to a run, named agent, stage visit, and attempt. Each accepted
artifact retains that provenance. Serialize access to a worker that has an active
request; another stage cannot silently take it over.

Keep accepted outputs by visit. If the authoring API also offers a convenient
“latest build” slot, repair may replace that pointer after acceptance, while the
previous artifact remains in history. A failed new visit must not expose the old
output as fresh success.

See [communication](communication.md) for submission validation and
[observability](observability.md) for the externally visible state.

## Implemented now (p2)

Real shipped behavior for run plans, run facts and derived state — not design
intent. Names are proposed API surface; shapes and refusal semantics are the
contract. Source: `src/domain/types.ts`, `src/domain/plan.ts`,
`src/journal/run-records.ts`, `src/state/reducer.ts`, `src/state/store.ts`.

- **Plan types.** A `RunPlan` names a `workflow { name, version }`, a
  non-empty unique-id `agents: AgentSpec[]` (`agentId, role, kind, model`,
  plus an optional `args: string[]` — resolved launch arguments, p3), a
  non-empty unique-id `stages: StageSpec[]` (`stageId, agentId, verdicts`,
  each `agentId` naming a planned agent), an optional `checks: string[]`
  (p3: engine-run check ids, unique and disjoint from stage ids — the
  scheduler always writes this field for a workflow with check stages; see
  "Implemented now (p3)" for how the reducer uses it), and `limits: Limits`
  (`maxAttemptsPerVisit, maxVisitsPerStage, maxRounds`, each a safe integer
  1–1000; `runTimeoutMs, readinessWaitMs, blockedWaitMs, deliveryTimeoutMs`,
  each a safe integer 1–604 800 000 ms, i.e. seven days — a lead decision:
  every wait must be bounded, so an unbounded duration is not a limit; plus
  an optional `maxFormatRepairs`, a safe integer 0–1000, absent ≡ 0 — p3,
  format-repair attempts per visit, kept distinct from `maxAttemptsPerVisit`).
  A run may also be plan-less (p1's shape); every plan-referencing check
  below is then skipped. `validateRunPlan` rejects unknown keys, duplicate
  ids, and an unresolved stage `agentId`, one detail per offending field
  path. It reads only the input's own enumerable properties (arrays by own
  index), never a prototype's: a required field supplied only by
  inheritance (for example an object built with `Object.create`) is
  reported missing, exactly as if it were absent. A plan built entirely
  from null-prototype objects is accepted and validated the same as an
  ordinary object.

- **Run status is derived, never recorded.** There is no `run.status`
  record. `created` (only `run.opened`), `starting` (at least one
  `agent.assigned`, no dispatch yet), `running` (at least one
  `request.dispatched`, not terminated), and the terminal statuses (from
  `run.terminated.outcome`) are computed by the reducer from whichever
  records are present so far. `blocked` **is derived (p3):** an unresolved
  `run.blocked` record makes the status `blocked`, ahead of `running`; see
  "Implemented now (p3)" below.

- **Run-fact record types (p2).**

  | Record type          | Fields                                                                                 | Refused as (reducer reason)                                                                                                                                                                                   |
  | -------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `run.opened`         | `runId`, optional `plan`                                                               | a second one: `run_exists`; anything else before it: `invalid_transition`                                                                                                                                     |
  | `agent.assigned`     | `agentId`, `runtime {adapter, runtimeName, paneId}`, optional `terminalId`/`sessionId` | unplanned agent: `agent_unknown`; reassigned to the same pane: `assignment_unchanged`; agent owns an open dispatched attempt: `agent_busy`; after termination: `run_closed`                                   |
  | `request.dispatched` | `agentId, stageId, visit, attempt, delivery, reason`, optional `paneId`                | attempt never opened or no longer open: `attempt_unknown`; wrong owner: `owner_mismatch`; already dispatched: `dispatch_exists`; agent has no assignment: `agent_unassigned`; after termination: `run_closed` |
  | `run.terminated`     | `outcome, reason`, `limit` required iff `outcome: "exhausted"`                         | a second one: `run_closed`                                                                                                                                                                                    |

  A later `agent.assigned` for the same agent on a different pane is a
  **replacement** (counted in `counters.replacementsByAgent`), not a
  refusal. With a plan present, `attempt.opened` also gains `stage_unknown`
  and `owner_mismatch`/`verdicts_mismatch` against the stage's declared
  agent and verdict set (order-insensitive comparison). All fourteen
  `ReducerReason` values are exercised in `test/unit/reducer.test.ts` and by
  the seeded fold generator in `test/unit/events.test.ts`.

- **Refusal vs. policy.** The reducer and the store record facts and refuse
  impossible states; neither decides what happens next. Reaching
  `maxAttemptsPerVisit` is not itself refused — only a scheduler's decision
  to stop (`run.terminated {outcome: "exhausted", limit}`) is a fact the
  journal can hold. **The reducer now has rules for rounds, gates, blocks,
  format repairs and work retries (p3)** — see "Implemented now (p3)" below;
  it still only refuses impossible records, never decides what to do next.

- **Limits are declared, validated and counted, and enforced by the
  scheduler (p3).** Every `Limits` field is required and bounds-checked on
  every plan (plus the optional `maxFormatRepairs`, 0–1000, absent ≡ 0); the
  snapshot's `counters` (see [observability](observability.md#implemented-now-p2))
  track `attemptsOpened`, `visitsByStage`, `attemptsByVisit`, dispatch
  outcomes and replacements next to the declared limits. The reducer and
  store still never refuse an attempt, visit or round for exceeding a
  limit — that check, and the response to reaching one
  (`run.terminated{outcome:"exhausted", limit}`), is the scheduler (p3); see
  "Implemented now (p3)" below for the exact map.

- **Gate, block and reconciliation are implemented (p3), not types only.**
  `GateResult`, `GateDecision`, `BlockInfo` and `DeliveryResolution` (in
  `src/domain/types.ts`) now have journal record types
  (`gate.recorded`, `run.blocked`, `run.unblocked`, `delivery.reconciled`),
  written and read by the scheduler; see "Implemented now (p3)" below.

- **`abandoned` is a snapshot-only derived status.** The reducer's own
  `AttemptStatus` stays `open | superseded | accepted`; a snapshot reports
  an attempt still `open` when the run terminated as `abandoned`, so a
  consumer never has to infer it from status plus run termination.

- **One dispatch per attempt; retrying is a new attempt.**
  `request.dispatched` records the delivery certainty of the one dispatch
  attempt made for the attempt (`started | not_delivered | ambiguous`, each
  with its own closed `reason` set — `not_delivered/not_found` and its
  siblings are precondition failures where nothing was sent, not proof a
  prompt went out); a second dispatch for the same attempt is
  refused (`dispatch_exists`). There is no resend: sending the work again is
  only expressible by opening a new, explicitly numbered attempt, which is
  journaled and visible, and p1's staleness rule keeps a late result from
  the old attempt from being accepted. An `ambiguous` dispatch whose attempt
  is still open surfaces in `snapshot.attention.ambiguousDeliveries` until
  the attempt is accepted or superseded.

- **Runtime lifecycle is an overlay, never a record.** A runtime adapter's
  lifecycle observations (`ready | working | blocked | unknown | gone`) live
  only in an in-memory tracker; overlaying them onto a snapshot
  (`overlayRuntime`) fills `agents[].runtime` for display and reports
  whether any agent was observed. It applies an agent's last tracked
  observation only when the assignment's `terminalId` is null or equals the
  observation's terminal — otherwise that agent's `runtime` stays `null` and
  the agent is listed in the result's `skipped` list instead of being
  overlaid with the wrong occupant's lifecycle. A derived snapshot on its
  own (`deriveSnapshot`/`readSnapshot`/`woof run show`) always reports
  `agents[].runtime: null`: no lifecycle value completes, accepts or fails
  an attempt, and runtime observation is lossy by construction —
  transitions between two reads are not seen. See
  [observability](observability.md#implemented-now-p2) for the runtime
  adapter contract itself.

## Implemented now (p3)

Real shipped behavior for the scheduler, its workflow definitions, check
gates, rounds, blocking, reconciliation and revision binding — not design
intent. Source: `src/scheduler/{definition,core,driver,admission,request,
launch,revision,check,loader}.ts`, `src/journal/control-records.ts`,
`src/state/{reducer,store,snapshot,result}.ts`, `src/domain/types.ts`.

- **A workflow definition (`src/scheduler/definition.ts`) is a static graph
  the engine names no part of.** It declares `agents`, `AgentStage`/
  `CheckStage` entries, a `start` stage, an optional `roundStage`, and a
  static `edges` map from every stage/check id to its allowed next ids and
  terminal outcomes. Only `validateInput`, `resolveAgents`, `resolveLimits`
  and `repository` are called from caller input; every other function
  (`request`, `next`, `command`) is called only from snapshot-derived
  context, must be synchronous and side-effect free, and is guarded — a
  throw or a malformed return ends the run
  `failed{reason:"definition_threw: …"}` rather than propagating. See
  [workflow authoring](../workflows/authoring.md#implemented-now-p3) for the
  full contract, `validateWorkflowDefinition` and the loader
  (`.js`/`.mjs` everywhere, `.ts` through Node's built-in type stripping;
  loading executes the module's code).

- **The scheduler is the only router (D1).** `decide(view) → Action` is a
  pure function of the run snapshot, the definition, the scheduler's
  in-memory runtime view (per-agent handle, last observation, ready-since
  time, activity-since-dispatch) and the clock; it never reads or writes the
  journal itself. `src/scheduler/driver.ts` executes exactly one action per
  tick (open attempt, start agent, deliver, run a check, compute a revision,
  record a gate, block/unblock, reconcile, terminate, or sleep), then
  re-reads the snapshot and asks again. There is no second reducer and no
  scheduler write that bypasses the store.

- **Check gates (D3).** A `CheckStage` runs an argv (no shell) in the
  repository with a bounded timeout (`src/scheduler/check.ts`); its combined
  stdout/stderr tail (capped at 1 MiB) is written to an engine-owned evidence
  file and journaled as `gate.recorded{kind:"check"}`. A check has no
  `AgentSpec`, no visits and no attempts; its subject is the accepted
  submission whose gate transition entered it. A failing or timed-out check
  routes by the definition's `next`, so a verify↔repair loop is bounded by
  `maxVisitsPerStage` on the repair stage, not by a separate check limit.

- **Rounds, format repair and work retry (D5, D9).** Entering the
  definition's `roundStage` starts a round, counted in
  `counters.rounds`/`visitsByStage[roundStage]` and bounded by `maxRounds`.
  Within a visit, `deriveCause` in the reducer derives each attempt's
  `cause` from the _previous_ attempt of the same visit: no previous attempt
  → `initial`; previous attempt accepted, or dispatched `not_delivered`, or
  never dispatched → `work_retry`; previous attempt dispatched `started` (or
  `ambiguous` and reconciled `abandoned`) with no acceptance → `format_repair`
  (an `ambiguous` dispatch reconciled `delivered` also counts as
  `format_repair`). `initial + work_retry` attempts are bounded by
  `maxAttemptsPerVisit`; `format_repair` attempts by the separate
  `maxFormatRepairs` (absent ≡ 0, so no plan enables format repair unless it
  opts in). A format-repair attempt sends no new goal/task — only the
  journaled rejections of the previous attempt (or "no submission was
  recorded") — and is dispatched into a new attempt directory, never a
  resend into the old one.

- **Limit enforcement map (D9).** The scheduler — not the reducer — checks
  every limit and ends the run `exhausted` with the limit's key before the
  journal write that would exceed it: `maxRounds` before opening a new round
  visit; `maxVisitsPerStage` before opening visit n+1 of an agent stage;
  `maxAttemptsPerVisit` before a `work_retry` attempt; `maxFormatRepairs`
  before a `format_repair` attempt; `readinessWaitMs` from starting an agent
  (or first needing it ready) until it settles `ready`;
  `blockedWaitMs` from `run.blocked` until unblocked; `deliveryTimeoutMs`
  passed to delivery as one deadline covering both the precondition read
  (checking the agent is not gone/working/blocked before anything is sent)
  and the prompt itself — if the read alone exhausts it, nothing is sent and
  the dispatch is `not_delivered` — and as the ambiguous-reconciliation
  deadline;
  `runTimeoutMs` checked before every blocking call and before any
  dispatch/check/gate write, so a budget that expires mid-tick ends the run
  with no partial dispatch (`request.dispatched`) or delivery ever recorded
  for that step. Waiting for a worker's result after a started dispatch has
  no separate limit; it is bounded only by `runTimeoutMs`.

- **`runTimeoutMs` bounds every blocking step, not only writes (PR fix
  round 1).** Once the first snapshot is read, the deadline
  (`openedAt + runTimeoutMs`) caps the timeout passed to each observe call, to
  `openPane`, to `startAgent`, to every repository fingerprint (dispatch,
  `compute_revision`, after a check, and again immediately before a
  revision-bound gate append), and to the tick's own sleep — each gets
  `min(its own cap, the remaining budget)` (observe and pane-open share a
  10-second adapter command cap; deadline expiry is re-checked immediately
  before every gate append, after the subject re-hash and fingerprint). A
  remaining start budget under the Herdr adapter's own minimum start timeout
  (3001 ms) ends the run `exhausted{runTimeoutMs}` before `startAgent` is even
  called, rather than attempting a start Herdr would refuse outright. A
  fingerprint that hits the deadline reports `timeout` (mapped to
  `exhausted{runTimeoutMs}`); one that is aborted mid-flight is picked up
  again on the next tick as a cancellation.

- **Blocking is a journaled scheduler decision (D7).** When a tracked
  observation of an assigned agent is `blocked`, the scheduler records
  `run.blocked{agentId, reason: "blocked_on_input"|"startup_blocked",
requiredAction, observed, [stageId, visit, attempt]}` once; `requiredAction`
  names the pane, the runtime agent name and `woof run cancel <run-dir>` as
  the resolution. `status` derives `blocked` ahead of `running` while the
  block is unresolved. Resolution paths: the scheduler observes the same
  terminal leave `blocked` (`ready`/`working`) → `run.unblocked
{resolution:"observed_unblocked"}`; `woof run cancel` (or a second SIGINT
  to the CLI) → `cancelled`; or `blockedWaitMs` elapses →
  `exhausted{limit:"blockedWaitMs"}`. A startup block (`agent_not_ready` from
  the runtime) records the agent's assignment first, then
  `run.blocked{reason:"startup_blocked"}` with no attempt. Nothing answers a
  permission prompt automatically.

- **Ambiguous delivery is reconciled only on evidence (D8).** After
  `request.dispatched{delivery:"ambiguous"}` the scheduler sends nothing
  further and waits until `dispatch.ts + deliveryTimeoutMs`: a
  `submission.accepted`/identity-bearing `submission.rejected`, or a tracked
  observation of the same terminal (taken after the dispatch) showing
  `working`/`blocked`, records `delivery.reconciled
{resolution:"delivered", evidence:"submission_recorded"|"observed_activity"}`
  and the attempt continues as if started; neither before the deadline
  records `delivery.reconciled{resolution:"abandoned",
evidence:"no_evidence_before_deadline"}` and the run ends
  `exhausted{limit:"deliveryTimeoutMs"}`. `not_delivered` stays in the
  `DeliveryResolution` type, but no p3 record can carry it: no evidence
  proves a prompt was never delivered after an ambiguous dispatch.

- **Revision binding (D4).** `revisionOf(repo, {timeoutMs?, signal?})` first
  resolves `git rev-parse --show-toplevel` from the given path — the
  fingerprint always covers the whole work tree from its root, whatever
  directory inside it is given — then computes `{head: git rev-parse HEAD |
null, tree: <write-tree of a temporary index seeded with HEAD and git add
-A>, root}` without touching the real index or working tree (`git add` into
  the temporary index does write unreferenced blobs into the repository's
  object store). Admission requires the workflow's `repository(input)` to
  already name that top level (`realpath(repository) === realpath(root)`,
  else `repo_invalid` naming both); every later fingerprint therefore starts
  from the same root. Given a `timeoutMs`, one deadline covers every git step;
  hitting it returns `{ok:false, reason:"timeout"}` (an aborted call returns
  `"aborted"`) rather than a `repo_invalid` git error. The driver computes the
  fingerprint at dispatch (`request.dispatched.revision`) and again immediately before
  recording a gate (`gate.recorded.revision`); a stage declared
  `bindsRevision: true` receives both `reviewed` (the revision its accepted
  attempt was dispatched against) and `current` (the fresh revision) in its
  `next(ctx)`. A `pass` transition to `completed` from such a stage is
  honoured only when `reviewed.tree === current.tree === the tree of the
latest work-stage gate`; otherwise the engine itself records
  `reject/revision_moved` back to the same stage (a new round) — the
  workflow definition never has to declare that self-edge. If the repository
  moves again between the fresh fingerprint and appending a _non-completing_
  gate (for example a `reject → failed` gate), the fresh revision is still
  recorded but the gate's original decision, reason and `next` are kept: the
  re-decision path applies only to a gate that would approve completion.

- **New journal record types**, written by the scheduler through the store
  (never `appendRecord` directly): `gate.recorded`, `run.blocked`,
  `run.unblocked`, `delivery.reconciled` (`src/journal/control-records.ts`),
  plus optional fields on `run.opened` (`input`), `request.dispatched`
  (`request`, `target`, `revision`) and the plan (`AgentSpec.args`,
  `Limits.maxFormatRepairs`, `RunPlan.checks`). New reducer refusal reasons:
  `gate_subject_unknown`, `gate_subject_stale`, `gate_mismatch`,
  `gate_exists`, `round_invalid`, `run_blocked`, `not_blocked`,
  `dispatch_not_ambiguous`, `reconcile_exists`, `assignment_mismatch`, and
  `dispatch_not_latest` (an accepted-first dispatch — see below — must also
  name the stage's current latest attempt). New counters: `rounds`,
  `gatesByDecision {pass, reject}`, `gatesByGate`, `formatRepairsByVisit`,
  `workRetriesByVisit`, `blocks`, `reconciliations {delivered, abandoned}`.
  When a plan lists `checks`, the reducer additionally refuses a
  `gate.recorded.next.stageId`/gate id that names neither a plan stage nor a
  listed check (`stage_unknown`); a plan without `checks` keeps the lenient
  rule.

- **A worker that submits before its own dispatch is recorded still keeps
  the dispatch's revision.** The reducer accepts exactly one
  `request.dispatched{delivery:"started"}` for an attempt that is already
  accepted but has no dispatch record yet, as long as that attempt is still
  the stage's latest (`dispatch_not_latest` otherwise) — a fast worker never
  loses the pre-delivery revision fingerprint that revision binding depends
  on.

- **Agent kind table (D10).** `src/scheduler/launch.ts` turns a resolved
  `{kind, model, args}` into runtime launch arguments; only `"claude"` is
  supported today (`agent_kind_unsupported` otherwise, checked at admission
  before any pane opens). The engine adds only `--model <model>` (when given)
  and `--add-dir <runDir>`; it never adds permission flags — those are
  caller-supplied `args`. Before every dispatch the scheduler requires the
  tracked observation's terminal id to equal the assignment's; a mismatch
  ends the run `failed{reason:"agent_replaced: …"}`, and a `gone` observation
  ends it `failed{reason:"agent_gone: …"}`.

- **Worker request (D11).** The rendered request (§ see
  [communication.md](communication.md#implemented-now-p3)) is persisted to
  `requests/<stageId>/visit-<n>/attempt-<m>/request.md` (mode `0444`, set on
  the still-open file descriptor with `fchmodSync` after `fsync` and before
  `close`, never by path — this applies to every engine-owned file, including
  check evidence), hashed and recorded, and delivered as the identical text.
  Before rendering any request that references an accepted artifact or check
  evidence, the driver resolves each declared `InputRef` and re-hashes it
  against its journal record (`acceptedCopyProblem`); a mismatch ends the run
  `failed{reason:"input_artifact_altered: …"}` before any dispatch, and a
  declared input whose accepted artifact or check evidence does not exist at
  all ends the run `failed{reason:"input_unresolved: <label>: …"}` before any
  fingerprint, attempt or request write — a declared input is never silently
  dropped. An observe call that fails with a structured runtime error (not a
  timeout) ends the run at once, `failed{reason:"runtime_error: <code>: agent
<id>: <message>"}`; a `timeout` ends the run the same way only after three
  consecutive timeouts for that agent (any successful observation resets the
  count), since one slow poll is not evidence the agent is gone.

- **Cancellation (D12).** `runWorkflow({signal})` terminates
  `cancelled{reason:"cancel requested"}` on abort and stops owned panes
  unless `keepPanes` is set; a second SIGINT/SIGTERM at the CLI exits at once
  without writing. External termination (`woof run cancel`, or any
  `terminateRun` call) is detected on the scheduler's next tick, or as soon
  as one of its own store writes is refused `run_closed`; a late `woof
submit` after termination is refused `run_closed` (p1). Settling always keeps
  the recorded terminal outcome: a pane that cannot be stopped (an agent last
  observed `gone` is skipped, since it has no pane left) does not change
  `RunResult.outcome`, but the driver returns `error: {reason:
"runtime_cleanup_failed", message: "could not stop <runtime> (pane <id>):
…"}` naming every pane it could not close; the CLI prints its normal
  rejection line with that `result` attached and exits 3.

- **`woof run build-review`** (`src/cli.ts`) is the CLI entry point for the
  scheduler: parses flags, self-validates the built-in definition, reads and
  validates input, runs admission (`admitWorkflow`: input → repository/
  top-level/revision → run-dir/repository overlap check → agent kind
  resolution → limits → plan), resolves a runtime (the Herdr CLI adapter,
  requiring `HERDR_ENV=1` and `HERDR_PANE_ID`, or `--runtime-module` for
  tests — a factory result missing or misshaping any `RuntimeAdapter` method
  is rejected `runtime_unavailable`, exit 3, naming what is missing or
  invalid, before any run opens), opens the run and calls `runWorkflow` with
  the repository admission already resolved: the driver runs every pane,
  check and fingerprint against that same path and never calls
  `definition.repository(input)` again. `runWorkflow` also resolves
  `options.runDir` once to one absolute, symlink-resolved canonical path
  (`realpath(resolve(runDir))`, falling back to the plain resolved path when
  it cannot be resolved) and uses that same canonical path for every read,
  write, env var, rendered request text and the returned `RunResult` —
  including `RunResult.runDir` — even when a relative or symlinked `runDir`
  was passed in; admission and the launched agent's `--add-dir` still use the
  run directory exactly as given, so both name the same directory, one
  canonical and one as supplied. `woof run cancel <run-dir>` records
  `terminateRun{outcome:"cancelled"}` for a scheduler that may still be
  running elsewhere. Neither command is hosted: each is a foreground CLI
  process, and a killed scheduler leaves a non-terminal run whose only
  resolution is `woof run cancel`.
