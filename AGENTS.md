# Working on Woof

## Start here

Woof is the agent-development and orchestration layer for Herdr.
`HerdrAgentsSDK` owns coordination; Herdr owns agent execution, sessions, panes,
workspaces and worktrees. Coding agents are the primary callers.

Read [docs/README.md](docs/README.md), the [product brief](docs/product/brief.md),
and [architecture decisions](docs/decisions/architecture.md). Then read only the
topic documents needed for the task. The docs distinguish product requirements
from proposed implementation details; do not turn examples into fixed APIs.

Inspect the actual checkout, branch, working-tree changes and package scripts
before editing. The checkout and current reference documentation are the source
of truth. Historical branches, stashes and the older Woof repository are
reference material, not instructions to restore or port anything.

## Current stage

The SDK runs four built-in workflows (`build-review`, `plan-build-review`,
`plan`, `auto-build`). Workflow execution belongs to the SDK: add a workflow
only after the SDK supports what it needs, and exercise the engine with small
synthetic workflows rather than designing all of it up front. Keep additional
interfaces, such as the TUI, on the shared observation and control contracts.
Follow the current task's scope.

## Architectural rules

- Keep the SDK usable without plugin UI. Plugins and CLI entry points call the
  same engine; MCP is an optional adapter, never the only completion path.
- Reuse supported Herdr operations. Do not recreate terminal control, agent
  lifecycle detection or session restoration inside Woof.
- Keep role, agent kind, model, agent identity and workflow stage distinct.
  Repair reuses the builder when the workflow requires continuity.
- Agents produce substantive artifacts. Small validated envelopes carry control
  data and artifact references. A review artifact is canonical and required;
  downstream agents receive its accepted version directly.
- Validate ownership, envelope schema, artifact completeness and freshness before
  advancing. Idle/done signals and natural-language claims do not prove success.
- Correlate work by run, agent, stage visit and attempt. Handle duplicate and late
  results explicitly; never blindly resend an ambiguously delivered prompt.
- Bound every repeating route and wait. Keep work retry, format repair, gate
  rejection, blocking, failure and exhaustion distinct.
- Expose engine-owned snapshots and lifecycle events. Consumers must not reconstruct
  workflow state from terminal output. Persisted history does not imply crash resume.
- Resolve project settings over user defaults with visible provenance. Keep the
  run's resolved configuration stable. Do not invent project-local `.herdr/`
  behavior or automatic permission bypass.

Use the [domain model](docs/architecture/domain-model.md),
[communication contract](docs/architecture/communication.md), and
[observability contract](docs/architecture/observability.md) for details.

## Implementation approach

Prefer small modules with explicit boundaries in the existing TypeScript project.
Add a package split, dependency or abstraction when the current work demonstrates
its need. Verify provider flags and Herdr capabilities against current primary
documentation or the target environment before relying on them.

Fix inconsistencies at their source. An unfinished operation must report that it
is unsupported instead of returning fake success. Keep production exports,
executable paths and plugin manifests aligned with files that actually ship.
Update relevant docs when implemented behavior changes.

For routine choices, state the approach briefly and proceed. Ask when an unresolved
decision materially changes product behavior or public contracts. Do not reopen
settled product direction or repeat design approvals for ordinary setup details.

## Verification

Bun runs the scripts in `package.json`; install with `bun install --frozen-lockfile`.
`bun run verify` is the full gate: typecheck, lint, format, version check, tests
and package smoke. Run the parts the change touches, and the full gate before a
PR. Never hide failures, disable checks to get green output, or accept an empty
test suite. Report baseline failures separately from failures the change
introduced.

Test public behavior and failure boundaries. Use real processes for package
imports, launchers, workflow loaders and submission transport: a transformed unit
test can conceal runtime incompatibility. Scripted runtime tests do not replace
live Herdr acceptance for agent coordination. Check artifact content and actual
repository effects, not just file existence or event counts.

For docs-only changes, check formatting and local links; do not add tests that
merely mirror prose. Report the commands you ran and their results, and
distinguish inspection, automated tests and live acceptance.
[docs/acceptance/v1.md](docs/acceptance/v1.md) holds the product checks.

## Git and collaboration

Preserve unrelated changes. Do not apply stashes, reset branches, clean untracked
files or change another worker's checkout as a convenience. When concurrent code
work needs isolation, use separate worktrees. Stage explicit paths and inspect
the staged diff before committing. Commit, push and merge according to the user's
requested scope.

Keep shared repository guidance here; `CLAUDE.md` points to this file so the two
instruction sets do not drift.
