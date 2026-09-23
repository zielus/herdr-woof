# Woof documentation

These pages describe Woof 0.3.1: what it is, how the current engine and
integrations behave, how to extend it, and which capabilities are not supported.

## Reading order

1. [Product brief](product/brief.md) for current scope and boundaries.
2. [Architecture decisions](decisions/architecture.md) for the settled design,
   open choices and known limits.
3. [Domain model](architecture/domain-model.md),
   [communication and artifacts](architecture/communication.md),
   [configuration](architecture/configuration.md) and
   [observability](architecture/observability.md) for the engine contracts.
4. [Initial workflows](workflows/initial-workflows.md) and
   [workflow authoring](workflows/authoring.md) to use or extend workflows.
5. [Integration surfaces](integrations/plugins.md),
   [Herdr plugin setup](integrations/herdr-setup.md) and
   [Web UI](architecture/web-ui.md) for operator-facing entry points.
6. [Contributing](../CONTRIBUTING.md) and the
   [release process](decisions/release-process.md) for repository work and
   publishing.

## Reference pages

### Product and architecture

- [Product brief](product/brief.md)
- [Architecture decisions and known limits](decisions/architecture.md)
- [Domain model and execution state](architecture/domain-model.md)
- [Communication and artifacts](architecture/communication.md)
- [Configuration and project context](architecture/configuration.md)
- [Observability](architecture/observability.md)
- [Web UI](architecture/web-ui.md)

### Workflows and integrations

- [Initial workflows](workflows/initial-workflows.md)
- [Authoring a workflow](workflows/authoring.md)
- [CLI and plugin surfaces](integrations/plugins.md)
- [Set up the Woof Herdr plugin](integrations/herdr-setup.md)
- [Open proposals](design/proposals.md), clearly separated from implemented
  behavior
- [Human-readable run output](design/run-output.md), the implemented design brief
  and visual reference for `woof watch` and the run host's view
- [Terminal UI](design/tui.md), the design behind `woof tui`: terminal-native runs
  browser, expandable steps and keyboard navigation with an interactive prototype
- [Checkout policy and workflow composition](design/composition.md), implemented:
  worktree checkouts, workflows as steps, `plan` and `auto-build`

### Contribution and release

- [Contributing](../CONTRIBUTING.md)
- [Release process](decisions/release-process.md)
- [Repository working instructions](../AGENTS.md)

## Acceptance records

[Acceptance criteria](acceptance/v1.md) define the v1 checks. The
[acceptance evidence](acceptance/v1-evidence.md), its machine-readable evidence
and `research/*.log` files record results for the revisions named in those
files. They are retained because tests and evidence tooling parse them; they do
not claim fresh 0.3.x acceptance. The
[composition evidence](acceptance/composition-evidence.md) records the live
proof of checkouts and workflow composition.

The phase-labelled headings in some contract pages remain as compatibility
anchors. A later documentation pass can consolidate those sections without
changing their meaning.
