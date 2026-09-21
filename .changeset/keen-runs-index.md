---
"herdr-woof": minor
---

Runs can now be found and followed from one place, wherever their directories are.

Opening a run registers a small locator under `~/.woof/index/runs/<runId>.json`
(`WOOF_INDEX_DIR` overrides the index root). The locator only says where the run
directory is: status and events still come from the run's own journal, and a
locator that no longer leads to its run is reported under `skipped`.

- `woof runs` with no `--runs-dir` also lists indexed runs, so a run started with
  its own `--run-dir` shows up. `woof runs --reindex` writes missing locators and
  prunes those whose run directory is gone.
- `woof status`, `events`, `watch`, `run show` and `run cancel` accept a run id as
  well as a run directory.
- `woof events --all [--follow] [--project <dir>] [--since <iso>]` streams the
  events of every known run as NDJSON, and `woof watch --all` prints the same
  stream as readable lines. `woof ui` without `--runs-dir` lists indexed runs too.
