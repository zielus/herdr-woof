# Authoring a workflow

Status: authoring contract, plus an implemented definition contract and loader
(p3), configuration-driven role/workflow discovery (p4), and a second built-in
workflow plus an external, project-authored one proving the contract
generalizes (p5). See "Implemented now (p3)", "Implemented now (p4)" and
"Implemented now (p5)" below.

A workflow defines how work progresses. Adding a new workflow should normally
mean adding a definition, roles and artifact contracts, without adding a special
case to the engine.

## Definition contents

| Part        | Author supplies                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Identity    | A name and a way to identify the definition used by a run.                                                |
| Input       | A schema for the structured task and context parameters.                                                  |
| Agents      | Named agents bound to role profiles; identity is separate from stage names.                               |
| Stages      | Assigned agent or supported deterministic operation, input mapping, required artifacts and result schema. |
| Transitions | A next stage or terminal outcome for every allowed gate result.                                           |
| Limits      | Finite loop, attempt, format-repair and wait budgets, plus an overall bound.                              |
| Result      | A small structured terminal result referring to accepted artifacts.                                       |

Define input mappings explicitly. For example, `review` receives the task,
acceptance criteria, current change reference, and verification evidence. `repair`
receives the accepted review artifact and belongs to `builder`. Do not send only
a rewritten prose summary of that artifact.

## Validation before execution

Reject missing input fields, unresolved roles, invalid limits, unknown transition
targets, and allowed outcomes without a transition. Check that every potentially
repeating route encounters a finite bound. The implementation should also catch
invalid artifact references and stage dependencies as early as its authoring
format permits.

Request construction and gate evaluation should be predictable functions of
validated input and accepted outputs. They must not secretly start agents or
perform untracked work. If executable TypeScript definitions are chosen, document
that loading them executes project code and test the actual supported runtime.

## Output and gates

Declare the substantive artifact and the envelope separately. A reviewer produces
a review file and a verdict; a planner produces a plan file and a completion
outcome. The engine checks contracts, then the workflow routes on validated
control fields.

Use distinct edges for content rejection and infrastructure failure. A reviewer
requesting changes is expected workflow behavior. A dead worker or an invalid
envelope is an execution problem handled by explicit policy.

## Extending the catalog

First implement [build-review](initial-workflows.md). Then add the planner stage
and plan artifact mapping for `plan-build-review` using the same engine. Keep an
externally authored small workflow in acceptance to prove that built-ins have no
special privileges.

Research/discussion workflows can assign researchers or critics and pass their
artifacts to a synthesis stage. They must also define termination and ownership.
Parallel execution is a separate scheduler capability; do not imply it exists
because several agents are declared in a definition.

## Implemented now (p3)

Real shipped behavior for the definition contract, validation and the loader —
not design intent. Source: `src/scheduler/definition.ts`,
`src/scheduler/loader.ts`, `src/scheduler/admission.ts`.

- **A definition is an ES module whose default export is a `WorkflowDefinition`.**
  It declares `schemaVersion: 1`, `name`/`version` (ids), `agents` (non-empty,
  unique `{agentId, role}`), `stages` (a mix of `AgentStage` and `CheckStage`,
  §3.1), `start` (an agent stage id), `roundStage` (null or an agent stage id),
  and a static `edges` map from every stage/check id to its allowed next ids
  and terminal outcomes (`"completed"`/`"failed"`). Four functions —
  `validateInput`, `resolveAgents`, `resolveLimits`, `repository` — are called
  from caller input, not from a snapshot; every other stage/check function
  (`request`, `next`, `command`) is called by the scheduler from
  snapshot-derived context only, must be synchronous and side-effect free, and
  is guarded: a throw or a malformed return value ends the run
  `failed{reason:"definition_threw: …"}` or is reported as
  `definition_contract_violated`/`transition_undeclared`, never an uncaught
  exception.
- **`validateWorkflowDefinition(value)`** checks this shape before any input is
  read: valid ids; unique stage/check ids across both kinds; every agent
  stage's `agentId` is declared; `start` is an agent stage; `roundStage` is null
  or an agent stage; every function member is a function; a safe, single-file
  `artifactFile` basename; an `edges` entry for every stage and check whose
  every target is a known id or an outcome; and no cycle made only of checks (a
  checks-only cycle would have no visit bound to end it). It never throws and
  returns one `RejectionDetail` per problem.
- **`loadWorkflowDefinition(path)`** (`loadModuleDefault` underneath) loads
  `.js`/`.mjs` everywhere and `.ts` through Node's built-in type stripping
  (erasable syntax only — no `enum`, `namespace`, parameter properties or
  decorators; Node does not strip `.ts` under `node_modules`, so a packaged
  definition must ship compiled `.js`). **Loading a definition module executes
  its code.** Rejections are one of `definition_not_found` (missing file),
  `definition_syntax_unsupported` (Node's `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`/
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), `definition_load_failed` (any
  other import error, including a throwing module body), or
  `definition_invalid` (no default export, or a default export that fails
  `validateWorkflowDefinition`). The built-in `build-review` definition ships
  as a compiled module.
- **Admission** (`admitWorkflow`) first checks the run directory itself:
  absolute and at most `MAX_RUN_DIR_BYTES` (512) bytes, otherwise
  `input_invalid` (field `runDir`) before any callback runs — the run
  directory is used verbatim in launch arguments and requests. It then calls
  the definition's four input callbacks in order — `validateInput`,
  `repository`, `resolveAgents`, `resolveLimits` — each guarded individually;
  a throw or a return shape that does not match the contract (missing `{ok}`,
  a `details` entry that is not exactly `{field: string, message: string}`, a
  non-string repository path, an agent map entry that is not `{kind, model,
args?}`, a non-object limits result) is `definition_invalid` naming the
  callback, never an exception. `repository(input)` must return the **top
  level** of a git work tree —
  `revisionOf` resolves `git rev-parse --show-toplevel` from the given path and
  fingerprints the whole tree from there; a path that is not that top level
  (a nested directory) is rejected `repo_invalid`, naming both the given path
  and the resolved top level. A repository path git itself cannot take (for
  example one containing a NUL byte) makes `revisionOf` throw; admission
  catches that and rejects it `repo_invalid` too, naming the path, rather than
  letting the exception escape. A run directory that equals, contains, or lies
  inside that repository is rejected `input_invalid` before any agent kind is
  resolved. Agent kind/model/args resolve through the kind table
  (`src/scheduler/launch.ts`; only `"claude"` is currently supported —
  `agent_kind_unsupported` otherwise) into the run plan. The repository
  admission resolved is the one the scheduler uses for every later pane, check
  and fingerprint; `runWorkflow` never calls `definition.repository(input)`
  again after admission.
- **Static edges are enforced at transition time, not only at validation.**
  `transitionProblem` checks every value a stage/check `next()` returns against
  its contract (a `pass`/`reject` decision, a non-empty reason of at most 200
  characters, exactly one of `to`/`outcome`, `completed` only from `pass` and
  `failed` only from `reject`; `requires: "round"` is valid only when the
  definition declares a `roundStage` — `requires: "round"` in a definition with
  `roundStage: null` is `definition_contract_violated`) and against the static
  `edges[from]` list; a target outside that list ends the run
  `failed{reason:"transition_undeclared: …"}` before any dispatch or gate
  write, even though the same shape already passed
  `validateWorkflowDefinition`. An agent stage's `request()` return is checked
  the same way for every dispatch cause except `format_repair`
  (`stageRequestProblem`: `{goal: string, instructions: string, inputs:
InputRef[]}` plus optional `task`/`roleInstructions`, each `InputRef`
  `{label: non-empty string, from: {stageId: string} xor {checkId: string}}`);
  a malformed return ends the run
  `failed{reason:"definition_contract_violated: <stage>: request() …"}` before
  any dispatch. `null` is reserved for a format-repair dispatch (which never
  calls `request()`) and is never a valid return otherwise. A present
  `task.context` is checked the same way, as a JSON value (`jsonValueProblem`,
  `src/contracts/json-value.ts` — no `BigInt`, function, symbol, non-finite
  number, cycle, or non-plain object such as a `Date`; nesting bounded to
  1000 levels): a violation is the same
  `definition_contract_violated: <stage>: request() task.context …` failure,
  caught before the request is rendered rather than surfacing later as an
  engine invariant. This is the shared check the built-in `build-review`
  workflow's own input validation uses for its `task.context` field, so a
  context a definition accepts at input time can never fail this later
  contract check with different rules.
- **Check stages** (`kind: "check"`) run an engine-owned command instead of an
  agent: `command(input) → {argv, timeoutMs}`, executed with no shell in the
  repository (`src/scheduler/check.ts`), and `next(ctx)` receives the exit code,
  signal, timeout flag and evidence file. A check has no `AgentSpec`, no visits
  and no attempts of its own; its subject is the accepted stage submission whose
  gate transition entered it. See [initial-workflows.md](initial-workflows.md)
  for `build-review`'s `verify` check.
- **What remained open here is now implemented (p4):** see "Implemented now
  (p4)" below for configuration-driven role catalogs, provenance and
  project/user workflow discovery. `--runtime-module`-style loading stays
  documented, unstable, and test-oriented for the runtime adapter, not the
  definition — its factory result is shape-validated against every
  `RuntimeAdapter` method before any run opens; a missing or non-function
  member is `runtime_unavailable`, exit 3, naming what is missing or invalid.

## Implemented now (p4)

Real shipped behavior for configuration-driven roles, limit defaults and
workflow discovery — not design intent. Source: `src/config/{discover,
resolve,record}.ts`, `src/scheduler/{admission,definition}.ts`.

- **`resolveAgents(input)` omissions are filled from configured roles.**
  Admission takes any agent a definition's `resolveAgents` does not return
  from `configuration.roles[role]` (project → user → built-in, whole-file
  replacement); if no layer resolves it, `role_unresolved`. The built-in
  `build-review`'s own `resolveAgents` now returns only the roles present in
  its input, so an input that omits `agents` entirely resolves purely from
  configuration.
- **An optional `WorkflowDefinition.limitDefaults?: Partial<Limits>`.** A
  definition may supply only selected fallback keys. When present, admission
  composes each `Limits` key it covers as
  `resolveLimits(input)[key] ?? project[key] ?? user[key] ??
limitDefaults[key]`; without it (an external p3 definition with no
  `limitDefaults`), the definition's own `resolveLimits(input)` result is
  used as before and configuration only fills the keys it lacks.
  `build-review` sets `limitDefaults = BUILD_REVIEW_DEFAULT_LIMITS` and its
  `resolveLimits` now returns only `{...input.limits}`.
- **Project and user workflow discovery.** `--workflow <name>` (else
  `defaults.workflow`, else `build-review`) resolves through
  `workflows/<name>.{mjs,js,ts}` in the project scope, then the user scope,
  then the built-in catalog. `woof run start`'s launcher pre-admits only the
  built-in workflow; for a discovered file it does not import the module —
  **the module body runs exactly once, in the pane host** — so a project
  definition's top-level side effects never run twice (the launcher and the
  host would otherwise both trigger them; `test/fixtures/workflows/
side-effect.mjs` exists for exactly this case). `woof config show` never
  imports a non-built-in workflow module either: its `workflow.value.version`
  is `null` for a file, with `path`/`sha256` identifying it instead.

## Implemented now (p5)

Real shipped behavior proving the authoring contract generalizes beyond
`build-review` — not design intent. Source: `test/fixtures/workflows/scribe.mjs`,
`src/workflows/{plan-build-review,catalog}.ts`, `src/submission/submit.ts`.

- **An external, project-authored workflow proves discovery end to end.**
  `scribe` (`.woof/workflows/scribe.mjs`, committed into a project's own repo,
  not shipped by Woof — it is not in the built-in catalog and not in
  `package.json#files`) needs no import at all, from Woof or from `node:`:
  every type in the contract is structural. It admits, runs and completes
  through `woof run start --workflow scribe` from a plain project `.woof/`,
  live-verified against a real `claude` agent through Herdr
  (`docs/research/external-workflow-live.log`, 8/8 gates) and offline through
  five real-process cases in `test/external-workflow.process.test.ts`.
- **`roundStage: null` end to end.** `scribe` declares one stage and no round
  at all; `requires: "round"` anywhere in such a definition is
  `definition_contract_violated`, and the only gate that can end the run is
  `note`'s own `pass` with `outcome: "completed"`. A definition author who
  wants no review-repair cycle at all — a single-stage note, a synthesis
  step — declares `roundStage: null` and never touches `requires`.
  `plan-build-review` and `build-review` both declare a real `roundStage`
  (`"review"`) for comparison.
- **`resolveLimits` with no `limitDefaults` is still the p3 shape, and still
  works.** `scribe` returns the complete `Limits` set from `resolveLimits`
  itself and declares no `limitDefaults`; admission fills only the keys
  configuration or a definition's own defaults set. This is the same shape
  the original p3 `build-review` shipped with, before p4 added
  `limitDefaults` as an optional convenience — a definition author may still
  do all limit composition inside `resolveLimits` and skip `limitDefaults`
  entirely.
- **An agent id that is not its role, and a stage the engine has never
  seen.** `scribe`'s one agent has `agentId: "scribe"`, `role: "builder"` —
  identity and role are independent, exactly as the domain model states — and
  its one stage, `note`, is a stage id no built-in workflow declares. Neither
  needed an engine change.
- **The optional `artifactVerdictMarker` (p5 D5).** An `AgentStage` with
  verdicts may declare `artifactVerdictMarker: string` (at most 64
  characters, checked by `validateWorkflowDefinition`); `woof submit`'s check
  17b then requires the artifact's **first non-blank line only** to start
  with that marker and, when it does, the rest of the line must equal the
  envelope's verdict — a mismatch is rejected `verdict_artifact_mismatch`,
  naming both. Both built-in `review` stages declare
  `REVIEW_VERDICT_MARKER = "Woof-Verdict:"` and ask for it in the request
  text. It is per stage (a stage with no marker checks nothing) and anchored
  to the first line **on purpose**: a reviewer quoting the required line
  inside an example elsewhere in its artifact writes it at the start of a
  line too, and scanning the whole artifact for any matching line would
  reject that quotation as a second, disagreeing marker. See
  [communication](../architecture/communication.md#implemented-now-p5) for
  the check's exact position and its BOM-stripping rule.
- **State the artifact's authority in the request, not only in the
  workflow's own documentation.** Live acceptance found a builder treating a
  requirement it encountered only inside an upstream review artifact as a
  possible prompt injection, and declining it twice — the run's own request
  text never said whose word the review was, so the builder had no way to
  tell an unverified claim from a project requirement (see
  [v1-evidence.md](../acceptance/v1-evidence.md#documented-limits)'s
  checklist-injection observation). Both built-in `repair` stages now say so
  directly: a repair entered by the review stage is told the accepted review
  is canonical for it, its blocking findings are project requirements, and an
  objection belongs in `completion.md`, never left unaddressed. **A workflow
  whose downstream stage must act on an upstream artifact should say so in
  the request** — an agent cannot infer an artifact's authority from the
  artifact itself, only from what the request tells it about that artifact.
