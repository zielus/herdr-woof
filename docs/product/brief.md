# Product brief

## Purpose

Woof is the agent-development and orchestration layer for Herdr. A coding agent
or operator gives it a workflow, structured input and project context; Woof
resolves roles, coordinates the work and returns a structured outcome with
artifact references. Herdr runs the agents and owns their panes, sessions,
workspaces and worktrees.

`HerdrAgentsSDK` is the reusable engine. The CLI, Herdr plugin, Claude Code
plugin and Web UI use the same run state and workflow behavior.

## Current scope

Woof 0.2.0 includes:

- `build-review`, which builds, verifies, reviews and returns to the same builder
  for repair when the review gate fails;
- `plan-build-review`, which adds a planning handoff before the same bounded
  build, verification, review and repair cycle;
- project and user workflow discovery, role resolution and recorded
  configuration provenance;
- validated artifact/envelope handoff, finite limits, blocking, cancellation and
  explicit terminal outcomes;
- snapshots, events, inspection commands and hosted-run liveness;
- an independently consumable SDK, command-line tools, Herdr and Claude Code
  integrations, and a local read-mostly Web UI.

Project-authored workflows and roles use the same admission and scheduler
contracts as the built-ins. The supported production agent kind is currently
`claude` through the Herdr CLI runtime adapter.

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
from terminal output.

## Not supported

Woof does not currently provide crash resume or re-hosting, parallel workflow
scheduling, a second production agent kind, per-role instruction/context files,
or per-stage structural artifact schemas. The Web UI cannot start or retry work
or answer blocked agents. See [Architecture decisions](../decisions/architecture.md)
for the open decisions and known limits.
