---
"herdr-woof": minor
---

Workflow runs now use one Herdr tab per participant instead of pane splits.

`woof run start --host herdr-pane` (and the Herdr `start` action) opens the run
host in the root pane of a new, unfocused tab labelled `woof:<workflow>`, and
every agent of the run gets its own tab labelled `woof:<role>`. The live watch
(`woof watch <run-dir> --follow`) is now on by default as a pane split below the
host inside the host's tab; `--no-watch` opts out and `--watch` is still
accepted. The started output's `host` gains `tabId`. When a run ends, Woof closes
the tabs it created and never a tab it did not create.

The runtime adapter contract's `openPane` takes `placement: "tab"` with a
`label` and returns `{ paneId, tabId }`; `stop` reports `tabClosed` when it
closed an owned tab. `woof agent start` still splits a pane.
