# Initial workflows

Status: required examples and recommended stage mappings. `build-review` is now
an executable, built-in workflow definition, runnable via `woof run
build-review` (p3; see "Implemented now (p3)" below). `plan-build-review` is
still not an executable definition in the current checkout (phase 5).

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

## Implemented now (p3)

Real shipped behavior for the built-in `build-review` definition — not design
intent. Source: `src/workflows/build-review.ts`.

- **Executable via `woof run build-review --input <path|-> --run-dir <dir>`.**
  Input is validated with an exact key set: `schemaVersion: 1`, `repo` (absolute
  git work tree path), `task {title, description, acceptanceCriteria,
context?}`, optional `instructions {builder?, reviewer?}`, optional `verify
{command, timeoutMs}`, `agents {builder, reviewer}` each
  `{kind, model, args}`, and optional `limits` (each key optional, same bounds
  as `Limits`, defaulting to `maxAttemptsPerVisit: 2, maxVisitsPerStage: 3,
maxRounds: 3, maxFormatRepairs: 2, runTimeoutMs: 7200000, readinessWaitMs:
180000, blockedWaitMs: 600000, deliveryTimeoutMs: 60000`). `task` and
  `instructions` together are capped at 24 KiB (headroom under the 32 KiB
  request cap).
- **Stages:** `build` (builder) → `verify` (an engine-run check, only when
  `input.verify` is given — otherwise the build/repair gate routes straight to
  `review`) → `review` (reviewer, verdicts `pass`/`fail`) → `repair`
  (same builder). A failing check routes to `repair`; a `review` verdict
  `fail` routes to `repair` with `requires: "round"`; `repair` re-enters
  `verify` or `review` exactly like `build`. `review` is the round stage.
- **Revision binding (`bindsRevision: true` on `review`).** A `pass` verdict
  completes the run only when the review's dispatched-against tree equals the
  current repository tree and equals the tree of the latest builder/repair
  gate; otherwise the engine records `reject/revision_moved` and opens another
  review round (bounded by `maxRounds`). A passing review from an earlier
  revision is never reported as approval of newer work.
- **Outcome.** `RunResult.artifacts.review` is non-null only when the run
  completed; `artifacts.completion` is the accepted build/repair submission
  the completing review was dispatched against; `artifacts.verification` is
  the latest check evidence, when a `verify` command was configured.
- **`plan-build-review` is still not executable** — the phase 5 planner stage
  described below has no definition module yet.

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
