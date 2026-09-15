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
  inspection CLI `woof status [--wait]`, `woof runs` and `woof events
[--follow] [--stats]`; a functional Herdr plugin (`doctor`, `status`,
  `start`, `cancel` actions, pane metadata and notifications) and Claude Code
  plugin (`/woof:run`, with a read-only Claude folder-trust pre-flight); and
  `openAdmittedRun` exported from the SDK. Changed public types:
  `RunSnapshot.liveness.owner` widens to `"unhosted"|"alive"|"lost"|"exited"`
  with a new `host`/`claimProblem`; `AdmissionReason` gains
  `config_invalid`, `config_conflict`, `setting_scope_invalid`,
  `role_invalid`, `role_unresolved`, `project_mismatch`,
  `workflow_not_found`, and the loader's `definition_not_found|
definition_syntax_unsupported|definition_load_failed`; `WorkflowDefinition`
  gains an optional `limitDefaults`; build-review's `agents` and each role in
  it are now optional. Configuration-driven role instructions/context files,
  a second built-in workflow, MCP, crash resume/re-hosting a lost run, and
  parallel scheduling remain out of scope. No version bump (`check:version`
  stays at 0.0.0).
