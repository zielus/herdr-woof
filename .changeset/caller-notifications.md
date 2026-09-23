---
"herdr-woof": minor
---

**Breaking:** the run host now notifies the agent that started a run, and
`woof status --wait` is removed.

Inside Herdr, `woof run start` returns as soon as the run is open. The run host
then pushes `[woof]` messages into the pane of the agent that ran `run start`,
using `herdr agent prompt`. It sends one message for each of these events:

- `action_required`: a worker is blocked.
- `resumed`: the worker continues.
- `error`: Herdr became unavailable to the run, or a worker agent is gone.
- One terminal message: `done`, or `limit_reached` when the run ended exhausted.

Messages carry engine facts only and never a worker's words. The host sends one
only while the caller's pane still hosts the same agent session and that agent
is idle. A working or blocked caller keeps the message queued, within bounds.
An ambiguous delivery is never resent.

`config.json` records the target, or why there is none. The journal records the
target (`notify.target`) and every outcome (`notify.outcome`). Both are new
record types, added at `schemaVersion: 1`.

`woof status` is now a snapshot only: `--wait`, `--timeout-ms`,
`--allow-blocked` and `--poll-ms` are gone. When the owner exited without
recording an end, `status` shows the host's `outcome.json` as `hostOutcome`.
`--host foreground` is now documented as the mode for tests, CI and scripted
runtimes. It notifies nobody and still exits with the outcome's code.
`/woof:run` and the woof skill now start the run, report it, end the turn and
act on the `[woof]` messages.
