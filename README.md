# Woof

Woof is the future orchestration SDK for coding agents running through Herdr.
This repository provides a package boundary, build and packaging checks, a
diagnostic CLI, a first working slice of result handoff (a worker-callable
`woof submit` CLI/SDK bridge backed by an append-only run journal), a p2
run-facts and snapshot layer (run plans, journaled agent
assignment/dispatch/termination, derived snapshots and events, and a Herdr
runtime adapter), a p3 scheduler that runs the built-in `build-review`
workflow end to end, and a p4 product-integration layer: `.woof`/`~/.woof`
configuration with provenance, `woof run start` hosting a run in a Herdr
pane with claim/heartbeat liveness, a read-only inspection CLI, and
functional Herdr and Claude Code plugins — see below. It does not run a
second built-in workflow, delegate agents outside a workflow, resume a
crashed run, or publish a stable `HerdrAgentsSDK` API yet.

## Requirements

- macOS or Linux, matching the Herdr plugin's supported platforms. Windows is
  not supported.
- Node.js 22.18 or newer to run built artifacts.
- Bun 1.3.2 for repository installation, scripts, and the Herdr plugin build
  step.

## Development

```sh
bun install --frozen-lockfile
bun run verify
```

`bun run build` compiles the ESM package and declarations to `dist/`. The
installed `woof` bin is the compiled Node entry point (`dist/cli.js`);
`bin/woof` is a Unix launcher for checkouts and the Herdr plugin action.
Executable behavior today spans diagnostics, result handoff, workflow
hosting, and read-only inspection:

```sh
bin/woof --help
bin/woof --version
bin/woof doctor [--json] [--repo <dir>]
bin/woof attempt open --run-dir <dir> --run <id> --agent <id> --stage <id> \
  --visit <n> --attempt <n> [--verdicts a,b] [--pane <pane-id>]
bin/woof submit --envelope <path|-> [--run-dir <dir>]
bin/woof run show <run-dir> [--verify-artifacts]
bin/woof config show [--project <dir>] [--workflow <name>]
bin/woof run start [--workflow <name>] --input <path|-> [--project <dir>] \
  [--host herdr-pane|foreground] [--poll-ms <n>] [--keep-panes]
bin/woof status <run-dir> [--wait] [--timeout-ms <n>] [--allow-blocked]
bin/woof runs [--runs-dir <dir>] [--project <dir>] [--all] [--limit <n>]
bin/woof events <run-dir> [--after <cursor>] [--follow] [--stats]
bin/woof run build-review --input <path|-> --run-dir <dir> [--run-id <id>] \
  [--poll-ms <n>] [--keep-panes] [--runtime-module <path>]
bin/woof run cancel <run-dir> [--reason <text>]
bin/woof herdr status|start|cancel|doctor
```

`doctor` reports whether Herdr and Claude Code can be invoked, and (with
`--json`) the read-only Claude folder-trust status of a repository; neither
Herdr nor Claude Code is required for the command to complete. See
[Product integration (p4)](#product-integration-p4) below for `config show`,
`run start`, the inspection commands and the plugins; any other
workflow-oriented command is rejected as not implemented.

The package smoke test packs the project, installs it into an isolated local
consumer, imports its public entry point, and exercises the installed CLI.

## Result handoff (p1 prototype)

A worker declares an attempt, then submits a small envelope pointing at the
artifact it wrote. `woof` validates the envelope and the artifact against an
append-only run journal (`<runDir>/journal.jsonl`) and records the outcome:

```sh
RUN_DIR=/tmp/woof-example
bin/woof attempt open --run-dir "$RUN_DIR" --run demo-1 --agent worker-1 \
  --stage report --visit 1 --attempt 1 --verdicts pass,fail
# {"outcome":"opened","attempt":{...,"artifactDir":"<absolute path>"}}

mkdir -p "$RUN_DIR/artifacts/report/visit-1/attempt-1"
echo "# Report" > "$RUN_DIR/artifacts/report/visit-1/attempt-1/report.md"
HASH=$(shasum -a 256 "$RUN_DIR/artifacts/report/visit-1/attempt-1/report.md" | cut -d' ' -f1)

cat > "$RUN_DIR/envelope.json" <<EOF
{
  "schemaVersion": 1,
  "runId": "demo-1",
  "agentId": "worker-1",
  "stageId": "report",
  "visit": 1,
  "attempt": 1,
  "status": "completed",
  "verdict": "pass",
  "artifact": { "path": "artifacts/report/visit-1/attempt-1/report.md", "sha256": "$HASH" }
}
EOF
bin/woof submit --run-dir "$RUN_DIR" --envelope "$RUN_DIR/envelope.json"
# {"outcome":"accepted","receipt":{...}}
```

Exit codes: `0` for `accepted`/`duplicate`/`opened`; `2` for a rejection with a
machine-readable reason (including `artifact_too_large` for artifacts over 32 MiB; a closed set, see
[communication.md](docs/architecture/communication.md#implemented-now-p1-prototype));
`3` for a run-directory or journal infrastructure failure; `1` for a usage
error. The SDK exposes the same operations as `submitResult`, `openAttempt`
and `readJournal` (marked as an unstable p1 prototype in `src/index.ts`).

## Run snapshot (p2)

`woof run show` prints a read-only snapshot of a run journal — status,
agents, per-stage attempts and outcomes, counters, and any ambiguous
deliveries still open — without touching Herdr or taking the journal lock:

```sh
bin/woof run show "$RUN_DIR"
# {"outcome":"snapshot","snapshot":{...}}
bin/woof run show "$RUN_DIR" --verify-artifacts
# re-hashes every accepted copy; snapshot.integrity.artifacts reports {checked, altered}
```

Exit `0` with the snapshot; exit `3` when the run directory or journal is
invalid — reason `run_dir_invalid` (missing journal or no records),
`journal_corrupt`, or `journal_replaced` (the journal's line 1 changed
during each of three consecutive re-reads). It works on a terminated run
and on a p1 journal. The SDK also exposes a run plan
(`RunPlan`/`Limits`/`AgentSpec`/`StageSpec`, `validateRunPlan`), the
run-facts store (`openRun`, `assignAgent`, `recordDispatch`,
`terminateRun`; `assignAgent` throws a TypeError for a malformed
`terminalId`/`sessionId` rather than dropping it — only `null`/`undefined`
are omitted), snapshots and events (`readSnapshot`/`deriveSnapshot`,
`readEvents`/`subscribeEvents`/`foldEvents`), and a runtime adapter contract
(`RuntimeAdapter`/`createHerdrCliRuntime`/`herdrRuntimeName`,
`ObservationTracker`/`watchAgent`, `overlayRuntime`) — see
[domain model](docs/architecture/domain-model.md#implemented-now-p2) and
[observability](docs/architecture/observability.md#implemented-now-p2), all
marked as an unstable p2 contract in `src/index.ts`.

`createHerdrCliRuntime`'s `inspect` runs only a read-only allowlist —
`agent list`, `agent get <target>`, `pane get <id>`, `pane list` and
`workspace list` — and refuses everything else as `invalid_request` without
spawning. Its `waitFor` returns `unsupported` without spawning whenever the
requested states include `gone` or `unknown` (Herdr cannot wait for either),
and `stop` gives up the closed pane's ownership immediately once `pane
close` succeeds, before it even verifies the agent is gone. Any exit-0
Herdr response is treated as `protocol_error`, not success, unless it
carries both a non-empty string request `id` and an object `result`. A
deterministic in-memory double for the same runtime contract,
`createScriptedRuntime`, ships from the `herdr-woof/testing` subpath for
workflow-author tests; it is never exported from the main entry. Its
`advance` throws a TypeError for a negative or non-integer step count, and
construction throws a TypeError for an empty `afterDeliver` sequence (flat
or nested). A scripted `started` delivery is also checked like the Herdr
adapter's own: if the observation right after delivery is not `working` or
`blocked`, the outcome is downgraded to `ambiguous/protocol_error` (the call
is still logged as `sent`).

## Build-review loop (p3)

A scheduler now runs the built-in `build-review` workflow end to end: build
→ verify (an engine-run check, only when the input names a command) → review
→ repair, until a review passes on the exact repaired revision or a limit
ends the run. It launches `claude` agents in Herdr panes next to the
scheduler's own (`HERDR_ENV=1` and `HERDR_PANE_ID` must be set), so an
interactive Claude agent it starts must already be allowed to run — the
operator must have trusted the target repository in Claude Code at least
once (open `claude` there and answer its folder-trust question) before
`woof run build-review` can start an agent in it; Woof surfaces an untrusted
repository as `run.blocked{reason:"startup_blocked"}` and never bypasses
that dialog. `repo` must be the top level of that git work tree (`git
rev-parse --show-toplevel`); a nested directory is rejected `repo_invalid`,
naming both the given path and the resolved top level:

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
bin/woof run build-review --input input.json --run-dir /tmp/woof-run
# {"outcome":"run","result":{"outcome":"completed","limit":null,...}}
```

`agents.builder`/`agents.reviewer` resolve `kind`, `model` and caller launch
arguments; the engine adds only `--model <model>` (when given) and
`--add-dir <runDir>` — never a permission flag. `limits` is optional (each
key optional, same bounds as elsewhere) and defaults to
`maxAttemptsPerVisit: 2, maxVisitsPerStage: 3, maxRounds: 3,
maxFormatRepairs: 2, runTimeoutMs: 7200000, readinessWaitMs: 180000,
blockedWaitMs: 600000, deliveryTimeoutMs: 60000`.

`--poll-ms` must be an integer of at least 1 (usage error otherwise).
Progress goes to stderr; stdout prints exactly one JSON line. Exit codes:
`0` completed, `4` failed, `5` exhausted, `6` cancelled, `2` rejected before
launch (bad input, a repository that is not the git work tree's top level or
one git itself cannot take, an unsupported agent kind, a run directory
overlapping the repository, an existing run directory), `3` a runtime or
journal infrastructure failure (including `HERDR_ENV`/`HERDR_PANE_ID` unset
without `--runtime-module`, a `--runtime-module` factory whose result is
missing or misshapes a `RuntimeAdapter` method — checked before any run
opens — or a run that finished but left a pane the driver could not stop,
returned as `RunResult` plus an attached `runtime_cleanup_failed` error), `1`
a usage error. `woof run cancel <run-dir>` records
`run.terminated{outcome:"cancelled"}` for a scheduler that may still be
running elsewhere (its own next tick then stops it); exit `0` when
recorded, `2` when the run is already terminated, `3` on a journal failure.

See [domain model](docs/architecture/domain-model.md#implemented-now-p3),
[communication](docs/architecture/communication.md#implemented-now-p3),
[observability](docs/architecture/observability.md#implemented-now-p3),
[workflow authoring](docs/workflows/authoring.md#implemented-now-p3) and
[initial workflows](docs/workflows/initial-workflows.md#implemented-now-p3)
for the definition contract, the scheduler's decision rules, format repair,
blocking/reconciliation, revision binding and the terminal `RunResult`.

What still does not exist: a second built-in workflow (`plan-build-review`,
phase 5), an MCP adapter, crash resume or re-hosting a lost run, and parallel
scheduling (one active request per agent, one sequential decision loop).
`.woof`/`~/.woof` configuration and run hosting are implemented — see
[Product integration (p4)](#product-integration-p4) below.

## Product integration (p4)

Configuration, run hosting, read-only inspection and both plugins now exist.
`.woof/` (project) and `~/.woof/` (user) hold JSON settings, one role per
file, and workflow definition modules, with documented precedence
(project → user → built-in) and provenance on every resolved value:

```sh
mkdir -p .woof/roles
cat > .woof/roles/builder.json <<'EOF'
{"schemaVersion":1,"kind":"claude","model":"sonnet","args":["--permission-mode","auto"]}
EOF
bin/woof config show
# {"outcome":"config","configuration":{...,"roles":{"builder":{"source":"project","path":".woof/roles/builder.json",...}}}}
```

`woof run start` resolves that configuration, launches a scheduler in a
Herdr pane (`HERDR_ENV=1` and `HERDR_PANE_ID` required, or `--host
foreground` to run in this process), and returns once the pane host has
claimed and opened the run:

```sh
bin/woof run start --input input.json
# {"outcome":"started","runId":"br-…","runDir":"/abs","host":{"mode":"herdr-pane","paneId":"…"},...}
bin/woof status /abs --wait
# polls until a terminal outcome (exit 0/4/5/6), the owner gone without a
# recorded outcome -- lost, or exited without a terminal record (exit 8) --
# a block needing the operator (exit 9), or --timeout-ms (exit 7)
```

The pane host claims the run exclusively (`host.json`, a heartbeat every
2000 ms by default), so `woof status`/`woof runs` report the owner as
`unhosted`, `alive`, `lost` or `exited` instead of the p3 constant
`"unhosted"` — a killed host is reported `lost`, never silently as running,
and its only resolution is still `woof run cancel <run-dir>` (no crash
resume). `woof runs`, `woof events` and `woof config show` are read-only and
never take the journal lock or contact Herdr.

The Herdr plugin (`herdr-plugin.toml`) exposes `doctor`, `status`, `start`
and `cancel` actions that target the invocation's focused project and
project run state as pane metadata tokens. The Claude Code plugin
(`plugin/claude/`) ships `/woof:run <task description>`, which resolves the
CLI, applies the operator-trust precondition below, starts a run and waits
for it with `woof status --wait`, reporting the structured result.

**Operator-trust precondition.** Both `woof run build-review` and `woof run
start` launch interactive `claude` agents in Herdr panes; an agent that has
never been trusted in a target repository stops at its own folder-trust
prompt and the run records `run.blocked{reason:"startup_blocked"}` rather
than proceeding. Before starting a run against a repository, open `claude`
there at least once and accept its trust question — Woof only reports this
status (`woof doctor --json`, `run start`'s `warnings[]`, `/woof:run`'s
pre-flight); it never answers the prompt or bypasses it.

See [configuration](docs/architecture/configuration.md#implemented-now-p4),
[domain model](docs/architecture/domain-model.md#implemented-now-p4),
[observability](docs/architecture/observability.md#implemented-now-p4) and
[plugins](docs/integrations/plugins.md) for the full contracts.

## Integrations and scope

The Herdr plugin exposes `doctor`, `status`, `start` and `cancel` actions; the
Claude Code plugin's `/woof:run` command starts and waits on a run. Neither
ships tools, hooks, a background process or a transport adapter beyond what
[Product integration (p4)](#product-integration-p4) and
[plugins.md](docs/integrations/plugins.md) describe. MCP is deferred and is
not a maintained integration in this repository.

The [documentation index](docs/README.md) and [product brief](docs/product/brief.md)
describe the intended product; they are not claims that those features exist.
