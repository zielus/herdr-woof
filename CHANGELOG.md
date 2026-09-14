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
