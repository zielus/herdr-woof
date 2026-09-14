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
