# Checkout policy and workflow composition

Status: implementation plan for `feat/composition`, updated as phases land. The
"Implemented" notes at the end of each phase say what shipped; everything else
is the plan.

## Goal

A verified `feat/composition` branch that gives Woof:

1. a **checkout policy in the run input**: a run works in a new Herdr worktree
   by default when it is started inside Herdr, in the caller's tree otherwise,
   and a nested run inherits its parent's checkout;
2. **"a workflow can be a step"**: a stage kind that runs another workflow as a
   child run, maps its input declaratively from the parent's input and accepted
   outputs, and accepts the child's terminal result as the step's output, with
   journal, snapshot, events, run view and `woof runs` showing both runs and
   their link;
3. a **built-in composite** (`plan` and `auto-build` = `plan` → `build-review`)
   that proves (1) and (2) live with real agents in Herdr.

The engine stays generic: nothing below names a built-in workflow.

Source material: the [talk summary](../agents-vs-workflows-talk-summary.md) §8
("a workflow can be a step", "an agent can be a step") and §3 (prefer readable
top-to-bottom workflow code).

## Decisions

### Checkout lives in the run input, peeled off by the engine

Runs are started by agents or scripts that build a `woof run start --input`
document, so the policy is data in that document, not a CLI flag. Every
workflow input may carry a reserved top-level key:

```json
{ "checkout": { "mode": "worktree", "branch": "woof/x", "base": "main", "label": "x", "keep": true } }
{ "checkout": { "mode": "current" } }
{ "checkout": { "mode": "path", "path": "/abs/existing/worktree" } }
```

The engine removes `checkout` from the input **before** the definition's
`validateInput` sees it and validates it with one shared validator
(`src/scheduler/checkout.ts`). Consequences, chosen deliberately:

- every workflow, including project-authored ones, gets the policy without
  changing its validator; the key name `checkout` is reserved at the top level
  of every workflow input;
- `input.json` records the definition's validated input (without `checkout`),
  and `run.opened.checkout` records the resolved checkout. The launcher's
  pre-admission and the host's admission peel the same way, so the launcher's
  `expectedInputSha256` still matches the host's `run.opened.input`.

This deviates from the brief's suggestion to add `checkout` to each built-in's
exact-keys list: peeling keeps the engine generic and needs no per-workflow
code.

### Resolution

`source` is the repository the definition names (`repository(input)`), which
admission already requires to be a git top level and, with configuration, the
resolved project root.

| Situation                                                           | Default                             |
| ------------------------------------------------------------------- | ----------------------------------- |
| top-level run, `HERDR_ENV=1`, Herdr runtime (no `--runtime-module`) | `{mode:"worktree"}`                 |
| top-level run otherwise (outside Herdr, or a test runtime module)   | `{mode:"current"}`                  |
| nested (child) run                                                  | the parent's checkout, as `current` |

- `worktree` requires Herdr: `herdr worktree create --cwd <source> --branch
<branch> [--base <ref>] --label <label> --no-focus`. Branch default
  `woof/<runId>`, label default `woof:<workflow>`. Outside Herdr it is refused
  `checkout_unsupported` (no plain `git worktree add` fallback: Herdr owns
  worktrees). `--trust-repository` is never passed.
- `current` uses `source`.
- `path` uses an existing git top level given by the caller (for example a
  worktree created by a wrapping script); nothing is created.
- A child run's input may omit `checkout` or say `{mode:"current"}`; any other
  mode is refused `input_invalid` ("nested runs inherit the parent's
  checkout"). The child's repository is the parent's admitted repository.

The resolved checkout is an admission parameter, not an input rewrite:
`admitWorkflow({..., checkout: {path}})` validates `source` exactly as today
(top level, `project_mismatch`), then uses `checkout.path` as the run's
repository for the revision, the run-directory overlap check, panes, checks
and fingerprints.

### Writable definitions refuse a dirty tree

A definition may declare `checkout?: "any" | "writable"` (default
`"writable"`). For a top-level run whose checkout is `current` or `path`, a
writable definition refuses a tree with uncommitted or untracked changes
(`git status --porcelain` non-empty) as `checkout_dirty`: the builder's edits
would mix with the operator's and revision fences would review them. `any`
accepts a dirty tree (read-only workflows such as `plan`). A fresh worktree is
clean by construction, and an inherited checkout is never re-checked (the
parent's earlier steps legitimately changed it).

### Where the worktree is created, and the host pane

- `woof run start --host herdr-pane`: the launcher resolves the checkout after
  its (built-in) pre-admission and before `launch.json`. With a worktree it
  runs the host in the **root pane of the new worktree workspace** (instead of
  `tab create`), so the host view and every agent tab live in that workspace;
  the verified workspace id travels as `HERDR_WORKSPACE_ID`, as today. The
  resolved checkout is written into `launch.json` for the host. Every launcher
  failure after creation removes the worktree it created.
- `--host foreground` inside Herdr: the host creates the worktree before
  admission; the runtime factory receives the new workspace id, so agent tabs
  open there while the host stays in the caller's pane.

Observed Herdr 0.9.1 shapes (recorded from a probe on a scratch repository):

```json
{"id":"cli:worktree:create","result":{"type":"worktree_created",
 "root_pane":{"pane_id":"w9K:p1","tab_id":"w9K:t1","workspace_id":"w9K","cwd":"/Users/…/.herdr/worktrees/probe-repo/probe-one", …},
 "tab":{"tab_id":"w9K:t1","workspace_id":"w9K", …},
 "workspace":{"workspace_id":"w9K","label":"woof-probe", "worktree":{"checkout_path":"…/probe-one","repo_root":"…/probe-repo", …}, …},
 "worktree":{"branch":"probe/one","path":"/Users/…/.herdr/worktrees/probe-repo/probe-one","open_workspace_id":"w9K", …}}}
{"error":{"code":"worktree_create_failed","message":"fatal: invalid reference: nosuchref"},"id":"cli:worktree:create"}   (exit 1)
{"id":"cli:worktree:remove","result":{"type":"worktree_removed","path":"…/probe-one","workspace_id":"w9K","forced":false}}
```

`worktree remove --workspace` removes the checkout and its workspace but keeps
the branch.

### Recording and cleanup

`run.opened` gains two optional fields (additive at schemaVersion 1; old
journals read unchanged):

- `checkout: {mode, path, source, branch, base, workspaceId, created, keep,
inherited}` — `created` is true only for a worktree this run created;
  `inherited` is true for a child run;
- `parent: {runId, runDir, stageId, visit, attempt}` on a child run.

The snapshot projects both (`checkout`, `parent`), `woof status` and the run
view's opening block print a `checkout` line, and `config.json` keeps recording
the admitted repository (now the checkout path).

Cleanup: worktrees Woof created are kept by default (the operator inspects and
merges the branch). `keep: false` removes the worktree (`herdr worktree remove
--workspace <id>`) after a **completed** run only; the branch stays. The
removal is not a journal fact (nothing may follow `run.terminated` except
`host.exited`); it is reported in the host log and the host's result line.

### A workflow can be a step

New stage kind in `WorkflowDefinition.stages`:

```ts
interface WorkflowStage<Input> {
  kind: "workflow";
  stageId: string;
  workflow: { name: string }; // resolved like --workflow: project, user, built-in
  input(ctx: RequestContext<Input>): unknown; // the child's raw input (validated by the child)
  next(ctx: StageGateContext<Input>): Transition;
}
```

- `start` may be an agent or a workflow stage; `agents` may be empty when the
  definition has a workflow stage. The run plan gains an optional
  `workflows: [{stageId, workflow: {name}, verdicts}]` next to `checks`;
  `plan.agents` may be empty only when `workflows` is not.
- Verdicts of a workflow stage are the child's terminal outcomes
  `completed | failed | exhausted | cancelled`; `next` routes on
  `ctx.accepted.verdict`. The accepted status is `completed` exactly when the
  child completed. There is no `onFailedStatus`: `next` always decides.
- Input mapping is declarative data: `input(ctx)` sees the parent's validated
  input and `ctx.history`, which now also carries `children[stageId]` — the
  latest child result of each workflow step: `{runId, runDir, outcome, reason,
artifacts: Record<childStageId, AcceptedRef>}` where each artifact reference
  points at the parent's own immutable copy. So "the terminal result of a
  workflow aligns with the input of another": a mapping is a small pure
  function from the parent input and earlier step results to the next child's
  input.

**Input artifacts.** A child (or any run) must be able to receive an artifact
from outside its run directory by digest. A definition may declare
`inputArtifacts?(input): Array<{label, path, sha256}>`; admission checks each
file's digest (`input_invalid` otherwise), the run open copies each into
`<runDir>/inputs/<n>/<basename>` (read-only) and journals them on
`run.opened.inputArtifacts`; a stage names one with the new `InputRef`
`{label, from: {input: "<label>"}}`, re-hashed before every rendering like
every other input. `build-review` accepts an optional input
`inputs: [{label, path, sha256}]` for this; `auto-build` maps the plan step's
`plan.md` into it. Copying into the child's run directory keeps each run
self-contained: agents only get `--add-dir <their own runDir>`.

**Identity.** A child run is a sibling of its parent in the parent's runs
directory: `runDir = dirname(parentRunDir)/<childRunId>`, `childRunId =
<parentRunId>.<stageId>.<visit>` (ids allow `.`; attempts of a visit are always
1, see below). It is an ordinary run: its own journal, locator, `config.json`,
`input.json`, host claim (same pid) and `host.claimed`/`host.exited`, so `woof
runs`, the index, `woof status`, the Web UI and `woof watch` see it as a run.
`run.opened.parent` links back; the parent's journal links forward.

**Journal (parent).** Two new records, additive at schemaVersion 1, each 1:1
an event:

- `stage.child_opened {stageId, visit, attempt, child: {runId, runDir,
workflow: {name, version}}, input: {sha256, bytes}}` — opens the step's
  attempt (it plays the role `attempt.opened` plays for an agent stage and
  counts as a visit for `maxVisitsPerStage` and rounds);
- `stage.child_result {stageId, visit, attempt, child: {runId, outcome,
reason, limit?}, status, verdict, receiptId, artifact: {path, acceptedPath,
sha256, bytes}, artifacts: [{stageId, acceptedPath, sha256, bytes}]}` — the
  step's accepted submission. `artifact` is the child's `RunResult` published
  as `accepted/<stage>/visit-n/attempt-1/result.json`; `artifacts` are copies
  of the child's latest accepted artifact per child stage under
  `accepted/<stage>/visit-n/attempt-1/<childStage>/<file>`, each hashed and
  checked against the child's journal before it is copied.

The reducer folds both into the same attempt map as agent attempts (agent id
null, `child` set), so gates, visit and round limits, `latestAcceptedByStage`,
`InputRef {from:{stageId}}` (which yields `result.json`), integrity checks and
`RunResult.artifacts` work unchanged. An `InputRef` may also say
`{from: {stageId, artifact: "<childStageId>"}}` to receive one copied child
artifact. `attempt.opened`, `submission.*`, `request.dispatched` and
`run.blocked` for a workflow stage are refused (`stage_unknown` /
`owner_mismatch`), so a worker cannot submit to a step.

**Hosting.** In process, one host, one liveness story. The scheduler core gets
two new actions: `open_child` (the host admits and opens the child, then the
parent journals `stage.child_opened`, and the child's `runWorkflow` runs as a
background promise) and `record_child` (once that promise settles: copy,
hash, journal `stage.child_result`). Between them the parent keeps ticking with
`wait {reason: "awaiting_child"}`, so its own deadline, cancellation and agent
observation keep working. The child hosting itself (configuration, definition
load, admission against the parent's checkout, runtime creation, claim, open)
is a host concern passed to the driver as `children`; the scheduler never
loads a module. A workflow stage in a run without `children` fails
`definition_contract_violated`.

**Cancellation.** The child's abort signal follows the parent's: aborting the
parent (signal, or the parent's journal terminated by `woof run cancel`, which
the parent's next tick settles) aborts the child with the reason `parent run
<id> ended`, and the parent's settle waits for the child to settle before the
host exits. Cancelling only the child ends the child `cancelled`; the parent
records that result and its `next` decides.

**Limits.** A child's limits are its own (its input and configuration). The
parent bounds the step with its own `maxVisitsPerStage`, `maxRounds` and
`runTimeoutMs` (its deadline aborts the child). Each visit has exactly one
attempt: a child that could not be admitted is a definition/input bug and ends
the parent `failed` with `child_rejected: <reason>: <message>` rather than a
retry; a failed child is a result, retried only by `next` routing to a new
visit.

**Observability.** Run view rows `Workflow started · plan v1 → run <id>` and
`Workflow completed|failed|… · run <id>`; the stage map draws workflow stages;
`woof runs` shows `parent` (and `--json` carries it); `woof events --all`
already reads every run in the index, children included; snapshots carry
`stages[].kind`, `stages[].workflow` and `attempts[].child`. `foldEvents ==
readSnapshot` holds for both journals.

### Built-ins

- `plan` (checkout `any`): one planner stage writes `plan.md`. Input: `repo`,
  `task`, optional `constraints`, `instructions`, `agents`, `limits`, and
  `publish: {path}` — when set, the planner also writes the plan to that repo
  path and commits it (scenario (a); pushing is left to the caller's
  instructions because the fixture has no remote).
- `auto-build`: workflow step `plan` → workflow step `build`
  (`build-review`), the build input mapped from the parent input plus the plan
  step's `plan.md` artifact (path + digest) — scenario (c), one branch, one
  worktree. A failed, exhausted or cancelled child fails the parent.
- Scenario (b) needs no new code: `build-review` with `checkout:
{mode:"worktree", base:"<branch with the merged plan>"}`. The two `woof run
start` inputs for (a) and (b) are documented in
  [initial workflows](../workflows/initial-workflows.md).
- `plan-build-review` is unchanged.

## Phases

0. This note.
1. Checkout: validator and resolver, Herdr worktree parser and fake-Herdr
   support, admission `checkout` parameter and dirty rule, launcher/host
   wiring, `run.opened.checkout`, snapshot/status/run view, docs, changeset.
2. Workflow stage: definition and plan validation, input artifacts, records,
   reducer, snapshot, events, core actions, driver, host child hosting,
   cancellation, run view and `woof runs`, docs, changeset.
3. `plan` and `auto-build` built-ins, scripted-runtime tests, docs,
   changeset.
4. Live proof `scripts/live/composition.mjs` and recorded evidence.

Each phase is one commit (no push, no PR), verified with `bun run build` and
targeted vitest files while iterating and one full `bun run verify` at the end
of the phase.

## Cut list

- A `defineWorkflow({...})` top-to-bottom helper (brief phase 5): cut.
  [Architecture decisions](../decisions/architecture.md) rejects a fluent
  workflow API as a premature public contract; composite definitions stay
  ordinary `WorkflowDefinition` objects.
- Parallel child runs, crash resume of a parent or child, re-hosting.
- Following child rows inside the parent's host view (the child has its own
  `woof watch`; the parent shows start and end rows).
- Pushing from the `plan` workflow; journaling worktree removal.
