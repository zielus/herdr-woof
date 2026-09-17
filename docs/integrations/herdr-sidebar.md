# Optional sidebar: distinguish agents by worktree

Status: setup-first presentation proposal, 2026-09-17. Sidebar configuration is owned by the
operator, outside Woof. Nothing here installs configuration automatically.
Start with the existing capabilities identified in the
[plugin audit](../research/herdr-plugin-audit.md). The richer snippet depends on the proposed
[metadata phase](../design/herdr-metadata-phase.md).

## Display priorities

Agent rows should make checkout association easy to scan, followed by role,
agent kind and configured model, native lifecycle status, and current stage.
Workspaces should show their name, branch/worktree and native activity indicator,
plus a current stage only when it is unambiguous. Omit stage totals, rounds,
attempt counters and generated task descriptions from the default layout.

Use the same short worktree key and label on an agent and its workspace. Text is
the primary cue; optional color reinforces it. A key remains useful when long
branch names are truncated or two checkouts share a basename.

Example after the metadata phase, with illustrative values:

```text
Agents
  83ac19e2 · woof/api
  ● builder · claude · configured-model
  working · repair

  83ac19e2 · woof/api
  ○ reviewer · codex · configured-model
  idle

  a71db502 · woof/ui
  ● builder · claude · configured-model
  working · build

Spaces
  ● API work
  83ac19e2 · woof/api
  feat/api
  build-review · repair
```

This provides matching cues in a flat Agent list. It does not reorder agents or
create collapsible worktree sections. The checked Herdr configuration docs specify
row content and styling, not a worktree grouping option. Do not add an invented
`group_by` setting. Use Herdr's Space worktree grouping/navigation or an existing
plugin for structural navigation where supported.

## Usable with current Woof metadata

Use this first. A consistent workspace label is already a grouping cue on every
Agent entry. When each worktree has its own Herdr workspace, the native workspace
label connects its agents to the matching Space; the native branch identifies the
checkout there. Verify that your workspace preset plugin names these clearly.
If agents from different worktrees share one workspace, this cue alone is not
enough; record that gap before adopting extra Woof identity fields.

This snippet uses existing native fields and `$woof-role`. It keeps workspace
context visible on every agent, including unmanaged agents. It cannot yet add
the explicit shared worktree key, model or separate stage field.

```toml
[ui]
status_indicators = "symbols"

[ui.sidebar.agents]
row_gap = 1
rows = [
  ["machine", "workspace", "tab"],
  ["state_icon", "$woof-role", "agent"],
  ["state_text"],
]

[ui.sidebar.spaces]
row_gap = 1
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status"],
]
```

`agent` is a display name and may have been renamed; it is not guaranteed to be
the CLI kind. The future `woof-kind` field addresses that distinction. `$woof`
is intentionally omitted because its current value contains stage counters.
No native `worktree` token is documented for these row configurations; explicit
worktree labels below therefore use proposed custom fields.

For quick visual distinction today, replace `"workspace"` in both sets of rows
with a style table like this fragment, using your actual workspace names:

```toml
token = "workspace"
bold = true
rules = [
  { equals = "API work", fg = "#89b4fa" },
  { equals = "UI work", fg = "#a6e3a1" },
]
```

This uses a native field and needs no new Woof token. Names remain readable without
color. It visually associates entries; it does not change their order. Do not
automatically rename workspaces or edit rules as part of Woof installation.

## Proposed layout after metadata publishing is extended

Only adopt this if the setup-first trial demonstrates a need for the proposed
fields. Use it instead of the previous snippet, not in addition to it.
The native agent name stays on the
context line as a useful identity, especially for repeated roles.

```toml
[ui]
status_indicators = "symbols"

[ui.sidebar.agents]
row_gap = 1
rows = [
  ["machine", "workspace", "agent"],
  [{ token = "$woof-tree-key", bold = true }, "$woof-worktree"],
  ["$woof-branch"],
  ["state_icon", "$woof-role", "$woof-kind", "$woof-model"],
  ["state_text", "$woof-stage"],
]

[ui.sidebar.spaces]
row_gap = 1
rows = [
  ["state_icon", "workspace"],
  [{ token = "$woof-tree-key", bold = true }, "$woof-worktree"],
  ["branch", "git_status"],
  ["$woof-workflow", "$woof-stage", "$woof-activity"],
]
```

Missing custom values disappear; native context and status still render. Existing
`rows_by_agent` overrides replace the general Agent layout, so update those too
if they would hide the worktree cues. Adjust sidebar width in your personal config
if needed. Test the full layout at your normal terminal width; its extra context
uses more vertical space than the compact default.

Herdr documents these native/custom tokens, style tables and override behavior
in [sidebar configuration](https://herdr.dev/docs/configuration/#sidebar-row-layouts).
Expanded desktop row configuration does not establish the same layout for compact
or mobile views; check those separately before claiming coverage.

## Optional color and activity descriptions

To reinforce a known worktree's identity, replace the tree-key style entry in both
Agent and Space rows with an operator-maintained rule such as this fragment:

```toml
token = "$woof-tree-key"
bold = true
rules = [
  { equals = "83ac19e2", fg = "#89b4fa" },
  { equals = "a71db502", fg = "#a6e3a1" },
]
```

These example keys must be replaced with actual published values. Woof does not
assign colors, patch config or claim automatic palette generation. Keep state
icons in their semantic colors and retain the textual key so color is never the
only way to distinguish checkouts. A first version needs no color rules at all.

An optional last Agent row can show `terminal_title_stripped`, or a summary token
owned by an existing plugin. Choose one source; keep generated prose out of the
workflow state contract and never rename runtime agent identities to group rows.

## Visual acceptance

Use two worktrees with repeated builder/reviewer roles. Confirm that an operator
can associate agents with the right Space using the key alone, including narrow
widths, similar names and changed display titles. Verify branch visibility,
native blocked/working/idle states, missing model metadata and multi-run workspace
behavior. Record the Herdr version and a screenshot or explicit manual result.
TOML parsing alone does not prove that a sidebar is readable or supported by the
installed Herdr version.
