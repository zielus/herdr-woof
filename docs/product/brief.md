# Product brief

## Purpose

Woof makes it easy for a coding agent to create and coordinate other coding
agents inside Herdr. The normal caller is an agent such as Claude Code. The human
can see the work, inspect its artifacts, and respond when a decision is needed.

Herdr runs the agents. Woof supplies roles, project context, workflows, and
integrations. `HerdrAgentsSDK` is the reusable engine inside Woof that decides
what happens next.

The product has one name across its Herdr and Claude Code plugins. Orchestration
belongs inside that product; a separate Horde product is no longer part of the
direction.

## First complete experience

A caller starts `build-review` with a task, acceptance criteria, and project
context as structured input. Woof assigns a builder and reviewer, starts their
sessions through Herdr, and coordinates the work. The builder changes the
repository. The reviewer writes a review artifact. If review fails, the same
builder reads that artifact and repairs the work. The reviewer checks again.

The loop ends when the gate passes, a limit is exhausted, the work fails, or the
run is cancelled. Blocking is visible and has a defined resolution path. The
caller receives a small structured outcome with references to the work products.
No human has to create panes or relay feedback between agents.

## Required capabilities

| Area             | Requirement                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Product surfaces | Herdr plugin, Claude Code plugin, and independently consumable `HerdrAgentsSDK`.                                            |
| Roles            | Reusable builder, reviewer, planner, researcher, and project-defined profiles. Role, agent kind, and model remain separate. |
| Identity         | A named agent can perform several stages. A repair stage reuses its builder when continuity matters.                        |
| Workflow input   | Rich structured objects, validated before work starts. Human-friendly command-line flags do not constrain the contract.     |
| Workflow output  | Substantive work in artifacts; validated structured envelopes carry status and artifact references.                         |
| Control          | Explicit stages, rounds, attempts, retries, gates, blocking, failure, cancellation, completion, and finite limits.          |
| Configuration    | Reusable user defaults plus project-local roles, workflows, and context.                                                    |
| Observability    | Engine-owned current state and incremental lifecycle updates usable by plugins and future interfaces.                       |
| Reuse            | A second workflow works without workflow-specific changes to the engine.                                                    |

The first version must include a complete build/review/repair loop and at least
one additional workflow. `plan-build-review` is the recommended second example.
Multi-agent research and discussion remain supported product use cases; they
need not all ship in the first increment.

## Boundaries

Herdr keeps responsibility for terminal processes, agent execution, panes,
sessions, workspaces, and worktrees. Woof composes those capabilities. It does
not implement another terminal runtime or duplicate session restoration.

The SDK owns orchestration independently of presentation. A Herdr sidebar,
Claude command, future TUI, and log consumer must see the same underlying run
state. MCP is an optional adapter; neither the SDK nor core workflow execution
requires it.

The CLI is useful for inspection, debugging, testing, and automation. Starting
complex workflows by manually typing long commands is a secondary experience.

## Scope discipline

Build the engine and its observability contract now. Build a dedicated TUI or
Web UI later. Keep generic diff viewers, file browsers, navigation tools, and
notification interfaces in Herdr or optional integrations where practical.

Retain the useful ideas from the earlier customization discussion: role/model/task
metadata, project presets, task-to-worktree setup, and attention on blocked,
failed, or completed work. A large command palette, elaborate layouts,
multi-machine orchestration, and a collection of mandatory community plugins
are not prerequisites for the first workflow.

Exact package names, transport, storage, workflow syntax, configuration filenames,
and worker-provider rollout are implementation decisions. The
[decision record](../decisions/architecture.md) identifies the choices that still
need evidence before implementation.

## Source

The September 2026 product design conversation
is the product source. Its final artifact correction takes precedence over the
earlier suggestion that a review file is optional. See the
[acceptance criteria](../acceptance/v1.md) for completion evidence.
