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

Profiles may support explicit environment variables:

```yaml
profiles:
  custom:
    agent: claude
    env:
      SOME_MODE: strict
    args: [...]
```

Secrets should not be encouraged in config.

Use environment/OS secret storage for secrets.

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
