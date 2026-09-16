# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[SemVer](https://semver.org/).

## [Unreleased]

### Added

- Dispatch reason `precondition_failed` for `not_delivered`: a failed
  delivery-precondition read, or the delivery deadline expiring before the
  prompt could be sent, is now retried as work (`work_retry`, bounded by
  `maxAttemptsPerVisit`) instead of failing the run. **A 0.1.0 reader refuses
  a 0.1.1 journal that contains this reason** (cross-version journal reading
  is not promised).
- `woof doctor --json` gains `problems: string[]`
  (`herdr_unavailable`/`claude_unavailable`/`trust_untrusted`/
  `trust_unknown`/`config_invalid`); `--strict` exits 2 when it is
  non-empty, in both modes.

### Changed

- `woof submit` now journals a best-effort, owner-verified `identity` for
  `envelope_invalid`/`envelope_malformed` rejections when one can be
  verified; a format-repair request quotes it instead of "none — no
  submission was recorded".
- `owner_mismatch` rejections no longer count as delivery evidence for an
  ambiguous dispatch, and are no longer quoted in a format-repair request
  (the rejection itself is still recorded and visible in the snapshot).
- `woof doctor`'s trust check now resolves `--repo`/the working directory to
  its git top level before reading the trust key (an ancestor's trust still
  never counts); it now reads `~/.claude.json` with `lstat`/`O_NOFOLLOW` and
  a device/inode match, reporting `unknown` for a symlink instead of
  following it.
- `woof doctor`'s human-mode output now renders the same report `--json`
  does, from the same probes, instead of running `herdr status` separately.
- `herdr cancel` with no active run now exits 2 (previously 0); the JSON
  outcome and notification text are unchanged.
- An unknown CLI command now prints `woof: unknown command "<name>"; see
woof --help` to stderr (previously "... is not implemented in the SDK
  foundation"); still exit 1.
- The Claude Code plugin manifest's author now matches `package.json`
  (`Tomasz Chmielarz`, previously `zielu`).

### Fixed

- Two test races around a killed detached host and `host.json` reads
  (`test/run-start.cli.test.ts`, `test/host.process.test.ts`): cleanup now
  waits for the host process to exit before removing its directory, and
  every `host.json` read in tests goes through a parse-checked reader. No
  product-code change — the product's reader already retried a partial
  claim.

### Docs

- README: install split (npm vs checkout, the Herdr plugin is checkout-only),
  a new Trust model section, the CLI block synced with `--help`, removed SDK
  edge-case asides from Run snapshot (moved into domain-model.md and
  observability.md), corrected status banner and "Integrations and scope"
  wording.
- `docs/README.md`: status and lead rewritten; the "planned checks, not test
  results" line replaced with a pointer to `v1-evidence.md`.
- `docs/architecture/observability.md` and `domain-model.md`: p2-only
  statements (`liveness.owner` staying `"unhosted"`, "all fourteen
  `ReducerReason` values") marked historical and superseded; an unreproducible
  `--stats` timing number dropped.
- `docs/acceptance/v1-evidence.md` and `docs/decisions/architecture.md`:
  evidence now cited by PR and merge commit instead of branch SHAs, with the
  branch SHAs kept only as historical ids; a new "Known limits (0.1.x)" table
  for the design-level audit findings this release documents rather than
  fixes.
- `AGENTS.md`: the development-order note now says two production workflows
  exist, rather than saying they are deferred.
- `plugin/claude/skills/woof/SKILL.md`: exit-8 wording matches `woof status`'s
  own usage text; workflow file extensions corrected to `.{mjs,js,ts}`.
- New `.claude/skills/release/SKILL.md` and `.claude/skills/audit/SKILL.md`.

## [0.1.0] - 2026-09-16

This is the first release. The bullets below are cumulative notes from the phases that built it,
in order; a later bullet supersedes an earlier "placeholder" or "out of scope" statement.

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
  and delivery-reconciliation records remain design-only (phase 3).
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
  remain out of scope.
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
  parallel scheduling remain out of scope.
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
  instructions/context files in configuration remain out of scope. This release
  carries the version bump to `0.1.0` across `package.json`, `herdr-plugin.toml`
  and the Claude Code plugin manifest. The `v0.1.0` tag and the npm publish are
  the operator's steps after the merge.
- Public release preparation: an MIT `LICENSE`, package metadata for npm
  (`license`, `author`, `homepage`, `bugs`, `keywords`, `publishConfig`, and
  `"private": true` removed), a README and documentation index rewritten for
  first-time readers, and the committed live logs under `docs/research/`
  redacted line-preserving (home directory prefix and host name).
