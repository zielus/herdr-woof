# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[SemVer](https://semver.org/).

## [Unreleased]

### Added

- SDK foundation for Woof: a compiled Node ESM package entry point, a
  diagnostic-only `woof` CLI (`--help`, `--version`, `doctor`), Herdr and
  Claude Code plugin placeholders that decline workflow requests, and the
  packaging/versioning checks. No orchestration logic or MCP adapter yet.
- Result-handoff prototype (p1): envelope v1 validation, the `woof submit`
  and `woof attempt open` CLI commands, an append-only run journal
  (`journal.jsonl`) as the sole source of truth, immutable accepted artifact
  copies, and the equivalent SDK functions `submitResult`, `openAttempt` and
  `readJournal`. In-process transport only; no scheduler, workflow engine, or
  run hosting yet.
- SDK contracts (p2): run plans and domain types (`RunPlan`, `Limits`,
  `AgentSpec`, `StageSpec`, `validateRunPlan`); new journal record types
  (`agent.assigned`, `request.dispatched`, `run.terminated`, and an
  optional `plan` on `run.opened`) with the reducer rules that refuse
  impossible states; a run-facts store (`openRun`, `assignAgent`,
  `recordDispatch`, `terminateRun`); derived run snapshots and events
  (`readSnapshot`/`deriveSnapshot`, `readEvents`/`subscribeEvents`/
  `foldEvents`) with a resume cursor and tail-tolerant reads; a
  `RuntimeAdapter` contract with a Herdr CLI implementation (live-checked
  against a real `claude` agent through Herdr, its `inspect` restricted to a
  read-only command allowlist) and an in-memory scripted double exported
  from `herdr-woof/testing`; and the read-only `woof run show` CLI command,
  which also exits 3 with the distinct reason `journal_replaced` when the
  journal's line 1 changes on every one of three consecutive re-reads.
  Declared limits are validated and counted, not yet enforced; gate, block
  and delivery-reconciliation records remain design-only (phase 3). No
  version bump (`check:version` stays at 0.0.0).
- Scheduler and the built-in `build-review` workflow (p3): a workflow
  definition contract (`WorkflowDefinition`, `validateWorkflowDefinition`)
  and loader (`loadWorkflowDefinition`) for strip-only TypeScript or
  compiled `.js`/`.mjs` modules; a pure decision core (`decide`) plus an
  effectful driver (`runWorkflow`) that dispatches agents, runs engine-owned
  check gates, records gate decisions, blocks/unblocks on a runtime prompt,
  reconciles ambiguous deliveries, and enforces every declared limit
  (`maxAttemptsPerVisit`, `maxVisitsPerStage`, `maxRounds`, the new optional
  `maxFormatRepairs`, `runTimeoutMs`, `readinessWaitMs`, `blockedWaitMs`,
  `deliveryTimeoutMs`) by ending the run `exhausted` with the limit's name;
  four new journal record types (`gate.recorded`, `run.blocked`,
  `run.unblocked`, `delivery.reconciled`) and their reducer rules, still
  `schemaVersion: 1`; engine-owned git-tree revision binding so a passing
  review from an older revision never approves newer work; a bounded
  format-repair loop distinct from work retries; a persisted, hashed worker
  request format; downstream re-hashing of accepted artifacts before they
  are handed to the next agent (closing the p2 C2 requirement); the built-in
  `build-review` workflow (build → verify → review → repair) with its input
  schema; and the CLI/SDK surfaces `woof run build-review` and `woof run
cancel` (`runWorkflow`, `admitWorkflow`, `buildReviewWorkflow`,
  `deriveRunResult`, `recordGate`, `blockRun`, `unblockRun`,
  `reconcileDelivery`). Configuration-driven role catalogs, a second
  built-in workflow, MCP, run hosting, crash resume and parallel scheduling
  remain out of scope. No version bump (`check:version` stays at 0.0.0).
- Configuration, run hosting, inspection and functional plugins (p4):
  `.woof`/`~/.woof` JSON configuration (`woof.json`, one role per file, one
  workflow definition module per file) with project → user → built-in
  precedence, per-field provenance and `woof config show`; `woof run start`
  hosting one scheduler process per run in a Herdr pane, claimed exclusively
  with a heartbeat and an engine-owned `host-exit.json` marker on a clean
  exit (`woof run host`, `--host foreground`); the read-only
  inspection CLI `woof status [--wait]` (exit 8 covers any owner gone
  without a recorded outcome — `lost`, or `exited` with no terminal journal
  record, reporting the host's own `outcome.json` as `hostOutcome` when
  present), `woof runs` and `woof events [--follow] [--stats]` (`--follow`
  is lock-free and ends a persistent torn tail with `journal_corrupt`
  instead of blocking on the journal lock; resumed past a terminated run's
  last cursor it ends at once); a functional Herdr plugin (`doctor`,
  `status`, `start`, `cancel` actions — `doctor` now resolves the invocation
  context's project like the others, rather than running unscoped — pane
  metadata and notifications) and Claude Code plugin (`/woof:run`, with a
  read-only Claude folder-trust pre-flight); and `openAdmittedRun` exported
  from the SDK. Changed public types:
  `RunSnapshot.liveness.owner` widens to `"unhosted"|"alive"|"lost"|"exited"`
  with a new `host`/`claimProblem`; `SubscribeOptions` gains an optional
  `lockFree` (default `false`, so the existing one-locked-read behavior for
  a persistent torn tail is unchanged unless a caller opts in);
  `AdmissionReason` gains
  `config_invalid`, `config_conflict`, `setting_scope_invalid`,
  `role_invalid`, `role_unresolved`, `project_mismatch`,
  `workflow_not_found`, and the loader's `definition_not_found|
definition_syntax_unsupported|definition_load_failed`; `WorkflowDefinition`
  gains an optional `limitDefaults`; build-review's `agents` and each role in
  it are now optional. Configuration-driven role instructions/context files,
  a second built-in workflow, MCP, crash resume/re-hosting a lost run, and
  parallel scheduling remain out of scope. No version bump (`check:version`
  stays at 0.0.0).
- A second built-in workflow, an external workflow proof, an opt-in artifact
  verdict check, and acceptance evidence (p5): the built-in `plan-build-review`
  workflow (`src/workflows/plan-build-review.ts`) adds a planner stage ahead
  of the same build/verify/review/repair loop, with `plan.md` reaching every
  builder and repair request as an accepted `InputRef` (never inlined) and no
  re-planning or plan-approval gate in this version; the built-in workflow
  catalog becomes a name-keyed, null-prototype registry
  (`src/workflows/catalog.ts`, `BUILT_IN_WORKFLOWS`) and `planner` becomes a
  third built-in role, so neither workflow needed a branch anywhere in
  configuration resolution or the scheduler. `woof run start --workflow
<name>` and `/woof:run --workflow <name>` resolve a project- or user-authored
  workflow module from `.woof/workflows/`, with no engine change and no
  import from Woof required; a discovered workflow is admitted once, in the
  pane host, never pre-admitted by the launcher, proved live end to end by an
  external `scribe` example workflow
  (`docs/research/external-workflow-live.log`, 8/8 gates). An opt-in,
  first-line-anchored artifact/envelope verdict check (`artifactVerdictMarker`
  on an `AgentStage`, check 17b in `woof submit`) rejects
  `verdict_artifact_mismatch` when a reviewer's declared marker line disagrees
  with its own envelope verdict; both built-in `review` stages opt in. A
  three-part acceptance runner (`scripts/acceptance/matrix.mjs`,
  `scripts/acceptance/collect.mjs`/`bun run acceptance:collect`,
  `docs/acceptance/v1-evidence.md`) ties every acceptance-matrix row to a
  named test or a committed live-log gate, or to a written reason under
  `v1-evidence.md`'s "Documented limits"; `docs/research/build-review-live.log`
  is replaced with a fresh 13/13 run (the previously committed log recorded a
  failing `GATE 10` and 12/13). **API note (carry-over C1):** `RunResult` and
  snapshot per-key records (by stage id, role name, reason or workflow name)
  are built with `Object.create(null)` and stay that way in this first
  release — the shape is what keeps a key literally named `constructor` or
  `toString` safe; a consumer that needs to `deepStrictEqual` an in-memory
  result against a parsed one should compare both in JSON form
  (`scripts/live/lib/observer.mjs`'s `jsonForm`), not assume a plain-object
  prototype. MCP, crash resume/re-hosting a lost run, parallel scheduling, a
  second agent kind, per-stage structural artifact schemas, and role
  instructions/context files in configuration remain out of scope. No version
  bump in this bullet (`check:version` stays at 0.0.0); the `0.1.0` version
  bump and this section's eventual move under `## [0.1.0]` are a separate,
  later commit — `0.1.0` is a version and a git tag on this repository, not an
  npm publish (the package stays `"private": true`).
