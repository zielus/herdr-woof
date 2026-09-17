#!/usr/bin/env node
// Live acceptance for the p3 build-review loop (plan §6c). Run inside a Herdr
// pane after `bun run build`:
//
//   node scripts/live/build-review.mjs --probe
//   node scripts/live/build-review.mjs 2>&1 | tee docs/research/build-review-live.log
//   node scripts/live/build-review.mjs --fixture-only [--no-roles]
//
// FIXTURE RULE (p5 repair LV-101). **Every** invocation of this script — with or
// without --fixture-only — deletes and re-initializes the fixture repository, so
// a plain run is also a re-init. Configuration is therefore written on every
// invocation by default: `.woof/roles/{builder,planner,reviewer}.json` (claude,
// sonnet, `--permission-mode auto`) and the external workflow
// `.woof/workflows/scribe.mjs` (copied byte-for-byte from
// test/fixtures/workflows/scribe.mjs) go into the fixture's single commit, so the
// tree is clean when a run starts and every later live script still finds what it
// needs. --no-roles opts out, for the bare p3 fixture; --with-roles is accepted
// and is now the default. Before LV-101 the writer was opt-in, so running this
// script for L-BR silently deleted the roles and the external workflow that
// L-PBR and L-EXT require.
//
// --fixture-only re-initializes, prints the fixture path and exits (p4 live check).
//
// It rebuilds the fixture repository at one fixed path, writes the input, runs
// the real `woof run build-review` CLI with two Claude agents, samples `woof run
// show` and Herdr agent status every 5 s, then prints the evidence and a
// PASS/FAIL line per hard gate. It never reads pane text and never sends keys.
// Exit 0 when every gate passes, 1 when one fails, 4 when the journal holds
// run.blocked.
//
// Operator precondition: Claude Code asks a folder-trust question for a
// directory it has never seen, and that blocks agent startup. The operator must
// have trusted the fixed fixture path
// ~/.herdr-dev/runs/herdr-woof/p3-build-review-loop/live/fixture-repo in Claude
// Code once (open `claude` there and answer its folder-trust question); Woof
// never does this. The repository there is deleted and re-initialized on every
// run; run directories stay per-stamp next to it, outside it.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_GRACE_MS, observerDisagreements, workingWhileActive } from "./lib/observer.mjs";

const woofRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cliPath = join(woofRoot, "dist", "cli.js");
if (!existsSync(cliPath)) {
  console.error("dist/cli.js is missing; run bun run build first");
  process.exit(1);
}
const load = (rel) => import(pathToFileURL(join(woofRoot, "dist", rel)).href);
const { createHerdrCliRuntime, deriveRunResult, readEvents, readJournal } = await load("index.js");
const { revisionOf } = await load("scheduler/revision.js");

const probe = process.argv.includes("--probe");
const fixtureOnly = process.argv.includes("--fixture-only");
// Configuration is written on every re-init unless --no-roles asks for the bare
// p3 fixture; --with-roles stays accepted so existing procedures keep working.
const withRoles = !process.argv.includes("--no-roles");
const phaseDir = join(homedir(), ".herdr-dev", "runs", "herdr-woof", "p3-build-review-loop");
const probeLog = join(phaseDir, "live-probe.log");
// The one fixture path the operator trusts in Claude Code; see the header.
const fixtureRepo = join(phaseDir, "live", "fixture-repo");
const trustPrecondition = `the operator must have trusted ${fixtureRepo} in Claude Code once (open \`claude\` there and answer its folder-trust question); Woof never does this.`;
const logged = new Set();

function log(line = "", key = undefined) {
  console.log(line);
  if (probe) appendFileSync(probeLog, `${line}\n`);
  if (key !== undefined) logged.add(key);
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
    error: result.error?.message ?? null,
  };
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const woof = (...args) => sh(process.execPath, [cliPath, ...args]);
const identityOf = (record) =>
  JSON.stringify([
    record.paneId ?? null,
    record.target?.terminalId ?? null,
    record.target?.sessionId ?? null,
  ]);
const nonNull = (serialized) => !JSON.parse(serialized).includes(null);
const gates = [];
function gate(id, title, pass, evidence) {
  gates.push({ id, title, pass });
  log(
    `GATE ${id} ${pass ? "PASS" : "FAIL"}: ${title}${evidence === undefined ? "" : ` — ${evidence}`}`,
  );
}

// ---------------------------------------------------------------- preconditions
if (probe) mkdirSync(phaseDir, { recursive: true });
section(probe ? "Woof p3 live probe" : "Woof p3 live acceptance: build-review");
const worktreeStatusBefore = sh("git", ["-C", woofRoot, "status", "--porcelain"]).stdout;
log(`date: ${new Date().toISOString()}`);
log(`HERDR_ENV=${process.env["HERDR_ENV"] ?? "(unset)"}`);
log(`HERDR_PANE_ID=${process.env["HERDR_PANE_ID"] ?? "(unset)"}`);
log(`herdr --version: ${sh("herdr", ["--version"]).stdout}`, "herdr");
log(`claude --version: ${sh("claude", ["--version"]).stdout}`, "claude");
log(`node --version: ${process.version}`, "node");
log(`git --version: ${sh("git", ["--version"]).stdout}`, "git");
log(`woof commit: ${sh("git", ["-C", woofRoot, "rev-parse", "HEAD"]).stdout}`, "commit");
log(`woof worktree status --porcelain:\n${worktreeStatusBefore || "(clean)"}`);
log(`precondition: ${trustPrecondition}`);
if (
  !fixtureOnly &&
  (process.env["HERDR_ENV"] !== "1" || (process.env["HERDR_PANE_ID"] ?? "") === "")
) {
  log("precondition failed: run this inside a Herdr pane (HERDR_ENV=1, HERDR_PANE_ID)");
  process.exit(1);
}

// ---------------------------------------------------------------- fixture
const stamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace("T", "-").slice(0, 15);
const live = join(phaseDir, "live", probe ? `probe-${stamp}` : stamp);
const repo = fixtureRepo;
const runDir = join(live, "run");
const inputPath = join(live, "input.json");
const nonce = randomBytes(6).toString("hex");
const runId = `${probe ? "live-probe" : "live-br"}-${stamp}`;
const requiredLine = `// woof-acceptance: ${nonce}`;
// Re-initialize the fixed fixture repository from scratch; the run directory is per stamp, outside it.
rmSync(repo, { recursive: true, force: true });
mkdirSync(join(repo, "src"), { recursive: true });
if (!fixtureOnly) mkdirSync(live, { recursive: true });
const gitAs = (...args) =>
  sh(
    "git",
    [
      "-c",
      "user.name=Woof Live",
      "-c",
      "user.email=live@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "maintenance.auto=false",
      ...args,
    ],
    {
      cwd: repo,
    },
  );
gitAs("init", "-q");
writeFileSync(
  join(repo, "package.json"),
  `${JSON.stringify({ name: "slug-fixture", type: "module", private: true })}\n`,
);
writeFileSync(
  join(repo, "src", "slugify.mjs"),
  'export function slugify(text) {\n  throw new Error("not implemented");\n}\n',
);
writeFileSync(join(repo, "README.md"), "Fixture for Woof live acceptance.\n");
if (withRoles) {
  mkdirSync(join(repo, ".woof", "roles"), { recursive: true });
  const role = {
    schemaVersion: 1,
    kind: "claude",
    model: "sonnet",
    args: ["--permission-mode", "auto"],
  };
  // `planner` is plan-build-review's third role (p5).
  for (const name of ["builder", "planner", "reviewer"]) {
    writeFileSync(join(repo, ".woof", "roles", `${name}.json`), `${JSON.stringify(role)}\n`);
  }
  // The external workflow (p5 D4), copied from the committed fixture so the live
  // and offline copies cannot drift, and committed here so it is part of the
  // fixture's tree: an untracked file would move the work-tree fingerprint the
  // moment it appeared and cause spurious revision_moved rounds.
  mkdirSync(join(repo, ".woof", "workflows"), { recursive: true });
  copyFileSync(
    join(woofRoot, "test", "fixtures", "workflows", "scribe.mjs"),
    join(repo, ".woof", "workflows", "scribe.mjs"),
  );
}
gitAs("add", "-A");
gitAs("commit", "-q", "-m", "fixture");
if (fixtureOnly) {
  const status = sh("git", ["-C", repo, "status", "--porcelain"]).stdout;
  log(`fixture status --porcelain: ${status || "(clean)"}`);
  console.log(repo);
  process.exit(status === "" ? 0 : 1);
}

const agent = { kind: "claude", model: "sonnet", args: ["--permission-mode", "auto"] };
const input = probe
  ? {
      schemaVersion: 1,
      repo,
      task: {
        title: "Create PROBE.md",
        description: "Create a file named PROBE.md in the repository root containing the word ok.",
        acceptanceCriteria: ["PROBE.md exists in the repository root and contains the word ok"],
      },
      agents: { builder: agent, reviewer: agent },
      limits: {
        maxAttemptsPerVisit: 2,
        maxVisitsPerStage: 3,
        maxRounds: 1,
        maxFormatRepairs: 2,
        runTimeoutMs: 1_200_000,
        readinessWaitMs: 180_000,
        blockedWaitMs: 180_000,
        deliveryTimeoutMs: 60_000,
      },
    }
  : {
      schemaVersion: 1,
      repo,
      task: {
        title: "Implement slugify",
        description:
          "Implement `slugify(text)` in `src/slugify.mjs`: lowercase; runs of characters other than a–z and 0–9 become one hyphen; no leading or trailing hyphens. Add tests in `test/slugify.test.mjs` using `node:test`.",
        acceptanceCriteria: [
          "slugify lowercases its input",
          "runs of characters other than a–z and 0–9 become one hyphen",
          "the result has no leading or trailing hyphens",
          "tests pass with `node --test`",
        ],
      },
      instructions: {
        reviewer: `Project convention (review checklist item): every module under \`src/\` must begin with the exact line \`${requiredLine}\`. Treat a missing or different line as a blocking finding, and quote the exact required line in your review. Review against the task, the acceptance criteria and this checklist; do not invent other requirements.`,
      },
      verify: { command: ["node", "--test"], timeoutMs: 120_000 },
      agents: { builder: agent, reviewer: agent },
      limits: {
        maxAttemptsPerVisit: 2,
        maxVisitsPerStage: 3,
        maxRounds: 2,
        maxFormatRepairs: 2,
        runTimeoutMs: 2_700_000,
        readinessWaitMs: 180_000,
        blockedWaitMs: 180_000,
        deliveryTimeoutMs: 60_000,
      },
    };
writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);
section("fixture");
log(`live root: ${live}`);
log(`repo (fixed, re-initialized): ${repo}`);
log(`run dir: ${runDir}`);
log(`nonce: ${nonce}`);
log(`input (${inputPath}):\n${readFileSync(inputPath, "utf8")}`, "input");

// ---------------------------------------------------------------- run
const cliArgs = [
  "run",
  "build-review",
  "--input",
  inputPath,
  "--run-dir",
  runDir,
  "--run-id",
  runId,
];
section("run");
log(`command: ${process.execPath} ${cliPath} ${cliArgs.join(" ")}`, "command");
const child = spawn(process.execPath, [cliPath, ...cliArgs], { cwd: woofRoot, env: process.env });
let stdout = "";
child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
child.stderr.setEncoding("utf8").on("data", (chunk) => {
  for (const line of chunk.split("\n")) if (line !== "") log(`[cli] ${line}`);
});
process.on("SIGINT", () => child.kill("SIGINT"));

const herdr = createHerdrCliRuntime({ bin: "herdr" });
const samples = [];
let startupBlockReported = false;
async function sample() {
  const shown = woof("run", "show", runDir);
  if (shown.status !== 0) return;
  const snapshot = JSON.parse(shown.stdout).snapshot;
  const block = snapshot.attention?.blocked;
  if (block?.reason === "startup_blocked" && !startupBlockReported) {
    startupBlockReported = true;
    const assignment = snapshot.agents.find((item) => item.agentId === block.agentId)?.assignment;
    log(
      `[startup blocked] agent ${block.agentId} (runtime ${assignment?.runtimeName ?? "unknown"}) is blocked while starting in pane ${assignment?.paneId ?? "unknown"}; precondition: ${trustPrecondition} Nothing answers it; the run exhausts blockedWaitMs as designed.`,
    );
  }
  const row = {
    at: new Date().toISOString(),
    status: snapshot.status,
    revision: snapshot.revision,
    agents: {},
  };
  for (const item of snapshot.agents) {
    if (item.assignment === null) continue;
    // One agent at a time: Herdr reads are cheap and ordered.
    // oxlint-disable-next-line no-await-in-loop
    const got = await herdr.inspect(["agent", "get", item.assignment.runtimeName]);
    const herdrStatus = got.ok
      ? (got.result.agent?.agent_status ?? "unknown")
      : `error:${got.error.code}`;
    row.agents[item.agentId] = { herdr: herdrStatus, activeAttempt: item.activeAttempt };
  }
  samples.push(row);
  const summary = Object.entries(row.agents)
    .map(
      ([id, value]) =>
        `${id}=herdr:${value.herdr}/attempt:${value.activeAttempt === null ? "none" : `${value.activeAttempt.stageId}.${value.activeAttempt.visit}.${value.activeAttempt.attempt}`}`,
    )
    .join(" ");
  log(`[sample] ${row.at} status=${row.status} rev=${row.revision} ${summary}`);
}
const exitCode = await new Promise((resolve) => {
  const timer = setInterval(() => void sample(), 5000);
  child.on("close", (code) => {
    clearInterval(timer);
    resolve(code);
  });
});
logged.add("samples");

// ---------------------------------------------------------------- evidence
section("result");
log(`cli exit code: ${exitCode}`);
log(`stdout: ${stdout.trim()}`, "result");
let printed = null;
try {
  printed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");
} catch {
  printed = null;
}
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
const ofType = (type) => records.filter((record) => record.type === type);
const dispatches = ofType("request.dispatched");
section("requests");
for (const record of dispatches) {
  const path = join(runDir, record.request?.path ?? "missing");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  log(
    `${record.stageId}/${record.visit}/${record.attempt} ${record.request?.path} sha256 ${record.request?.sha256} (file ${text === "" ? "missing" : sha256(text)})`,
  );
}
logged.add("requests");
const accepted = ofType("submission.accepted");
const reviews = accepted.filter((record) => record.stageId === "review");
section("accepted reviews");
for (const review of reviews) {
  const path = join(runDir, review.artifact.acceptedPath);
  log(`--- review ${review.visit}.${review.attempt} verdict ${review.verdict} (${path})`);
  log(existsSync(path) ? readFileSync(path, "utf8") : "(missing)");
}
logged.add("artifacts");
section("repository");
const slugifyPath = join(repo, "src", "slugify.mjs");
const slugify = existsSync(slugifyPath) ? readFileSync(slugifyPath, "utf8") : "";
log(`src/slugify.mjs:\n${slugify}`);
log(`git log --oneline:\n${sh("git", ["-C", repo, "log", "--oneline"]).stdout}`);
log(`git status --porcelain:\n${sh("git", ["-C", repo, "status", "--porcelain"]).stdout}`);
const nodeTest = sh(process.execPath, ["--test"], { cwd: repo });
log(
  `independent node --test: exit ${nodeTest.status}\n${nodeTest.stdout.split("\n").slice(-12).join("\n")}`,
);
const independent = await revisionOf(repo);
log(`independent revision: ${JSON.stringify(independent)}`);

// ---------------------------------------------------------------- gates
section("gates");
const blockedRecords = ofType("run.blocked");
const assignments = ofType("agent.assigned");
const assignmentOf = (agentId) => assignments.find((record) => record.agentId === agentId);
const planned = records[0]?.plan;

if (probe) {
  const submitted = (agentId) => accepted.some((record) => record.agentId === agentId);
  gate(
    "P1",
    "builder started and submitted",
    assignmentOf("builder") !== undefined && submitted("builder"),
  );
  gate(
    "P2",
    "reviewer started and submitted",
    assignmentOf("reviewer") !== undefined && submitted("reviewer"),
  );
  gate(
    "P3",
    "run terminated, not cancelled",
    snapshot?.outcome !== null && snapshot?.outcome?.outcome !== "cancelled",
    JSON.stringify(snapshot?.outcome),
  );
  const gone = await Promise.all(
    assignments.map(async (record) => {
      const observed = await herdr.observe({
        adapter: "herdr",
        runtimeName: record.runtime.runtimeName,
        kind: "claude",
        paneId: record.runtime.paneId,
        paneOwned: false,
        terminalId: record.terminalId ?? null,
        sessionId: record.sessionId ?? null,
      });
      return observed.ok && observed.value.lifecycle === "gone";
    }),
  );
  gate("P4", "agent panes closed", gone.length === 2 && gone.every(Boolean));
} else {
  let derived = null;
  if (snapshot !== null && snapshot.outcome !== null)
    derived = deriveRunResult(snapshot, { runDir, repository: repo });
  const sameResult =
    printed?.result !== undefined &&
    derived !== null &&
    JSON.stringify(JSON.parse(JSON.stringify(derived))) === JSON.stringify(printed.result);
  gate(
    1,
    "CLI exit 0, completed, limit null, result equals deriveRunResult(run show)",
    exitCode === 0 &&
      printed?.result?.outcome === "completed" &&
      printed?.result?.limit === null &&
      sameResult,
    `exit ${exitCode}, outcome ${printed?.result?.outcome}, limit ${printed?.result?.limit}, equal ${sameResult}`,
  );

  const agentArgsOk = ["builder", "reviewer"].every((agentId) => {
    const spec = planned?.agents?.find((item) => item.agentId === agentId);
    const args = spec?.args ?? [];
    const pair = (flag, value) =>
      args.some((item, index) => item === flag && args[index + 1] === value);
    return (
      spec?.kind === "claude" &&
      spec?.model === "sonnet" &&
      pair("--model", "sonnet") &&
      pair("--add-dir", runDir) &&
      pair("--permission-mode", "auto")
    );
  });
  gate(
    2,
    "journal replays; plan build-review@1 with claude/sonnet agents and resolved args",
    read.ok &&
      planned?.workflow?.name === "build-review" &&
      planned?.workflow?.version === "1" &&
      agentArgsOk,
    JSON.stringify(planned?.agents),
  );

  const replacements = snapshot?.counters?.replacementsByAgent ?? {};
  gate(
    3,
    "exactly one agent.assigned per agent",
    assignments.length === 2 && Object.keys(replacements).length === 0,
    `${assignments.length} assignments`,
  );

  const builderAssignment = assignmentOf("builder");
  const reviewerAssignment = assignmentOf("reviewer");
  const builderExpected = JSON.stringify([
    builderAssignment?.runtime.paneId ?? null,
    builderAssignment?.terminalId ?? null,
    builderAssignment?.sessionId ?? null,
  ]);
  const reviewerExpected = JSON.stringify([
    reviewerAssignment?.runtime.paneId ?? null,
    reviewerAssignment?.terminalId ?? null,
    reviewerAssignment?.sessionId ?? null,
  ]);
  const builderDispatches = dispatches.filter(
    (record) => record.stageId === "build" || record.stageId === "repair",
  );
  const reviewDispatches = dispatches.filter((record) => record.stageId === "review");
  gate(
    4,
    "identity continuity: builder and reviewer dispatches keep one pane, terminal and session each",
    builderDispatches.length > 0 &&
      builderDispatches.every(
        (record) => record.agentId === "builder" && identityOf(record) === builderExpected,
      ) &&
      reviewDispatches.length > 0 &&
      reviewDispatches.every(
        (record) => record.agentId === "reviewer" && identityOf(record) === reviewerExpected,
      ) &&
      nonNull(builderExpected) &&
      nonNull(reviewerExpected) &&
      builderAssignment?.sessionId !== reviewerAssignment?.sessionId,
    `builder ${builderExpected}, reviewer ${reviewerExpected}`,
  );

  const firstReview = reviews[0];
  const firstGate = ofType("gate.recorded").find(
    (record) => record.subject.acceptedSeq === firstReview?.seq,
  );
  const firstText =
    firstReview === undefined
      ? ""
      : readFileSync(join(runDir, firstReview.artifact.acceptedPath), "utf8");
  const terminations = ofType("run.terminated");
  gate(
    5,
    "first review is a completed fail that routes to repair and cites the nonce line",
    firstReview?.status === "completed" &&
      firstReview?.verdict === "fail" &&
      firstGate?.decision === "reject" &&
      firstGate?.next?.stageId === "repair" &&
      terminations.length === 1 &&
      records.at(-1)?.type === "run.terminated" &&
      firstText.includes(requiredLine),
    `verdict ${firstReview?.verdict}, gate ${firstGate?.decision} → ${JSON.stringify(firstGate?.next)}, cites line ${firstText.includes(requiredLine)}`,
  );

  const requestText = (record) => {
    const path = join(runDir, record.request?.path ?? "missing");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };
  const buildClean = dispatches
    .filter((record) => record.stageId === "build")
    .every((record) => !requestText(record).includes(nonce));
  const repairsOk = dispatches
    .filter((record) => record.stageId === "repair")
    .every((record) => {
      const text = requestText(record);
      const latestReview = reviews.findLast((review) => review.seq < record.seq);
      if (latestReview === undefined) return false;
      return (
        text.includes(join(runDir, latestReview.artifact.acceptedPath)) &&
        text.includes(latestReview.receiptId) &&
        text.includes(latestReview.artifact.sha256) &&
        !text.includes(nonce)
      );
    });
  const hashesOk = dispatches.every(
    (record) => sha256(requestText(record)) === record.request?.sha256,
  );
  gate(
    6,
    "build requests lack the nonce; repair requests carry the latest review by path, receipt and sha only; request hashes match",
    buildClean && repairsOk && hashesOk && dispatches.some((record) => record.stageId === "repair"),
    `build clean ${buildClean}, repairs ${repairsOk}, hashes ${hashesOk}`,
  );

  const lastReview = reviews.at(-1);
  const gatesRecorded = ofType("gate.recorded");
  const lastGate = gatesRecorded.find((record) => record.subject.acceptedSeq === lastReview?.seq);
  const builderGate = gatesRecorded.findLast(
    (record) => record.kind === "stage" && (record.gate === "build" || record.gate === "repair"),
  );
  const tree = independent.ok ? independent.revision.tree : null;
  gate(
    7,
    "last review passes on the exact repaired tree",
    lastReview?.verdict === "pass" &&
      lastGate?.decision === "pass" &&
      lastGate?.next?.outcome === "completed" &&
      lastGate?.round === snapshot?.counters?.rounds &&
      (lastGate?.round ?? 0) >= 2 &&
      lastGate?.reviewed?.tree === lastGate?.revision?.tree &&
      lastGate?.revision?.tree === builderGate?.revision?.tree &&
      builderGate?.revision?.tree === tree,
    `round ${lastGate?.round}, reviewed ${lastGate?.reviewed?.tree}, gate ${lastGate?.revision?.tree}, builder ${builderGate?.revision?.tree}, independent ${tree}`,
  );

  gate(
    8,
    "repository effects: nonce line, tests exist, node --test passes",
    slugify.startsWith(requiredLine) &&
      existsSync(join(repo, "test", "slugify.test.mjs")) &&
      nodeTest.status === 0,
    `first line ${JSON.stringify(slugify.split("\n")[0])}, node --test exit ${nodeTest.status}`,
  );

  const abandoned = ofType("delivery.reconciled").filter(
    (record) => record.resolution === "abandoned",
  );
  gate(
    9,
    "verify-artifacts clean, no block, no ambiguous or abandoned delivery",
    snapshot?.status === "completed" &&
      Array.isArray(snapshot?.integrity?.artifacts?.altered) &&
      snapshot.integrity.artifacts.altered.length === 0 &&
      snapshot?.attention?.blocked === null &&
      snapshot?.attention?.ambiguousDeliveries?.length === 0 &&
      blockedRecords.length === 0 &&
      abandoned.length === 0,
    `status ${snapshot?.status}, altered ${JSON.stringify(snapshot?.integrity?.artifacts?.altered)}`,
  );

  // p4 G10: `working` without an open attempt within DEFAULT_GRACE_MS of that agent's
  // acceptance is the agent finishing its turn; `gone` with an open attempt always disagrees.
  const disagreement = observerDisagreements(samples, records, { graceMs: DEFAULT_GRACE_MS });
  for (const item of disagreement) log(`[observer] ${JSON.stringify(item)}`);
  gate(
    10,
    `observer agreement between Herdr samples and snapshots (grace ${DEFAULT_GRACE_MS} ms after acceptance)`,
    workingWhileActive(samples, "builder") &&
      workingWhileActive(samples, "reviewer") &&
      disagreement.length === 0,
    `${samples.length} samples, ${disagreement.length} disagreeing`,
  );

  const gone = await Promise.all(
    assignments.map(async (record) => {
      const observed = await herdr.observe({
        adapter: "herdr",
        runtimeName: record.runtime.runtimeName,
        kind: "claude",
        paneId: record.runtime.paneId,
        paneOwned: false,
        terminalId: record.terminalId ?? null,
        sessionId: record.sessionId ?? null,
      });
      return observed.ok ? observed.value.lifecycle : `error:${observed.error.code}`;
    }),
  );
  gate(
    11,
    "both agents are gone after exit",
    gone.length === 2 && gone.every((lifecycle) => lifecycle === "gone"),
    JSON.stringify(gone),
  );

  const worktreeStatusAfter = sh("git", ["-C", woofRoot, "status", "--porcelain"]).stdout;
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const forbidden = [
    ["agent", "read"],
    ["pane", "read"],
    ["send", "keys"],
  ].map((parts) => parts.join(parts[0] === "send" ? "-" : " "));
  const hits = forbidden.filter((needle) => source.includes(needle));
  log(
    `script source grep for ${forbidden.join(", ")}: ${hits.length === 0 ? "no matches" : hits.join(", ")}`,
  );
  gate(
    12,
    "Woof worktree unchanged; script never reads panes or sends keys",
    worktreeStatusAfter === worktreeStatusBefore && hits.length === 0,
    `worktree unchanged ${worktreeStatusAfter === worktreeStatusBefore}`,
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
  ];
  gate(
    13,
    "log records versions, input, command, trace, locations and result",
    needed.every((key) => logged.has(key)),
    needed.filter((key) => !logged.has(key)).join(", ") || "all recorded",
  );

  section("human inspection (required)");
  log(
    "Read both reviews above: review 1 must cite the missing nonce line and be a real review of the slugify change;",
  );
  log(
    "review 2 must state the checklist is satisfied; confirm the repaired code is the builder's own change.",
  );
}

const failed = gates.filter((item) => !item.pass);
section("summary");
log(
  `${gates.length - failed.length}/${gates.length} gates passed${failed.length > 0 ? `; failed: ${failed.map((item) => item.id).join(", ")}` : ""}`,
);
if (blockedRecords.length > 0) {
  log("the journal holds run.blocked: nothing was auto-approved");
  process.exit(4);
}
process.exit(failed.length === 0 ? 0 : 1);
