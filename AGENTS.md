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

## Development order

1. Establish a working foundation: runtime/tooling choices, TypeScript, package
   exports, launchers, plugin wiring, tests, CI and packaging.
2. Implement the SDK incrementally: runtime adapters, agent identity, result and
   artifact contracts, state, observation, scheduling, gates and limits.
3. Test the engine with small synthetic workflows during SDK development. Prove
   one real agent-to-artifact handoff early enough to validate the runtime boundary.
4. Add production workflows such as build-review and plan-build-review after the
   SDK supports them. Keep additional interfaces, such as the TUI, on the
   shared observation and control contracts used by the current Web UI.

Workflow execution belongs to the SDK; four built-in workflows
(`build-review`, `plan-build-review`, `plan`, `auto-build`) exist, and further ones are added only
after the SDK supports them. Avoid designing the entire engine without exercising it. Follow
the current task's scope; a foundation task does not authorize building the SDK.

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

Preserve useful scaffolding and fix inconsistencies at their source. An unfinished
operation must report that it is unsupported instead of returning fake success.
Keep production exports, executable paths and plugin manifests aligned with files
that actually ship. Update relevant docs when implemented behavior changes.

For routine choices, state the approach briefly and proceed. Ask when an unresolved
decision materially changes product behavior or public contracts. Do not reopen
settled product direction or repeat design approvals for ordinary setup details.

## Verification

Use the repository's lockfile and declared runtime versions. Bun is the current
package/script tool; inspect the scripts to distinguish Bun execution from Node
execution. Existing scripts may still reference missing scaffold files.

Typical commands, once their implementations exist:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun run test
bun run build
bun run smoke:package
bun run verify
```

Run checks appropriate to the change. During foundation repair, reconcile broken
scripts and CI with the supported surface. Do not hide failures, disable checks
to obtain green output, or silently accept an empty test suite. Report any
remaining baseline failures separately from failures introduced by the change.

Test public behavior and failure boundaries. Use real processes for package
imports, launchers, workflow loaders and submission transport: a transformed unit
test can conceal runtime incompatibility. Scripted runtime tests do not replace
live Herdr acceptance for agent coordination. Check artifact content and actual
repository effects, not just file existence or event counts.

For docs-only changes, check formatting and local links. Do not add tests that
merely mirror prose. Report commands actually run and their results; distinguish
inspection, automated tests and live acceptance. See
[docs/acceptance/v1.md](docs/acceptance/v1.md) for the eventual product checks.

## Git and collaboration

Preserve unrelated changes. Do not apply stashes, reset branches, clean untracked
files or change another worker's checkout as a convenience. When concurrent code
work needs isolation, use separate worktrees. Stage explicit paths and inspect
the staged diff before committing. Commit, push and merge according to the user's
requested scope.

Keep updates and final reports concise: what changed, why, what was verified,
and what remains. Maintain shared repository guidance here; `CLAUDE.md` points
to this file so the two instruction sets do not drift.
