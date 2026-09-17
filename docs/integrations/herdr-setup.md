# Set up the Woof Herdr plugin

Status: guide for the existing 0.1.2 checkout-based integration. Additional
metadata fields are a [proposal](../proposals/herdr-metadata.md).
Writing this guide did not install a plugin or alter local Herdr configuration.

## Installation is separate from CLI availability

First check whether the plugin is already registered. The
[2026-09-17 saved-configuration audit](../research/herdr-plugin-audit.md) found an
enabled Woof entry pointing at this checkout, with older cached version metadata.
Treat linking below as a registration refresh only if inspection shows it is
needed.

The repository root contains [herdr-plugin.toml](../../herdr-plugin.toml), with
four actions invoking [bin/woof](../../bin/woof). The published npm package's
files list currently includes compiled code and the Claude plugin, but excludes
those two Herdr-specific files. Having `woof` on PATH does not register a Herdr
plugin. Use a persistent repository checkout for the setup below.

The manifest currently requires Herdr 0.9.0 or newer. Use the Node and Bun versions
declared in [package.json](../../package.json).

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

## Published metadata

The plugin already publishes `$woof` and `$woof-role` while a hosted run is active.
See [plugin surfaces](plugins.md) for the shipped contract and the
[metadata proposal](../proposals/herdr-metadata.md) for additional fields.

Herdr presentation and third-party plugin configuration are managed separately by
the operator. They are not part of Woof's implementation or acceptance scope.
