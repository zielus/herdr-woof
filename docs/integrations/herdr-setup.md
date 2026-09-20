# Set up the Woof Herdr plugin

The Herdr plugin is a checkout-based integration in Woof 0.2.0. Installing the
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

The manifest requires Herdr 0.9.0 or newer. Use the Node and Bun versions in
[`package.json`](../../package.json). Linking keeps the plugin bound to this
checkout, so rebuild it after updating source. Inspect the registered path,
enabled state and plugin logs instead of treating command dispatch as proof that
the action succeeded.

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
plugin checkout. `start` reads `<project>/.woof/start.json`; `cancel` and `watch`
act only when the project has one unambiguous active run. Do not start or cancel
work as an installation probe. See [Woof integration surfaces](plugins.md) for
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

Merge selected settings into the existing Herdr configuration; do not overwrite
the file or duplicate TOML tables. Keep native lifecycle fields authoritative.
`agent` is a display name, not a guaranteed CLI kind, and the current `woof`
token contains stage/visit/attempt counters, so the compact example omits it.

Consistent native workspace names are the current checkout cue. Optional style
rules can color those names, but text must remain sufficient and Woof does not
rewrite personal configuration. Use Herdr or an existing layout plugin for
workspace presets; Woof does not manage them.

Separate kind/model/stage and checkout tokens are not available. They remain in
[Open proposals](../design/proposals.md).
