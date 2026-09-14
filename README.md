# Woof

Woof is the future orchestration SDK for coding agents running through Herdr.
This repository currently provides a **foundation only**: a package boundary,
build and packaging checks, a diagnostic CLI, and truthful Herdr/Claude plugin
placeholders. It does not run workflows, delegate agents, persist runs, or
publish a `HerdrAgentsSDK` API yet.

## Requirements

- Node.js 22.18 or newer to run built artifacts.
- Bun 1.3.2 for repository installation, scripts, and the Herdr plugin build
  step.

## Development

```sh
bun install --frozen-lockfile
bun run verify
```

`bun run build` compiles the ESM package and declarations to `dist/`. The only
current executable behavior is diagnostic:

```sh
bin/woof --help
bin/woof --version
bin/woof doctor
```

`doctor` reports whether Herdr and Claude Code can be invoked; neither is
required for the command to complete. Any workflow-oriented command is rejected
as not implemented.

The package smoke test packs the project, installs it into an isolated local
consumer, imports its public entry point, and exercises the installed CLI.

## Integrations and scope

The Herdr plugin exposes only `doctor`. The Claude plugin explicitly declines
workflow requests. MCP is deferred and is not a maintained integration in this
repository.

The [documentation index](docs/README.md) and [product brief](docs/product/brief.md)
describe the intended product; they are not claims that those features exist.
