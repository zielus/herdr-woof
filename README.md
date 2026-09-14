# Woof

Woof is the future orchestration SDK for coding agents running through Herdr.
This repository provides a package boundary, build and packaging checks, a
diagnostic CLI, truthful Herdr/Claude plugin placeholders, a first working
slice of result handoff (a worker-callable `woof submit` CLI/SDK bridge
backed by an append-only run journal), and a p2 run-facts and snapshot layer
(run plans, journaled agent assignment/dispatch/termination, derived
snapshots and events, and a Herdr runtime adapter — see below). It does not
run workflows, delegate agents, or publish a stable `HerdrAgentsSDK` API yet.

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
Executable behavior today is diagnostic, plus the result-handoff prototype:

```sh
bin/woof --help
bin/woof --version
bin/woof doctor
bin/woof attempt open --run-dir <dir> --run <id> --agent <id> --stage <id> \
  --visit <n> --attempt <n> [--verdicts a,b] [--pane <pane-id>]
bin/woof submit --envelope <path|-> [--run-dir <dir>]
bin/woof run show <run-dir> [--verify-artifacts]
```

`doctor` reports whether Herdr and Claude Code can be invoked; neither is
required for the command to complete. Any other workflow-oriented command is
rejected as not implemented.

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

What still does not exist: a scheduler or workflow engine, workflow
definitions or a loader, `.woof`/`~/.woof` configuration, an MCP adapter, or
run hosting (there is no daemon or live run owner — every store call and
`submit` open the journal themselves, in process). Declared limits are
validated and counted but never enforced; gate, block and
delivery-reconciliation related domain result shapes exist
(`GateResult`/`GateDecision`, `BlockInfo`, `DeliveryResolution`), but their
journal record types, writers, readers, events and behaviour — and the run
status `blocked` they would produce — are not implemented. Crash resume is
not claimed.

## Integrations and scope

The Herdr plugin exposes only `doctor`. The Claude plugin explicitly declines
workflow requests. MCP is deferred and is not a maintained integration in this
repository.

The [documentation index](docs/README.md) and [product brief](docs/product/brief.md)
describe the intended product; they are not claims that those features exist.
