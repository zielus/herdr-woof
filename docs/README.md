# Woof documentation

Status: design baseline, 2026-09-14. These documents synthesize the
[product conversation](https://chatgpt.com/c/6aa71569-4e7c-83ed-b6d6-03992919a7c4)
and inspected project material. They describe what to build; they do not claim
that the features exist or that proposed implementation details are approved.

Read in this order:

1. [Product brief](product/brief.md): purpose, scope, and required outcomes.
2. [Architecture plan](design/woof-v1-architecture-plan.md): ownership and proposed implementation boundaries.
3. [Domain model](architecture/domain-model.md): agents, stages, rounds, attempts, gates, and state.
4. [Communication and artifacts](architecture/communication.md): requests, canonical work products, validation, and handoff.
5. [Configuration](architecture/configuration.md): project settings and user defaults.
6. [Observability](architecture/observability.md): snapshots and updates for every interface.
7. [Plugin surfaces](integrations/plugins.md): Herdr, Claude Code, CLI, and optional MCP.
8. [Workflow authoring](workflows/authoring.md) and [initial workflows](workflows/initial-workflows.md).
9. [Decision record](decisions/architecture.md): settled direction, superseded ideas, and open choices.
10. [Project assessment](research/project-assessment.md): what was actually inspected and what can be reused.
11. [Acceptance criteria](acceptance/v1.md): evidence required before calling v1 complete.

The product brief and the conversation's final corrections govern requirements.
Other pages explain those requirements or explicitly label implementation
recommendations. Code-shaped examples are contract illustrations, not a released
API. Acceptance scenarios are planned checks, not test results.
