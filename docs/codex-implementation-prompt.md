# Codex Implementation Prompt

You are implementing the next version of **Woof**, a Herdr plugin that replaces the current `herdr-woof`.

Read all files in `docs/` before coding.

The user will provide local paths to two reference repositories:

- `ellingtonsp/herdr-orch`
- `eliasstravik/herdr-projects`

## First task: inspect references

Before editing Woof:

1. inspect both repositories,
2. map reusable code/components to the Woof docs,
3. identify assumptions that must be removed,
4. write a short implementation plan,
5. only then start coding.

Do not reimplement proven edge-case handling from memory if it can be ported.

## Architectural requirements

Woof must use:

- one global `woofd`,
- one global SQLite DB,
- multiple live Herdr session connections,
- short-lived Herdr plugin session registration/bootstrap,
- stable logical worker IDs independent of pane IDs,
- durable messages and append-only events,
- raw-args-based profiles,
- event-driven operation,
- watchdog ticks only for liveness/recovery.

Do not reproduce `herdr-orch`'s per-session daemon/database architecture.

## Important donors

From `herdr-orch`, strongly prefer adapting:

- Herdr client,
- event subscriptions,
- RPC,
- SQLite store patterns,
- worker lifecycle,
- dispatch settlement,
- mailbox and ask/reply,
- safe release,
- uncertain-mutation handling,
- gates,
- useful tests.

From `herdr-projects`, strongly prefer adapting:

- profiles,
- profile summaries,
- profile roster UX,
- ticker/nudge ideas,
- optional file projection patterns,
- skill/plugin ergonomics.

## Scope

Implement **Phase 1 only** unless a change is required to keep Phase 2 possible.

Do not implement the full workflow engine yet.

Do not introduce a generic model/effort resolver.

Do not use files as canonical state.

## Quality bar

Before considering Phase 1 complete:

- tests cover restart/recovery,
- tests cover multiple Herdr sessions,
- tests cover message replay/wait,
- tests cover worker settlement,
- tests cover uncertain mutation behavior,
- tests prove workers are addressed by logical identity,
- tests prove a second Herdr session does not create a second long-lived Woof daemon.

When a design question conflicts with these docs, stop and document the conflict instead of silently inventing a new architecture.
