# Profiles

## Goal

Profiles are thin, named launch presets.

A profile is **not**:

- a worker,
- an agent identity,
- a role,
- a normalized model/provider abstraction.

It is simply a reusable definition of how to launch one Herdr agent kind / CLI configuration.

## Design reference

Use `herdr-projects` profile ergonomics as the main reference.

Inspect its profile parser, list/summary behavior, defaults, and safety concepts before implementing.

## Configuration

Prefer one global configuration file.

Suggested location:

```text
~/.woof/config.yml
```

Example:

```yaml
profiles:
  luna:
    agent: omp
    args:
      - --config
      - ~/.omp/agent/luna.yml
    description: Cheap tier for small, clear tasks
    tags: [cheap, small-task]

  deep:
    agent: codex
    args:
      - --model
      - gpt-5.5
      - -c
      - model_reasoning_effort=high
    description: Hard debugging and design
    tags: [reasoning, review, expensive]

  claude:
    agent: claude
    cwd: ~/dev/project
    args:
      - --add-dir
      - ~/dev/shared
    description: General Claude Code worker
    tags: [general]

defaults:
  worker_profile: claude
```

## Avoid a provider resolver

Phase 1 should not contain logic such as:

```text
effort=high
→ convert to Claude flag
→ convert to Codex flag
→ convert to Grok flag
```

The profile should carry raw CLI args.

Woof passes them to the Herdr agent start path.

This intentionally avoids a large compatibility layer.

A smarter optional resolver can be added later on top of raw args.

## Environment

Profiles have no `env` field. The loader rejects unknown profile fields, so a
profile containing `env:` fails to load. A profile carries only `agent`, `args`,
`cwd`, `description` and `tags`.

A worker launched in a new tab receives Woof's own context (`WOOF_WORKER_ID`,
`WOOF_ATTACHMENT_ID`, the scope IDs, `WOOF_STATE_DIR`, `WOOF_CONFIG`) and a
`PATH` that includes the running Woof binaries. Any other environment comes
from the Herdr pane's shell. Keep secrets in the environment or OS secret
storage, not in config.

## Default worker permissions

A worker has to run `woof` commands to coordinate. Without help, Claude Code in
manual permission mode asks before every one of them, and Codex's sandbox
blocks the connection to the `woofd` socket so every command fails. Woof
therefore adds launch arguments, before the profile's own, when it starts a
worker of these agent kinds:

- `claude`: `--settings` with Bash allow rules for the worker's own
  coordination commands (inbox, message show/ack/consume, reply, dispatch
  show/check, done, worker show, status, operation show, wait, question wait,
  events list/follow, send, ask). It merges with the user's settings. The rules
  match command text; they are a convenience, not a security boundary, and do
  not restrict recipients. Worker start/stop/release/adopt, dispatching,
  schedules, sessions and daemon control still prompt.
- `codex`: `--no-daemon`, `--enable network_proxy` and a `permissions.woof`
  profile extending `:workspace` that allows the `woofd` Unix socket through the
  limited network proxy, selected with `default_permissions`. This grant is per
  socket: a Codex worker holding it can run every `woof` command. Codex cannot
  narrow it by subcommand for a single launch. `network_proxy` is an
  experimental Codex feature.

Other agent kinds are untouched. The effective arguments are recorded on the
worker and shown by `woof worker show`. The list lives in
`internal/daemon/worker_permissions.go` and is not configurable per rule.

A launch that already chooses its permissions is left alone: Claude arguments
containing `--settings`, `--allowedTools`/`--allowed-tools`,
`--dangerously-skip-permissions` or `--permission-mode bypassPermissions`; Codex
arguments containing `--sandbox`/`-s`,
`--dangerously-bypass-approvals-and-sandbox`/`--yolo`, `--disable
network_proxy`, or a `-c`/`--config` key naming `permissions`, `sandbox_` or
`network_proxy`.

Turn the whole feature off with:

```yaml
defaults:
  worker_permissions: false
```

## `~` expansion

Expand `~/` in profile path-like arguments where safe and predictable, following the useful behavior in `herdr-projects`.

Do not perform arbitrary shell interpolation.

The optional `cwd` also accepts an absolute directory or a path relative to
the directory containing the loaded config file. It keeps literal `$VAR`,
command substitutions and glob characters. `profile show` displays the
configured text, while new launches use the resolved absolute path. The
directory must exist when launching.

## Roster

Expose profile metadata to lead agents.

Example:

```bash
woof profile roster --json
```

Response:

```json
[
  {
    "name": "luna",
    "agent": "omp",
    "description": "Cheap tier for small, clear tasks",
    "tags": ["cheap", "small-task"]
  },
  {
    "name": "deep",
    "agent": "codex",
    "description": "Hard debugging and design",
    "tags": ["reasoning", "review", "expensive"]
  }
]
```

The roster should omit unnecessary launch implementation details unless explicitly requested.

The goal is to let a lead choose an appropriate profile from semantic metadata.

## Worker creation

```bash
woof worker start --profile deep --name reviewer
```

Creates a distinct worker.

Multiple workers may use the same profile.

Worker names should be unique within the relevant scope, not globally.

## Future workflow use

Phase 2 workflow definitions may reference profiles:

```yaml
roles:
  builder:
    profile: claude

  reviewer:
    profile: deep
```

Role and profile remain separate concepts.
