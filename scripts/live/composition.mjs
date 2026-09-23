#!/usr/bin/env node
// Live acceptance for checkout policy and workflow composition
// (docs/design/composition.md, phase 4). Run inside a Herdr pane after `bun run build`:
//
//   node scripts/live/composition.mjs 2>&1 | tee docs/research/composition-live.log
//   node scripts/live/composition.mjs --keep     # keep both runs' worktrees afterwards
//
// It re-initializes the fixture repository with `scripts/live/build-review.mjs
// --fixture-only` (roles claude/sonnet with `--permission-mode auto`, committed), then:
//
// 1. starts the built-in `auto-build` through the real `woof run start` (herdr-pane host)
//    with `checkout: {mode: "worktree"}`: the launcher creates a Herdr worktree and hosts the
//    run in its workspace's root pane; the run plans (publishing the plan on the branch) and
//    builds and reviews with real Claude agents, each in a child run;
// 2. samples `woof status` and Herdr (`pane get` of every assigned agent pane) every 5 s;
// 3. checks the gates below from the journals, artifacts, the worktree and Herdr;
// 4. starts a second `auto-build`, waits until its planner has its task, cancels the parent
//    with `woof run cancel`, and checks that the child was cancelled with it;
// 5. removes both runs' worktrees (Herdr keeps the branches) unless --keep.
//
// It never reads pane text and never sends keys. Exit 0 when every gate passes, 1 otherwise,
// 4 when a journal holds run.blocked (nothing is auto-approved).
//
// Operator precondition (as for build-review.mjs): Claude Code must trust the fixture
// repository ~/.herdr-dev/runs/herdr-woof/p3-build-review-loop/live/fixture-repo (open `claude`
// there once and answer its folder-trust question). The run's worktree is a Git worktree of
// that repository under ~/.herdr/worktrees/fixture-repo/; if Claude Code asks about trust
// there, the agents block at startup and the run reports `startup_blocked`: Woof never
// answers the question.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const woofRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cliPath = join(woofRoot, "dist", "cli.js");
if (!existsSync(cliPath)) {
  console.error("dist/cli.js is missing; run bun run build first");
  process.exit(1);
}
const load = (rel) => import(pathToFileURL(join(woofRoot, "dist", rel)).href);
const { foldEvents, readEvents, readJournal, readSnapshot } = await load("index.js");

const keep = process.argv.includes("--keep");
const phaseDir = join(homedir(), ".herdr-dev", "runs", "herdr-woof", "composition");
const RUN_TIMEOUT_MS = 3_600_000;
const logged = new Set();

function log(line = "", key = undefined) {
  console.log(line);
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
  };
}
const woof = (...args) => sh(process.execPath, [cliPath, ...args]);
const herdrJson = (...args) => {
  const result = sh("herdr", args);
  try {
    return result.status === 0 ? JSON.parse(result.stdout).result : null;
  } catch {
    return null;
  }
};
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const records = (runDir) => {
  const read = readJournal(runDir);
  return read.ok ? read.records : [];
};
const ofType = (list, type) => list.filter((record) => record.type === type);
const gates = [];
function gate(id, title, pass, evidence) {
  gates.push({ id, title, pass });
  log(
    `GATE ${id} ${pass ? "PASS" : "FAIL"}: ${title}${evidence === undefined ? "" : ` — ${evidence}`}`,
  );
}

// ---------------------------------------------------------------- preconditions
section("Woof live acceptance: checkout policy and workflow composition");
const worktreeStatusBefore = sh("git", ["-C", woofRoot, "status", "--porcelain"]).stdout;
log(`date: ${new Date().toISOString()}`);
log(
  `HERDR_ENV=${process.env["HERDR_ENV"] ?? "(unset)"} HERDR_PANE_ID=${process.env["HERDR_PANE_ID"] ?? "(unset)"}`,
);
log(`herdr --version: ${sh("herdr", ["--version"]).stdout}`, "herdr");
log(`claude --version: ${sh("claude", ["--version"]).stdout}`, "claude");
log(`node --version: ${process.version}`, "node");
log(`git --version: ${sh("git", ["--version"]).stdout}`, "git");
log(`woof commit: ${sh("git", ["-C", woofRoot, "rev-parse", "HEAD"]).stdout}`, "commit");
if (process.env["HERDR_ENV"] !== "1" || (process.env["HERDR_PANE_ID"] ?? "") === "") {
  log("precondition failed: run this inside a Herdr pane (HERDR_ENV=1, HERDR_PANE_ID)");
  process.exit(1);
}

// ---------------------------------------------------------------- fixture
section("fixture");
const fixture = sh(process.execPath, [
  join(woofRoot, "scripts", "live", "build-review.mjs"),
  "--fixture-only",
]);
const repo = fixture.stdout.split("\n").at(-1) ?? "";
log(`build-review.mjs --fixture-only exit ${fixture.status}: ${repo}`);
if (fixture.status !== 0 || !existsSync(join(repo, ".git"))) {
  log(fixture.stdout);
  log(fixture.stderr);
  process.exit(1);
}
log(`fixture HEAD: ${sh("git", ["-C", repo, "log", "--oneline", "-1"]).stdout}`);
const stamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace("T", "-").slice(0, 15);
const live = join(phaseDir, stamp);
const runsDir = join(live, "runs");
mkdirSync(runsDir, { recursive: true });
const task = {
  title: "Implement slugify",
  description:
    "Implement `slugify(text)` in `src/slugify.mjs`: lowercase; runs of characters other than a–z and 0–9 become one hyphen; no leading or trailing hyphens. Add tests in `test/slugify.test.mjs` using `node:test`.",
  acceptanceCriteria: [
    "slugify lowercases its input",
    "runs of characters other than a–z and 0–9 become one hyphen",
    "the result has no leading or trailing hyphens",
    "tests pass with `node --test`",
  ],
};
const planPath = "docs/plans/slugify.md";
const inputOf = (runId) => ({
  schemaVersion: 1,
  repo,
  task,
  verify: { command: ["node", "--test"], timeoutMs: 120_000 },
  publish: { path: planPath },
  limits: { runTimeoutMs: RUN_TIMEOUT_MS },
  checkout: { mode: "worktree", branch: `woof/${runId}` },
});

/** `woof run start --workflow auto-build` with the herdr-pane host; the started output. */
function start(runId) {
  const inputPath = join(live, `${runId}.json`);
  writeFileSync(inputPath, `${JSON.stringify(inputOf(runId), null, 2)}\n`);
  const args = [
    "run",
    "start",
    "--workflow",
    "auto-build",
    "--project",
    repo,
    "--input",
    inputPath,
    "--runs-dir",
    runsDir,
    "--run-id",
    runId,
  ];
  log(`command: ${process.execPath} ${cliPath} ${args.join(" ")}`, "command");
  log(`input (${inputPath}):\n${readFileSync(inputPath, "utf8")}`, "input");
  const started = woof(...args);
  log(`start exit ${started.status}: ${started.stdout}`);
  if (started.stderr !== "") log(`start stderr: ${started.stderr}`);
  try {
    return { code: started.status, output: JSON.parse(started.stdout.split("\n").at(-1) ?? "{}") };
  } catch {
    return { code: started.status, output: {} };
  }
}

// ---------------------------------------------------------------- run 1: auto-build to its end
section("run 1: auto-build in a new worktree");
const runId = `live-ab-${stamp}`;
const parentDir = join(runsDir, runId);
const planDir = join(runsDir, `${runId}.plan.1`);
const buildDir = join(runsDir, `${runId}.build.1`);
const first = start(runId);
const checkout = first.output["checkout"] ?? null;
const samples = [];
/** Herdr's own workspace of every agent pane a child run assigned, seen while it was open. */
const agentWorkspaces = new Map();
let blockedReported = false;
const deadline = Date.now() + RUN_TIMEOUT_MS + 120_000;
while (first.code === 0 && Date.now() < deadline) {
  const status = woof("status", parentDir);
  let view = null;
  try {
    view = JSON.parse(status.stdout).status;
  } catch {
    view = null;
  }
  const row = { at: new Date().toISOString(), parent: view?.status ?? "unreadable", children: {} };
  for (const dir of [planDir, buildDir]) {
    const read = readSnapshot(dir);
    if (!read.ok) continue;
    const snapshot = read.snapshot;
    row.children[snapshot.runId] = snapshot.status;
    if (snapshot.attention.blocked !== null && !blockedReported) {
      blockedReported = true;
      log(`[blocked] ${snapshot.runId}: ${JSON.stringify(snapshot.attention.blocked)}`);
    }
    for (const agent of snapshot.agents) {
      const paneId = agent.assignment?.paneId;
      if (paneId === undefined || agentWorkspaces.has(`${snapshot.runId}/${agent.agentId}`))
        continue;
      const pane = herdrJson("pane", "get", paneId);
      if (pane?.pane?.workspace_id !== undefined)
        agentWorkspaces.set(`${snapshot.runId}/${agent.agentId}`, {
          paneId,
          tabId: agent.assignment.tabId,
          workspaceId: pane.pane.workspace_id,
        });
    }
  }
  samples.push(row);
  log(
    `[sample] ${row.at} parent=${row.parent} ${Object.entries(row.children)
      .map(([id, value]) => `${id}=${value}`)
      .join(" ")}`,
  );
  if (["completed", "failed", "exhausted", "cancelled"].includes(row.parent)) break;
  // Sampling is sequential by design.
  // oxlint-disable-next-line no-await-in-loop
  await delay(5000);
}
logged.add("samples");
// The host writes its exit record once the run has ended.
for (let wait = 0; wait < 60 && !existsSync(join(parentDir, "host-exit.json")); wait += 1)
  // oxlint-disable-next-line no-await-in-loop
  await delay(1000);

// ---------------------------------------------------------------- evidence
section("parent status and runs");
log(woof("status", parentDir, "--pretty").stdout);
const runsListing = JSON.parse(woof("runs", "--runs-dir", runsDir).stdout || "{}");
log(
  JSON.stringify(
    runsListing.runs?.map((entry) => ({
      runId: entry.runId,
      status: entry.status,
      parent: entry.parent ?? null,
    })),
  ),
);
section("parent run view");
log(woof("watch", parentDir, "--ascii").stdout);
for (const dir of [planDir, buildDir]) {
  section(`child run view: ${dir}`);
  log(woof("watch", dir, "--ascii").stdout);
}
section("event traces");
for (const dir of [parentDir, planDir, buildDir]) {
  const events = readEvents(dir, { limit: 10_000 });
  for (const event of events.ok ? events.events : [])
    log(`${dir.split("/").at(-1)} ${event.seq} ${event.type} ${JSON.stringify(event.subject)}`);
}
logged.add("events");
const parent = records(parentDir);
const planRecords = records(planDir);
const buildRecords = records(buildDir);
const worktreePath = checkout?.path ?? "";
section("worktree");
log(`checkout: ${JSON.stringify(checkout)}`);
log(`git worktree list (fixture):\n${sh("git", ["-C", repo, "worktree", "list"]).stdout}`);
log(
  `git log (worktree):\n${sh("git", ["-C", worktreePath, "log", "--oneline", "--stat", "-5"]).stdout}`,
);
log(
  `git status --porcelain (worktree):\n${sh("git", ["-C", worktreePath, "status", "--porcelain"]).stdout || "(clean)"}`,
);
const nodeTest = sh(process.execPath, ["--test"], { cwd: worktreePath });
log(`independent node --test in the worktree: exit ${nodeTest.status}`);
section("plan and requests");
const planAccepted = ofType(planRecords, "submission.accepted").findLast(
  (record) => record.stageId === "plan",
);
const planBytes =
  planAccepted === undefined
    ? Buffer.alloc(0)
    : readFileSync(join(planDir, planAccepted.artifact.acceptedPath));
log(
  `accepted plan.md (${planAccepted?.artifact.acceptedPath}):\n${planBytes.toString("utf8")}`,
  "artifacts",
);
const buildDispatches = ofType(buildRecords, "request.dispatched");
for (const record of buildDispatches)
  log(
    `${record.stageId}/${record.visit}/${record.attempt} ${record.request?.path} sha256 ${record.request?.sha256}`,
  );
logged.add("requests");
for (const review of ofType(buildRecords, "submission.accepted").filter(
  (record) => record.stageId === "review",
)) {
  log(`--- review ${review.visit}.${review.attempt} verdict ${review.verdict}`);
  log(readFileSync(join(buildDir, review.artifact.acceptedPath), "utf8"));
}
section("agent workspaces seen while open");
for (const [key, value] of agentWorkspaces) log(`${key}: ${JSON.stringify(value)}`);

// ---------------------------------------------------------------- gates (run 1)
section("gates");
const opened = parent[0] ?? {};
const hostPane = first.output["host"]?.paneId ?? null;
// Herdr's own answer for the host's pane (it outlives the host process).
const hostWorkspace =
  typeof hostPane === "string"
    ? (herdrJson("pane", "get", hostPane)?.pane?.workspace_id ?? null)
    : null;
gate(
  1,
  "the launcher created a Herdr worktree on woof/<runId> and hosted the run in its workspace's root pane",
  first.code === 0 &&
    checkout?.mode === "worktree" &&
    checkout?.created === true &&
    checkout?.branch === `woof/${runId}` &&
    checkout?.source === repo &&
    existsSync(join(worktreePath, ".git")) &&
    sh("git", ["-C", repo, "worktree", "list"]).stdout.includes(worktreePath) &&
    typeof hostPane === "string" &&
    hostWorkspace === checkout?.workspaceId &&
    ofType(parent, "host.claimed")[0]?.workspaceId === checkout?.workspaceId &&
    JSON.stringify(opened.checkout) === JSON.stringify(checkout),
  `host pane ${hostPane} in workspace ${hostWorkspace}, checkout workspace ${checkout?.workspaceId}, path ${worktreePath}`,
);
const terminated = ofType(parent, "run.terminated")[0];
gate(
  2,
  "auto-build completed (plan step, then build step)",
  terminated?.outcome === "completed" &&
    ofType(parent, "gate.recorded")
      .map((record) => `${record.gate}:${record.reason}`)
      .join(",") === "plan:planned,build:built",
  JSON.stringify(terminated),
);
const listed = new Map((runsListing.runs ?? []).map((entry) => [entry.runId, entry]));
gate(
  3,
  "the child runs are ordinary runs, listed and linked both ways",
  listed.get(`${runId}.plan.1`)?.parent?.runId === runId &&
    listed.get(`${runId}.build.1`)?.parent?.stageId === "build" &&
    planRecords[0]?.parent?.runId === runId &&
    buildRecords[0]?.parent?.stageId === "build" &&
    ofType(parent, "stage.child_opened")
      .map((record) => record.child.runDir)
      .join(",") === `${planDir},${buildDir}` &&
    ofType(parent, "stage.child_result").every((record) => record.verdict === "completed"),
  `${ofType(parent, "stage.child_opened").length} opened, ${ofType(parent, "stage.child_result").length} results`,
);
const childAssignments = [
  ...ofType(planRecords, "agent.assigned"),
  ...ofType(buildRecords, "agent.assigned"),
];
const workspacesSeen = [...agentWorkspaces.values()].map((value) => value.workspaceId);
gate(
  4,
  "every agent tab of both children opened in the worktree's workspace (Herdr pane get while open)",
  childAssignments.length >= 3 &&
    agentWorkspaces.size === childAssignments.length &&
    workspacesSeen.every((id) => id === checkout?.workspaceId) &&
    childAssignments.every((record) => typeof record.tabId === "string"),
  `${childAssignments.length} assignments, workspaces ${JSON.stringify(workspacesSeen)}`,
);
const buildInput = existsSync(join(buildDir, "input.json"))
  ? JSON.parse(readFileSync(join(buildDir, "input.json"), "utf8"))
  : {};
const copied = join(buildDir, "inputs", "1", "plan.md");
const planLine = `- plan: ${copied} (run input artifact, sha256 ${sha256(planBytes)})`;
const requestsCarryPlan =
  buildDispatches.length > 0 &&
  buildDispatches.every((record) =>
    readFileSync(join(buildDir, record.request.path), "utf8").includes(planLine),
  );
gate(
  5,
  "the accepted plan.md flows by digest into build-review: its input, its run copy and every request",
  planBytes.byteLength > 0 &&
    buildInput.inputs?.[0]?.sha256 === sha256(planBytes) &&
    existsSync(copied) &&
    sha256(readFileSync(copied)) === sha256(planBytes) &&
    buildRecords[0]?.inputArtifacts?.[0]?.sha256 === sha256(planBytes) &&
    requestsCarryPlan,
  `plan sha256 ${sha256(planBytes)}, ${buildDispatches.length} requests carry it ${requestsCarryPlan}`,
);
const branchLog = sh("git", [
  "-C",
  worktreePath,
  "log",
  "--format=%s",
  `${checkout?.branch ?? "HEAD"}`,
]).stdout.split("\n");
const planCommitted =
  sh("git", ["-C", worktreePath, "cat-file", "-e", `${checkout?.branch ?? "HEAD"}:${planPath}`])
    .status === 0;
const slugCommitted =
  sh("git", ["-C", worktreePath, "cat-file", "-e", `${checkout?.branch ?? "HEAD"}:src/slugify.mjs`])
    .status === 0;
const worktreeClean = sh("git", ["-C", worktreePath, "status", "--porcelain"]).stdout === "";
gate(
  6,
  "the plan and the reviewed change are committed on the worktree branch, and its tests pass",
  planCommitted && slugCommitted && worktreeClean && branchLog.length >= 3 && nodeTest.status === 0,
  `commits ${JSON.stringify(branchLog.slice(0, 5))}, clean ${worktreeClean}, node --test ${nodeTest.status}`,
);
const inherited = [planRecords[0]?.checkout, buildRecords[0]?.checkout];
gate(
  7,
  "both children worked in the parent's checkout (inherited), none created its own",
  inherited.every(
    (value) =>
      value?.inherited === true && value?.path === worktreePath && value?.created === false,
  ),
  JSON.stringify(inherited),
);
const foldOk = [parentDir, planDir, buildDir].map((dir) => {
  const events = readEvents(dir, { limit: 10_000 });
  const read = readSnapshot(dir);
  if (!events.ok || !read.ok) return false;
  const folded = foldEvents(null, events.events);
  if (!folded.ok) return false;
  const { liveness: _a, ...projected } = folded.projection.snapshot;
  const { liveness: _b, ...fresh } = read.snapshot;
  return JSON.stringify(projected) === JSON.stringify(fresh);
});
gate(
  8,
  "journals consistent: foldEvents == readSnapshot for parent and both children",
  foldOk.every(Boolean),
  JSON.stringify(foldOk),
);
gate(
  9,
  "the parent read as running while its children ran",
  samples.some(
    (row) => row.parent === "running" && Object.values(row.children).includes("running"),
  ),
  `${samples.length} samples`,
);
const blocked = [parent, planRecords, buildRecords].some(
  (list) => ofType(list, "run.blocked").length > 0,
);

// ---------------------------------------------------------------- run 2: cancel propagation
section("run 2: cancelling the parent cancels its running child");
const cancelId = `live-abc-${stamp}`;
const cancelDir = join(runsDir, cancelId);
const cancelChild = join(runsDir, `${cancelId}.plan.1`);
const second = start(cancelId);
let childDispatched = false;
for (let wait = 0; wait < 120 && second.code === 0; wait += 1) {
  const read = readSnapshot(cancelChild);
  childDispatched = read.ok && read.snapshot.counters.dispatches.started > 0;
  if (childDispatched) break;
  // oxlint-disable-next-line no-await-in-loop
  await delay(2000);
}
const cancel = woof("run", "cancel", cancelDir);
log(`woof run cancel exit ${cancel.status}: ${cancel.stdout}`);
for (let wait = 0; wait < 90 && !existsSync(join(cancelDir, "host-exit.json")); wait += 1)
  // oxlint-disable-next-line no-await-in-loop
  await delay(1000);
const cancelled = ofType(records(cancelDir), "run.terminated")[0];
const childEnd = ofType(records(cancelChild), "run.terminated")[0];
log(`parent end: ${JSON.stringify(cancelled)}; child end: ${JSON.stringify(childEnd)}`);
gate(
  10,
  "cancelling a running auto-build cancels its plan child, which records why, before the host exits",
  second.code === 0 &&
    childDispatched &&
    cancel.status === 0 &&
    cancelled?.outcome === "cancelled" &&
    childEnd?.outcome === "cancelled" &&
    childEnd?.reason === "parent run ended" &&
    ofType(records(cancelChild), "host.exited").length === 1,
  `dispatched before cancel ${childDispatched}`,
);

// ---------------------------------------------------------------- hygiene
const worktreeStatusAfter = sh("git", ["-C", woofRoot, "status", "--porcelain"]).stdout;
const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
const forbidden = [
  ["agent", "read"],
  ["pane", "read"],
  ["send", "keys"],
].map((parts) => parts.join(parts[0] === "send" ? "-" : " "));
const hits = forbidden.filter((needle) => source.includes(needle));
gate(
  11,
  "Woof worktree unchanged; the script never reads panes or sends keys",
  worktreeStatusAfter === worktreeStatusBefore && hits.length === 0,
  `hits ${JSON.stringify(hits)}`,
);
const needed = [
  "commit",
  "herdr",
  "claude",
  "node",
  "git",
  "input",
  "command",
  "samples",
  "events",
  "requests",
  "artifacts",
];
gate(
  12,
  "the log records versions, inputs, commands, traces and artifacts",
  needed.every((key) => logged.has(key)),
  needed.filter((key) => !logged.has(key)).join(", ") || "all recorded",
);

// ---------------------------------------------------------------- cleanup
section("cleanup");
for (const started of [first, second]) {
  const created = started.output["checkout"];
  if (created?.created !== true) continue;
  if (keep) {
    log(
      `kept worktree ${created.path} (workspace ${created.workspaceId}, branch ${created.branch})`,
    );
    continue;
  }
  const removed = sh("herdr", [
    "worktree",
    "remove",
    "--workspace",
    created.workspaceId,
    "--force",
  ]);
  log(
    `herdr worktree remove --workspace ${created.workspaceId}: exit ${removed.status}; branch ${created.branch} stays in ${repo}`,
  );
}

const failed = gates.filter((item) => !item.pass);
section("summary");
log(
  `${gates.length - failed.length}/${gates.length} gates passed${failed.length > 0 ? `; failed: ${failed.map((item) => item.id).join(", ")}` : ""}`,
);
if (blocked) {
  log("a journal holds run.blocked: nothing was auto-approved");
  process.exit(4);
}
process.exit(failed.length === 0 ? 0 : 1);
