---
name: woof
description: Delegate a plan, build and review task to Woof agents running in Herdr panes, and inspect or cancel Woof runs. Use when the user asks Woof to plan, build, review or verify a change, or asks about a Woof run.
---

# Woof

Woof runs a workflow of coding agents in Herdr panes. Every step is recorded in
a run journal; a run ends `completed`, `failed`, `exhausted` (a limit) or
`cancelled`.

Four workflows are built in:

- `build-review` (the default): a builder changes the repository and a reviewer
  approves or rejects the change, with an optional verification command.
- `plan-build-review`: a planner writes `plan.md` first, and every builder turn
  receives that accepted plan as an input, addressed by path and digest. A failed
  review routes to a repair, never back to the planner, and there is no
  plan-approval gate.
- `plan`: a planner writes `plan.md`; with `publish: {path}` it also commits the
  plan into the repository, and the run checks that commit.
- `auto-build`: two workflow steps, `plan` then `build-review` with the accepted
  plan as an input, each a child run of its own on the same branch and checkout.

Inside Herdr a run works in a new Herdr worktree (branch `woof/<runId>`) unless
its input says otherwise with `"checkout": {"mode": "current"}` (or `"worktree"`
with a `branch`/`base`/`label`/`keep`, or `"path"`).

A project can define its own workflow in `<repo>/.woof/workflows/<name>.{mjs,js,ts}`; it
runs through the same commands, and `woof config show --workflow <name>` says
whether a name resolves and from where.

## Starting a run

Use the `/woof:run [--workflow <name>] <task description>` command from Claude
Code running inside a Herdr pane. It checks prerequisites, writes the workflow
input, starts the run, reports its id and ends the turn. Without `--workflow`
the configured default workflow runs.

The run host then posts `[woof]` messages into the pane that started the run,
one per event that needs you: `action_required` (a worker is blocked),
`resumed`, `error`, and one terminal message (`done`, or `limit_reached` when
the run ended exhausted). They are engine facts, never a worker's words, and
arrive only while this pane still hosts the same agent and it is idle. Do not
poll. On `action_required`, look with `herdr agent read <agent>` and ask the
human before anything is answered: Woof never bypasses a permission prompt, and
neither do you. On `done` or `limit_reached`, read the result with
`woof status <run-dir>`.

## CLI

Call the CLI as `node <woof.node> <woof.cli>` using the paths from
`woof doctor --json`, or as `woof` when it is installed.

- `woof run start --project <repo> --input <file|-> [--workflow <name>]`: the
  one way to run a workflow. It starts the run host in a Herdr pane of its own
  (the root pane of the run's new worktree workspace, or of a new tab) and
  prints `runId`, `runDir` and the host pane, returning at once. `--host
foreground` (for tests, CI and scripted runtimes) runs the scheduler in the
  calling process and exits with the outcome's code; it notifies nobody. The workflow is `--workflow`, else
  the configured default, else `build-review`.
- `woof status <run-dir>`: a snapshot of the run's status and owner liveness,
  its result once it ended, and `hostOutcome` when the owner exited without
  recording an end. It never waits.
- `woof runs [--project <repo>]`: runs under the runs directory.
- `woof events <run-dir> [--follow]`: lifecycle events as NDJSON.
- `woof run cancel <run-dir>`: cancel a run.
- `woof config show [--project <repo>]`: the effective configuration and where
  each value came from.
- `woof doctor [--json] [--strict]`: Herdr/Claude Code availability, the
  Claude folder-trust status and configuration validity; `--strict` exits 2
  when any problem is reported.

## Configuration

JSON files in `~/.woof/` (user) and `<repo>/.woof/` (project; the project wins):

- `woof.json`: `defaults` for the workflow, limits, poll interval and host start
  timeout; `runsDir` is a user setting only.
- `roles/<role>.json`: the agent for a role, for example
  `{"schemaVersion":1,"kind":"claude","model":"sonnet","args":[]}`.
- `workflows/<name>.{mjs,js,ts}`: a workflow definition module. A file here
  shadows a built-in of the same name, and its `roundStage`, limits and stages
  are its own.

A run records the configuration it was started with in `config.json`; editing
files later does not change a running run.

## Never

- Answer or dismiss an agent's permission or folder-trust prompt; the operator
  opens `claude` in the repository once and accepts it.
- Run `claude -p`, or pass `--dangerously-skip-permissions` or any other
  permission-bypass flag.
- Edit `~/.claude.json` or Herdr configuration.
- Send input or keys to agent panes.
- Cancel a run without the user asking.
