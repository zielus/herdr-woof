---
"herdr-woof": minor
---

Runs choose where they work through the input: a reserved `checkout` key.

Every workflow input may carry `checkout`: `{"mode":"current"}`,
`{"mode":"worktree","branch"?,"base"?,"label"?,"keep"?}` or
`{"mode":"path","path"}`. The engine peels it off before the workflow's own
validation. Inside Herdr with the Herdr runtime a run now defaults to a new
Herdr worktree (branch `woof/<runId>`): `woof run start` hosts the run in the
root pane of that worktree's workspace, and every agent tab opens there.
Outside Herdr the default stays the repository itself, and a worktree is
refused `checkout_unsupported`. A workflow that edits the tree (the default,
`checkout: "writable"` in its definition) refuses a `current` or `path`
checkout with uncommitted changes as `checkout_dirty`; `checkout: "any"`
accepts one. `run.opened.checkout` records the result (additive at
schemaVersion 1), and snapshots, `woof status` and the run view show it.
Created worktrees are kept; `keep: false` removes one after a completed run
(the branch stays).
