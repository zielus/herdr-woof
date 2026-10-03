# Woof — Specification

## Purpose

Woof is a Herdr plugin that provides a durable coordination layer for coding agents.

It replaces the current `herdr-woof` implementation with a simpler architecture built around:

- one global daemon,
- one SQLite database,
- multiple live Herdr sessions,
- stable logical worker identities,
- durable messages and events,
- thin agent profiles,
- event-driven coordination with watchdog ticks,
- future workflow orchestration.

Woof is not a replacement for Herdr. Herdr remains the execution/runtime layer for sessions, workspaces, panes, agents, and worktrees.

## Reference implementations

Before changing code, inspect both local reference repositories supplied by the user:

1. `ellingtonsp/herdr-orch`
2. `eliasstravik/herdr-projects`

The user will provide their local paths.

Treat them as implementation references, not as architecture that must be copied wholesale.

### Reuse from `herdr-orch`

Prefer adapting these ideas and implementations where practical:

- Herdr socket client and event subscription handling.
- Durable SQLite store patterns.
- RPC over a local Unix socket.
- Mailbox, `ask` / `reply`, and durable messages.
- Worker lifecycle handling.
- Safe release/stop semantics.
- Dispatch tracking.
- Settlement requiring both:
  - explicit worker completion report, and
  - Herdr lifecycle evidence that the worker turn ended.
- Escalation instead of guessing when a worker becomes idle or blocked.
- No blind replay of mutations after an uncertain RPC outcome.
- Decision gates.
- TUI/Web foundations where reusable.

Do **not** inherit these architectural choices:

- one daemon per Herdr session,
- one SQLite DB per Herdr session,
- session-local orchestration as the top-level ownership model,
- coordinator-centric execution as a hard requirement.

### Reuse from `herdr-projects`

Prefer adapting:

- profile ergonomics,
- profile descriptions,
- profile safety/default concepts where useful,
- lightweight CLI-facing configuration,
- roster/context output intended for a lead agent,
- agent-friendly nudges/tickers,
- file projections where useful for tools that can monitor files,
- plugin/skill ergonomics.

Do **not** copy its files-only state model. Woof has a daemon and database.

## Core principles

1. **One daemon**
   - One `woofd` process owns all durable state.
   - It manages multiple Herdr sessions concurrently.

2. **One database**
   - One SQLite database is the canonical state store.
   - Session/workspace/worktree/run scope is represented in rows, not separate databases.

3. **Herdr remains the executor**
   - Woof does not replace Herdr pane, workspace, session, or agent execution.
   - Woof routes through Herdr APIs.

4. **Stable logical identities**
   - Woof addresses workers by Woof identity, not pane location.
   - Pane IDs are transport/runtime references only.

5. **Profiles are launch presets**
   - A profile is not an agent identity.
   - A profile describes how to launch one CLI configuration.

6. **Event-driven normal operation**
   - Herdr events and Woof events drive progression.
   - Ticks are watchdog/recovery mechanisms, not the primary workflow loop.

7. **DB is source of truth**
   - Optional files are projections/artifacts only.
   - No core state depends on a monitor file.

8. **No direct invisible agent-to-agent transport**
   - Worker messages always pass through Woof.
   - This preserves durability, auditability, routing, and recovery.

## Scope model

Woof should support:

- global scope,
- session scope,
- workspace scope,
- worktree scope,
- run scope,
- worker scope.

CLI commands infer the narrowest useful default scope from injected environment/context.

Explicit CLI scope flags can override it.

Example:

```text
WOOF_SESSION_ID=s1
WOOF_WORKSPACE_ID=ws4
WOOF_WORKTREE_ID=wt2
WOOF_RUN_ID=r17
WOOF_WORKER_ID=w9
```

Running:

```bash
woof inbox
```

uses the current inferred scope.

Running:

```bash
woof inbox --global
woof inbox --workspace ws8
woof workers --session s2
```

explicitly overrides it.

Environment variables are convenience/context input, not canonical truth.

## Major components

- `woofd`
  - global daemon
  - session registry
  - event subscriptions
  - durable store
  - message router
  - watchdog
  - future workflow engine

- `woof`
  - CLI for humans and agents
  - talks to `woofd` over Unix socket

- Herdr plugin bootstrap
  - starts or discovers `woofd`
  - registers the current Herdr session with its socket
  - exits after registration
  - does not become a per-session long-running daemon

- SQLite store
  - one DB
  - single writer: `woofd`

- optional TUI/Web
  - observability and control
  - no independent state ownership

- Claude Code skill
  - teaches Claude how to use Woof safely and efficiently

## Phase 1

Implement the durable coordination core without a dedicated workflow engine.

Required Phase 1 features:

- global daemon,
- global DB,
- session registration/discovery,
- reconnect/recovery,
- workers,
- profiles,
- profile roster,
- messages,
- ask/reply,
- events,
- event follow/wait,
- watchdog ticks,
- dispatch,
- completion settlement,
- safe release,
- scope inference,
- TUI or minimal board if cheap to port.

## Phase 2

Add the dedicated workflow engine after the core is stable.

The Phase 1 architecture must not block:

- workflow-owned workspace/worktree,
- multiple persistent role workers in one workflow,
- deterministic node transitions,
- loops such as implement → review → implement,
- structured node outputs,
- event-driven workflow execution,
- workflow observation from the invoking session.

See `docs/phases.md`.

## Non-goals for Phase 1

- Generic cross-CLI model/effort resolver.
- Multi-machine orchestration.
- Full workflow DSL.
- Autonomous coordinator replacement.
- Reimplementing Herdr worktree internals.
- Files-only persistence.
