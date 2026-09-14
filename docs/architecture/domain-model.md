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
