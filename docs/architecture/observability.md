# Observability and future interfaces

## One source of run meaning

The engine exposes current state and incremental updates. Herdr, Claude Code,
logs, a future TUI, and a future Web UI consume that contract. Consumers must not
infer stages or success by reading prompts, scraping terminals, or interpreting
UI labels. Observability works when the Herdr Woof plugin is absent.

## Snapshot contract

A snapshot needs enough information to answer what is happening, who owns the
work, what is waiting, and how the run can end:

| Area      | Required information                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Identity  | Run ID, workflow identity/version, project context, schema version and snapshot revision.                                         |
| Progress  | Run status, current stage/visit/attempt, round counters, start/update/completion times.                                           |
| Agents    | Logical name, role, kind/model, runtime target, session identity when available, current assignment and observed lifecycle state. |
| Control   | Gate outcomes, active limits and consumed counters, retries and format repairs.                                                   |
| Attention | Block reason, owning agent, required action, failure or exhaustion reason.                                                        |
| Outputs   | Accepted artifact references by visit, latest accepted result and terminal envelope when present.                                 |
| Liveness  | Whether the run owner is reachable and whether runtime observation is current.                                                    |

Do not place whole review or research bodies in every snapshot. References let
consumers retrieve the canonical artifact when needed.

## Event contract

Expose run admission and termination, agent assignment and lifecycle changes,
stage/attempt start and completion, artifact acceptance, submission rejection,
format repair, work retry, gate evaluation, blocking/unblocking, cancellation,
limit exhaustion, and observation loss/recovery.

Each event carries schema version, run identity, timestamp and a monotonic
per-run sequence. Include agent, stage, visit and attempt identity where relevant.
Event names are an API design choice; the required facts are independent of their
spelling.

A consumer must be able to obtain a snapshot and continue with later updates
without missing transitions between those operations. Define duplicate handling,
reconnection and a stale-cursor response. A bounded replay window with an explicit
resnapshot path is sufficient; indefinite event retention is not implied.

Publish state changes only after they are recorded. A journal/reducer design is
recommended if it can reproduce the snapshot exactly. Otherwise document the
actual authoritative state and test snapshot/event consistency rather than
claiming event replay that the stored data cannot support.

Herdr exposes a snapshot and event subscriptions for runtime clients. Its runtime
events are inputs to the SDK; Woof supplies workflow events such as review gates
and repair rounds. [Herdr socket API](https://herdr.dev/docs/socket-api/).

## Human-facing projection

The Herdr adapter can publish role, model, task, workflow, stage, round, and state
metadata. A useful display might read:

```text
builder · configured model
task-123 · build-review · repair · round 2
working
```

Metadata is a view of the engine state. Losing a sidebar update cannot change a
gate decision. Keep visual layout and keybindings in the host's presentation
layer, and keep notification delivery separate from event generation. Attention
should focus on blocks, failures and completion rather than every activity change.

## TUI readiness

The future TUI needs run listing, snapshots, incremental updates, artifact
retrieval, and defined control operations such as cancellation. It should be
possible to build it without modifying workflow definitions. No TUI, Web UI,
rendering library, WebSocket server, or specific database is required now.

Verify this with an external consumer that follows an active run, disconnects,
reconnects, and reaches the same visible state as a fresh snapshot. Include a
blocked run and a terminated runtime, not just successful completion.
