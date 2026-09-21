# Woof integration surfaces

Woof 0.2.0 provides the CLI and SDK, hosted runs with heartbeat-tracked
liveness, read-only inspection commands, a Herdr plugin and a Claude Code
plugin. The Herdr plugin exposes `doctor`, `status`, `start`, `cancel` and
`watch`; `/woof:run` starts a run, waits for it and reports the result. Every
command and action below is an implemented surface.

## CLI

`woof <command>`:

- `--help`, `--version`, `doctor [--json] [--strict] [--repo <dir>]` — both
  modes report the same probes: the CLI path, Herdr environment, Claude Code
  availability, the read-only Claude folder-trust status of the git top level
  of `--repo` (or the working directory), and whether its configuration
  resolves. Each external probe (`herdr`, `claude`), in either mode, is
  bounded at 10 s. `--json` gains `problems: string[]`
  (`herdr_unavailable`/`claude_unavailable`/`trust_untrusted`/
  `trust_unknown`/`config_invalid`). Diagnostic only: exits 0, or 2 with
  `--strict` when `problems` is non-empty.
- Result handoff (unstable): `attempt open`, `submit`, `run show
<run-dir> [--verify-artifacts]` — see
  [communication.md](../architecture/communication.md#implemented-now-p1-prototype).
- Configuration: `config show [--project <dir>] [--workflow <name>]` — prints
  the effective configuration and where each value came from (flag, project,
  user or built-in), the file that supplied it and what it shadows. See
  [configuration](../architecture/configuration.md#implemented-now-p4).
- Inspection (read-only; no journal lock, never contacts Herdr):
  `status <run-dir> [--wait] [--pretty]`, `runs [--runs-dir <dir>] [--project <dir>]
[--all] [--limit <n>]`, `events <run-dir> [--after <cursor>] [--follow]
[--stats] [--pretty]`, `watch [<run-dir>] [--follow] [--after <cursor>]
[--poll-ms <n>] [--timeout-ms <n>]`. `watch` (and `events --pretty`, which
  prints exactly the same) is the human view: a header (run, workflow, current
  stage, host owner, agents with role, kind, model and pane) and one line per
  event, following like `events --follow` and with its exit codes; `<run-dir>`
  defaults to `WOOF_RUN_DIR`. `status --pretty` prints only that header. Colors
  only when stdout is a terminal and `NO_COLOR` is unset or empty. See
  [observability](../architecture/observability.md#implemented-now-p4).
- Workflows (unstable): `run start [--workflow <name>] --input <path|-> …` —
  starts a workflow hosted in Herdr (`--host herdr-pane`, default) or in this
  process (`--host foreground`). Layout is one tab per participant: the first
  tab Woof creates (`herdr tab create --label woof:<workflow> --no-focus`)
  holds the run host in its root pane, and every agent of the run gets its
  own unfocused tab (`woof:<role>`); agents are never pane splits. Woof
  closes only the tabs it created. By default (herdr-pane only; `--no-watch`
  opts out, `--watch` is still accepted and is refused with exit 2 under
  `--host foreground` or outside Herdr) it also splits a pane below the host,
  inside the host's tab, running `woof watch <run-dir> --follow` and adds
  `watch: {paneId, command}` (or `watch: {problem}`) to its output, next to
  `host: {paneId, tabId, …}`. The
  watch pane closes when the run ends only with an explicit `--no-keep-panes`
  (its typed command is then `… --follow && herdr pane close <pane>`); unlike
  agent panes it otherwise stays, so its final lines remain readable;
  `run cancel <run-dir>`; `run
build-review …` (foreground, kept as an alias for `run start --workflow
build-review --host foreground`); `run host <run-dir>` (internal and
  unstable — hosts a launch request in this process; `run start` types this
  into the Herdr pane it opens).
- Herdr plugin actions (unstable; the project comes from
  `HERDR_PLUGIN_CONTEXT_JSON`, never the working directory): `herdr status`,
  `herdr start`, `herdr cancel`, `herdr doctor`, `herdr watch` — see "Herdr
  plugin" below.

See [domain model](../architecture/domain-model.md#implemented-now-p4) for
run hosting's claim/heartbeat/liveness contract and
[workflow authoring](../workflows/authoring.md#implemented-now-p4) for
configuration-driven role and workflow resolution.

## Herdr plugin

For registration and wiring, see [Set up the Woof Herdr plugin](herdr-setup.md).
That guide also contains an operator-owned sidebar example using the metadata
available now. Separate stage/model fields, checkout cues and workspace
projection are [open proposals](../design/proposals.md). The behavior below
describes the existing implementation.

`herdr-plugin.toml` registers a build step (`bun install --frozen-lockfile`,
`bun run build`), five parameterless actions, each running `bin/woof
herdr <action>` from the plugin's own checkout, and one plugin pane
(`[[panes]] watch`, command `bin/woof watch --follow`):

- **`doctor`** — `woof doctor --json` for the invocation context's project:
  Herdr and Claude Code availability, the read-only Claude folder-trust
  status, and whether the project's configuration resolves (a configuration
  problem is reported, `config: {ok: false, reason, message}`, never
  refused). Notifies with the project root and one line each for herdr,
  claude, trust and config; prints `{"outcome":"doctor","project",…report}`.
  The notification title is `Woof: doctor` with no problems, `Woof: doctor
(1 problem)` for one, and `Woof: doctor (N problems)` for N ≥ 2; the action
  still exits 0 either way.
- **`status`** — notifies and prints the target project's non-terminal runs.
- **`start`** — starts the project's default workflow with the input in
  `<project>/.woof/start.json` (a missing file, or one that is not a regular
  file — a FIFO, device or directory is `input_invalid` at once, without
  blocking — is a notification and exit 2), hosted in the root pane of a new
  tab with the `woof watch --follow` pane split below it (an action process
  has no `HERDR_PANE_ID` of its own, and a new tab needs none; without
  `HERDR_WORKSPACE_ID` the tab goes to Herdr's default workspace).
- **`cancel`** — cancels the project's one non-terminal run. With none
  active, exits **0** with `{"outcome":"noop","reason":"no_active_run",
"message":"no active Woof run in <project>","details":[]}` (notification
  unchanged, "Woof: nothing to cancel") — Herdr's own action log records a
  non-zero exit as a failure, indistinguishable from a crash, so a genuine
  no-op must exit 0. With several active, refuses (exit 2) with
  `{"outcome":"rejected","reason":"run_ambiguous",…}`, naming each
  `woof run cancel <run-dir>`.
- **`watch`** ("Woof: watch the active run") — opens a Herdr plugin pane
  following the project's one non-terminal run: `herdr plugin pane open
--plugin herdr-woof --entrypoint watch --placement split [--target-pane
<focused pane>] --direction right --env WOOF_RUN_DIR=<run-dir> --no-focus`.
  The pane's fixed command runs `bin/woof watch --follow` from the plugin
  root and reads the run directory from `WOOF_RUN_DIR`. Prints
  `{"outcome":"watching","runId","runDir","paneId"}` and notifies "Woof:
  watching <run-id>". With none active, exits **0** with `outcome` `noop`
  (`no_active_run`, "Woof: nothing to watch"), like `cancel`; with several,
  refuses (exit 2, `run_ambiguous`), naming each `woof watch <run-dir>`; a
  pane that cannot be opened is `watch_pane_failed` (exit 3). Herdr closes a
  plugin pane when its command exits, so the pane disappears as soon as the
  run reaches its terminal record; use `woof watch <run-dir>` in a shell to
  read the full history afterwards.

Every action, including `doctor`, resolves its target project from
`HERDR_PLUGIN_CONTEXT_JSON`, never from the action process's own working
directory (the plugin's checkout). It tries the **focused pane's
directory**, then the **workspace directory**, then the **workspace's
worktree checkout**, in that order, and takes the first one that is inside
a git work tree — a candidate that is outside git, or that no longer exists
(for example a deleted focused directory), is skipped and the next
candidate is tried. Only when none of them qualifies is the result
`project_context_missing`, naming each skipped candidate; that is notified
as "Woof: no project context", and every action exits 2 in that case.

The run host projects state as pane metadata while it runs: its own pane
gets `--token woof=<value>` (`starting`, `running <stage> v<visit> a<attempt>
r<round>`, `blocked <reason>`, or the terminal outcome), refreshed on change
and every 10 s, `--ttl-ms 30000`; each agent pane gets `--token
woof=<stage v a|idle>` and `--token woof-role=<role>`. On termination every
token is sent once more with `--ttl-ms 600000`, so a killed host's tokens
simply expire rather than staying stuck. `herdr notification show` fires once
on a new `run.blocked` and once on termination. Reports never queue up: the
host sends at most one at a time and folds every refresh requested while one
is in flight into a single, fresh follow-up, so a slow Herdr call bounds
reporting instead of delaying termination. Metadata is a display-only
projection — nothing in Woof reads a token back, the journal stays
authoritative, and a failed report only logs to stderr and never affects the
run.

For local wiring checks after a build:

```sh
herdr plugin link .
herdr plugin action list --plugin herdr-woof
herdr plugin action invoke status --plugin herdr-woof
herdr plugin action invoke watch --plugin herdr-woof
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
   resolved), 8 (the owner is gone without a recorded outcome — `lost`, or
   `exited` before the run recorded its own end; reports `hostOutcome`'s
   `reason`/`message` when present, suggests `run cancel`, never cancels
   unasked) or a terminal code (0/4/5/6).
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
