#!/usr/bin/env node
// Live acceptance for pi as the second agent kind (p8a). Run inside a Herdr
// pane after `bun run build`:
//
//   node scripts/live/pi-build-review.mjs --fixture-only
//   node scripts/live/pi-build-review.mjs --probe
//   node scripts/live/pi-build-review.mjs 2>&1 | tee docs/research/pi-build-review-live.log
//
// Not part of `bun run verify`: it starts real agents in real Herdr panes and
// spends real provider tokens, so a person runs it.
//
// It is a sibling of build-review.mjs, not a flag on it. That script's header
// records incident LV-101: changing its fixture behaviour silently deleted what
// the later live checks depend on. This one owns a separate phase directory and
// a separate fixture repository and never touches p3's.
//
// FIXTURE RULE (inherited from LV-101). Every invocation -- with or without
// --fixture-only -- deletes and re-initializes the fixture repository at one
// fixed path, so a plain run is also a re-init.
//
// --probe is the cheap check and does not run a workflow: it splits a pane,
// starts one pi agent through `herdr agent start --kind pi`, confirms Woof
// observes it ready, sends one prompt, and has pi complete one `woof submit`
// round-trip from its own shell, then stops the pane. Run it before the full
// run; a failed probe is cheap and a failed full run is not.
//
// The full run is build-review with a pi builder and a claude reviewer.
//
// PRECONDITIONS.
//  - claude (the reviewer): Claude Code asks a folder-trust question for a
//    directory it has never seen, which blocks agent startup and which Woof
//    never answers. The operator must have trusted the fixed fixture path once:
//      mkdir -p ~/.herdr-dev/runs/herdr-woof/p8a-pi-agent-kind/live/fixture-repo
//      cd ~/.herdr-dev/runs/herdr-woof/p8a-pi-agent-kind/live/fixture-repo && claude
//    answer the folder-trust question, then exit.
//  - pi (the builder): no precondition is expected here, and this script records
//    the facts rather than assuming them. pi asks a trust question only when the
//    project has trust-requiring resources and no saved decision; its
//    trust-manager treats the user-global ~/.agents/skills directory as an
//    always-trusted user resource and ignores it. The fixture has no .pi/, so a
//    pi agent started there reaches no trust question. Woof adds no pi trust
//    pre-flight; a project that does carry .pi/ is a known limit (see
//    docs/design/agent-kinds.md).
//
// Exit 0 when every gate passes, 1 when one fails or a precondition fails, 4
// when the journal holds run.blocked (nothing is auto-approved).
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const woofRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cliPath = join(woofRoot, "dist", "cli.js");
if (!existsSync(cliPath)) {
  console.error("dist/cli.js is missing; run bun run build first");
  process.exit(1);
}
const load = (rel) => import(pathToFileURL(join(woofRoot, "dist", rel)).href);
const sdk = await load("index.js");
const { createHerdrCliRuntime, herdrRuntimeName, readEvents, readJournal } = sdk;

const probe = process.argv.includes("--probe");
const fixtureOnly = process.argv.includes("--fixture-only");
const phaseDir = join(homedir(), ".herdr-dev", "runs", "herdr-woof", "p8a-pi-agent-kind");
const probeLog = join(phaseDir, "live-probe.log");
// The one fixture path the operator trusts in Claude Code; see the header.
const fixtureRepo = join(phaseDir, "live", "fixture-repo");
const trustPrecondition = `the operator must have trusted ${fixtureRepo} in Claude Code once (open \`claude\` there and answer its folder-trust question); Woof never does this.`;
const logged = new Set();

// D5: always provider/id, never the bare defaultModel, which drifts with
// ~/.pi/agent/settings.json. --model is not restricted to enabledModels.
const PI_MODEL = process.env["WOOF_LIVE_PI_MODEL"] ?? "openai-codex/gpt-5.6-sol";
const PI_PROVIDER = PI_MODEL.split("/")[0];

function log(line = "", key = undefined) {
  console.log(line);
  if (probe) appendFileSync(probeLog, `${line}\n`);
  if (key !== undefined) logged.add(key);
}

function section(title) {
  log();
  log(`=== ${title} ===`);
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
const gates = [];
function gate(id, title, pass, evidence) {
  gates.push({ id, title, pass });
  log(
    `${pass ? "PASS" : "FAIL"} gate ${id}: ${title}${evidence === undefined ? "" : ` (${evidence})`}`,
  );
}

if (probe) mkdirSync(phaseDir, { recursive: true });
section(probe ? "Woof p8a live probe: pi agent kind" : "Woof p8a live acceptance: pi build-review");
const worktreeStatusBefore = sh("git", ["-C", woofRoot, "status", "--porcelain"]).stdout;
log(`date: ${new Date().toISOString()}`);
log(`HERDR_ENV=${process.env["HERDR_ENV"] ?? "(unset)"}`);
log(`HERDR_PANE_ID=${process.env["HERDR_PANE_ID"] ?? "(unset)"}`);
log(`herdr --version: ${sh("herdr", ["--version"]).stdout}`, "herdr");
log(`claude --version: ${sh("claude", ["--version"]).stdout}`, "claude");
log(`pi --version: ${sh("pi", ["--version"]).stdout}`, "pi");
log(`node --version: ${process.version}`, "node");
log(`git --version: ${sh("git", ["--version"]).stdout}`, "git");
log(`woof commit: ${sh("git", ["-C", woofRoot, "rev-parse", "HEAD"]).stdout}`, "commit");
log(`woof worktree status --porcelain:\n${worktreeStatusBefore || "(clean)"}`);

// Recorded pi preconditions: facts, not assumptions.
section("pi preconditions (recorded, not assumed)");
const authCheck = sh("pi", ["auth", "check", "--provider", PI_PROVIDER, "--json", "--no-refresh"]);
log(`pi model (provider/id): ${PI_MODEL}`, "pi-model");
log(
  `pi auth check --provider ${PI_PROVIDER} --json --no-refresh: ${authCheck.stdout || authCheck.stderr}`,
  "pi-auth",
);
const piTrustJson = join(homedir(), ".pi", "agent", "trust.json");
log(`~/.pi/agent/trust.json exists: ${existsSync(piTrustJson)}`, "pi-trust-file");
log(`~/.agents/skills exists: ${existsSync(join(homedir(), ".agents", "skills"))}`);
log("reason no pi trust question is expected: pi's trust manager treats the user-global");
log("~/.agents/skills directory as an always-trusted user resource and ignores it when deciding");
log("whether a project has trust-requiring resources; the fixture below has no .pi/ of its own.");
log(`precondition (claude reviewer): ${trustPrecondition}`);
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
const runId = `${probe ? "live-pi-probe" : "live-pi-br"}-${stamp}`;
const requiredLine = `// woof-acceptance: ${nonce}`;
// Re-initialize the fixed fixture repository from scratch; the run directory is per stamp, outside it.
rmSync(repo, { recursive: true, force: true });
mkdirSync(join(repo, "src"), { recursive: true });
mkdirSync(live, { recursive: true });
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
    { cwd: repo },
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
writeFileSync(join(repo, "README.md"), "Fixture for Woof p8a pi live acceptance.\n");
// No .woof/roles here on purpose: the pi builder comes from the input's agents
// map, which shadows any configured role, so this check does not depend on
// fixture role files. The fixture also carries no .pi/, which is the condition
// under which pi asks no trust question.
gitAs("add", "-A");
gitAs("commit", "-q", "-m", "fixture");

section("fixture");
log(`live root: ${live}`);
log(`repo (fixed, re-initialized): ${repo}`);
log(`run dir: ${runDir}`);
const fixtureListing = sh("ls", ["-a"], { cwd: repo }).stdout;
log(`ls -a ${repo}:\n${fixtureListing}`, "fixture-listing");
log(`fixture has .pi/: ${existsSync(join(repo, ".pi"))}`, "fixture-no-pi");
if (fixtureOnly) {
  const status = sh("git", ["-C", repo, "status", "--porcelain"]).stdout;
  log(`fixture status --porcelain: ${status || "(clean)"}`);
  console.log(repo);
  process.exit(status === "" ? 0 : 1);
}

// ---------------------------------------------------------------- probe
if (probe) {
  const adapter = createHerdrCliRuntime({ bin: "herdr", env: process.env });
  const runtimeName = herdrRuntimeName(runId, "builder");
  const agentId = "builder";
  const stageId = "build";
  mkdirSync(runDir, { recursive: true });

  let handle;
  let stopped = false;
  async function stopAgent(label) {
    if (handle === undefined || stopped) return;
    const result = await adapter.stop(handle, { timeoutMs: 15_000 });
    stopped = result.ok;
    log(`${label}: ${JSON.stringify(result)}`);
  }
  process.on("SIGINT", () => {
    void stopAgent("stop (interrupted)").finally(() => process.exit(130));
  });

  section("probe: start a pi agent");
  const pane = await adapter.openPane({ near: "current", cwd: repo, direction: "down" });
  log(`openPane: ${JSON.stringify(pane)}`);
  if (!pane.ok) {
    log("openPane failed");
    process.exit(1);
  }
  // Exactly what the engine's launch table produces for pi: the model and
  // nothing else. pi has no directory sandbox, so no run-directory grant.
  const launchArgs = ["--model", PI_MODEL];
  log(`herdr agent start ${runtimeName} --kind pi ... -- ${launchArgs.join(" ")}`, "command");
  const started = await adapter.startAgent({
    runtimeName,
    kind: "pi",
    paneId: pane.value.paneId,
    paneOwned: true,
    args: launchArgs,
    timeoutMs: 180_000,
  });
  log(`startAgent: ${JSON.stringify(started)}`, "start");
  if (!started.ok) {
    log("startAgent failed: a pi agent did not reach a detected state");
    gate("P1", "pi agent starts through herdr agent start --kind pi", false, started.error?.code);
    log("PROBE FAIL");
    process.exit(1);
  }
  handle = started.value;
  const before = await adapter.observe(handle);
  log(`observe (before): ${JSON.stringify(before)}`, "observe");
  gate(
    "P1",
    "pi agent starts through herdr agent start --kind pi and Woof observes it",
    started.ok && before.ok && before.value.lifecycle !== "gone",
    `lifecycle ${before.ok ? before.value.lifecycle : "unobserved"}`,
  );
  gate(
    "P2",
    "no pi trust question blocked startup",
    before.ok && before.value.lifecycle !== "blocked",
    `lifecycle ${before.ok ? before.value.lifecycle : "unobserved"}`,
  );

  // One woof submit round-trip, driven by pi's own shell.
  section("probe: one woof submit round-trip");
  const opened = woof(
    "attempt",
    "open",
    "--run-dir",
    runDir,
    "--run",
    runId,
    "--agent",
    agentId,
    "--stage",
    stageId,
    "--visit",
    "1",
    "--attempt",
    "1",
    "--verdicts",
    "pass,fail",
  );
  log(`woof attempt open: exit ${opened.status} ${opened.stdout}`, "attempt");
  const artifactRel = `artifacts/${stageId}/visit-1/attempt-1/report.md`;
  const envelopeRel = "outbox/envelope.json";
  const prompt = [
    `You are completing one submission round-trip for a test harness. Do exactly these steps in ${runDir} and nothing else.`,
    `1. Write the file ${join(runDir, artifactRel)} containing exactly this single line: ${requiredLine}`,
    `2. Compute its sha256 with: shasum -a 256 ${join(runDir, artifactRel)}`,
    `3. Write the file ${join(runDir, envelopeRel)} containing this JSON, with SHA replaced by the hex digest from step 2:`,
    JSON.stringify({
      schemaVersion: 1,
      runId,
      agentId,
      stageId,
      visit: 1,
      attempt: 1,
      status: "completed",
      verdict: "pass",
      artifact: { path: artifactRel, sha256: "SHA" },
    }),
    `4. Run exactly this command and report its output: ${process.execPath} ${cliPath} submit --run-dir ${runDir} --envelope ${join(runDir, envelopeRel)}`,
    `Then stop. Do not modify anything else.`,
  ].join("\n");
  const delivered = await adapter.deliver(handle, prompt, { timeoutMs: 120_000 });
  log(`deliver: ${JSON.stringify(delivered)}`, "deliver");

  const deadline = Date.now() + 600_000;
  let acceptedRecord;
  while (Date.now() < deadline) {
    const read = readJournal(runDir);
    if (read.ok) {
      acceptedRecord = read.records.find((record) => record.type === "submission.accepted");
      if (acceptedRecord !== undefined) break;
    }
    const observed = await adapter.observe(handle);
    if (observed.ok && observed.value.lifecycle === "gone") break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  const artifactPath = join(runDir, artifactRel);
  const artifactText = existsSync(artifactPath) ? readFileSync(artifactPath, "utf8") : "";
  section("probe: journal");
  const finalRead = readJournal(runDir);
  for (const record of finalRead.ok ? finalRead.records : []) {
    log(`${record.seq} ${record.type}${record.reason === undefined ? "" : ` ${record.reason}`}`);
  }
  logged.add("journal");
  const events = readEvents(runDir);
  for (const event of events.ok ? events.events : []) {
    log(`event ${event.seq} ${event.type} ${JSON.stringify(event.subject)}`);
  }

  // deliver reports outcome, not ok: "started" means the prompt reached the agent
  // and it began working. "ambiguous" is never treated as delivered.
  gate(
    "P3",
    "pi received the prompt and started working",
    delivered.outcome === "started" && delivered.observation?.lifecycle === "working",
    delivered.outcome === "started"
      ? `lifecycle ${delivered.observation?.lifecycle}`
      : `${delivered.outcome}: ${JSON.stringify(delivered.error)}`,
  );
  gate(
    "P4",
    "pi wrote the artifact from its own shell",
    artifactText.includes(requiredLine),
    `artifact ${artifactText === "" ? "missing" : `${artifactText.trim().length} bytes`}`,
  );
  gate(
    "P5",
    "woof submit accepted pi's envelope and the digest matches the file on disk",
    acceptedRecord !== undefined &&
      acceptedRecord.artifact?.sha256 === sha256(artifactText) &&
      artifactText !== "",
    acceptedRecord === undefined
      ? "no submission.accepted in the journal"
      : `receipt ${acceptedRecord.receiptId}`,
  );

  await stopAgent("stop");
  const after = await adapter.observe(handle);
  log(`observe (after): ${JSON.stringify(after)}`);
  gate("P6", "the pane this probe opened is closed", after.ok && after.value.lifecycle === "gone");

  const failedProbe = gates.filter((item) => !item.pass);
  section("summary");
  log(
    `${gates.length - failedProbe.length}/${gates.length} gates passed${failedProbe.length > 0 ? `; failed: ${failedProbe.map((item) => item.id).join(", ")}` : ""}`,
  );
  log(`probe log: ${probeLog}`);
  log(failedProbe.length === 0 ? "PROBE PASS" : "PROBE FAIL");
  process.exit(failedProbe.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------- full run
// The pi builder goes in the input's agents map, which shadows any configured
// role. Never --add-dir (pi has no such flag and would reject it) and never
// --approve (it would trip permission_bypass_configured and is unnecessary
// here: the fixture raises no trust question).
const builder = { kind: "pi", model: PI_MODEL, args: [] };
const reviewer = { kind: "claude", model: "sonnet", args: ["--permission-mode", "auto"] };
const input = {
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
  agents: { builder, reviewer },
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
log(`nonce: ${nonce}`);
log(`input (${inputPath}):\n${readFileSync(inputPath, "utf8")}`, "input");

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

let startupBlockReported = false;
async function sample() {
  const shown = woof("run", "show", runDir);
  if (shown.status !== 0) return;
  const snapshot = JSON.parse(shown.stdout).snapshot;
  const block = snapshot.attention?.blocked;
  if (block?.reason === "startup_blocked" && !startupBlockReported) {
    startupBlockReported = true;
    log(`[sample] startup blocked for ${block.agentId}: ${JSON.stringify(block)}`);
  }
  log(
    `[sample] ${new Date().toISOString()} stage ${snapshot.current?.stageId ?? "(none)"} agents ${snapshot.agents
      .map((item) => `${item.agentId}:${item.lifecycle ?? "?"}`)
      .join(" ")}`,
  );
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
section("event trace");
const events = readEvents(runDir);
for (const event of events.ok ? events.events : []) {
  log(`${event.seq} ${event.type} ${JSON.stringify(event.subject)}`);
}
logged.add("events");
const ofType = (type) => records.filter((record) => record.type === type);
const accepted = ofType("submission.accepted");
const reviews = accepted.filter((record) => record.stageId === "review");
section("accepted reviews");
for (const review of reviews) {
  const path = join(runDir, review.artifact.acceptedPath);
  log(`--- review ${review.visit}.${review.attempt} verdict ${review.verdict} (${path})`);
  log(existsSync(path) ? readFileSync(path, "utf8") : "(missing)");
}
logged.add("artifacts");
section("recorded configuration");
const configPath = join(runDir, "config.json");
const recordedConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : null;
log(JSON.stringify(recordedConfig?.agents ?? null, null, 2), "config");
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

// ---------------------------------------------------------------- gates
section("gates");
const blockedRecords = ofType("run.blocked");
const assignments = ofType("agent.assigned");
const assignmentOf = (agentId) => assignments.find((record) => record.agentId === agentId);
const planned = records[0]?.plan;
const plannedOf = (agentId) => planned?.agents?.find((item) => item.agentId === agentId);

gate(
  1,
  "CLI exit 0, the run completed and the snapshot agrees",
  exitCode === 0 &&
    printed?.result?.outcome === "completed" &&
    printed?.result?.limit === null &&
    snapshot?.outcome?.outcome === "completed",
  `exit ${exitCode}, outcome ${printed?.result?.outcome}, limit ${printed?.result?.limit}, snapshot ${JSON.stringify(snapshot?.outcome)}`,
);

const plannedBuilder = plannedOf("builder");
const builderArgs = plannedBuilder?.args ?? [];
gate(
  2,
  "the plan's builder is pi with the model and no run-directory grant",
  plannedBuilder?.kind === "pi" &&
    plannedBuilder?.model === PI_MODEL &&
    JSON.stringify(builderArgs) === JSON.stringify(["--model", PI_MODEL]),
  JSON.stringify(plannedBuilder),
);

const plannedReviewer = plannedOf("reviewer");
const reviewerArgs = plannedReviewer?.args ?? [];
const pair = (args, flag, value) =>
  args.some((item, index) => item === flag && args[index + 1] === value);
gate(
  3,
  "the plan's reviewer is still claude and still gets --add-dir",
  plannedReviewer?.kind === "claude" &&
    pair(reviewerArgs, "--model", "sonnet") &&
    pair(reviewerArgs, "--add-dir", runDir),
  JSON.stringify(plannedReviewer),
);

gate(
  4,
  "config.json records builder.kind pi with source input",
  recordedConfig?.agents?.builder?.value?.kind === "pi" &&
    recordedConfig?.agents?.builder?.source === "input",
  JSON.stringify(recordedConfig?.agents?.builder),
);

const builderAccepted = accepted.filter((record) => record.agentId === "builder");
gate(
  5,
  "the pi builder started, was dispatched and produced an accepted artifact through woof submit",
  assignmentOf("builder") !== undefined && builderAccepted.length > 0,
  `${builderAccepted.length} accepted submissions from builder`,
);

const firstReview = reviews[0];
gate(
  6,
  "the claude reviewer reviewed the pi builder's work through the same envelope contract",
  assignmentOf("reviewer") !== undefined &&
    firstReview?.status === "completed" &&
    (firstReview?.verdict === "pass" || firstReview?.verdict === "fail"),
  `first review verdict ${firstReview?.verdict}`,
);

gate(
  7,
  "the fixture repository carries the builder's change and its tests pass independently",
  slugify !== "" && !slugify.includes("not implemented") && nodeTest.status === 0,
  `node --test exit ${nodeTest.status}`,
);

const needed = [
  "herdr",
  "claude",
  "pi",
  "node",
  "git",
  "commit",
  "pi-model",
  "pi-auth",
  "pi-trust-file",
  "fixture-listing",
  "fixture-no-pi",
  "input",
  "command",
  "samples",
  "events",
  "artifacts",
  "config",
  "result",
];
gate(
  8,
  "log records versions, pi preconditions, input, command, trace and result",
  needed.every((key) => logged.has(key)),
  needed.filter((key) => !logged.has(key)).join(", ") || "all recorded",
);

section("human inspection (required)");
log("Confirm the accepted build artifact is pi's own work and the review is a real review of it.");

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
