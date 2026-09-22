---
"herdr-woof": minor
---

Workflow runs now use one Herdr tab per participant instead of pane splits.

`woof run start --host herdr-pane` (and the Herdr `start` action) opens the run
host in the root pane of a new, unfocused tab labelled `woof:<workflow>`, and
every agent of the run gets its own tab labelled `woof:<role>`. The started
output's `host` gains `tabId`.

When a run ends, Woof closes the agent tabs it created (unless `keepPanes` is
set) and never a tab it did not create. The host's tab stays open so its last
lines remain readable. A launch that
fails before any host owns the run directory — `pane run` failed, the host's
claim failed, no host claimed in time, or the `tab create` reply did not verify
— closes the host tab it created; a tab whose host did claim the directory is
kept.

Tabs go to the workspace Herdr reports for the launcher's pane (for a Herdr
action, the focused pane), falling back to `HERDR_WORKSPACE_ID` and then to
Herdr's default. `tab create` replies are verified as a whole (tab id, root
pane, matching tab and workspace ids) before a tab is used, and the host
process receives the verified workspace so agent tabs open next to it.

The runtime adapter contract's `openPane` takes `placement: "tab"` with a
`label` and returns `{ paneId, tabId }`; `stop` reports `tabClosed` when it
closed an owned tab. `woof agent start` still splits a pane.
