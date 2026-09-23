# Set up the Woof Herdr plugin

The Herdr plugin is a checkout-based integration in Woof 0.3.1. Installing the
`woof` CLI from npm does not register it because the published package excludes
the root `herdr-plugin.toml` and `bin/woof` files used by the manifest.

## Link a built checkout

Use a persistent repository checkout. From its root, inspect any existing
registration before linking or replacing it:

```sh
herdr plugin list --plugin herdr-woof --json
herdr plugin action list --plugin herdr-woof
```

If the checkout needs building or registration, run:

```sh
bun install --frozen-lockfile
bun run build
herdr plugin link .
herdr plugin list --plugin herdr-woof --json
herdr plugin action list --plugin herdr-woof
```

The manifest requires Herdr 0.9.0 or newer, but that minimum does not prove that
the installed version supports every feature in the current online configuration
reference. Use the Node and Bun versions in [`package.json`](../../package.json).
Linking keeps the plugin bound to this checkout, so rebuild it after updating
source. Inspect the registered path, enabled state and plugin logs instead of
treating command dispatch as proof that the action succeeded.

Herdr documents checkout registration in its
[plugin CLI reference](https://herdr.dev/docs/cli-reference/#plugins).

## Check the focused project

Focus the intended project or worktree in Herdr, then invoke the diagnostic and
inspection actions:

```sh
herdr plugin action invoke doctor --plugin herdr-woof
herdr plugin action invoke status --plugin herdr-woof
herdr plugin log list --plugin herdr-woof --limit 10
```

The actions resolve the project from Herdr's invocation context, not from the
plugin checkout. `cancel` and `watch` act only when the project has one
unambiguous active run. The plugin does not start runs: start one with
`woof run start` (or `/woof:run` from Claude Code). Do not cancel work as an
installation probe. See [Woof integration surfaces](plugins.md) for
the command outcomes and exit behavior.

## Configure the current metadata

Hosted runs publish compact `woof` and `woof-role` pane tokens. Herdr displays a
custom token only when the sidebar configuration references it. This optional
example uses current Woof metadata and native Herdr fields:

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

Merge selected settings into `~/.config/herdr/config.toml`; do not overwrite the
file or duplicate TOML tables. Apply the change with the installed Herdr
version's reload mechanism and check for configuration warnings. Keep existing
keybindings, themes and preset plugins under your control. Existing
`rows_by_agent` overrides replace the general Agent layout, so update those too
if they hide these rows.

Keep native lifecycle fields authoritative. `agent` is a display name, not a
guaranteed CLI kind. The current `woof` worker value is a stage with counters or
the literal `idle`; `idle` describes assignment, not observed lifecycle state.
Use Herdr's `state_icon` and `state_text` for working, idle and blocked state. The
compact example omits `woof` because it includes stage/visit/attempt counters.

Consistent native workspace names are the current checkout cue. Optional style
rules can color those names, but text must remain sufficient and Woof does not
rewrite personal configuration. Use Herdr or an existing layout plugin for
workspace presets; Woof does not manage them. Keep state icons in their semantic
colors so color is never the only checkout cue. Herdr does not document a native
`worktree` token for these rows.

The existing host publisher owns TTLs, coalescing and ordered metadata sends; a
future extension should add fields there instead of creating another scheduler.
Herdr's display-label targeting flags do not guard token patches, so such an
extension must validate pane ownership itself.

Linking alone publishes nothing. Metadata appears only after a managed run starts
with a Herdr host pane and reporting context. Non-Woof agents keep their native
Herdr fields.

Separate kind/model/stage and checkout tokens are not available. They remain in
[Open proposals](../design/proposals.md).

Herdr documents the available settings in its
[configuration reference](https://herdr.dev/docs/configuration/),
[sidebar row layouts](https://herdr.dev/docs/configuration/#sidebar-row-layouts)
and [CLI reference](https://herdr.dev/docs/cli-reference/). Successful TOML
parsing alone does not prove that the installed version supports or renders the
selected layout clearly.
