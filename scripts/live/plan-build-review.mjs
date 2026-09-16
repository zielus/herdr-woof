#!/usr/bin/env node
// Live acceptance for the built-in plan-build-review workflow (p5 §6, L-PBR).
// Run inside a Herdr pane after `bun run build`, and after the fixture has been
// re-initialized once by `node scripts/live/build-review.mjs --fixture-only
// --with-roles` (which writes the planner role and the external workflow into
// the fixture's single commit):
//
//   node scripts/live/plan-build-review.mjs 2>&1 | tee <rundir>/live/plan-build-review-live.log
//
// It writes the input, runs the real `woof run start --workflow
// plan-build-review --host foreground` CLI with three Claude agents, samples
// `woof run show` and Herdr agent status every 5 s, then prints the evidence and
// a PASS/FAIL line per hard gate. It never reads pane text and never sends keys.
// Exit 0 when every gate passes, 1 when one fails, 4 when the journal holds
// run.blocked.
//
// The gate numbering mirrors scripts/live/build-review.mjs so the acceptance
// matrix can name the same ids in both logs. Gate 6 is the one this phase
// exists for: the planner's plan.md reaches the builder and every repair as a
// resolved input, by path, receipt and sha256, and is never inlined.
//
// It does NOT re-initialize the fixture: only the verifier does that, exactly
// once, at the start of the live gate. Running it here would destroy an
// in-flight run on the shared fixture.
//
// FIXTURE RULE (p5 repair LV-101): `scripts/live/build-review.mjs` deletes and
// re-initializes the shared fixture on **every** invocation, not only with
// --fixture-only, and re-commits `.woof/roles/*` and `.woof/workflows/scribe.mjs`
// every time (that writer is the default since LV-101; --no-roles opts out). This
// script never re-initializes the fixture: it reads what is there and refuses to
// start if the work tree is dirty or the configuration it needs is missing.
//
// Operator precondition: the fixed fixture path
// ~/.herdr-dev/runs/herdr-woof/p3-build-review-loop/live/fixture-repo must have
// been trusted in Claude Code once; Woof never answers a folder-trust question.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const phaseDir = join(homedir(), ".herdr-dev", "runs", "herdr-woof", "p3-build-review-loop");
const fixtureRepo = join(phaseDir, "live", "fixture-repo");
const trustPrecondition = `the operator must have trusted ${fixtureRepo} in Claude Code once (open \`claude\` there and answer its folder-trust question); Woof never does this.`;
const logged = new Set();
const AGENTS = ["planner", "builder", "reviewer"];

function log(line = "") {
  console.log(line);
}
function record(key) {
  logged.add(key);
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
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const woof = (...args) => sh(process.execPath, [cliPath, ...args]);
const identityOf = (item) =>
  JSON.stringify([
    item.paneId ?? null,
    item.target?.terminalId ?? null,
    item.target?.sessionId ?? null,
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
section("Woof p5 live acceptance: plan-build-review");
const worktreeStatusBefore = sh("git", ["-C", woofRoot, "status", "--porcelain"]).stdout;
log(`date: ${new Date().toISOString()}`);
log(`HERDR_ENV=${process.env["HERDR_ENV"] ?? "(unset)"}`);
log(`HERDR_PANE_ID=${process.env["HERDR_PANE_ID"] ?? "(unset)"}`);
log(`herdr --version: ${sh("herdr", ["--version"]).stdout}`);
record("herdr");
log(`claude --version: ${sh("claude", ["--version"]).stdout}`);
record("claude");
log(`node --version: ${process.version}`);
record("node");
log(`git --version: ${sh("git", ["--version"]).stdout}`);
record("git");
log(`woof commit: ${sh("git", ["-C", woofRoot, "rev-parse", "HEAD"]).stdout}`);
record("commit");
log(`woof worktree status --porcelain:\n${worktreeStatusBefore || "(clean)"}`);
log(`precondition: ${trustPrecondition}`);
if (process.env["HERDR_ENV"] !== "1" || (process.env["HERDR_PANE_ID"] ?? "") === "") {
  log("precondition failed: run this inside a Herdr pane (HERDR_ENV=1, HERDR_PANE_ID)");
  process.exit(1);
}
if (!existsSync(join(fixtureRepo, ".git"))) {
  log(
    `precondition failed: ${fixtureRepo} is not initialized; run node scripts/live/build-review.mjs --fixture-only --with-roles once first`,
  );
  process.exit(1);
}
const fixtureStatus = sh("git", ["-C", fixtureRepo, "status", "--porcelain"]).stdout;
if (fixtureStatus !== "") {
  log(`precondition failed: the fixture work tree is dirty:\n${fixtureStatus}`);
  log("another run may be in flight; never run two at once on the shared fixture");
  process.exit(1);
}
for (const role of AGENTS) {
  if (!existsSync(join(fixtureRepo, ".woof", "roles", `${role}.json`))) {
    log(
      `precondition failed: .woof/roles/${role}.json is missing; re-run --fixture-only --with-roles`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------- input
const stamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace("T", "-").slice(0, 15);
const live = join(phaseDir, "live", `pbr-${stamp}`);
const repo = fixtureRepo;
const runDir = join(live, "run");
const inputPath = join(live, "input.json");
const nonce = randomBytes(6).toString("hex");
const runId = `live-pbr-${stamp}`;
const requiredLine = `// woof-acceptance: ${nonce}`;
mkdirSync(live, { recursive: true });

const input = {
  schemaVersion: 1,
  repo,
  task: {
    title: "Implement titleCase",
    description:
      "Implement `titleCase(text)` in `src/title-case.mjs`: each word's first letter uppercased, the rest lowercased, words separated by single spaces. Add tests in `test/title-case.test.mjs` using `node:test`.",
    acceptanceCriteria: [
      "titleCase uppercases the first letter of every word",
      "the rest of every word is lowercased",
      "runs of whitespace collapse to one space, with no leading or trailing space",
      "tests pass with `node --test`",
    ],
  },
  constraints: [
    "Change only files under `src/` and `test/`.",
    "Add no dependencies: `node:test` and the standard library only.",
  ],
  instructions: {
    reviewer: `Project convention (review checklist item): every module under \`src/\` must begin with the exact line \`${requiredLine}\`. Treat a missing or different line as a blocking finding, and quote the exact required line in your review. Review against the task, the acceptance criteria and this checklist; do not invent other requirements.`,
  },
  verify: { command: ["node", "--test"], timeoutMs: 120_000 },
  limits: {
    maxAttemptsPerVisit: 2,
    maxVisitsPerStage: 3,
    maxRounds: 2,
    maxFormatRepairs: 2,
    runTimeoutMs: 3_600_000,
    readinessWaitMs: 180_000,
    blockedWaitMs: 180_000,
    deliveryTimeoutMs: 60_000,
  },
};
writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);
section("fixture");
log(`live root: ${live}`);
log(`repo (fixed, not re-initialized by this script): ${repo}`);
log(`run dir: ${runDir}`);
log(`nonce: ${nonce}`);
log(`created under ~/.woof/runs: (none; --run-dir is used)`);
// The agents come from the fixture's own .woof/roles/*.json, not from the input:
// an input that names no agents is exactly the p4 resolution path under test.
log(
  `configuration: ${woof("config", "show", "--project", repo, "--workflow", "plan-build-review").stdout}`,
);
log(`input (${inputPath}):\n${readFileSync(inputPath, "utf8")}`);
record("input");

// ---------------------------------------------------------------- run
const cliArgs = [
  "run",
  "start",
  "--workflow",
  "plan-build-review",
  "--host",
  "foreground",
  "--project",
  repo,
  "--input",
  inputPath,
  "--run-dir",
  runDir,
  "--run-id",
  runId,
];
section("run");
log(`command: ${process.execPath} ${cliPath} ${cliArgs.join(" ")}`);
record("command");
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
record("samples");

// ---------------------------------------------------------------- evidence
section("result");
log(`cli exit code: ${exitCode}`);
log(`stdout: ${stdout.trim()}`);
record("result");
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
record("events");
const ofType = (type) => records.filter((item) => item.type === type);
const dispatches = ofType("request.dispatched");
const requestText = (item) => {
  const path = join(runDir, item.request?.path ?? "missing");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};
section("requests");
for (const item of dispatches) {
  const text = requestText(item);
  log(
    `${item.stageId}/${item.visit}/${item.attempt} ${item.request?.path} sha256 ${item.request?.sha256} (file ${text === "" ? "missing" : sha256(text)})`,
  );
}
record("requests");
const accepted = ofType("submission.accepted");
const plans = accepted.filter((item) => item.stageId === "plan");
const reviews = accepted.filter((item) => item.stageId === "review");
section("accepted plan");
for (const item of plans) {
  const path = join(runDir, item.artifact.acceptedPath);
  log(`--- plan ${item.visit}.${item.attempt} (${path})`);
  log(existsSync(path) ? readFileSync(path, "utf8") : "(missing)");
}
section("accepted reviews");
for (const review of reviews) {
  const path = join(runDir, review.artifact.acceptedPath);
  log(`--- review ${review.visit}.${review.attempt} verdict ${review.verdict} (${path})`);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "(missing)";
  log(text);
  // p5 D5: the opt-in marker is a request, not a requirement. Whether a real
  // reviewer actually leads with it decides whether the contract is dead weight,
  // so the log records it either way.
  log(
    `[verdict marker] review ${review.visit}.${review.attempt}: first line ${JSON.stringify(
      text.split("\n").find((line) => line.trim() !== "") ?? "",
    )}`,
  );
}
record("artifacts");
section("repository");
const modulePath = join(repo, "src", "title-case.mjs");
const moduleText = existsSync(modulePath) ? readFileSync(modulePath, "utf8") : "";
log(`src/title-case.mjs:\n${moduleText}`);
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
const assignmentOf = (agentId) => assignments.find((item) => item.agentId === agentId);
const planned = records[0]?.plan;
const gatesRecorded = ofType("gate.recorded");

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

// The input names no agents: every role resolves from the fixture's .woof/roles.
const agentArgsOk = AGENTS.every((agentId) => {
  const spec = planned?.agents?.find((item) => item.agentId === agentId);
  const args = spec?.args ?? [];
  const pair = (flag, value) =>
    args.some((item, index) => item === flag && args[index + 1] === value);
  return (
    spec?.role === agentId &&
    spec?.kind === "claude" &&
    spec?.model === "sonnet" &&
    pair("--model", "sonnet") &&
    pair("--add-dir", runDir) &&
    pair("--permission-mode", "auto")
  );
});
gate(
  2,
  "journal replays; plan plan-build-review@1 with three claude/sonnet agents resolved from configuration",
  read.ok &&
    planned?.workflow?.name === "plan-build-review" &&
    planned?.workflow?.version === "1" &&
    planned?.agents?.length === 3 &&
    agentArgsOk,
  JSON.stringify(planned?.agents),
);

const replacements = snapshot?.counters?.replacementsByAgent ?? {};
gate(
  3,
  "exactly one agent.assigned per agent, three distinct panes",
  assignments.length === 3 &&
    Object.keys(replacements).length === 0 &&
    new Set(assignments.map((item) => item.runtime.paneId)).size === 3,
  `${assignments.length} assignments, panes ${JSON.stringify(assignments.map((item) => item.runtime.paneId))}`,
);

const expectedIdentity = Object.fromEntries(
  AGENTS.map((agentId) => {
    const assignment = assignmentOf(agentId);
    return [
      agentId,
      JSON.stringify([
        assignment?.runtime.paneId ?? null,
        assignment?.terminalId ?? null,
        assignment?.sessionId ?? null,
      ]),
    ];
  }),
);
const stagesOf = { planner: ["plan"], builder: ["build", "repair"], reviewer: ["review"] };
const continuity = AGENTS.every((agentId) => {
  const own = dispatches.filter((item) => stagesOf[agentId].includes(item.stageId));
  return (
    own.length > 0 &&
    own.every(
      (item) => item.agentId === agentId && identityOf(item) === expectedIdentity[agentId],
    ) &&
    nonNull(expectedIdentity[agentId])
  );
});
const distinctSessions =
  new Set(AGENTS.map((agentId) => assignmentOf(agentId)?.sessionId)).size === 3;
gate(
  4,
  "identity continuity: each of planner, builder and reviewer keeps one pane, terminal and session",
  continuity && distinctSessions,
  AGENTS.map((agentId) => `${agentId} ${expectedIdentity[agentId]}`).join(", "),
);

const firstReview = reviews[0];
const firstGate = gatesRecorded.find((item) => item.subject.acceptedSeq === firstReview?.seq);
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

// The gate this phase exists for.
const acceptedPlan = plans[0];
const planPath = acceptedPlan === undefined ? "" : join(runDir, acceptedPlan.artifact.acceptedPath);
const planBody = existsSync(planPath) ? readFileSync(planPath, "utf8") : "";
// A distinctive line of the plan itself: if the engine ever inlined the plan,
// the builder's request would contain it.
const planLine =
  planBody
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 40)
    .toSorted((a, b) => b.length - a.length)[0] ?? "";
const builderDispatches = dispatches.filter(
  (item) => item.stageId === "build" || item.stageId === "repair",
);
const planCarried = builderDispatches.every((item) => {
  const text = requestText(item);
  return (
    acceptedPlan !== undefined &&
    text.includes(planPath) &&
    text.includes(acceptedPlan.receiptId) &&
    text.includes(acceptedPlan.artifact.sha256) &&
    (planLine === "" || !text.includes(planLine))
  );
});
const repairsCarryReview = dispatches
  .filter((item) => item.stageId === "repair")
  .every((item) => {
    const text = requestText(item);
    const latestReview = reviews.findLast((review) => review.seq < item.seq);
    if (latestReview === undefined) return false;
    return (
      text.includes(join(runDir, latestReview.artifact.acceptedPath)) &&
      text.includes(latestReview.receiptId) &&
      text.includes(latestReview.artifact.sha256)
    );
  });
const hashesOk = dispatches.every((item) => sha256(requestText(item)) === item.request?.sha256);
gate(
  6,
  "every builder request carries the accepted plan by path, receipt and sha256 and never inlines it; repairs also carry the latest review; request hashes match",
  builderDispatches.length >= 2 &&
    planCarried &&
    repairsCarryReview &&
    hashesOk &&
    dispatches.some((item) => item.stageId === "repair"),
  `builder requests ${builderDispatches.length}, plan carried ${planCarried}, reviews ${repairsCarryReview}, hashes ${hashesOk}, plan line probed ${JSON.stringify(planLine.slice(0, 60))}`,
);

const lastReview = reviews.at(-1);
const lastGate = gatesRecorded.find((item) => item.subject.acceptedSeq === lastReview?.seq);
const builderGate = gatesRecorded.findLast(
  (item) => item.kind === "stage" && (item.gate === "build" || item.gate === "repair"),
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
  moduleText.startsWith(requiredLine) &&
    existsSync(join(repo, "test", "title-case.test.mjs")) &&
    nodeTest.status === 0,
  `first line ${JSON.stringify(moduleText.split("\n")[0])}, node --test exit ${nodeTest.status}`,
);

const abandoned = ofType("delivery.reconciled").filter((item) => item.resolution === "abandoned");
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

const disagreement = observerDisagreements(samples, records, { graceMs: DEFAULT_GRACE_MS });
for (const item of disagreement) log(`[observer] ${JSON.stringify(item)}`);
gate(
  10,
  `observer agreement between Herdr samples and snapshots (grace ${DEFAULT_GRACE_MS} ms after acceptance)`,
  AGENTS.every((agentId) => workingWhileActive(samples, agentId)) && disagreement.length === 0,
  `${samples.length} samples, ${disagreement.length} disagreeing`,
);

const gone = await Promise.all(
  assignments.map(async (item) => {
    const observed = await herdr.observe({
      adapter: "herdr",
      runtimeName: item.runtime.runtimeName,
      kind: "claude",
      paneId: item.runtime.paneId,
      paneOwned: false,
      terminalId: item.terminalId ?? null,
      sessionId: item.sessionId ?? null,
    });
    return observed.ok ? observed.value.lifecycle : `error:${observed.error.code}`;
  }),
);
gate(
  11,
  "all three agents are gone after exit",
  gone.length === 3 && gone.every((lifecycle) => lifecycle === "gone"),
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
  "samples",
];
gate(
  13,
  "log records versions, input, command, trace, locations and result",
  needed.every((key) => logged.has(key)),
  needed.filter((key) => !logged.has(key)).join(", ") || "all recorded",
);

section("human inspection (required)");
log(
  "Read the accepted plan above: it must be a real, file-level plan for THIS task, not a restatement",
);
log(
  "of the acceptance criteria. Read both reviews: review 1 must cite the missing nonce line and be a",
);
log(
  "real review of the titleCase change; review 2 must state the checklist is satisfied. Confirm the",
);
log(
  "repaired code is the builder's own change, and that the builder followed the plan it was given.",
);
log(
  "Record in live/INDEX.md whether each review's first line was the Woof-Verdict marker (p5 D5).",
);

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
