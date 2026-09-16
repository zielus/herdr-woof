#!/usr/bin/env node
// Live acceptance for the "Runtime loss" matrix row (p5 §6 step 5, carry-over
// C2; p5 repair PB-003). Run inside a Herdr pane after `bun run build`, and
// after the fixture has been initialized once by
// `node scripts/live/build-review.mjs --fixture-only`:
//
//   node scripts/live/runtime-loss.mjs 2>&1 | tee <rundir>/live/runtime-loss-live.log
//
// FIXTURE RULE (p5 repair LV-101): `scripts/live/build-review.mjs` deletes and
// re-initializes the shared fixture on **every** invocation, not only with
// --fixture-only, and re-commits `.woof/roles/*` and `.woof/workflows/scribe.mjs`
// every time (that writer is the default since LV-101; --no-roles opts out). This
// script never re-initializes the fixture: it reads what is there and refuses to
// start if the work tree is dirty or the configuration it needs is missing.
//
// The procedure, in order, each step a hard requirement of the one gate:
//
//   1. `woof run start --host herdr-pane` on the fixture; keep the host pid the
//      launcher prints.
//   2. wait for `request.dispatched` in the journal — the host must be doing
//      real work, not idling before its first dispatch.
//   3. wait for `journal.lock` to be absent, so the kill cannot land while the
//      host holds the lock (that is carry-over C1's separate, documented limit,
//      not this row).
//   4. `kill -9` the host.
//   5. `woof status` reports owner `lost`; `woof status --wait` exits 8.
//   6. `woof run cancel` exits 0 and records the cancellation.
//   7. no `host-exit.json`: a killed host records no clean exit.
//
// It prints `GATE L7 PASS` or `GATE L7 FAIL`, which is what the acceptance
// collector reads out of the committed log (`runtime-loss-live.log:L7`). It
// never reads pane text and never sends keys, and it kills exactly one pid: the
// one the launcher reported, refused unless it is a positive integer.
//
// Exit 0 when the gate passes, 1 when it fails.
//
// Operator precondition: the fixed fixture path
// ~/.herdr-dev/runs/herdr-woof/p3-build-review-loop/live/fixture-repo must have
// been trusted in Claude Code once; Woof never answers a folder-trust question.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const woofRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cliPath = join(woofRoot, "dist", "cli.js");
if (!existsSync(cliPath)) {
  console.error("dist/cli.js is missing; run bun run build first");
  process.exit(1);
}

const phaseDir = join(homedir(), ".herdr-dev", "runs", "herdr-woof", "p3-build-review-loop");
const fixtureRepo = join(phaseDir, "live", "fixture-repo");
const timeoutMs =
  Number(process.argv[process.argv.indexOf("--timeout-ms") + 1] ?? Number.NaN) || 600_000;

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const steps = [];
/** Records one step of the procedure; the gate passes only when every step did. */
function step(title, pass, evidence) {
  steps.push({ title, pass });
  log(`[step] ${pass ? "ok  " : "FAIL"} ${title}${evidence === undefined ? "" : ` — ${evidence}`}`);
  return pass;
}

// ---------------------------------------------------------------- preconditions
section("Woof p5 live acceptance: runtime loss (L7)");
log(`date: ${new Date().toISOString()}`);
log(`HERDR_ENV=${process.env["HERDR_ENV"] ?? "(unset)"}`);
log(`HERDR_PANE_ID=${process.env["HERDR_PANE_ID"] ?? "(unset)"}`);
log(`herdr --version: ${sh("herdr", ["--version"]).stdout}`);
log(`claude --version: ${sh("claude", ["--version"]).stdout}`);
log(`node --version: ${process.version}`);
log(`git --version: ${sh("git", ["--version"]).stdout}`);
log(`woof commit: ${sh("git", ["-C", woofRoot, "rev-parse", "HEAD"]).stdout}`);
const worktreeStatusBefore = sh("git", ["-C", woofRoot, "status", "--porcelain"]).stdout;
log(`woof worktree status --porcelain:\n${worktreeStatusBefore || "(clean)"}`);

function refuse(reason) {
  log(`precondition failed: ${reason}`);
  log("GATE L7 FAIL: runtime loss — precondition not met");
  process.exit(1);
}
if (process.env["HERDR_ENV"] !== "1" || (process.env["HERDR_PANE_ID"] ?? "") === "") {
  refuse("run this inside a Herdr pane (HERDR_ENV=1, HERDR_PANE_ID)");
}
if (!existsSync(join(fixtureRepo, ".git"))) {
  refuse(
    `${fixtureRepo} is not initialized; run node scripts/live/build-review.mjs --fixture-only once first`,
  );
}
const fixtureStatus = sh("git", ["-C", fixtureRepo, "status", "--porcelain"]).stdout;
if (fixtureStatus !== "") {
  refuse(
    `the fixture work tree is dirty:\n${fixtureStatus}\nanother run may be in flight; never run two at once on the shared fixture`,
  );
}

// ---------------------------------------------------------------- input
const stamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace("T", "-").slice(0, 15);
const live = join(phaseDir, "live", `l7-${stamp}`);
const runDir = join(live, "run");
const inputPath = join(live, "input.json");
const runId = `live-l7-${stamp}`;
mkdirSync(live, { recursive: true });
// A small build-review task: the point is a host doing real work when it dies,
// not the task. maxRounds 1 keeps the run short if it is ever left to finish.
const input = {
  schemaVersion: 1,
  repo: fixtureRepo,
  task: {
    title: "Implement reverseWords",
    description:
      "Implement `reverseWords(text)` in `src/reverse-words.mjs`: the words of `text` in reverse order, separated by single spaces.",
    acceptanceCriteria: ["reverseWords reverses the order of the words"],
  },
  limits: {
    maxAttemptsPerVisit: 1,
    maxVisitsPerStage: 1,
    maxRounds: 1,
    maxFormatRepairs: 1,
    runTimeoutMs: 1_800_000,
    readinessWaitMs: 180_000,
    blockedWaitMs: 180_000,
    deliveryTimeoutMs: 60_000,
  },
};
writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);
section("fixture");
log(`live root: ${live}`);
log(`repo (fixed, not re-initialized by this script): ${fixtureRepo}`);
log(`run dir: ${runDir}`);
log(`input (${inputPath}):\n${readFileSync(inputPath, "utf8")}`);

// ---------------------------------------------------------------- 1. start
const cliArgs = [
  "run",
  "start",
  "--input",
  inputPath,
  "--project",
  fixtureRepo,
  "--run-dir",
  runDir,
  "--run-id",
  runId,
  "--host",
  "herdr-pane",
];
section("run");
log(`command: ${process.execPath} ${cliPath} ${cliArgs.join(" ")}`);
const started = woof(...cliArgs);
log(`launcher exit ${started.status}`);
log(`launcher stdout: ${started.stdout}`);
if (started.stderr !== "") log(`launcher stderr: ${started.stderr}`);
let launched = null;
try {
  launched = JSON.parse(started.stdout.split("\n").at(-1) ?? "null");
} catch {
  launched = null;
}
const hostPid = launched?.host?.pid;
step(
  "1. run start --host herdr-pane reported a started run with a host pid",
  started.status === 0 &&
    launched?.outcome === "started" &&
    Number.isSafeInteger(hostPid) &&
    hostPid > 0,
  `exit ${started.status}, outcome ${launched?.outcome ?? "none"}, pane ${launched?.host?.paneId ?? "none"}, pid ${String(hostPid)}`,
);

const journalPath = join(runDir, "journal.jsonl");
const records = () =>
  existsSync(journalPath)
    ? readFileSync(journalPath, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
    : [];

async function waitFor(what, ready) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return true;
    // oxlint-disable-next-line no-await-in-loop
    await sleep(1000);
  }
  log(`[wait] ${what}: not satisfied within ${timeoutMs} ms`);
  return false;
}

// ---------------------------------------------------------------- 2–3. wait
const dispatched = await waitFor("request.dispatched", () =>
  records().some((record) => record.type === "request.dispatched"),
);
step(
  "2. the host dispatched work before the kill (not an idle host)",
  dispatched,
  `journal records ${records().length}, types ${JSON.stringify([...new Set(records().map((r) => r.type))])}`,
);
// The lock must be absent: killing a lock holder is carry-over C1's separate
// documented limit (manual `rm journal.lock`), not this row's claim.
const lockPath = join(runDir, "journal.lock");
const unlocked = await waitFor("journal.lock absent", () => !existsSync(lockPath));
step("3. journal.lock is absent, so the kill cannot orphan the lock", unlocked);

// ---------------------------------------------------------------- 4. kill
section("kill");
let killed = false;
if (!Number.isSafeInteger(hostPid) || hostPid <= 0) {
  log(`refusing to kill: the launcher reported no usable host pid (${String(hostPid)})`);
} else if (!dispatched || !unlocked) {
  log("refusing to kill: the run never reached the state this gate is about");
} else {
  const signalled = sh("kill", ["-9", String(hostPid)]);
  log(`kill -9 ${hostPid}: exit ${signalled.status} ${signalled.stderr}`);
  await sleep(2000);
  const alive = sh("ps", ["-p", String(hostPid)]).status === 0;
  killed = signalled.status === 0 && !alive;
  log(`ps -p ${hostPid} after the kill: ${alive ? "still present" : "gone"}`);
}
step("4. the host process was killed and is gone", killed, `pid ${String(hostPid)}`);

// ---------------------------------------------------------------- 5–7. observe
section("observation after the loss");
const shown = woof("status", runDir);
log(`woof status exit ${shown.status}: ${shown.stdout}`);
let status = null;
try {
  status = JSON.parse(shown.stdout.split("\n").at(-1) ?? "null");
} catch {
  status = null;
}
const owner = status?.status?.liveness?.owner ?? status?.liveness?.owner ?? null;
step("5a. woof status reports the owner as lost", owner === "lost", `owner ${String(owner)}`);

const waited = woof("status", runDir, "--wait", "--timeout-ms", "60000");
log(`woof status --wait exit ${waited.status}`);
step("5b. woof status --wait exits 8 (owner lost), not 7 (still running)", waited.status === 8);

const cancelled = woof("run", "cancel", runDir, "--reason", "L7 runtime-loss probe");
log(`woof run cancel exit ${cancelled.status}: ${cancelled.stdout}`);
let cancelJson = null;
try {
  cancelJson = JSON.parse(cancelled.stdout.split("\n").at(-1) ?? "null");
} catch {
  cancelJson = null;
}
const terminated = records().findLast((record) => record.type === "run.terminated");
step(
  "6. woof run cancel exits 0 and records the cancellation",
  cancelled.status === 0 &&
    cancelJson?.outcome === "recorded" &&
    terminated?.outcome === "cancelled",
  `exit ${cancelled.status}, outcome ${cancelJson?.outcome ?? "none"}, journal ${terminated?.type ?? "none"}/${terminated?.outcome ?? "none"}`,
);

const exitMarker = join(runDir, "host-exit.json");
step(
  "7. a killed host left no host-exit.json",
  !existsSync(exitMarker),
  existsSync(exitMarker) ? readFileSync(exitMarker, "utf8") : "absent",
);

// ---------------------------------------------------------------- gate
section("gate");
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
const worktreeStatusAfter = sh("git", ["-C", woofRoot, "status", "--porcelain"]).stdout;
log(`woof worktree unchanged: ${worktreeStatusAfter === worktreeStatusBefore}`);

const failed = steps.filter((item) => !item.pass);
const pass =
  failed.length === 0 && hits.length === 0 && worktreeStatusAfter === worktreeStatusBefore;
log(
  `GATE L7 ${pass ? "PASS" : "FAIL"}: runtime loss — the observer reports loss instead of claiming active work — ${steps.length - failed.length}/${steps.length} steps${failed.length > 0 ? `; failed: ${failed.map((item) => item.title).join("; ")}` : ""}`,
);
log("");
log(`run directory for operator cleanup: ${runDir}`);
log(
  "note: carry-over C1 (a stale journal.lock after a kill) is a separate documented limit; this probe waits for the lock to be absent before killing, so it never exercises it.",
);
process.exit(pass ? 0 : 1);
