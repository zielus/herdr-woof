# Woof integration surfaces

Status: foundation, plus p1–p3 CLI/SDK prototypes and p4 configuration, run
hosting and inspection. As of p4, `woof run start` hosts a workflow run in a
Herdr pane with a heartbeat-tracked liveness, `woof status`/`runs`/`events`/
`config show` give read-only inspection, and both plugins are functional: the
Herdr plugin exposes `doctor`, `status`, `start` and `cancel` actions, and the
Claude Code plugin's `/woof:run` command starts a run, waits for it and
reports the result. Every command and action below is a real, tested surface.

## CLI

`woof <command>`:

- `--help`, `--version`, `doctor [--json] [--repo <dir>]` — `--json` reports
  the CLI path, Herdr environment, Claude Code availability, the read-only
  Claude folder-trust status of `--repo` (or the working directory), and
  whether its configuration resolves. Each external probe (`herdr`,
  `claude`), in either mode, is bounded at 10 s. Diagnostic only; always
  exits 0.
- Prototype result handoff (unstable): `attempt open`, `submit`, `run show
<run-dir> [--verify-artifacts]` — see
  [communication.md](../architecture/communication.md#implemented-now-p1-prototype).
- Configuration: `config show [--project <dir>] [--workflow <name>]` — prints
  the effective configuration and where each value came from (flag, project,
  user or built-in), the file that supplied it and what it shadows. See
  [configuration](../architecture/configuration.md#implemented-now-p4).
- Inspection (read-only; no journal lock, never contacts Herdr):
  `status <run-dir> [--wait]`, `runs [--runs-dir <dir>] [--project <dir>]
[--all] [--limit <n>]`, `events <run-dir> [--after <cursor>] [--follow]
[--stats]`. See
  [observability](../architecture/observability.md#implemented-now-p4).
- Workflows (unstable): `run start [--workflow <name>] --input <path|-> …` —
  starts a workflow hosted in a Herdr pane (`--host herdr-pane`, default) or
  in this process (`--host foreground`); `run cancel <run-dir>`; `run
build-review …` (foreground, kept as an alias for `run start --workflow
build-review --host foreground`); `run host <run-dir>` (internal and
  unstable — hosts a launch request in this process; `run start` types this
  into the Herdr pane it opens).
- Herdr plugin actions (unstable; the project comes from
  `HERDR_PLUGIN_CONTEXT_JSON`, never the working directory): `herdr status`,
  `herdr start`, `herdr cancel` — see "Herdr plugin" below.

See [domain model](../architecture/domain-model.md#implemented-now-p4) for
run hosting's claim/heartbeat/liveness contract and
[workflow authoring](../workflows/authoring.md#implemented-now-p4) for
configuration-driven role and workflow resolution.

## Herdr plugin

`herdr-plugin.toml` registers a build step (`bun install --frozen-lockfile`,
`bun run build`) and four parameterless actions, each running `bin/woof
herdr <action>` (or `bin/woof doctor` for `doctor`) from the plugin's own
checkout:

- **`doctor`** — Herdr and Claude Code availability.
- **`status`** — notifies and prints the target project's non-terminal runs.
- **`start`** — starts the project's default workflow with the input in
  `<project>/.woof/start.json` (a missing file is a notification and exit 2),
  hosted in a pane split from the invocation's focused pane (an action
  process has no `HERDR_PANE_ID` of its own).
- **`cancel`** — cancels the project's one non-terminal run; two or more
  active runs refuse (exit 2) and name each `woof run cancel <run-dir>`.

Each action resolves its target project from `HERDR_PLUGIN_CONTEXT_JSON`,
never from the action process's own working directory (the plugin's
checkout): the **focused pane's directory**, else the **workspace
directory**, else the **workspace's worktree checkout**. No usable directory,
or one outside a git work tree, is `project_context_missing`, notified as
"Woof: no project context".

The run host projects state as pane metadata while it runs: its own pane
gets `--token woof=<value>` (`starting`, `running <stage> v<visit> a<attempt>
r<round>`, `blocked <reason>`, or the terminal outcome), refreshed on change
and every 10 s, `--ttl-ms 30000`; each agent pane gets `--token
woof=<stage v a|idle>` and `--token woof-role=<role>`. On termination every
token is sent once more with `--ttl-ms 600000`, so a killed host's tokens
simply expire rather than staying stuck. `herdr notification show` fires once
on a new `run.blocked` and once on termination. Metadata is a display-only
projection — nothing in Woof reads a token back, the journal stays
authoritative, and a failed report only logs to stderr and never affects the
run.

For local wiring checks after a build:

```sh
herdr plugin link .
herdr plugin action list --plugin herdr-woof
herdr plugin action invoke status --plugin herdr-woof
```

## Claude Code plugin

`plugin/claude/` ships `commands/run.md` (`/woof:run <task description>`) and
`skills/woof/SKILL.md`. No `.mcp.json`, hooks, agents or scripts.

`/woof:run`:

1. Runs `doctor --json` through `dist/cli.js` next to the plugin
   (`${CLAUDE_PLUGIN_ROOT}/../../dist/cli.js`), falling back to `woof` on
   `PATH`; stops if neither is found, or if `herdr.env` is `false`.
2. Builds a workflow input from the conversation (`schemaVersion: 1`, `repo`,
   `task.title`/`description`/`acceptanceCriteria`, optional `verify
{command, timeoutMs}`), omitting `agents` unless the user asked for
   specific kinds or models — configuration supplies them.
3. Applies the Claude folder-trust gate unconditionally, whatever the
   repository (the pre-flight's `trust.status` when `repo` is the working
   directory, else a fresh `doctor --json --repo <repo>`): on `untrusted` or
   `unknown` it tells the user to open `claude` in that repository once and
   accept its trust question, and continues only after the user confirms. It
   never answers that question itself.
4. Starts the run (`run start --project <repo> --input -`); on a rejection it
   fixes every field the details name and retries once. If the retry is
   rejected too, it reports and stops — never an interactive menu, since no
   run exists yet for anyone watching to see.
5. Waits with `status <run-dir> --wait --timeout-ms 540000` (Bash timeout
   600000), acting on exit 7 (still running — reports the stage and round,
   then waits again), 9 (blocked — reports `attention.blocked.requiredAction`
   verbatim, waits again with `--allow-blocked` only once the user says it is
   resolved), 8 (owner lost — suggests `run cancel`, never cancels unasked)
   or a terminal code (0/4/5/6).
6. Reports `outcome`, `reason`, `limit`, `counters.rounds` and the artifact
   references from `result`. `artifacts.review` is non-null only when
   `outcome` is `completed` (never on `failed`/`exhausted`/`cancelled`), and
   `artifacts.completion`/`artifacts.verification` can each be `null` too (no
   completing gate reached, or no `verify` command configured); the command
   reads and summarizes the accepted review only when `artifacts.review` is
   present. Claims success only when `outcome` is `completed`.

It never answers an agent's permission or trust prompt, runs `claude -p` or a
permission-bypass flag, edits `~/.claude.json` or Herdr configuration, sends
input to agent panes, or cancels a run the user did not ask to cancel.

For local validation:

```sh
claude plugin validate plugin/claude --strict
claude --plugin-dir plugin/claude
```

The supported loading path is `--plugin-dir` into a checkout or an installed
`herdr-woof` package (`plugin/claude/` ships inside the npm package); the
pre-flight's `dist/cli.js` path only resolves there, falling back to `woof`
on `PATH` otherwise. Marketplace installation is not supported.

## Deferred adapters

MCP is deferred and is not maintained in this repository. A future adapter may
translate a stable SDK contract, but it must remain outside the SDK and cannot
become a required path for workflow admission or worker completion.
