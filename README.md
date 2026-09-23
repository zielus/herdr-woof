<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/woof.svg">
    <img alt="Woof logo" src="assets/brand/woof-ink.svg" width="160">
  </picture>
</p>

# Woof

[![CI](https://github.com/zielus/herdr-woof/actions/workflows/ci.yml/badge.svg)](https://github.com/zielus/herdr-woof/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/herdr-woof)](https://www.npmjs.com/package/herdr-woof)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen)](https://nodejs.org/en/download)
[![Herdr](https://img.shields.io/badge/herdr-%3E%3D0.9.0-blueviolet)](https://herdr.dev)

Woof is a multi-agent workflow engine for [Herdr](https://herdr.dev): plan, build, review,
repair, every hand-off verified. It launches `claude` agents in Herdr panes, validates the
artifact each agent submits and hands the accepted artifact to the next agent. A run ends when a
review passes on the exact repaired revision or a limit ends it.

## Demo

![Woof workflow demo](assets/woof-workflow-readme.gif)

> **Status: 0.3.x, pre-release.**
>
> - The SDK and CLI surfaces are unstable until v1 (marked in `src/index.ts`).
> - macOS and Linux only. Workflows need Herdr 0.9 or newer and Claude Code.
> - Not implemented yet: an MCP adapter, crash resume or re-hosting a lost run, parallel work
>   within a run, and a second agent kind besides `claude`.

## Contents

- [Demo](#demo)
- [Requirements](#requirements)
- [Trust model](#trust-model)
- [Install](#install)
- [Quick start](#quick-start)
- [CLI](#cli)
- [Result handoff](#result-handoff)
- [Run snapshot](#run-snapshot)
- [Build-review loop](#build-review-loop)
- [Configuration, hosting and inspection](#configuration-hosting-and-inspection)
- [Plan-build-review and project workflows](#plan-build-review-and-project-workflows)
- [Integrations and scope](#integrations-and-scope)
- [Development](#development)
- [License](#license)

## Requirements

- macOS or Linux, matching the Herdr plugin's supported platforms. Windows is
  not supported.
- Node.js 22.18 or newer to run built artifacts.
- Bun 1.3.2 for repository installation, scripts, and the Herdr plugin build
  step.
- Herdr 0.9.0 or newer (the Herdr plugin's `min_herdr_version`) and Claude Code
  to run workflows.

## Trust model

Woof runs code with the same privileges as running the repository's own
tests, not less:

- Project `.woof/` workflow modules, a caller's `--runtime-module`, and role
  `args` all run with the operator's own privileges — the same trust as
  running the repository's tests.
- The `verify` check runs after the builder has already edited the tree.
- Permission flags in role `args` (for example
  `--dangerously-skip-permissions`) pass through with a warning; Woof itself
  never adds one.
- Workers receive `--add-dir <runDir>` on the run directory, so journal
  integrity relies on workers not editing it.

These are statements of the current design, not fixes pending. See
[Known limits](docs/decisions/architecture.md#known-limits) in
the decision record for the related design-level items this release does not
address.

## Install

**From npm**: `npm install -g herdr-woof` gives you the `woof` command. Needs
Node.js 22.18 or newer; no Bun. The package ships the CLI, the SDK and the
Claude Code plugin, under `node_modules/herdr-woof/plugin/claude`. The Herdr
plugin (`herdr-plugin.toml`, `bin/woof`) is checkout-only — it is not part of
the npm tarball:

```sh
npm install -g herdr-woof
woof doctor
```

**From a checkout** — needed for the Herdr plugin:

```sh
git clone https://github.com/zielus/herdr-woof.git
cd herdr-woof
bun install --frozen-lockfile
bun run build
bin/woof doctor
```

`bun run build` compiles the ESM package and declarations to `dist/`. The
installed `woof` bin is the compiled Node entry point (`dist/cli.js`);
`bin/woof` is a Unix launcher for checkouts and the Herdr plugin action; every
`woof` command below works as `bin/woof` from a checkout. Wire up the Herdr
plugin from a checkout with `herdr plugin link .`.

## Quick start

Run inside a Herdr pane (`HERDR_ENV=1` and `HERDR_PANE_ID` set), against a
repository you have already opened with `claude` once (see the
[operator-trust precondition](#operator-trust-precondition)). Replace
`/abs/path/to/git/worktree` with that repository's top level:

```sh
cat > input.json <<'EOF'
{
  "schemaVersion": 1,
  "repo": "/abs/path/to/git/worktree",
  "task": {
    "title": "Implement titleCase",
    "description": "Implement titleCase(text) in src/title-case.mjs.",
    "acceptanceCriteria": ["capitalizes each word", "tests pass"]
  },
  "constraints": ["Keep the function pure; no repository files besides src/ and test/."],
  "verify": { "command": ["node", "--test"], "timeoutMs": 120000 }
}
EOF
woof doctor --json --repo /abs/path/to/git/worktree
woof run start --workflow plan-build-review --input input.json \
  --project /abs/path/to/git/worktree
woof status <run-dir> --wait
```

`doctor --json` reports the repository's Claude folder-trust status. `--project`
defaults to the working directory, and the input's `repo` must be that project's
git top level. `run start` prints the run directory. `status --wait` polls it and
returns when the run ends (completed, failed, exhausted or cancelled), when it is
blocked and needs you, when its host is gone without a recorded outcome, or when
`--timeout-ms` passes. Each case has its own exit code, listed under
[Configuration, hosting and inspection](#configuration-hosting-and-inspection).

## CLI

`woof run start` is the one way to run a workflow; the Herdr plugin and the
Claude Code plugin wrap it. The rest of the CLI serves running workflows:
the result handoff agents call, run control, read-only inspection and setup
diagnostics:

```sh
woof --help
woof --version
woof doctor [--json] [--strict] [--repo <dir>]
woof submit --envelope <path|-> [--run-dir <dir>]
woof config show [--project <dir>] [--workflow <name>]
woof run start --input <path|-> [--workflow <name>] [--project <dir>] \
  [--run-id <id>] [--run-dir <dir> | --runs-dir <dir>] \
  [--host herdr-pane|foreground] [--poll-ms <n>] \
  [--keep-panes|--no-keep-panes] [--host-start-timeout-ms <n>] \
  [--split-from <pane-id>] [--runtime-module <path>] \
  [--plain] [--ascii] [--preview summary|json]
woof status <run-dir|run-id> [--wait] [--timeout-ms <n>] [--allow-blocked] \
  [--poll-ms <n>] [--verify-artifacts] [--pretty]
woof runs [--runs-dir <dir>] [--project <dir>] [--all] [--limit <n>]
woof runs --reindex [--prune] [--runs-dir <dir>]
woof events <run-dir|run-id> [--after <cursor>] [--follow] [--timeout-ms <n>] \
  [--poll-ms <n>] [--stats] [--pretty]
woof events --all [--follow] [--project <dir>] [--since <iso>] \
  [--runs-dir <dir>] [--max-runs <n>] [--timeout-ms <n>] [--poll-ms <n>] [--pretty]
woof watch [<run-dir|run-id>] [--follow] [--input summary|json] [--ascii] \
  [--plain] [--after <cursor>] [--poll-ms <n>] [--timeout-ms <n>]
woof watch --all [--follow] [--project <dir>] [--since <iso>] \
  [--runs-dir <dir>] [--max-runs <n>] [--poll-ms <n>] [--timeout-ms <n>]
woof tui [--project <dir>] [--runs-dir <dir>] [--ascii] [--poll-ms <n>]
woof tui --frames [--cols <n>] [--rows <n>] [--project <dir>] [--runs-dir <dir>]
woof run cancel <run-dir|run-id> [--reason <text>]
woof herdr status|cancel|doctor|watch
```

`doctor` reports whether Herdr and Claude Code can be invoked, the read-only
Claude folder-trust status of a repository, resolved to that repository's git
top level, and whether its configuration resolves (as text, or one JSON line
with `--json`). Neither Herdr nor Claude Code is
required for the command to complete. `doctor` exits 0 by default; `--strict`
exits 2 when the report lists any problem (`herdr_unavailable`,
`claude_unavailable`, `trust_untrusted`, `trust_unknown`, `config_invalid`).

See [Configuration, hosting and inspection](#configuration-hosting-and-inspection)
for `config show`, `run start`, the inspection commands and the plugins.
`woof --help` also lists `run host` (internal: hosts a launched run in this
process). An unrecognized command prints `woof: unknown command "<name>"; see
woof --help` to stderr and exits 1; a recognized command used incorrectly is a
usage error, also exit 1.

## Result handoff

The scheduler opens each attempt and tells its agent where to write the
artifact and how to report it. The agent then submits a small envelope pointing
at that artifact. `woof` validates the envelope and the artifact against an
append-only run journal (`<runDir>/journal.jsonl`) and records the outcome:

```sh
# In the agent's pane, after it wrote artifacts/report/visit-1/attempt-1/report.md:
woof submit --run-dir "$RUN_DIR" --envelope "$RUN_DIR/envelope.json"
# {"outcome":"accepted","receipt":{...}}
```

The envelope names the attempt and the artifact's path and SHA-256:

```json
{
  "schemaVersion": 1,
  "runId": "demo-1",
  "agentId": "worker-1",
  "stageId": "report",
  "visit": 1,
  "attempt": 1,
  "status": "completed",
  "verdict": "pass",
  "artifact": { "path": "artifacts/report/visit-1/attempt-1/report.md", "sha256": "<hex>" }
}
```

Exit codes:

- `0` for `accepted`/`duplicate`.
- `2` for a rejection with a machine-readable reason, including
  `artifact_too_large` for artifacts over 32 MiB. The reasons are a closed set,
  see [communication.md](docs/architecture/communication.md#implemented-now-p1-prototype).
- `3` for a run-directory or journal infrastructure failure.
- `1` for a usage error.

The SDK exposes the same operations as `submitResult`, `openAttempt` (what the
scheduler calls to open an attempt) and `readJournal`, marked unstable in
`src/index.ts`.

## Run snapshot

`readSnapshot(runDir)` in the SDK returns a read-only snapshot of a run
journal — status, agents, per-stage attempts and outcomes, counters, and any
ambiguous deliveries still open — without touching Herdr or taking the journal
lock. `woof status <run-dir>` prints the operator's view of the same snapshot.
`readSnapshot(runDir, {verifyArtifacts: true})` re-hashes every accepted copy;
`snapshot.integrity.artifacts` then reports `{checked, altered}`.

A snapshot that cannot be read is `{ok: false}` with reason `run_dir_invalid`
(missing journal or no records), `journal_corrupt`, or `journal_replaced` (the
journal's line 1 changed during each of three consecutive re-reads). It works
on a terminated run.

The SDK also exposes, all marked unstable in `src/index.ts`:

- a run plan (`RunPlan`/`Limits`/`AgentSpec`/`StageSpec`, `validateRunPlan`);
- the run-facts store (`openRun`, `assignAgent`, `recordDispatch`,
  `terminateRun`);
- snapshots and events (`readSnapshot`/`deriveSnapshot`,
  `readEvents`/`subscribeEvents`/`foldEvents`);
- a runtime adapter contract (`RuntimeAdapter`/`createHerdrCliRuntime`/`herdrRuntimeName`,
  `ObservationTracker`/`watchAgent`, `overlayRuntime`).

See [domain model](docs/architecture/domain-model.md#implemented-now-p2) and
[observability](docs/architecture/observability.md#implemented-now-p2) for
the full contracts, including the runtime adapter's allowlisted inspection,
`waitFor`/`stop`/`protocol_error` rules and the scripted test double's own
edge cases.

## Build-review loop

A scheduler runs the built-in `build-review` workflow end to end: build
→ verify (an engine-run check, only when the input names a command) → review
→ repair, until a review passes on the exact repaired revision or a limit
ends the run.

It launches each `claude` agent in its own Herdr tab (`woof:<role>`)
(`HERDR_ENV=1` and `HERDR_PANE_ID` must be set). An interactive Claude agent it
starts must already be allowed to run: the operator must have trusted the target
repository in Claude Code at least once (open `claude` there and answer its
folder-trust question) before a run can start an agent in it.
Woof surfaces an untrusted repository as `run.blocked{reason:"startup_blocked"}`
and never bypasses that dialog.

`repo` must be the top level of that git work tree (`git rev-parse --show-toplevel`);
a nested directory is rejected `repo_invalid`, naming both the given path and the
resolved top level:

```sh
cat > input.json <<'EOF'
{
  "schemaVersion": 1,
  "repo": "/abs/path/to/git/worktree",
  "task": {
    "title": "Implement slugify",
    "description": "Implement slugify(text) in src/slugify.mjs.",
    "acceptanceCriteria": ["lowercase", "hyphenated", "tests pass"]
  },
  "verify": { "command": ["node", "--test"], "timeoutMs": 120000 },
  "agents": {
    "builder": { "kind": "claude", "model": "sonnet", "args": ["--permission-mode", "auto"] },
    "reviewer": { "kind": "claude", "model": "sonnet", "args": ["--permission-mode", "auto"] }
  }
}
EOF
woof run start --workflow build-review --host foreground \
  --project /abs/path/to/git/worktree --input input.json --run-dir /tmp/woof-run
# … the human view of the run, then as the last line:
# {"outcome":"run","result":{"outcome":"completed","limit":null,...}}
```

`agents.builder`/`agents.reviewer` resolve `kind`, `model` and caller launch
arguments. The engine adds only `--model <model>` (when given) and
`--add-dir <runDir>`, never a permission flag. `limits` is optional (each
key optional, same bounds as elsewhere) and defaults to
`maxAttemptsPerVisit: 2, maxVisitsPerStage: 3, maxRounds: 3,
maxFormatRepairs: 2, runTimeoutMs: 7200000, readinessWaitMs: 180000,
blockedWaitMs: 600000, deliveryTimeoutMs: 60000`.

`--host foreground` runs the scheduler in the calling process, which is how
tests and scripts drive a run to its end; without it `run start` hosts the run
in a Herdr pane and returns once the run is open (see below).
`--poll-ms` must be an integer of at least 1 (usage error otherwise).
In the foreground, the human view of the run (what `woof watch --follow` prints)
goes to stdout, the technical log to `<run-dir>/host.log` (`--plain` prints the
log to stdout instead), and the last stdout line is the result JSON. Exit codes:

- `0` completed, `4` failed, `5` exhausted, `6` cancelled.
- `2` rejected before launch: bad input, a repository that is not the git work
  tree's top level or one git itself cannot take, an unsupported agent kind, a
  run directory overlapping the repository, an existing run directory.
- `3` a runtime or journal infrastructure failure. This includes
  `HERDR_ENV`/`HERDR_PANE_ID` unset without `--runtime-module`, a
  `--runtime-module` factory whose result is missing or misshapes a
  `RuntimeAdapter` method (checked before any run opens), or a run that
  finished but left a pane the driver could not stop, returned as `RunResult`
  plus an attached `runtime_cleanup_failed` error.
- `1` a usage error.

`woof run cancel <run-dir|run-id>` records `run.terminated{outcome:"cancelled"}` for a
scheduler that may still be running elsewhere (its own next tick then stops
it). Exit `0` when recorded, `2` when the run is already terminated, `3` on a
journal failure.

See [domain model](docs/architecture/domain-model.md#implemented-now-p3),
[communication](docs/architecture/communication.md#implemented-now-p3),
[observability](docs/architecture/observability.md#implemented-now-p3),
[workflow authoring](docs/workflows/authoring.md#implemented-now-p3) and
[initial workflows](docs/workflows/initial-workflows.md#implemented-now-p3)
for the definition contract, the scheduler's decision rules, format repair,
blocking/reconciliation, revision binding and the terminal `RunResult`.

What still does not exist: an MCP adapter, crash resume or re-hosting a lost
run, and parallel scheduling (one active request per agent, one sequential
decision loop).

## Configuration, hosting and inspection

Configuration, run hosting, read-only inspection and both plugins exist.
`.woof/` (project) and `~/.woof/` (user) hold JSON settings, one role per
file, and workflow definition modules, with documented precedence
(project → user → built-in) and provenance on every resolved value:

```sh
mkdir -p .woof/roles
cat > .woof/roles/builder.json <<'EOF'
{"schemaVersion":1,"kind":"claude","model":"sonnet","args":["--permission-mode","auto"]}
EOF
woof config show
# {"outcome":"config","configuration":{...,"roles":{"builder":{"source":"project","path":".woof/roles/builder.json",...}}}}
```

`woof run start` resolves that configuration, launches a scheduler in a Herdr
pane (`HERDR_ENV=1` and `HERDR_PANE_ID` required, or `--host foreground` to run
in this process) — the root pane of the run's new worktree workspace by default,
else of a new, unfocused tab (`woof:<workflow>`) — and returns once the pane
host has claimed and opened the run:

```sh
woof run start --input input.json
# {"outcome":"started","runId":"br-…","runDir":"/abs","host":{"mode":"herdr-pane","paneId":"…","tabId":"…",...},...}
woof status /abs --wait
# polls until a terminal outcome (exit 0/4/5/6), the owner gone without a
# recorded outcome -- lost, or exited without a terminal record (exit 8) --
# a block needing the operator (exit 9), or --timeout-ms (exit 7)
```

The pane host claims the run exclusively (`host.json`, a heartbeat every
2000 ms by default), so `woof status`/`woof runs` report the owner as
`unhosted`, `alive`, `lost` or `exited`. A killed host is reported `lost`,
never silently as running, and its only resolution is still
`woof run cancel <run-dir>` (no crash resume). `woof runs`, `woof events`,
`woof watch`, `woof tui` and `woof config show` are read-only and never take the
journal lock or contact Herdr; `woof runs --reindex` writes only the run index.

Opening a run registers a locator in the run index (`~/.woof/index`, or
`WOOF_INDEX_DIR`), so `woof status`, `events`, `watch` and
`run cancel` take a run id as well as a run directory, and `woof runs` and `woof
tui` without `--runs-dir` also list runs opened with their own
`--run-dir`. `woof events --all` and `woof watch --all` stream every known run
at once. `woof tui` is an interactive, read-only run browser for the terminal: a
runs list and a run view with steps, activity and config tabs.

To follow or debug a run in a terminal, `woof watch` prints one readable
account of it: an opening block (workflow, repository, run id and directory,
agent roster, stage map, limits, input preview), one plain-English row per
meaningful fact and, when the run ends, an outcome summary with the accepted
artifact paths. `--follow` keeps reading until the run's terminal record (and,
while its host is alive, the host's `host.exited`), with the exit codes of
`woof events --follow`; `woof watch --plain` (and `woof
events --pretty`) prints the technical view instead — a status header and one
line per journal event — and `woof status <run-dir> --pretty` prints only that
header instead of JSON. Colors appear only when stdout is a terminal and
`NO_COLOR` is unset or empty. A pane-hosted `woof run start` opens the run
host in a Herdr pane of its own, and the host prints that same human view in its
pane as its own journal grows (its technical log goes to `<run-dir>/host.log`;
`--plain` prints the log instead); every agent gets a tab of its own. The
host's tab stays open after the run so its last lines remain readable;
`--no-keep-panes` closes only the agent tabs:

```sh
woof run start --input input.json
woof watch /abs --follow
# run      br-…  build-review@1  running
# …
# 16:33:00 #6 gate.recorded        build v1 a1  stage build pass (built) round 0 -> verify
```

The Herdr plugin (`herdr-plugin.toml`) exposes `doctor`, `status`, `cancel`
and `watch` actions that target the invocation's focused project and
project run state as pane metadata tokens; `watch` opens a plugin pane running
`woof watch --follow` for the project's single active run. The Claude Code plugin
(`plugin/claude/`) ships `/woof:run <task description>`, which resolves the
CLI, applies the operator-trust precondition below, starts a run and waits
for it with `woof status --wait`, reporting the structured result, and a `woof`
skill that describes the workflows and the inspection and cancel commands.

### Operator-trust precondition

`woof run start` launches interactive `claude` agents in Herdr tabs. An agent that has never been trusted in a target
repository stops at its own folder-trust prompt, and the run records
`run.blocked{reason:"startup_blocked"}` rather than proceeding. Before starting
a run against a repository, open `claude` there at least once and accept its
trust question. Woof only reports this status (`woof doctor --json`,
`run start`'s `warnings[]`, `/woof:run`'s pre-flight); it never answers the
prompt or bypasses it.

See [configuration](docs/architecture/configuration.md#implemented-now-p4),
[domain model](docs/architecture/domain-model.md#implemented-now-p4),
[observability](docs/architecture/observability.md#implemented-now-p4) and
[plugins](docs/integrations/plugins.md) for the full contracts.

## Plan-build-review and project workflows

A second built-in workflow, `plan-build-review`, adds a planner before the
same build/verify/review/repair loop: plan → build → verify (optional) →
review → repair, until a review passes on the exact repaired revision or a
limit ends the run.

The planner's `plan.md` reaches every builder and repair request as an accepted
input, by path, receipt and sha256 — never inlined — exactly the way an accepted
review already does. There is no re-planning (a failed review or check routes to
`repair`, never back to `plan`) and no plan-approval gate in this version:

```sh
cat > input.json <<'EOF'
{
  "schemaVersion": 1,
  "repo": "/abs/path/to/git/worktree",
  "task": {
    "title": "Implement titleCase",
    "description": "Implement titleCase(text) in src/title-case.mjs.",
    "acceptanceCriteria": ["capitalizes each word", "tests pass"]
  },
  "constraints": ["Keep the function pure; no repository files besides src/ and test/."],
  "verify": { "command": ["node", "--test"], "timeoutMs": 120000 }
}
EOF
woof run start --workflow plan-build-review --input input.json
```

### Project and user workflows

`--workflow <name>` (else `defaults.workflow`, else `build-review`) also
resolves a definition module a project or the user has authored, at
`<scope>/.woof/workflows/<name>.{mjs,js,ts}`. No import from Woof is required;
every type in the contract is structural.

A discovered workflow is not pre-admitted by the launcher: its module body runs
exactly once, in the pane host, which writes any rejection to that run's
`outcome.json` (the source of the reason and details). The launcher reads it
and reports the same rejection as its own exit code: 2 for an admission
rejection, 3 for an infrastructure reason (for example the host's own claim
failing).

`woof config show --workflow <name>` reports whether a name resolves and from
where (`version: null` for a file, with `path`/`sha256` identifying it instead,
since `config show` never imports a non-built-in module). `/woof:run` takes the
same `--workflow <name>` as a leading `$ARGUMENTS` prefix.

The engine required no per-workflow branch for any of this: the built-in
catalog is a name-keyed registry (`src/workflows/catalog.ts`), and the same
admission, scheduler and submission code serve every definition by its own
declared shape.

Live-verified: `docs/research/plan-build-review-live.log` (13/13 gates) and
`docs/research/external-workflow-live.log` (8/8 gates, a `scribe` note-writing
workflow run via `/woof:run --workflow scribe`). See
[initial workflows](docs/workflows/initial-workflows.md#implemented-now-p5),
[workflow authoring](docs/workflows/authoring.md#implemented-now-p5) and
[the acceptance evidence](docs/acceptance/v1-evidence.md) for the full
contracts and evidence.

### Worktrees and workflows as steps

Where a run works is part of its input: the reserved key `checkout` is
`{"mode":"current"}`, `{"mode":"worktree","branch"?,"base"?,"label"?,"keep"?}` or
`{"mode":"path","path"}`. Started inside Herdr, a run defaults to a new Herdr
worktree (branch `woof/<runId>`) whose workspace holds the run host and every
agent tab; outside Herdr it works in the repository itself, and a worktree is
refused `checkout_unsupported`. A workflow that edits the tree refuses a
`current` or `path` checkout with uncommitted changes (`checkout_dirty`).

A workflow can also be a step of another. The built-in `auto-build` runs the
built-in `plan` workflow and then `build-review` as two child runs on one
branch, handing the accepted `plan.md` to the builder and reviewer as a
digest-checked input:

```sh
woof run start --workflow auto-build --input input.json   # plan-build-review's input shape
```

Each child is an ordinary run next to its parent (`<runId>.plan.1`,
`<runId>.build.1`) that `woof runs`, `woof status` and `woof watch` show with
its parent link; cancelling the parent cancels the running child. See
[composition](docs/design/composition.md) and
[initial workflows](docs/workflows/initial-workflows.md#plan-and-auto-build-composition).

## Integrations and scope

The Herdr plugin exposes `doctor`, `status`, `cancel` and `watch` actions; the
Claude Code plugin's `/woof:run` command starts and waits on a run through
`woof run start`, and its `woof` skill describes the CLI. Neither has its own
way to start a run or its own input format. Neither
ships tools, hooks, a background process or a transport adapter beyond what
[Configuration, hosting and inspection](#configuration-hosting-and-inspection)
and [plugins.md](docs/integrations/plugins.md) describe. MCP is deferred and is
not a maintained integration in this repository.

The [documentation index](docs/README.md) and [product brief](docs/product/brief.md)
describe the intended product. Implemented behaviour is in the Implemented-now
sections; the rest of docs/ is design and requirements.

## Development

```sh
bun install --frozen-lockfile
bun run verify
```

The package smoke test packs the project, installs it into an isolated local
consumer, imports its public entry point, and exercises the installed CLI.
See [AGENTS.md](AGENTS.md) for development order, verification and Git
practices, and [CHANGELOG.md](CHANGELOG.md) for release history.

`bun run release:preflight` runs the release checks (versions, changelog,
private strings, secrets, links, format, verify, pack) without publishing
anything; see [.claude/skills/release/SKILL.md](.claude/skills/release/SKILL.md)
for the full release process.

## License

[MIT](LICENSE) © 2026 Tomasz Chmielarz
