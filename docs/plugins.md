# Plugin surfaces

Woof ships two plugin surfaces plus the CLI/MCP code they both launch. As of
this scaffold, **nothing here is functional** — no workflows run, no agents
get coordinated, the MCP servers advertise zero tools. This documents the
wiring, not a feature.

## Herdr plugin

`herdr-plugin.toml` at the repo root registers Woof with herdr.

- `[[build]]`: `bun install --frozen-lockfile`, then `bun run build` (a
  typecheck/compile gate — nothing in the runtime path depends on `dist/`).
- `[[actions]]`:
  - `doctor` — runs `bin/woof doctor`, which prints `herdr status` and
    `claude --version` output. Never throws; missing binaries are reported,
    not fatal.
  - `runs` — runs `bin/woof runs`, currently always prints `no runs`.
- `[[panes]]`:
  - `runtime` — a `tab`-placed pane running `bin/woof runtime`. It reads
    `WOOF_RUN_DIR` from its environment and prints it; herdr does not yet set
    that variable when opening the pane (wiring pending).
- No `[[events]]`.

## Claude Code plugin

`plugin/claude/` is a standalone Claude Code plugin directory (see
[the plugin reference](https://code.claude.com/docs/en/plugins-reference.md)):

- `.claude-plugin/plugin.json` — names the plugin `woof`.
- `.mcp.json` — registers the `woof` MCP server as
  `${CLAUDE_PLUGIN_ROOT}/bin/woof-mcp`.
- `skills/woof/SKILL.md` — tells Claude what Woof is and that it should use
  the `woof` MCP tools to run workflows and delegate to agents. There are no
  tools yet.
- `commands/run.md` — a `/woof:run` stub that tells the user the surface
  isn't implemented rather than guessing at a tool call.
- `bin/woof`, `bin/woof-mcp`, `bin/woof-agent-mcp` — symlinks to the
  repo-root launchers of the same name, so `${CLAUDE_PLUGIN_ROOT}/bin/*`
  resolves regardless of how the plugin directory is loaded.
- No hooks.

## CLI and MCP entry points

- `bin/woof`, `bin/woof-mcp`, `bin/woof-agent-mcp` — bash launchers. Each
  resolves its own real path (following symlinks) to find the repo root, then
  execs `bun run src/cli.ts` / `src/mcp/woof.ts` / `src/mcp/agent.ts`
  directly. No compile step is required to run any of them from a checkout.
- `src/cli.ts` — a commander CLI: `--version`, `doctor`, `runs`, `runtime`
  (see herdr plugin section above).
- `src/mcp/serve.ts` — the hand-rolled JSON-RPC-over-stdio loop shared by the
  two MCP entry points (no SDK dependency, matching the previous iteration's
  approach). `src/mcp/woof.ts` and `src/mcp/agent.ts` are thin wrappers that
  each answer `initialize`/`tools/list` and expose zero tools.

`package.json`'s own `bin` field points at the same three launcher scripts
(`bin/woof`, `bin/woof-mcp`, `bin/woof-agent-mcp`), so an `npm`/`bun` install
of the packed tarball gets the identical entry points — see
`scripts/smoke-package.ts`.

## Linking locally for testing

From a checkout of this repo:

```sh
# Herdr plugin
herdr plugin link .

# Claude Code plugin
claude --plugin-dir plugin/claude
```

`claude plugin validate plugin/claude --strict` is a useful sanity check
before either.

## Known gaps

- Herdr does not yet set `WOOF_RUN_DIR` before spawning the `runtime` pane —
  the pane just echoes whatever is in its environment.
- A stale `herdr-woof` plugin registration may already exist locally,
  pointing at a different checkout (`herdr plugin list --json` will show
  `manifest unavailable` for it). Re-link from this checkout rather than
  relying on that entry.
- `plugin/claude/skills/woof/SKILL.md` and `commands/run.md` intentionally
  name no MCP tools — the `woof` MCP server has none yet.
