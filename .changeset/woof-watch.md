---
"herdr-woof": minor
---

Follow a run in plain language. `woof watch <run-dir> [--follow]` prints a short header (run, workflow, current stage, host owner, agents with role, kind, model and pane) and then one readable line per journal event; `woof events --pretty` prints the same, and `woof status <run-dir> --pretty` prints the header instead of JSON. Colors appear only on a terminal and are off with `NO_COLOR`. `woof run start --watch` opens that view in a pane below the run host (it stays open after the run unless you pass `--no-keep-panes`), and the Herdr plugin gains a "Woof: watch the active run" action. JSON output without `--pretty` is unchanged.
