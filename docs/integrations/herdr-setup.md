# Set up the Woof Herdr plugin

Status: guide for the existing 0.1.2 checkout-based integration. Rich metadata
and the proposed sidebar are a [future phase](../design/herdr-metadata-phase.md).
Writing this guide did not install a plugin or alter local Herdr configuration.

## Installation is separate from CLI availability

First check whether the plugin is already registered. The
[2026-09-17 saved-configuration audit](../research/herdr-plugin-audit.md) found an
enabled Woof entry pointing at this checkout, with older cached version metadata.
Treat linking below as a registration refresh only if inspection shows it is
needed. The same audit found no custom sidebar rows, so display configuration is
the first likely missing connection.

The repository root contains [herdr-plugin.toml](../../herdr-plugin.toml), with
four actions invoking [bin/woof](../../bin/woof). The published npm package's
files list currently includes compiled code and the Claude plugin, but excludes
those two Herdr-specific files. Having `woof` on PATH does not register a Herdr
plugin. Use a persistent repository checkout for the setup below.

The manifest currently requires Herdr 0.9.0 or newer. Use the Node and Bun versions
declared in [package.json](../../package.json). Confirm the Herdr version supports
the sidebar features you select; the manifest minimum alone does not prove that
every feature in today's online configuration documentation is present.

## Link a built checkout

Run these commands from the Woof repository root in the intended Herdr environment:

```sh
herdr plugin list --plugin herdr-woof --json
herdr plugin action list --plugin herdr-woof
```

Inspect the existing path, enabled state, version and logs first. If the checkout
needs building or the registration needs refreshing, use:

```sh
bun install --frozen-lockfile
bun run build
herdr plugin link .
herdr plugin list --plugin herdr-woof --json
herdr plugin action list --plugin herdr-woof
```

Inspect the registered path, enabled state and build/action errors. Linking uses
this checkout; retain it and rebuild after updating its source. If Woof is already
installed through another path, inspect that registration before replacing it.
Herdr documents linking and registration in its
[plugin CLI reference](https://herdr.dev/docs/cli-reference/#plugins).

## Check the focused project

Focus the actual project/worktree in Herdr, then invoke the existing diagnostic
and inspection actions through Herdr's action interface or CLI:

```sh
herdr plugin action invoke doctor --plugin herdr-woof
herdr plugin action invoke status --plugin herdr-woof
herdr plugin log list --plugin herdr-woof --limit 10
```

Action invocation returns an action log record; inspect the result/log rather
than treating dispatch as proof of success. These actions resolve the project
from Herdr invocation context. Running from the plugin checkout does not make
that checkout the intended project.

`start` uses the focused project's `.woof/start.json` and its resolved workflow
configuration. `cancel` cancels only an unambiguous active run. Do not start or
cancel work merely to check installation; follow the behavior documented in
[plugin surfaces](plugins.md) when you actually intend those actions.

## Configure presentation separately

The plugin already publishes `$woof` and `$woof-role` while a hosted run is active.
Herdr shows custom fields only when its sidebar configuration references them.
Use the [sidebar guide](herdr-sidebar.md) for a current-version example and the
proposed worktree-oriented layout.

Merge selected settings into your existing `~/.config/herdr/config.toml`; do not
overwrite the whole file or repeat TOML table declarations. Apply them using the
installed Herdr version's reload mechanism and check for configuration warnings.
Keep keybindings, themes and workspace preset plugins under your own control.

The metadata phase will validate this path with live evidence. Until then, the
new model/stage/worktree tokens in the proposed example are unavailable, and
their rows will be absent.

## Reuse installed layout tools

The saved setup already includes Herdr Plus, whose installed documentation covers
project templates, worktree auto-layouts and quick actions. Use its own supported
configuration and resolve its actual config directory when setting up presets.
Keep that configuration separate from Woof roles/workflows and from the Herdr
sidebar. This phase should verify the combination, not recreate those features.
