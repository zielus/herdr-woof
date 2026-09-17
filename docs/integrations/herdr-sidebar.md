# Optional sidebar: distinguish agents by worktree

Status: guide using current Woof 0.1.2 metadata. Sidebar configuration belongs to
the operator; nothing here installs configuration automatically. See the
[plugin setup guide](herdr-setup.md) for registration and configuration merging.

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
No native `worktree` token is documented for these row configurations. Proposed
extensions are described in the [metadata proposal](../proposals/herdr-metadata.md).

Missing custom values disappear; native context and status still render. Existing
`rows_by_agent` overrides replace the general Agent layout, so check whether they
hide workspace cues. This layout associates agents visually; it does not reorder
them or create collapsible worktree groups.

Herdr documents these fields and overrides in its
[sidebar configuration reference](https://herdr.dev/docs/configuration/#sidebar-row-layouts).
Verify the installed version, normal and narrow widths, native lifecycle indicators
and two worktrees with repeated roles. Record a screenshot or manual display result;
TOML parsing alone does not prove readability or live support.
