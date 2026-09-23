---
"herdr-woof": minor
---

**Breaking:** the web UI is removed. `woof ui` no longer exists, and the package
no longer ships `dist-ui/`. Woof is a workflow engine and a Herdr agents library;
follow runs with `woof status`, `woof watch`, `woof events`, `woof runs` or
`woof tui`, and cancel them with `woof run cancel`. The engine's inspection and
cancellation functions (`listRuns`, `readRunStatus`, `cancelRun`) are unchanged.
Journals whose `run.cancel_requested` names the old `web` source still replay.
