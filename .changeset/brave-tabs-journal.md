---
"herdr-woof": minor
---

The journal now records which Herdr tab each participant runs in.

`agent.assigned` gains an optional `tabId` (the tab opened for that agent) and
`host.claimed` an optional `tabId` (the host tab the launcher created, passed to
the host process as `WOOF_HOST_TAB_ID`). Snapshots project the agent's tab as
`agents[].assignment.tabId` (`null` when none was journaled), and `woof watch`,
`woof status` and the `agent.assigned` event line show it next to the pane id.
Both fields are additive at schemaVersion 1: journals written without them read
as before.
