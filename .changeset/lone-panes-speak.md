---
"herdr-woof": minor
---

One pane per run: the run host prints the human run view itself, and the watch
split is gone.

`woof run host` (what `woof run start --host herdr-pane` types into the root
pane of the host's tab), `woof run start --host foreground` and `woof run
build-review` now print to their stdout exactly what `woof watch <run-dir>
--follow` prints — the opening block, one history row per fact as the journal
records land, the outcome summary — followed by the result JSON line. The host
follows its own journal through the same read-only, lock-free observe stream
`woof watch` uses, so its pane and a separate observer agree by construction,
and the follow never delays the host's exit. The technical log (scheduler
actions, warnings, metadata-report failures) goes to `<run-dir>/host.log`, one
timestamped line per entry, and no longer to stderr; `--plain` prints that log
to stdout instead of the human view, and `--ascii` and `--preview summary|json`
(`--input summary|json` on `run host`) shape the view like `woof watch`'s
flags. Colors follow `NO_COLOR` and whether stdout is a terminal.

Removed: the `woof watch --follow` pane split below the host, the
`--watch`/`--no-watch` flags of `woof run start` (now usage errors), the
`watch` field of the started output and the Herdr `start` action's watch pane.
`--keep-panes`/`--no-keep-panes` keep deciding whether the agent tabs close
when the run ends; the host's tab always stays open. `outcome.json`, exit
codes, `host-exit.json`, `host.claimed`/`host.exited` and `woof status --wait`
are unchanged.
