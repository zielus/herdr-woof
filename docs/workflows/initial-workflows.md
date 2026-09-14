# Initial workflows

Status: required examples and recommended stage mappings. These are not executable
definitions in the current checkout.

## Build-review

Input is a structured object containing the task, acceptance criteria and project
context. It can also contain a target change reference and verification policy.
The workflow assigns one builder and one reviewer for the run.

```text
build → verify → review ── pass → completed
          │        │
          │        └─ fail → repair → verify → review
          └─ fail → repair
```

`verify` is a recommended deterministic check stage when a project provides a
verification command. The required product behavior is the builder/reviewer loop;
the exact command-stage API is an implementation choice.

| Stage  | Owner                            | Substantive output                         | Next decision                                                           |
| ------ | -------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| Build  | Builder                          | Repository changes and completion artifact | Proceed to verification or review after contract validation.            |
| Verify | Engine-supported check operation | Command result and retained evidence       | Passing checks reach review; failing checks supply evidence for repair. |
| Review | Reviewer                         | Review artifact tied to the current change | Valid `pass` completes; valid `fail` goes to repair.                    |
| Repair | Same builder                     | Updated change and completion artifact     | Re-run checks and review the new change.                                |

The review artifact includes findings and references. The builder reads that
accepted version directly. A later review produces another artifact; it does not
overwrite the first. The reviewer continues in its session where continuity is
required by this workflow.

A check failure may loop through repair without reaching review. A review-round
limit alone therefore does not bound this workflow: enforce a total step/visit
bound or a separate repair/check bound as well. Work retries and format repairs
consume their own counters.

On success, return the run identity, outcome, final change reference, completion
artifact, passing review artifact and verification references. On other exits,
return the reason, failed or blocked location, counters and last accepted outputs.
Never return a passing review from an earlier revision as approval of newer work.

## Plan-build-review

Add a planner before the same build/review loop. The planner receives the task
and constraints and produces `plan.md` with a validated envelope. The builder
receives that plan artifact alongside the original input.

This second workflow proves that the engine accepts a new agent, stage, artifact
contract and transition without changes specific to the workflow's name. An
optional plan-approval gate must declare its result, attention behavior and
finite waiting policy.

## Direct delegation and later research

Direct delegation starts or addresses one agent for one assignment and returns
an artifact-backed result. It may be implemented with the runtime SDK or a
single-stage workflow; callers should not need to author a graph for it.

A later research workflow can gather independent research artifacts, ask a critic
to review them, and produce a synthesis artifact. Discussion and critique loops
still require explicit bounds. A parallel scheduler, provider expansion and UI
work should be scoped separately from the first acceptance flow.
