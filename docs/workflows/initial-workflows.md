# Initial workflows

Status: required examples and recommended stage mappings. `build-review` is now
an executable, built-in workflow definition, runnable via `woof run
build-review` (p3; see "Implemented now (p3)" below). `plan-build-review` is
also now an executable, built-in workflow definition, runnable via `woof run
start --workflow plan-build-review` (p5; see "Implemented now (p5)" below).
`plan` and the composite `auto-build` followed with workflow composition (see
"Plan and auto-build" below).

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
  Input is validated with an exact key set: `schemaVersion: 1`, `repo` (an
  absolute path, required at admission to be the top level of a git work tree
  — `git rev-parse --show-toplevel`; a nested directory is rejected
  `repo_invalid`, naming both the given path and the resolved top level),
  `task {title, description, acceptanceCriteria,
context?}`, optional `instructions {builder?, reviewer?}`, optional `verify
{command, timeoutMs}`, optional `agents` (each of `builder`/`reviewer`
  optional; when present, each is `{kind, model, args}` — an omitted role
  resolves from configured roles, p4, see "Implemented now (p4)" below), and
  optional `limits` (each key optional, same bounds as `Limits`; an absent
  key falls back to configuration, then to this workflow's own default:
  `maxAttemptsPerVisit: 2, maxVisitsPerStage: 3,
maxRounds: 3, maxFormatRepairs: 2, runTimeoutMs: 7200000, readinessWaitMs:
180000, blockedWaitMs: 600000, deliveryTimeoutMs: 60000`). `task.context`,
  when given, is validated recursively as a JSON value: `null`, booleans,
  finite numbers, strings, arrays (checked by index, so a hole is refused) and
  plain objects only — `undefined`, functions, `bigint`, symbols, non-finite
  numbers, non-plain objects (for example a `Date`), a cycle, or nesting past
  1000 levels are all refused, each reported at its exact path (for example
  `task.context.nested`). `task` and `instructions` together are still capped
  at 24 KiB compact JSON, and admission additionally renders, with the real
  `renderRequest` and the definition's own `request()` functions, the largest
  request this input could produce (the review, and the repair entered by
  either the review or the verify check, each with every input it names, at
  the admitted maximum run-directory length and maximal counters/ids/digests)
  and refuses the input when that render would exceed the 32 KiB request cap
  — a compact-JSON context can still be too large once pretty-printed into a
  request.
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

## Implemented now (p4)

Real shipped behavior for build-review's configuration-driven agents/limits
and the verify check's fingerprint interaction — not design intent. Source:
`src/workflows/build-review.ts`.

- **`agents` and each role in it are optional.** `resolveAgents` returns only
  the roles the input actually names; an omitted `builder`/`reviewer` (or an
  input with no `agents` at all) resolves from the project's or user's
  `roles/<role>.json`, else the built-in `{kind:"claude", model:null,
args:[]}` role. `limits` keys fall back the same way: an input key, then
  project/user `defaults.limits.<key>`, then this workflow's own
  `limitDefaults` (`BUILD_REVIEW_DEFAULT_LIMITS`, the values above). An input
  that supplies every field behaves exactly as it did before p4.
- **Verify outputs must be gitignored (carry-over C-FP).** `revisionOf`
  fingerprints the repository through a temporary git index (`git add
--all`), which honours `.gitignore`, `.git/info/exclude` and
  `core.excludesFile`. A verification command that writes files git does not
  ignore changes the fingerprint after it runs, so a review dispatched
  against the pre-verify tree no longer matches — the engine's revision
  binding (see
  [domain model](../architecture/domain-model.md#implemented-now-p3))
  records `reject/revision_moved` and opens another round rather than a false
  approval; this stays a bounded spurious round, never a false approval.
  Woof adds no ignore globs of its own (a second ignore engine would diverge
  from git's own rules); a project's `verify.command` should write any
  report, log or cache file to a path already covered by that project's
  `.gitignore`.

## Plan-build-review

Add a planner before the same build/review loop. The planner receives the task
and constraints and produces `plan.md` with a validated envelope. The builder
receives that plan artifact alongside the original input.

This second workflow proves that the engine accepts a new agent, stage, artifact
contract and transition without changes specific to the workflow's name. An
optional plan-approval gate must declare its result, attention behavior and
finite waiting policy.

## Implemented now (p5)

Real shipped behavior for the built-in `plan-build-review` definition — not
design intent. Source: `src/workflows/plan-build-review.ts`.

- **Executable via `woof run start --workflow plan-build-review --input <path|->`**
  (also `--host foreground`/`herdr-pane`, like any other run). Input adds
  `constraints?: string[]` (reaches the planner's request only) and an
  `instructions.planner?` key to build-review's shape; `agents`/`limits` gain a
  `planner` entry alongside `builder`/`reviewer`. `PLAN_BUILD_REVIEW_DEFAULT_LIMITS`
  equals build-review's defaults unchanged (`maxAttemptsPerVisit: 2,
maxVisitsPerStage: 3, maxRounds: 3, maxFormatRepairs: 2, runTimeoutMs: 7200000,
readinessWaitMs: 180000, blockedWaitMs: 600000, deliveryTimeoutMs: 60000`): the
  planner adds one stage visit, not a loop, so no bound needed raising to fit it.
- **Stages and edges:** `plan` (planner, artifact `plan.md`) → `build` (builder,
  artifact `completion.md`) → `verify` (an engine-run check, only when
  `input.verify` is given) → `review` (reviewer, verdicts `pass`/`fail`, the
  round stage, revision-binding) → `repair` (same builder) → back to `verify` or
  `review`. There is **no re-planning**: a failed review or a failed check both
  route to `repair`, never back to `plan` — re-planning would need a second
  round counter and an answer to whether the old plan is still canonical, and
  this version takes no position on either. There is also **no plan-approval
  gate**: the plan reaches the builder unconditionally once written; adding an
  approval step needs its own attention/waiting policy this version does not
  define.
- **The plan is an `InputRef` on every builder turn, not only the first.** The
  accepted `plan.md` (`{label: "plan", from: {stageId: "plan"}}`) is the first
  entry in every `build` and `repair` request's `inputs`, addressed by path,
  receipt and sha256 and re-hashed before rendering — never inlined or
  paraphrased. A repair entered by the review stage also carries the accepted
  review as a second input, with the request stating the review is canonical
  for that repair (see [authoring](authoring.md#implemented-now-p5)); a repair
  entered by a failed `verify` check carries the verification output instead,
  and — because that repair was never given a review to point to — the
  request does not say any review is canonical for it.
- **No engine change was needed.** `RunResult.artifacts` (`{completion, review,
verification, lastAcceptedByStage}`) already carried `plan`, `build`, `repair`
  and `review` for this workflow's own stage ids with no engine-side edit;
  `validateWorkflowDefinition(planBuildReviewWorkflow)` is `ok` and the
  scheduler's `decide()` grew no branch for it (`test/plan-build-review.cli.test.ts`).
- **Live-verified.** `scripts/live/plan-build-review.mjs` runs the workflow
  end to end against real `claude` agents through Herdr: `docs/research/plan-build-review-live.log`
  records 13/13 gates passing, including gate 6 (the plan reaches every
  builder request by reference, never inlined) and gate 10 (Herdr status and
  an external observer agree with the SDK state, 0 disagreeing).

## Plan and auto-build (composition)

Two built-ins added with workflow composition — see
[Checkout policy and workflow composition](../design/composition.md). Source:
`src/workflows/{plan,auto-build}.ts`.

- **`plan`**: one `planner` writes `plan.md`. Input: `schemaVersion`, `repo`,
  `task`, optional `constraints`, `instructions.planner`, `agents.planner`,
  `limits`, and `publish: {path, push?}`. With `publish` the planner also writes
  the plan to `path` in the repository and commits only that file (and pushes
  with `push: true`). Engine-run checks confirm the checkout's HEAD commit
  holds exactly the accepted `plan.md` at that path (`published`: the path is
  in HEAD; `committed`: the tree has no other version of it; `matches`: it is
  byte-for-byte the accepted plan). A failed check sends the planner back,
  bounded by `maxVisitsPerStage` (default 2). A last check, `changed`, confirms
  the run committed it: a commit since the revision on the run's first dispatch
  touches the path. When that exact plan was already committed there, no commit is
  possible, so the run fails with `not_changed`.
  Access `writable`: it never starts on a dirty `current` tree.
- **`auto-build`**: two workflow steps and no agents. `plan` runs the `plan`
  workflow; `build` runs `build-review` with the accepted `plan.md` as the input
  artifact `plan` (the builder is told to follow it and to commit each turn's
  change on the branch, never pushing; the reviewer to check the change against
  it). Input: build-review's fields (`task`, `verify`,
  `instructions.{planner,builder,reviewer}`, `agents.{planner,builder,reviewer}`),
  plus `constraints` and `publish` for the plan step and `limits` for this run
  (default `runTimeoutMs` 4 h, one visit per step). Both children's inputs are
  validated up front, so a bad field is refused before any step runs. A step
  whose child does not complete fails the run (`plan_failed`,
  `build_exhausted`, …).
- **`build-review` accepts `inputs: [{label, path, sha256}]`** (at most 8): files
  from outside the run every build, review and repair request names by path
  and digest after the run copies them into `inputs/<n>/`.

### Three scenarios as `woof run start` inputs

Inside Herdr each top-level run below works in a new Herdr worktree by default.

(a) Plan in its own worktree and commit the plan on its branch
(`woof run start --workflow plan --input a.json`):

```json
{
  "schemaVersion": 1,
  "repo": "/abs/repo",
  "task": {
    "title": "Add slugify",
    "description": "Add slugify(text) in src/slugify.mjs.",
    "acceptanceCriteria": ["slugify lowercases its input"]
  },
  "publish": { "path": "docs/plans/slugify.md", "push": true },
  "checkout": { "mode": "worktree", "branch": "plan/slugify" }
}
```

(b) Once `plan/slugify` is merged, build and review on a branch based on it,
with the merged plan as a checked input (`woof run start --workflow
build-review --input b.json`; `sha256` is `shasum -a 256
docs/plans/slugify.md` on the merged branch):

```json
{
  "schemaVersion": 1,
  "repo": "/abs/repo",
  "task": {
    "title": "Add slugify",
    "description": "Implement docs/plans/slugify.md.",
    "acceptanceCriteria": ["slugify lowercases its input"]
  },
  "inputs": [{ "label": "plan", "path": "/abs/repo/docs/plans/slugify.md", "sha256": "<hex>" }],
  "checkout": { "mode": "worktree", "branch": "build/slugify", "base": "main" }
}
```

(c) Both on one branch in one worktree (`woof run start --workflow auto-build
--input c.json`): the same `task`, optional `publish` and `verify`, and
`"checkout": {"mode": "worktree", "branch": "auto/slugify"}`. The plan and
build-review children inherit that worktree.

## Direct delegation and later research

Direct delegation starts or addresses one agent for one assignment and returns
an artifact-backed result. It may be implemented with the runtime SDK or a
single-stage workflow; callers should not need to author a graph for it.

A later research workflow can gather independent research artifacts, ask a critic
to review them, and produce a synthesis artifact. Discussion and critique loops
still require explicit bounds. A parallel scheduler, provider expansion and UI
work should be scoped separately from the first acceptance flow.
