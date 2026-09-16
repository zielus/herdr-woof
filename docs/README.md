# Woof documentation

Status: design baseline, 2026-09-14. These documents synthesize the
September 2026 product design conversation
and inspected project material. They describe what to build; they do not claim
that the features exist or that proposed implementation details are approved.

A first working slice now exists: result handoff (envelope v1, `woof submit`,
`woof attempt open`, and the run journal), a p2 run-facts contract (run
plans, journaled agent assignment/dispatch/termination, derived run
snapshots and events, a runtime adapter over the Herdr CLI, and `woof run
show`), a p3 workflow-scheduling layer: a workflow definition contract and
loader, the built-in `build-review` workflow (build → verify → review →
repair, with format repair, revision binding and bounded blocking/
reconciliation), and `woof run build-review`/`woof run cancel`, a p4
product-integration layer: `.woof`/`~/.woof` configuration with provenance,
`woof run start` hosting a run in a Herdr pane with claim/heartbeat liveness,
the read-only inspection CLI (`status`, `runs`, `events`, `config show`), and
functional Herdr and Claude Code plugins (`/woof:run`), and a p5 layer: a
second built-in workflow (`plan-build-review`), project/user workflow
discovery via `--workflow <name>`, an opt-in artifact/envelope verdict check,
and acceptance evidence executed at revision
`5e0236e6d06152222e6ff35f80dc05889841d4c2` — see
[the acceptance evidence](acceptance/v1-evidence.md). See
[Communication and artifacts](architecture/communication.md#implemented-now-p1-prototype)
and [Communication and artifacts](architecture/communication.md#implemented-now-p5) (p5),
[Domain model](architecture/domain-model.md#implemented-now-p2) (p2),
[Domain model](architecture/domain-model.md#implemented-now-p3) (p3),
[Domain model](architecture/domain-model.md#implemented-now-p4) (p4) and
[Domain model](architecture/domain-model.md#implemented-now-p5) (p5),
[Observability](architecture/observability.md#implemented-now-p2) (p2),
[Observability](architecture/observability.md#implemented-now-p3) (p3) and
[Observability](architecture/observability.md#implemented-now-p4) (p4),
[Configuration](architecture/configuration.md#implemented-now-p4) (p4),
[Workflow authoring](workflows/authoring.md#implemented-now-p3) (p3),
[Workflow authoring](workflows/authoring.md#implemented-now-p4) (p4) and
[Workflow authoring](workflows/authoring.md#implemented-now-p5) (p5), and
[Initial workflows](workflows/initial-workflows.md#implemented-now-p3) (p3)
and [Initial workflows](workflows/initial-workflows.md#implemented-now-p5)
(p5) for what is real today versus still proposed.

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
API. Acceptance scenarios are planned checks, not test results.
