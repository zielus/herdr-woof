# Product brief

## Purpose

Woof is the agent-development and orchestration layer for Herdr. A coding agent
or operator gives it a workflow, structured input and project context; Woof
resolves roles, coordinates the work and returns a structured outcome with
artifact references. Herdr runs the agents and owns their panes, sessions,
workspaces and worktrees.

`HerdrAgentsSDK` is the reusable engine. The CLI, Herdr plugin and Claude Code
plugin use the same run state and workflow behavior.

## Current scope

Woof 0.3.1 includes:

- `build-review`, which builds, verifies, reviews and returns to the same builder
  for repair when the review gate fails;
- `plan-build-review`, which adds a planning handoff before the same bounded
  build, verification, review and repair cycle;
- `plan`, a planner that writes (and optionally commits) an implementation plan,
  and `auto-build`, which composes `plan` and `build-review` as workflow steps
  on one branch: a workflow can be a step of another;
- a checkout policy in the run input: runs started inside Herdr work in a new
  Herdr worktree by default, and nested runs inherit their parent's checkout;
- project and user workflow discovery, role resolution and recorded
  configuration provenance;
- validated artifact/envelope handoff, finite limits, blocking, cancellation and
  explicit terminal outcomes;
- snapshots, events, inspection commands (including a run index, a readable
  `woof watch` view and the `woof tui` terminal browser) and hosted-run liveness;
- an independently consumable SDK, command-line tools, and Herdr and Claude Code
  integrations.

Project-authored workflows and roles use the same admission and scheduler
contracts as the built-ins. The admitted agent kinds are `claude`, `pi`, `codex`
and `grok`, all started through the Herdr CLI runtime adapter; `claude` and `pi`
have live build-review evidence, `codex` and `grok` do not yet. See
[Configuration](../architecture/configuration.md#agent-kinds).

## Product boundaries

Woof owns workflow admission, scheduling, validation, gates, limits, run state
and artifact references. It does not implement a terminal runtime or duplicate
Herdr's session restoration.

Artifacts carry substantive work. Validated envelopes carry control data and
references. The review artifact is canonical and required; runtime idle state or
an agent's prose claim does not complete a stage.

Configuration has project, user and built-in layers. The resolved values and
their provenance are fixed for a run. Woof does not invent project-local
`.herdr/` behavior or automatically bypass agent permissions.

The SDK does not depend on plugin UI or MCP. Presentation layers consume the
engine's snapshot, event and control contracts instead of reconstructing state
from terminal output. A run does not require a Claude Code conversation.

The CLI supports inspection, debugging, testing and automation. Manually typing
long commands to start complex workflows is secondary; structured workflow input
remains the primary contract. Generic diff viewers, file browsers, navigation
tools and notification interfaces belong in Herdr or optional integrations where
practical.

## Not supported

Woof does not currently provide crash resume or re-hosting, parallel workflow
scheduling, agent kinds beyond `claude`, `pi`, `codex` and `grok` (such as the
standalone `copilot` CLI), per-role instruction/context files, or per-stage
structural artifact schemas. Multi-machine orchestration and a large command palette
are not current product goals. See
[Architecture decisions](../decisions/architecture.md) for the open decisions and
known limits.
