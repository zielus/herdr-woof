# Open proposals

Nothing on this page is implemented. Current behavior is documented in
[Woof integration surfaces](../integrations/plugins.md); current setup is in
[Set up the Woof Herdr plugin](../integrations/herdr-setup.md).

## Richer Herdr metadata

Woof currently publishes `woof` and `woof-role` on managed agent panes and
`woof` plus a title on the run-host pane. The open proposal is to publish
separate configured kind/model, counter-free stage, workflow, run and Woof-state
tokens while preserving the existing keys during any migration.

An optional extension would publish a short checkout label and stable key on
managed panes when native workspace labels cannot distinguish worktrees. It must
derive identity from verified runtime and Git context, not a branch name or
directory basename. Unknown values must be absent rather than guessed.

Workspace-level run or stage projection is a separate extension. It needs one
reconciled view across hosts so simultaneous runs cannot overwrite or clear each
other. A mixed-worktree workspace must not advertise one false checkout.

Any extension must keep metadata display-only, bounded, coalesced and expiring.
It must validate pane ownership before publishing, clear obsolete values, touch
only Woof-owned keys and leave scheduling, artifact acceptance and lifecycle
authority unchanged.

## Richer sidebar presentation

The operator, not Woof, owns Herdr sidebar rows, ordering, styling and workspace
presets. First use native workspace, agent, branch and lifecycle fields with the
existing `woof-role` token as shown in the setup guide.

If that layout is insufficient after the metadata extension exists, a richer
personal layout could add the proposed checkout, kind, model and stage tokens.
It must keep native lifecycle fields visible, remain useful when optional values
are absent and avoid invented grouping settings. Woof would not rewrite personal
configuration, assign colors or rename workspaces.

Acceptance would require visual checks with repeated roles in two worktrees,
narrow widths, missing optional values, publisher loss and multiple runs in one
workspace. Automated token tests alone would not establish readable sidebar
behavior.
