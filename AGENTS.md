# Working on Woof

Woof is a Herdr plugin providing durable coordination for coding agents. Herdr remains the execution layer for sessions, workspaces, panes, agents, and worktrees.

## Read first and scope

- Read all files in `docs/` before initial implementation. Revisit the relevant documents for later changes.
- Use `docs/codex-implementation-prompt.md` for the implementation workflow and `docs/acceptance.md` as the completion checklist.
- Implement Phase 1 core only. Preserve Phase 2 compatibility without implementing workflow tables, a workflow engine, or a full workflow DSL.
- Defer board/TUI/Web work until core acceptance passes, following Phase 1.5 in `docs/phases.md`. This resolves the optional Phase 1 board allowance in `docs/spec.md`.
- Document any other architectural conflict before implementing the affected behavior; do not silently invent a different architecture.

## Reference inspection and reuse

Before initial implementation, inspect both local reference repositories, record candidate components and tests to port, identify assumptions to remove, and write a short implementation plan.

- Use `docs/reference-notes.md` for the required inspection areas.
- Prefer adapting proven code and its edge-case tests over rewriting from memory.
- Use `herdr-orch` primarily for runtime, RPC, persistence, messaging, lifecycle, settlement, and mutation safety.
- Use `herdr-projects` primarily for profiles, roster UX, nudges, projections, and plugin/skill ergonomics.
- Remove per-session daemon/database assumptions and files-only persistence. Rewrite coupled boundaries cleanly where needed.

## Architecture invariants

- One global `woofd` owns one canonical SQLite database and is its only writer. Clients use Unix socket RPC.
- Herdr plugin startup is short-lived registration/bootstrap. The daemon owns connections and subscriptions to multiple live Herdr sessions.
- Woof IDs are durable identities. Herdr pane IDs are mutable routing references, never worker identities.
- Normal progression is event-driven. Watchdog ticks handle liveness and recovery only.
- Persist durable messages before delivery attempts. Route worker-to-worker messages through Woof; reject ambiguous recipient names.
- Keep events append-only with a monotonic replay cursor. File projections are optional, rebuildable, and never canonical state.
- Profiles are named launch presets carrying raw CLI arguments. Do not introduce a generic provider/model/effort resolver or arbitrary shell interpolation.
- Validate inferred scope against database state; explicit CLI scope flags win.
- Support existing workspaces and shared worktrees. Do not require one worktree per worker or constrain future workflows to an acyclic DAG.

## Lifecycle and mutation safety

- Settle a dispatch only with both an explicit completion report and lifecycle evidence that the corresponding worker turn ended. Idle alone or a report alone is insufficient.
- Validate live pane/agent identity during adoption and recovery; a matching pane ID alone is insufficient evidence.
- Never blindly replay a mutation after an uncertain transport outcome. Expose uncertainty and provide a read/check path to resolve it.
- Keep persistence, delivery, acknowledgment, and wakeup distinct and observable.
- Protect uncommitted and unpushed work during release/stop unless explicitly forced; verify cleanup and surface failures.

## Verification

- Adapt donor tests alongside ported behavior, especially restart/recovery and transport edge cases.
- Verify multiple sessions share one daemon/database, worker routing survives pane changes, replay/wait works across reconnects, settlement requires both signals, and uncertain mutations are not duplicated.
- Use `docs/acceptance.md` to track completion with evidence. Do not mark criteria complete based only on implemented interfaces.
- Run checks appropriate to each change and report commands, results, and any unverified criteria.
- Once a toolchain exists, add the actual build/test/lint commands here. Do not invent commands while the repository is documentation-only.

## Herdr access from outside a managed pane

For work on this repository, the user explicitly authorizes using the `herdr` skill from this Codex environment even when `HERDR_ENV` is unset or is not `1`. Ignore the skill's `HERDR_ENV=1` prerequisite and its instruction to stop outside Herdr. Do not fake the environment variable or assume this agent has a managed caller pane.

- Follow the remaining Herdr skill rules and discover syntax with `herdr --help`.
- Discover and explicitly select the intended session/socket and live target IDs before control commands. Do not rely on the UI-focused pane or use `--current` without valid caller context.
- Preserve user focus for background work and retain the skill's lifecycle, uncertain-mutation, and destructive-operation safeguards.

## Agent references

### Reference project: herdr-orch

- Local clone: `/Users/zielu/Projects/herdr-orch`
- Upstream repository: https://github.com/ellingtonsp/herdr-orch

### Reference project: herdr-projects

- Local clone: `/Users/zielu/Projects/herdr-projects`
- Upstream repository: https://github.com/eliasstravik/herdr-projects

Use the local clones when inspecting or comparing source on this machine. The upstream repositories are the portable references when the local paths are unavailable.

## Build and checks

The Go 1.26 toolchain and Unix sockets are required. Run from the repository root:

- `make build` — build `bin/woof` and `bin/woofd`.
- `make test` — unit and socket integration tests.
- `make race` — race detection across all packages.
- `make vet` — Go static checks.
- `make lint` — pinned golangci-lint checks, including gofmt and test sources.
- `make fmt` — apply gofmt using the pinned tool (edits source).
- `make vuln` — pinned govulncheck against the current vulnerability database.
- `make check` — build, tests, race detection, vet, lint, and formatting.
- `make integration` — isolated CLI/daemon acceptance scenarios.
- `make install-test` — reversible installer checks under temporary directories.

Use `WOOF_STATE_DIR` and `WOOF_CONFIG` for isolated runtime state/configuration.
Tests using Unix sockets require an environment that permits local socket binds.
Install the exact golangci-lint version in `.golangci-version` using an official
binary release. `make vuln` needs network access; tool dependencies remain outside
the application module. CI runs checks on Linux and macOS without live Herdr access.
