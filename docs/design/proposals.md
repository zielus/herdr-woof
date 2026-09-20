# Open proposals

Nothing on this page is implemented. Current behavior is documented in
[Woof integration surfaces](../integrations/plugins.md); current setup is in
[Set up the Woof Herdr plugin](../integrations/herdr-setup.md). Verify the
existing setup before extending it, and add only fields whose absence causes a
demonstrated display problem.

## Richer Herdr metadata

Woof currently publishes `woof` and `woof-role` on managed agent panes and
`woof` plus a title on the run-host pane. The proposal extends that publisher;
it does not add a second scheduler or reporter. Stage and assignment facts come
from the existing snapshot and host interfaces, which already carry configured
kind and model values.

The names below are literal proposed token keys, referenced with `$` in Herdr
sidebar configuration. Values stay small and never contain prompts, secrets or
artifact bodies. Unknown values are absent, not guessed. If adopted, the source
and token names become a public display contract.

- `woof-role` on an agent pane: assigned responsibility; preserve the existing
  key.
- `woof-kind` on an agent pane: configured CLI kind such as `claude` or `codex`,
  separate from a mutable display name.
- `woof-model` on an agent pane: model from resolved launch configuration, not a
  claim to observe in-session model changes.
- `woof-stage` on agent and host panes: current assigned stage ID without
  counters; clear it when no stage is active.
- `woof-workflow` on agent and host panes: workflow definition name.
- `woof-run` on agent and host panes: run ID bounded to Herdr's display limit;
  full identity stays in inspection output.
- `woof-state` on the host pane: Woof run status or outcome, separate from
  Herdr's agent state.
- `woof-worktree` on agent and host panes and an eligible workspace: short
  checkout label for the run's repository context, including the main checkout.
- `woof-tree-key` on the same targets as `woof-worktree`: stable short identifier
  that distinguishes checkouts with similar labels.
- `woof-branch` on agent and host panes: branch of the run checkout, with a
  truthful detached or unborn label. Space rows continue to use native `branch`.
- `woof-stage`, `woof-workflow` and `woof-run` on an eligible workspace: values
  only when one active run provides an unambiguous projection.
- `woof-activity` on an eligible workspace: the literal value `multiple runs`
  when several runs are active; otherwise absent. It is not a progress count.

An eligible workspace is a verified runtime workspace associated with the
managed run. It is not the plugin checkout or the caller's launch-time working
directory. Resolve it through supported Herdr data. If a pane moves, keep its run
association explicit and do not make the destination workspace advertise a
false checkout.

### Checkout identity

Explicit worktree identity is conditional. Try consistent native workspace
labels first. Herdr's documented sidebar rows do not expose a native `worktree`
token, so the custom fields above are needed only when native labels cannot
distinguish the operator's checkouts.

Every managed agent from the same checkout receives the same worktree label and
key, and the matching workspace row uses those values. Different worktrees in
one repository receive different keys. The key is independent of role, model,
run ID, branch renaming and automatic agent naming.

Derive checkout identity from verified Git worktree context and runtime host
identity, not a branch name or directory basename. The key is deterministic
across publisher restarts. Define collision handling before implementation,
preserve the key when shortening labels, and resolve paths on the target host.
Symlink aliases of one verified checkout must not create a second identity.

### Stage coverage and reconciliation

Deterministic `CheckStage` work must remain visible. A stage such as `verify`
must not disappear merely because no agent owns it.

Workspace projection needs one reconciled view across all active hosts. With
multiple runs, clear singular run, stage and workflow fields and publish
`woof-activity=multiple runs`. Restore the single-run view when appropriate;
one run finishing must not erase another run's data. Independent hosts must not
race to set or clear workspace fields, and reconciliation must not become a
second workflow-coordination layer.

For mixed worktree contexts in one workspace, omit the workspace's single
worktree key and label while retaining accurate labels on each agent.

### Publisher hygiene

Retain bounded, coalesced reports and expiring values. Refresh live context,
republish after observation recovers, and clear obsolete keys on transitions,
terminal outcomes and ownership changes. A final outcome may remain briefly; an
old active stage must not.

Re-resolve pane and workspace context after moves. Never refresh old role or run
data onto a replacement agent. Token patches are not guarded by Herdr's
display-label targeting flags, so the publisher must validate ownership before
reporting. Sequence numbers need a restart-aware policy.

Touch only Woof-owned keys. Unmanaged agents keep native `workspace`, `agent`
and lifecycle fields; Woof does not take over every agent to fill missing role
or model metadata. Metadata failure may reduce display freshness but must not
change scheduling, artifact acceptance, cancellation or terminal outcomes.

## Richer sidebar presentation

The operator, not Woof, owns Herdr sidebar rows, ordering, styling, keybindings
and workspace presets. The first setup should use native workspace, agent,
branch and lifecycle fields with the existing `woof-role` token. The current
worker value `idle` is assignment text, not a lifecycle observation; native
`state_icon` and `state_text` remain authoritative.

The proposal provides matching checkout cues in a flat Agent list. It does not
reorder agents or create collapsible worktree sections. Do not invent a
`group_by = "worktree"` setting: the Herdr configuration reference documents row
content and styling, not that grouping feature. Structural navigation belongs
in Herdr or a supported navigation plugin.

If the setup-first trial still leaves a gap after the metadata extension exists,
a richer personal layout may add checkout, kind, model and stage fields. It must
remain useful when optional values are absent. Existing `rows_by_agent`
overrides would also need updating because they replace the general Agent row
layout. Woof does not rewrite personal configuration, assign colors or rename
workspaces.

Merge any future layout into `~/.config/herdr/config.toml`; never replace the
whole file or duplicate TOML tables. Apply it with the installed Herdr version's
reload mechanism and check for configuration warnings. The manifest minimum does
not prove that every field in the current online configuration documentation is
supported by the installed version. See Herdr's
[configuration reference](https://herdr.dev/docs/configuration/),
[sidebar row layouts](https://herdr.dev/docs/configuration/#sidebar-row-layouts)
and [CLI reference](https://herdr.dev/docs/cli-reference/).

### Acceptance for either proposal

Visual acceptance would use repeated builder and reviewer roles in two worktrees,
narrow widths, missing optional values, publisher loss, pane moves, agent
replacement and several runs in one workspace. Check compact and mobile layouts
separately. Same directory or branch labels across repositories or hosts must
remain distinguishable.

Evidence would record the commands, code revision, installed Herdr version,
metadata responses and a screenshot or explicit manual display result.
Automated token tests and successful TOML parsing do not establish that the
installed Herdr can render a readable sidebar.

Task-to-worktree setup remains a separate unimplemented product idea; it is not
part of the display-metadata proposal.
