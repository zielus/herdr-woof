#!/usr/bin/env node
// Live acceptance for an external, project-authored workflow (p5 §6, L-EXT).
//
// Unlike the other live scripts this one starts nothing. A Claude Code caller
// agent, started with `--plugin-dir <worktree>/plugin/claude` inside the fixture
// repository, runs `/woof:run --workflow scribe <note text>`. This script
// samples that run alongside the caller and gates it:
//
//   node scripts/live/external-workflow.mjs --run-dir <dir> [--host-pane <pane>]
//   node scripts/live/external-workflow.mjs --watch          # wait for a new run to appear
//
// Take the run directory from the caller's own `started` output, or from a
// before/after diff of `woof runs` — never from a stale listing. `--watch` does
// that diff for you: it records the runs under the runs directory now, waits for
// exactly one new one, and samples it.
//
// The discovered-workflow launch path matters here: the launcher does NOT
// pre-admit a workflow it finds in the project's `.woof/`. The module body runs
// once, in the pane host, so the host is what admits or rejects the input, and
// the host writes its verdict to the run directory's `outcome.json`.
//
// The launcher does still surface that verdict: `launchInPane` reads the host's
// `outcome.json` and returns exit 2 for a non-infrastructure rejection, exit 3
// otherwise (src/host/launch.ts:251-264). `outcome.json` is the source of the
// rejection's *details* — its reason, message and per-field details — which an
// exit code cannot carry. This script also never sees that exit code: it samples
// a run a separate caller agent started. So it reads `outcome.json` on every
// pass; without that, a rejected run would look like a hang.
//
// FIXTURE RULE (p5 repair LV-101): `scripts/live/build-review.mjs` deletes and
// re-initializes the shared fixture on **every** invocation, not only with
// --fixture-only, and re-commits `.woof/roles/*` and `.woof/workflows/scribe.mjs`
// every time (that writer is the default since LV-101; --no-roles opts out). This
// script never re-initializes the fixture: it reads what is there and refuses to
// start if the work tree is dirty or the configuration it needs is missing.
//
// It never reads pane text and never sends keys. Exit 0 when every gate passes,
// 1 when one fails, 4 when the journal holds run.blocked.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_GRACE_MS, observerDisagreements } from "./lib/observer.mjs";

const woofRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cliPath = join(woofRoot, "dist", "cli.js");
if (!existsSync(cliPath)) {
  console.error("dist/cli.js is missing; run bun run build first");
  process.exit(1);
}
const load = (rel) => import(pathToFileURL(join(woofRoot, "dist", rel)).href);
const { createHerdrCliRuntime, readEvents, readJournal } = await load("index.js");

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const watch = argv.includes("--watch");
const phaseDir = join(homedir(), ".herdr-dev", "runs", "herdr-woof", "p3-build-review-loop");
const fixtureRepo = join(phaseDir, "live", "fixture-repo");
const hostPane = flag("host-pane") ?? null;
const timeoutMs = Number(flag("timeout-ms") ?? 900_000);

const logged = new Set();
function log(line = "") {
  console.log(line);
}
function section(title) {
  log("");
  log(`== ${title} ==`);
}
function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}
const woof = (...args) => sh(process.execPath, [cliPath, ...args]);
const gates = [];
function gate(id, title, pass, evidence) {
  gates.push({ id, title, pass });
  log(
    `GATE ${id} ${pass ? "PASS" : "FAIL"}: ${title}${evidence === undefined ? "" : ` — ${evidence}`}`,
  );
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run directories under the configured runs directory, as a set. `woof runs`
 * prints `{"outcome":"runs","runsDir","exists","runs":[{runId,runDir,…}],…}`
 * (verified against `node dist/cli.js runs`), and its default listing always
 * includes every run that has not ended. `--project` is deliberately NOT passed:
 * it keeps only runs whose *recorded configuration* names that root, and a run
 * that has just been created has not written config.json yet.
 */
function listRunDirs() {
  const listed = woof("runs");
  if (listed.status !== 0) {
    log(`[watch] woof runs exited ${listed.status}: ${listed.stderr || listed.stdout}`);
    return new Set();
  }
  try {
    const parsed = JSON.parse(listed.stdout);
    return new Set((parsed.runs ?? []).map((item) => item.runDir));
  } catch {
    log(`[watch] woof runs printed no JSON: ${listed.stdout.slice(0, 200)}`);
    return new Set();
  }
}

// ---------------------------------------------------------------- preconditions
section("Woof p5 live acceptance: external workflow (scribe) through /woof:run --workflow");
log(`date: ${new Date().toISOString()}`);
log(`herdr --version: ${sh("herdr", ["--version"]).stdout}`);
logged.add("herdr");
log(`claude --version: ${sh("claude", ["--version"]).stdout}`);
logged.add("claude");
log(`node --version: ${process.version}`);
logged.add("node");
log(`git --version: ${sh("git", ["--version"]).stdout}`);
logged.add("git");
log(`woof commit: ${sh("git", ["-C", woofRoot, "rev-parse", "HEAD"]).stdout}`);
logged.add("commit");
const worktreeStatusBefore = sh("git", ["-C", woofRoot, "status", "--porcelain"]).stdout;
log(`woof worktree status --porcelain:\n${worktreeStatusBefore || "(clean)"}`);

const definitionPath = join(fixtureRepo, ".woof", "workflows", "scribe.mjs");
if (!existsSync(definitionPath)) {
  log(
    `precondition failed: ${definitionPath} is missing; run node scripts/live/build-review.mjs --fixture-only --with-roles once first`,
  );
  process.exit(1);
}
const shipped = join(woofRoot, "test", "fixtures", "workflows", "scribe.mjs");
const sameBytes = readFileSync(definitionPath, "utf8") === readFileSync(shipped, "utf8");
log(`definition: ${definitionPath}`);
log(`identical to ${shipped}: ${sameBytes}`);
log(
  `configuration: ${woof("config", "show", "--project", fixtureRepo, "--workflow", "scribe").stdout}`,
);
logged.add("input");

// ---------------------------------------------------------------- find the run
let runDir = flag("run-dir") ?? null;
if (runDir === null && !watch) {
  log("usage: --run-dir <dir> (from the caller's started output), or --watch");
  process.exit(1);
}
if (runDir === null) {
  const before = listRunDirs();
  log(`[watch] ${before.size} run directories before; waiting for a new one`);
  // This diff only works if this script starts BEFORE the caller creates its run
  // directory: a run that already exists is in `before` and never counts as new.
  // Prefer --run-dir from the caller's own `started` output whenever you have it.
  log("[watch] prefer --run-dir from the caller's started output; this diff must start first");
  const deadline = Date.now() + timeoutMs;
  while (runDir === null && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop
    await sleep(2000);
    const added = [...listRunDirs()].filter((dir) => !before.has(dir));
    if (added.length === 1) runDir = added[0];
    else if (added.length > 1) {
      log(`[watch] ${added.length} new run directories appeared: ${JSON.stringify(added)}`);
      log("never run two at once on the shared fixture; pass --run-dir explicitly");
      process.exit(1);
    }
  }
  if (runDir === null) {
    log(`[watch] no new run directory within ${timeoutMs} ms`);
    process.exit(1);
  }
}
section("run");
log(`run dir: ${runDir}`);
log(`caller's host pane: ${hostPane ?? "(not given)"}`);
log("command: the caller agent ran /woof:run --workflow scribe <note text>");
logged.add("command");

// ---------------------------------------------------------------- sample
const herdr = createHerdrCliRuntime({ bin: "herdr" });
const samples = [];
const outcomePath = join(runDir, "outcome.json");
const deadline = Date.now() + timeoutMs;
let outcome = null;
while (Date.now() < deadline) {
  const shown = woof("run", "show", runDir);
  if (shown.status === 0) {
    const snapshot = JSON.parse(shown.stdout).snapshot;
    const row = {
      at: new Date().toISOString(),
      status: snapshot.status,
      revision: snapshot.revision,
      agents: {},
    };
    for (const item of snapshot.agents) {
      if (item.assignment === null) continue;
      // oxlint-disable-next-line no-await-in-loop
      const got = await herdr.inspect(["agent", "get", item.assignment.runtimeName]);
      row.agents[item.agentId] = {
        herdr: got.ok ? (got.result.agent?.agent_status ?? "unknown") : `error:${got.error.code}`,
        activeAttempt: item.activeAttempt,
      };
    }
    samples.push(row);
    const summary = Object.entries(row.agents)
      .map(([id, value]) => `${id}=herdr:${value.herdr}`)
      .join(" ");
    log(`[sample] ${row.at} status=${row.status} ${summary}`);
    if (snapshot.outcome !== null) break;
  }
  // The launcher does not pre-admit a discovered workflow: a rejection shows up
  // here, not as a launcher exit code, so it is read on every pass.
  if (existsSync(outcomePath)) {
    try {
      outcome = JSON.parse(readFileSync(outcomePath, "utf8"));
    } catch {
      outcome = null;
    }
    if (outcome?.outcome === "rejected") break;
  }
  // oxlint-disable-next-line no-await-in-loop
  await sleep(5000);
}
logged.add("samples");
if (existsSync(outcomePath)) {
  try {
    outcome = JSON.parse(readFileSync(outcomePath, "utf8"));
  } catch {
    outcome = null;
  }
}

// ---------------------------------------------------------------- evidence
section("host outcome.json");
log(existsSync(outcomePath) ? readFileSync(outcomePath, "utf8") : "(absent)");
logged.add("result");
const shownFinal = woof("run", "show", "--verify-artifacts", runDir);
section("woof run show --verify-artifacts");
log(shownFinal.stdout);
const snapshot = shownFinal.status === 0 ? JSON.parse(shownFinal.stdout).snapshot : null;
const read = readJournal(runDir);
const records = read.ok ? read.records : [];
const events = readEvents(runDir);
section("event trace");
for (const event of events.ok ? events.events : []) {
  log(`${event.seq} ${event.type} ${JSON.stringify(event.subject)}`);
}
logged.add("events");
const ofType = (type) => records.filter((item) => item.type === type);
const dispatches = ofType("request.dispatched");
section("requests");
for (const item of dispatches) {
  const path = join(runDir, item.request?.path ?? "missing");
  log(`${item.stageId}/${item.visit}/${item.attempt} ${item.request?.path}`);
  log(existsSync(path) ? readFileSync(path, "utf8") : "(missing)");
}
logged.add("requests");
const accepted = ofType("submission.accepted");
section("accepted note");
for (const item of accepted) {
  const path = join(runDir, item.artifact.acceptedPath);
  log(`--- ${item.stageId} ${item.visit}.${item.attempt} (${path})`);
  log(existsSync(path) ? readFileSync(path, "utf8") : "(missing)");
}
logged.add("artifacts");
section("configuration recorded with the run");
const configPath = join(runDir, "config.json");
log(existsSync(configPath) ? readFileSync(configPath, "utf8") : "(absent)");

// ---------------------------------------------------------------- gates
section("gates");
const planned = records[0]?.plan;
const assignments = ofType("agent.assigned");
const blockedRecords = ofType("run.blocked");
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : null;

gate(
  1,
  "an external project workflow ran to completion through /woof:run --workflow, with no engine branch naming it",
  snapshot?.outcome?.outcome === "completed" &&
    planned?.workflow?.name === "scribe" &&
    planned?.workflow?.version === "1",
  `outcome ${snapshot?.outcome?.outcome}, workflow ${planned?.workflow?.name}@${planned?.workflow?.version}`,
);

gate(
  2,
  "the definition came from the project .woof, byte-identical to the committed fixture, recorded with its sha256",
  sameBytes &&
    config?.workflow?.source === "project" &&
    config?.workflow?.path === definitionPath &&
    /^[0-9a-f]{64}$/.test(config?.workflow?.sha256 ?? ""),
  `source ${config?.workflow?.source}, path ${config?.workflow?.path}, identical ${sameBytes}`,
);

const stageIds = [...new Set(ofType("attempt.opened").map((item) => item.stageId))];
gate(
  3,
  "one agent whose id is not its role, one stage the engine has never seen, and no rounds at all",
  planned?.agents?.length === 1 &&
    planned?.agents?.[0]?.agentId === "scribe" &&
    planned?.agents?.[0]?.role === "builder" &&
    assignments.length === 1 &&
    JSON.stringify(stageIds) === JSON.stringify(["note"]) &&
    (planned?.checks ?? []).length === 0 &&
    (snapshot?.counters?.rounds ?? 0) === 0,
  `agents ${JSON.stringify(planned?.agents)}, stages ${JSON.stringify(stageIds)}, rounds ${snapshot?.counters?.rounds}`,
);

// The complete limit set came from resolveLimits, not from limitDefaults: this
// definition declares none, the p3 shape.
const limits = planned?.limits ?? {};
gate(
  4,
  "the complete limit set came from the definition's resolveLimits (it declares no limitDefaults)",
  limits.maxRounds === 1 &&
    limits.maxVisitsPerStage === 1 &&
    limits.maxAttemptsPerVisit === 1 &&
    limits.runTimeoutMs === 900_000,
  JSON.stringify(limits),
);

gate(
  5,
  "the caller's host recorded a terminal outcome in outcome.json, not only an exit code",
  outcome !== null && typeof outcome.outcome === "string",
  JSON.stringify(outcome?.outcome ?? null),
);

const disagreement = observerDisagreements(samples, records, { graceMs: DEFAULT_GRACE_MS });
for (const item of disagreement) log(`[observer] ${JSON.stringify(item)}`);
gate(
  6,
  `observer agreement between Herdr samples and snapshots (grace ${DEFAULT_GRACE_MS} ms after acceptance)`,
  samples.length > 0 && disagreement.length === 0,
  `${samples.length} samples, ${disagreement.length} disagreeing`,
);

const worktreeStatusAfter = sh("git", ["-C", woofRoot, "status", "--porcelain"]).stdout;
const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
const forbidden = [
  ["agent", "read"],
  ["pane", "read"],
  ["send", "keys"],
].map((parts) => parts.join(parts[0] === "send" ? "-" : " "));
// Built from parts so the check does not match its own source.
const startsRuns = ["run", "start"].join(" ");
const hits = forbidden.filter((needle) => source.includes(needle));
log(
  `script source grep for ${forbidden.join(", ")}: ${hits.length === 0 ? "no matches" : hits.join(", ")}`,
);
gate(
  7,
  "Woof worktree unchanged; script never reads panes, sends keys or starts a run",
  worktreeStatusAfter === worktreeStatusBefore && hits.length === 0 && !source.includes(startsRuns),
  `worktree unchanged ${worktreeStatusAfter === worktreeStatusBefore}, starts no run ${!source.includes(startsRuns)}`,
);

const needed = [
  "commit",
  "herdr",
  "claude",
  "node",
  "git",
  "input",
  "command",
  "events",
  "requests",
  "artifacts",
  "result",
  "samples",
];
gate(
  8,
  "log records versions, definition, command, trace, locations and result",
  needed.every((key) => logged.has(key)),
  needed.filter((key) => !logged.has(key)).join(", ") || "all recorded",
);

section("human inspection (required)");
log("Read the accepted note above: it must be a real note about this repository, written by the");
log("agent, not a restatement of the request. Read the caller agent's own report and confirm it");
log("named the run id, the run directory and the outcome, and that it reported the note's");
log("acceptedPath from artifacts.lastAcceptedByStage (a workflow with no review stage has a null");
log("artifacts.review even when it completed).");

const failed = gates.filter((item) => !item.pass);
section("summary");
log(
  `${gates.length - failed.length}/${gates.length} gates passed${failed.length > 0 ? `; failed: ${failed.map((item) => item.id).join(", ")}` : ""}`,
);
log(`run directory for operator cleanup: ${runDir}`);
if (blockedRecords.length > 0) {
  log("the journal holds run.blocked: nothing was auto-approved");
  process.exit(4);
}
process.exit(failed.length === 0 ? 0 : 1);
