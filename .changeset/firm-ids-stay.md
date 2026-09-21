---
"herdr-woof": patch
---

The run index no longer guesses, forgets or polls without bound.

- A run id that names two different runs (one in the run index, another at
  `<runs-dir>/<id>`) is rejected as `run_id_ambiguous` (exit 3) by `status`,
  `events`, `watch`, `run show` and `run cancel` instead of silently picking one;
  the run directory always works. A second run with the same id no longer takes
  over the locator of a run that still exists: the first locator stays and the
  newcomer is reported on stderr, without failing its open.
- `woof runs --reindex` keeps locators whose run directory cannot be reached and
  lists them under `unavailable`, so a volume that is not mounted does not lose
  its runs. `--reindex --prune` removes the locators whose directory does not
  exist.
- `woof events --all --follow` and `woof watch --all --follow` poll at most
  `--max-runs <n>` runs at a time (default 64), runs that have not ended and the
  most recent first, and stop polling a run once it has ended. A run that has to
  wait is reported once as `{"kind":"woof.events.skipped",…,"reason":"follow_cap"}`
  and followed from where it stood when a follower ends.
- A locator whose `runDir` is not an absolute path is `locator_invalid` and is
  never followed against the current directory; a locator's directory is
  resolved on every load.
