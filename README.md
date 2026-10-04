# Woof

Woof is a Herdr plugin for durable coordination between coding agents. One global `woofd` owns a SQLite database and connects to multiple Herdr sessions. The `woof` CLI uses Unix socket RPC; Herdr owns the terminals, agent processes, workspaces and worktrees.

This repository implements Phase 1: logical workers, thin launch profiles, durable messages and questions, replayable events, dispatch settlement, minimal decision gates, recovery and protected release. Phase 1.5 adds `woof tui`, a human monitor with inbox and decision handling. Web views and a workflow engine are deferred. See [docs/spec.md](docs/spec.md), [docs/phases.md](docs/phases.md), the completed [acceptance checklist](docs/acceptance.md) and [verification evidence](docs/verification.md).

## Terminal interface

Run `woof tui` after installing, or `bin/woof tui` after `make build`. It shows all
sessions by default; use `s` to select scope. Messages, questions, explicit
ack/consume and gate decisions are available, with confirmation before submission.
Worker launch, dispatch and lifecycle remain in CLI. See [TUI usage](docs/tui.md)
for views, keyboard shortcuts and uncertainty handling, and [Phase 1.5 acceptance](docs/tui-verification.md) for test and live evidence.

## Build and verify

Use macOS or Linux, Go 1.26 or newer, `make`, and Herdr 0.9.3 or newer. Use a patched Go toolchain (Go 1.26.3 or newer); `go.mod` retains the Go 1.26.0 language minimum. The integration and installer tests also use `jq`.

```sh
make build          # bin/woof and bin/woofd
make check          # build, unit tests, race tests, vet, lint and formatting
make fmt            # apply gofmt (explicitly edits source)
make vuln           # pinned govulncheck; requires network access
make integration    # isolated real-binary RPC scenarios; no live Herdr mutations
sh scripts/install-test.sh  # installer tests in temporary directories
```

Install the exact golangci-lint version in [.golangci-version](.golangci-version)
using an [official binary release](https://golangci-lint.run/docs/welcome/install/local/).
`make lint` checks formatting, errors, unused code, assignments, vet and Staticcheck,
including tests; it refuses a different tool version. `make vuln` runs
`govulncheck v1.1.4` without adding tool dependencies to the application module.
GitHub Actions runs these checks and the integration/installer scenarios on Linux
and macOS for pull requests and pushes to `master`. CI selects the latest available
Go 1.26 patch with `go-version: '1.26.x'` and `check-latest: true`.
The checks use isolated state
and do not control live Herdr sessions.

The integration script checks concurrent bootstrap, second-writer refusal, messaging, gates, replay/wait and daemon restart with an active event follower. Set `WOOF_IT_HERDR_SOCKETS` to a newline-separated list of explicitly selected sockets to also attach those live sessions. It does not create or stop Herdr sessions, or mutate panes.

## Install and link

Install both binaries together so the CLI can discover `woofd` beside itself:

```sh
./scripts/install.sh --build
export PATH="$HOME/.local/bin:$PATH"
```

The installer defaults to `~/.local/bin`. Set `WOOF_BIN_DIR` or pass `--bin-dir /absolute/path` to choose another location. It installs existing binaries unless `--build` is supplied. It preserves conflicting or locally modified files and replaces owned executables by rename. It does not start a daemon, change config, register a plugin or edit shell startup files.

The usage skill is bundled at [skill/SKILL.md](skill/SKILL.md). Copy it only when desired:

```sh
./scripts/install.sh --skills --skills-dir /absolute/path/to/skills
```

`--skills` is required even when `WOOF_SKILLS_DIR` is set; the default skill root is `~/.agents/skills`. The copied directory is `using-woof`.

For managed workers that should handle Woof notices, make the installed
`using-woof` skill an explicit part of their user-owned startup instructions.
Skill discovery alone does not ensure a worker reads it when a notice arrives.
The skill tells the worker to treat a pasted notice as a hint, verify its message
or dispatch through its own injected Woof identity and persisted state, then
apply its existing authorization and role limits. Keep this bootstrap conditional on managed
context; it does not change direct agent sessions or Herdr's prompt transport.

From the checkout, link the plugin using Herdr's installed CLI:

```sh
herdr plugin link "$PWD" --enabled
```

The manifest's build step runs `make build`. Its short-lived startup runs `./bin/woof session attach`, registering the invoking Herdr socket with the global daemon. Startup does not become a per-session daemon. Keep the linked checkout available. Outside a managed pane, attach a discovered socket explicitly:

```sh
woof session attach --socket /absolute/path/to/herdr.sock --herdr-name selected-session
woof session list --global --json
```

For removal, stop Woof first and use the same destination options as installation:

```sh
woof daemon stop
./scripts/install.sh --uninstall --skills --skills-dir /absolute/path/to/skills
```

Uninstall removes only files matching the saved installation checksums. It preserves unrelated skill files, global config and durable state. Herdr plugin registration is separate from binary installation.

## Global config and profiles

Create `~/.woof/config.yml` using [config.example.yml](config.example.yml), preserving an existing config:

```sh
mkdir -p "$HOME/.woof"
test -e "$HOME/.woof/config.yml" || cp config.example.yml "$HOME/.woof/config.yml"
```

Profiles carry literal CLI arguments. They do not resolve model/effort settings or run shell substitutions:

```yaml
profiles:
  reviewer:
    agent: codex
    args: [--model, gpt-5.5, -c, model_reasoning_effort=high]
    cwd: ~/dev/project
    description: Review using an explicitly selected model
    tags: [review]
defaults:
  worker_profile: reviewer
```

Choose arguments supported by your installed agent CLI. In arguments, only leading `~/` and `=~/` expand the home directory. The optional profile `cwd` accepts an absolute path, leading `~/`, or a path relative to the directory containing `WOOF_CONFIG`. `$VAR`, command substitutions, globs and quotes remain literal; no shell runs to resolve paths. Unknown profile fields are errors. `woof profile roster --json` lists metadata without raw arguments or cwd; `woof profile show reviewer` shows the configured launch preset, including its original cwd text. OMP can be configured as a launch preset, but automatic input delivery currently waits because its prompt layout has no verified fixture.

Prompt safety requires faithful ANSI styling when a CLI uses placeholder text. Launch workers with color enabled: an inherited `NO_COLOR=1` can make Claude's empty placeholder indistinguishable from typed text, so Woof conservatively refuses delivery. Remove `NO_COLOR` from the Herdr server/agent launch environment and verify snapshot styling before retrying; Woof does not discard typed drafts to work around it.

| Setting | Default | Purpose |
| --- | --- | --- |
| `WOOF_STATE_DIR` | `~/.woof` | Canonical DB, daemon lock, log and archives |
| `WOOF_CONFIG` | `~/.woof/config.yml` | Global profile config; independent of state-dir override |
| `WOOF_DAEMON_BIN` | `woofd` beside `woof` | Explicit daemon executable override |

The daemon owns the database. Use the CLI for reads and mutations instead of opening SQLite. File artifacts reference caller-owned paths; they are not canonical coordination state.

## Workers and scope

Discover Woof IDs before choosing a target. `--workspace` selects a Woof workspace ID; `--herdr-workspace` is a raw Herdr launch selector.

```sh
woof workspace list --global --json
woof worker start --workspace workspace_ID --name builder --profile reviewer --cwd /absolute/repo
woof worker start --workspace workspace_ID --name builder --profile reviewer --arg=--local --arg='a b'
woof worker adopt --workspace workspace_ID --pane w1:p7 --name reviewer
woof worker show worker_ID --global
woof worker read worker_ID --global --lines 100
```

For a new worker, the launch directory is chosen from explicit `--cwd`, selected `--worktree`, profile `cwd`, then workspace cwd. A selected worktree conflicts with a different explicit `--cwd`; Woof rejects it. The effective directory must exist before a worker is reserved or a tab is created. An existing empty pane must report the same cwd. Adoption uses the live agent's cwd and identity; changing a profile affects future launches only. The resolved cwd is saved on the worker.

`worker start` and `worker spawn` accept repeatable `--arg=VALUE`. Values are appended in order to the profile's raw arguments and saved on the worker; an empty value is allowed, while NUL is rejected. Each value is one literal argument, so quote shell metacharacters when invoking Woof from a shell. Launches with extra arguments require daemon protocol 2 and fail before spawning against an older protocol 1 daemon. Launches without `--arg` continue to use protocol 1.

Adoption requires an explicit live pane and verifies agent/session identity. To rebind an existing logical worker after inspection, supply its ID and the new live pane:

```sh
woof worker adopt --id worker_ID --workspace workspace_ID --pane w2:p9
```

Woof worker IDs survive pane moves. Pane IDs are routing references. Aliases are unique within a workspace; use `worker:worker_ID` or explicit scope when a name could be ambiguous. Injected `WOOF_*` scope is checked against durable state. Explicit `--session`, `--workspace`, `--worktree`, `--run`, `--worker-scope` or `--global` wins over inference. Shared worktrees are supported; a worker does not require a private worktree.

If recovery leaves an obsolete injected attachment, inspect the current worker binding first. To explicitly act as that worker, supply both `--as-worker worker_ID` and `--as-attachment attachment_ID`. This replaces inherited actor identity and clears inherited scope; explicit scope flags remain. Mutations still validate the current attachment in the daemon.

## Messages, questions and handoff files

Write detailed instructions into a file, then send a short message and its path:

```sh
woof send --workspace workspace_ID --to worker:worker_ID \
  --body 'Review the API change described in the handoff.' --artifact /absolute/review.md
woof inbox --all
woof message show message_ID
woof ack message_ID
woof consume message_ID
```

A send persists before delivery is attempted. Persistence, prompt/wakeup attempts, lifecycle-confirmed delivery, acknowledgment and consumption are separate observations. Busy, blocked, draft-containing or unknown prompts hold automatic input. Read the inbox and artifacts before acknowledging; consume once handled. Reading or waiting does not acknowledge or consume. Missing/unreadable artifact paths remain visible, and file contents are not copied into the database or prompts.

```sh
woof ask --global --to human --question 'Approve this change?' --no-wait
woof reply --global --id question_ID --body 'Approved.'
woof question wait question_ID --global --timeout 20m
```

Without `--no-wait`, ask persists once and then waits for a reply. A disconnect or timeout leaves the question durable; resume `question wait` for that ID instead of asking again.

## Dispatch and settlement

```sh
woof dispatch --workspace workspace_ID --to worker:worker_ID \
  --handoff /absolute/implementation.md
woof dispatch show dispatch_ID --global
```

The worker receives the dispatch and original attachment IDs. It reports explicitly after doing the work:

```sh
woof done --dispatch dispatch_ID --attachment attachment_ID \
  --body 'Implemented and verified.' --artifact /absolute/result.md
```

Settlement requires both that report and evidence that the corresponding worker turn ended. Idle alone, a report alone, unknown lifecycle status or a later unrelated turn is insufficient. Use `done --failed` to report failure; inspect with `check`, `dispatch show`, or `worker read`. Minimal `gate create/list/show/resolve` commands persist human decisions without introducing a task DAG or workflow engine.

## Events, uncertainty and daemon control

```sh
woof events list --global --since 0 --json
woof events follow --global --since 1842
woof wait --global --since 1842 --events dispatch.settled --timeout 20m
```

Follow and wait start at the current head when `--since` is omitted. Capture `event_cursor` from `woof status --json` before launching an action, then pass that cursor to a later wait so an immediate completion is included. Reconnect retains the cursor; read retries retain the original timeout. Events are append-only and replayable. Watchdog ticks handle liveness and recovery; normal progression follows Herdr events.

If a mutation returns `outcome_unknown`, retain its operation ID and inspect the operation and resulting worker/message/dispatch state. Never blindly resend it:

```sh
woof operation show operation_ID --global
woof operation list --global --json
woof dispatch show dispatch_ID --global
woof operation resolve operation_ID --global --resolution completed \
  --reason 'Confirmed the original submission from live state and durable evidence.'
```

Resolve only after investigation; `failed` is available when evidence supports abandoning the operation. Resolution records the decision and does not replay a prompt or substitute for dispatch completion evidence.

```sh
woof daemon stop
woof daemon restart
```

Stop drains Woof RPC/subscriptions and preserves durable state; restart waits for drain before bootstrapping. It does not stop Herdr agents. `worker retain`, `worker release` and `worker stop` control worker lifetime. Release/stop refuse busy workers and dirty, untracked, unpublished or unverifiable Git work unless explicitly forced. Attachment identity and cleanup proof remain mandatory with `--force`; surviving or unverified processes stay visible as failures. Shared worktrees remain independent of worker lifetime.

Run `woof --help` for all supported commands. Source provenance and both donor MIT notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
