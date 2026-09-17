# Woof documentation

Status: 0.1.x pre-release. The Implemented-now sections linked below describe shipped behaviour,
backed by the acceptance evidence; other sections are design and requirements.

## What exists today

The [acceptance evidence](acceptance/v1-evidence.md) states which revision each part of it was
run against. Its live logs were recorded before two source fixes that are part of the 0.1.0 code
merged to master as `b329cdc`.

- **Result handoff** (p1): envelope v1, `woof submit`, `woof attempt open`, and the run journal.
  See [Communication and artifacts](architecture/communication.md#implemented-now-p1-prototype).
- **Run facts and snapshots** (p2): run plans, journaled agent assignment/dispatch/termination,
  derived run snapshots and events, a runtime adapter over the Herdr CLI, and `woof run show`. See
  [Domain model](architecture/domain-model.md#implemented-now-p2) and
  [Observability](architecture/observability.md#implemented-now-p2).
- **Workflow scheduling** (p3): a workflow definition contract and loader, the built-in
  `build-review` workflow (build → verify → review → repair, with format repair, revision binding
  and bounded blocking/reconciliation), and `woof run build-review`/`woof run cancel`. See
  [Domain model](architecture/domain-model.md#implemented-now-p3),
  [Observability](architecture/observability.md#implemented-now-p3),
  [Workflow authoring](workflows/authoring.md#implemented-now-p3) and
  [Initial workflows](workflows/initial-workflows.md#implemented-now-p3).
- **Product integration** (p4): `.woof`/`~/.woof` configuration with provenance, `woof run start`
  hosting a run in a Herdr pane with claim/heartbeat liveness, the read-only inspection CLI
  (`status`, `runs`, `events`, `config show`), and functional Herdr and Claude Code plugins
  (`/woof:run`). See [Configuration](architecture/configuration.md#implemented-now-p4),
  [Domain model](architecture/domain-model.md#implemented-now-p4),
  [Observability](architecture/observability.md#implemented-now-p4) and
  [Workflow authoring](workflows/authoring.md#implemented-now-p4).
- **Plan-build-review and project workflows** (p5): a second built-in workflow
  (`plan-build-review`), project/user workflow discovery via `--workflow <name>`, an opt-in
  artifact/envelope verdict check, and acceptance evidence. See
  [Communication and artifacts](architecture/communication.md#implemented-now-p5),
  [Domain model](architecture/domain-model.md#implemented-now-p5),
  [Workflow authoring](workflows/authoring.md#implemented-now-p5),
  [Initial workflows](workflows/initial-workflows.md#implemented-now-p5) and
  [the acceptance evidence](acceptance/v1-evidence.md).

## Proposed next phase

[Use the existing Herdr plugin, then close display gaps](design/herdr-metadata-phase.md)
starts with the [plugin audit](research/herdr-plugin-audit.md): registration,
actions, basic metadata and third-party presets already exist. Configure and
verify those first. Separate kind/model/stage fields and additional worktree cues
are follow-ups only where the adoption check demonstrates a gap. Sidebar
configuration and workspace presets remain outside Woof.

See the [checkout-based plugin setup](integrations/herdr-setup.md) and
[optional sidebar proposal](integrations/herdr-sidebar.md). New tokens are
proposals; these pages do not claim that the phase is implemented or installed.

## Reading order

Read in this order:

1. [Product brief](product/brief.md): purpose, scope, and required outcomes.
2. [Architecture plan](design/woof-v1-architecture-plan.md): ownership and proposed implementation boundaries.
3. [Domain model](architecture/domain-model.md): agents, stages, rounds, attempts, gates, and state.
4. [Communication and artifacts](architecture/communication.md): requests, canonical work products, validation, and handoff.
5. [Configuration](architecture/configuration.md): project settings and user defaults.
6. [Observability](architecture/observability.md): snapshots and updates for every interface.
7. [Plugin surfaces](integrations/plugins.md): the CLI, the Herdr plugin (`doctor`/`status`/`start`/`cancel`), and the Claude Code plugin (`/woof:run`); MCP is deferred.
8. [Workflow authoring](workflows/authoring.md) and [initial workflows](workflows/initial-workflows.md).
9. [Decision record](decisions/architecture.md): settled direction, superseded ideas, and open choices.
10. [Project assessment](research/project-assessment.md): what was actually inspected and what can be reused.
11. [Acceptance criteria](acceptance/v1.md): evidence required before calling v1 complete.

The product brief and the conversation's final corrections govern requirements.
Other pages explain those requirements or explicitly label implementation
recommendations. Code-shaped examples are contract illustrations, not a released
API. The acceptance matrix is evidenced in
[v1-evidence.md](acceptance/v1-evidence.md).
