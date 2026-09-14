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
  non-empty unique-id `agents: AgentSpec[]` (`agentId, role, kind, model`), a
  non-empty unique-id `stages: StageSpec[]` (`stageId, agentId, verdicts`,
  each `agentId` naming a planned agent), and `limits: Limits`
  (`maxAttemptsPerVisit, maxVisitsPerStage, maxRounds`, each a safe integer
  1–1000; `runTimeoutMs, readinessWaitMs, blockedWaitMs, deliveryTimeoutMs`,
  each a safe integer 1–604 800 000 ms, i.e. seven days — a lead decision:
  every wait must be bounded, so an unbounded duration is not a limit). A run
  may also be plan-less (p1's shape); every plan-referencing check below is
  then skipped. `validateRunPlan` rejects unknown keys, duplicate ids, and an
  unresolved stage `agentId`, one detail per offending field path.

- **Run status is derived, never recorded.** There is no `run.status`
  record. `created` (only `run.opened`), `starting` (at least one
  `agent.assigned`, no dispatch yet), `running` (at least one
  `request.dispatched`, not terminated), and the terminal statuses (from
  `run.terminated.outcome`) are computed by the reducer from whichever
  records are present so far. `blocked` is never derived in p2: it needs a
  `run.blocked` record, which does not exist until phase 3.

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
  journal can hold. There is no reducer rule for rounds, gates, blocks,
  format repairs or work retries, because those records and loops do not
  exist yet (an unfinished operation must not fake success).

- **Limits are declared, validated and counted — not enforced.** Every
  `Limits` field is required and bounds-checked on every plan; the
  snapshot's `counters` (see [observability](observability.md#implemented-now-p2))
  track `attemptsOpened`, `visitsByStage`, `attemptsByVisit`, dispatch
  outcomes and replacements next to the declared limits, but nothing refuses
  an attempt, visit or round for exceeding one. Enforcement, and the
  response to reaching a limit, is scheduler policy (phase 3).

- **Gate, block and reconciliation are types only.** `GateResult`,
  `GateDecision`, `BlockInfo` and `DeliveryResolution` exist in
  `src/domain/types.ts` so consumers can handle them now. Their journal
  record types (`gate.recorded`, `run.blocked`, `run.unblocked`,
  `delivery.reconciled`) arrive with the scheduler in phase 3; no p2 code
  path writes or reads one.

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
  only in an in-memory tracker; overlaying them onto a snapshot fills
  `agents[].runtime` for display and reports whether any agent was observed.
  A derived snapshot on its own (`deriveSnapshot`/`readSnapshot`/`woof run
show`) always reports `agents[].runtime: null`: no lifecycle value
  completes, accepts or fails an attempt, and runtime observation is lossy
  by construction — transitions between two reads are not seen. See
  [observability](observability.md#implemented-now-p2) for the runtime
  adapter contract itself.
