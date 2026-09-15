---
name: woof
description: Delegate a build and review task to Woof agents running in Herdr panes, and inspect or cancel Woof runs. Use when the user asks Woof to build, review or verify a change, or asks about a Woof run.
---

# Woof

Woof runs a workflow of coding agents in Herdr panes. The built-in
`build-review` workflow has a builder change a repository and a reviewer
approve or reject the change, with an optional verification command. Every
step is recorded in a run journal; a run ends `completed`, `failed`,
`exhausted` (a limit) or `cancelled`.

## Starting a run

Use the `/woof:run <task description>` command from Claude Code running inside
a Herdr pane. It checks prerequisites, writes the workflow input, starts the run
in a new pane, waits for it and reports the result.

## CLI

Call the CLI as `node <woof.node> <woof.cli>` using the paths from
`woof doctor --json`, or as `woof` when it is installed.

- `woof run start --project <repo> --input <file|->`: start a run hosted in a
  new Herdr pane; prints `runId`, `runDir` and the host pane.
- `woof status <run-dir> [--wait]`: the run's status and owner liveness; with
  `--wait`, exits 0/4/5/6 on an outcome, 7 on timeout, 8 when the owner is lost
  and 9 when an agent is blocked.
- `woof runs [--project <repo>]`: runs under the runs directory.
- `woof events <run-dir> [--follow]`: lifecycle events as NDJSON.
- `woof run cancel <run-dir>`: cancel a run.
- `woof config show [--project <repo>]`: the effective configuration and where
  each value came from.

## Configuration

JSON files in `~/.woof/` (user) and `<repo>/.woof/` (project; the project wins):

- `woof.json`: `defaults` for the workflow, limits, poll interval and host start
  timeout; `runsDir` is a user setting only.
- `roles/<role>.json`: the agent for a role, for example
  `{"schemaVersion":1,"kind":"claude","model":"sonnet","args":[]}`.
- `workflows/<name>.mjs`: a workflow definition module.

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
