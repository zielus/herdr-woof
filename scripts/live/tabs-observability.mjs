#!/usr/bin/env node
// Live acceptance for the hosted tab layout and the observability surface
// (one Herdr tab per participant, journaled tab ids, host lifecycle records,
// the run index, cross-run events and event reconnects). Run inside a Herdr
// pane after `bun run build`:
//
//   node scripts/live/tabs-observability.mjs --probe
//   node scripts/live/tabs-observability.mjs [--part A|B|C|all] [--evidence-dir <dir>]
//                                            [--timeout-ms <n>] [--keep-tabs]
//
// Part A  a real build-review run hosted in a Herdr tab (`woof run start --host
//         herdr-pane`, never foreground) on the deterministic fixture task of
//         scripts/live/build-review.mjs (review fail → repair → pass). Gates: the
//         tab layout as journaled and as Herdr lists it, the review loop, artifact
//         integrity, the repository effect, the run index (`woof runs`, `woof
//         status <runId>`, `woof events --all`) and the host lifecycle records.
// Part B  a second run whose host is killed (-9) once it dispatched work and the
//         journal lock is absent. Gates: owner lost, `--wait` exit 8, the index
//         still lists it, cancel journals host.lost → run.cancel_requested →
//         run.terminated{cancelled}, a late submit is refused, and the agent tabs
//         are cleaned up or reported.
// Part C  follows `woof events <runId> --follow` in a child process, kills it
//         mid-run, resumes with `--after <last cursor>` and checks that no seq is
//         missing, that a repeated seq carries identical content and that folding
//         the collected events (SDK `foldEvents`) equals `readSnapshot`. With Part
//         A selected it rides on Part A's run; alone it starts a short run.
//
// FIXTURE RULE: every part that starts a run first re-initializes the shared
// fixture by running `node scripts/live/build-review.mjs --fixture-only`, the one
// writer of that fixture. Never run two live scripts at once on it.
//
// Operator precondition: Claude Code asks a folder-trust question for a directory
// it has never seen, and that blocks agent startup. The operator must have trusted
// ~/.herdr-dev/runs/herdr-woof/p3-build-review-loop/live/fixture-repo in Claude
// Code once (open `claude` there and answer the question); Woof never does this.
// --probe reports what ~/.claude.json says about that path.
//
// State comes only from the journal, the Woof CLI/SDK and Herdr's JSON listings
// (`herdr tab list`, `herdr pane list`, `herdr pane get`). The script never reads
// pane text and never sends keys. It kills exactly one process per Part B: the
// pid in host.json, and only when `ps` shows it is that run's `woof run host`.
// It closes only tabs whose ids the journal (or the launcher's output) names.
//
// Every wait is bounded. Exit 0 when every gate passes, 1 when one fails (or a
// precondition is not met), 4 when a run's journal holds run.blocked.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { jsonForm } from "./lib/observer.mjs";

const woofRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cliPath = join(woofRoot, "dist", "cli.js");
const phaseDir = join(homedir(), ".herdr-dev", "runs", "herdr-woof", "p3-build-review-loop");
const fixtureRepo = join(phaseDir, "live", "fixture-repo");
const trustPrecondition = `the operator must have trusted ${fixtureRepo} in Claude Code once (open \`claude\` there and answer its folder-trust question); Woof never does this.`;

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
function option(name) {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}
const KNOWN = new Set(["--probe", "--part", "--evidence-dir", "--timeout-ms", "--keep-tabs"]);
for (const [index, arg] of argv.entries()) {
  const isValue =
    index > 0 && ["--part", "--evidence-dir", "--timeout-ms"].includes(argv[index - 1]);
  if (!isValue && !KNOWN.has(arg)) usage(`unknown argument ${arg}`);
}
const probe = flag("--probe");
const keepTabs = flag("--keep-tabs");
const partArg = (option("--part") ?? "all").toUpperCase();
if (!["A", "B", "C", "ALL"].includes(partArg)) usage(`--part must be A, B, C or all`);
const parts = new Set(partArg === "ALL" ? ["A", "B", "C"] : [partArg]);
/** Upper bound for one run to end, on top of which the script never waits. */
const runTimeoutMs = Number(option("--timeout-ms") ?? Number.NaN) || 3_000_000;
const evidenceDir = resolve(
  option("--evidence-dir") ?? mkdtempSync(join(tmpdir(), "woof-tabs-observability-")),
);
mkdirSync(evidenceDir, { recursive: true });
const logPath = join(evidenceDir, "log.txt");

function usage(problem) {
  console.error(problem);
  console.error(
    "Usage: node scripts/live/tabs-observability.mjs [--probe] [--part A|B|C|all] [--evidence-dir <dir>] [--timeout-ms <n>] [--keep-tabs]",
  );
  process.exit(1);
}

// ---------------------------------------------------------------- helpers
function log(line = "") {
  console.log(line);
  appendFileSync(logPath, `${line}\n`);
}
function section(title) {
  log("");
  log(`== ${title} ==`);
}
function sh(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error?.message ?? null,
  };
}
const woof = (...args) => sh(process.execPath, [cliPath, ...args], { cwd: woofRoot });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const stampNow = () =>
  new Date().toISOString().replaceAll(/[-:]/g, "").replace("T", "-").slice(0, 15);

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
const lastJsonLine = (text) => parseJson(text.split("\n").at(-1) ?? "");

/** Saves one piece of evidence under the evidence directory and returns its path. */
function evidence(rel, content) {
  const path = join(evidenceDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
  );
  return path;
}
/** Runs a Woof command, saves its output as evidence and returns it with its last JSON line. */
function woofSaved(rel, ...args) {
  const result = woof(...args);
  evidence(
    rel,
    `$ woof ${args.join(" ")}\nexit ${result.status}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}\n`,
  );
  return { ...result, json: lastJsonLine(result.stdout) };
}

const gates = [];
function gate(id, title, pass, detail) {
  gates.push({ id, title, pass: pass === true });
  log(
    `GATE ${id} ${pass === true ? "PASS" : "FAIL"}: ${title}${detail === undefined ? "" : ` — ${detail}`}`,
  );
}

async function waitFor(what, ready, timeoutMs, stepMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop
    if (await ready()) return true;
    // oxlint-disable-next-line no-await-in-loop
    await sleep(stepMs);
  }
  log(`[wait] ${what}: not satisfied within ${timeoutMs} ms`);
  return false;
}

/** Complete journal lines, parsed; a torn final line is skipped (a write in flight). */
function recordsOf(runDir) {
  const path = join(runDir, "journal.jsonl");
  if (!existsSync(path)) return [];
  const records = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line === "") continue;
    const record = parseJson(line);
    if (record !== null) records.push(record);
  }
  return records;
}
/** A snapshot in JSON form without `liveness`, the read-time probe a fold cannot know. */
function withoutLiveness(snapshot) {
  const { liveness: _liveness, ...rest } = jsonForm(snapshot);
  return rest;
}
/** The runtime identity a dispatch was sent to. */
const identity = (record) =>
  JSON.stringify([
    record.paneId ?? null,
    record.target?.terminalId ?? null,
    record.target?.sessionId ?? null,
  ]);
const ofType = (records, type) => records.filter((record) => record.type === type);
const terminatedIn = (records) => records.some((record) => record.type === "run.terminated");

// Herdr, JSON listings only.
function herdrJson(...args) {
  const result = sh("herdr", args);
  const parsed = result.status === 0 ? parseJson(result.stdout) : null;
  return {
    ok: parsed !== null && parsed.error === undefined,
    result: parsed?.result ?? null,
    raw: result,
  };
}
function listTabs() {
  const listed = herdrJson("tab", "list");
  return listed.ok && Array.isArray(listed.result?.tabs) ? listed.result.tabs : null;
}
function listPanes() {
  const listed = herdrJson("pane", "list");
  return listed.ok && Array.isArray(listed.result?.panes) ? listed.result.panes : null;
}

// ---------------------------------------------------------------- preconditions
section(probe ? "Woof tabs + observability: probe" : "Woof live acceptance: tabs + observability");
log(`date: ${new Date().toISOString()}`);
log(`evidence dir: ${evidenceDir}`);
log(`parts: ${[...parts].join(", ")}`);
log(`HERDR_ENV=${process.env["HERDR_ENV"] ?? "(unset)"}`);
log(`HERDR_PANE_ID=${process.env["HERDR_PANE_ID"] ?? "(unset)"}`);
const herdrVersion = sh("herdr", ["--version"]);
const claudeVersion = sh("claude", ["--version"]);
log(`herdr --version: ${herdrVersion.stdout || herdrVersion.error || "(none)"}`);
log(`claude --version: ${claudeVersion.stdout || claudeVersion.error || "(none)"}`);
log(`node --version: ${process.version}`);
log(`git --version: ${sh("git", ["--version"]).stdout}`);
log(`woof commit: ${sh("git", ["-C", woofRoot, "rev-parse", "HEAD"]).stdout}`);
const worktreeStatusBefore = sh("git", ["-C", woofRoot, "status", "--porcelain"]).stdout;
log(`woof worktree status --porcelain:\n${worktreeStatusBefore || "(clean)"}`);
log(`precondition: ${trustPrecondition}`);

const preconditions = [];
function precondition(title, pass, detail, { advisory = false } = {}) {
  preconditions.push({ title, pass, advisory });
  log(
    `[precondition] ${pass ? "ok  " : advisory ? "WARN" : "FAIL"} ${title}${detail === undefined ? "" : ` — ${detail}`}`,
  );
}
precondition(
  "inside a Herdr pane (HERDR_ENV=1 and HERDR_PANE_ID)",
  process.env["HERDR_ENV"] === "1" && (process.env["HERDR_PANE_ID"] ?? "") !== "",
);
precondition("herdr is on PATH", herdrVersion.status === 0, herdrVersion.error ?? undefined);
precondition("claude is on PATH", claudeVersion.status === 0, claudeVersion.error ?? undefined);
precondition("dist/cli.js is built (bun run build)", existsSync(cliPath));

let sdk = null;
if (existsSync(join(woofRoot, "dist", "index.js"))) {
  try {
    sdk = await import(pathToFileURL(join(woofRoot, "dist", "index.js")).href);
  } catch (error) {
    log(`dist/index.js failed to load: ${error.message}`);
  }
}
const sdkNeeds = ["foldEvents", "readSnapshot", "readJournal", "claudeTrustStatus"];
precondition(
  `dist/index.js exports ${sdkNeeds.join(", ")}`,
  sdk !== null && sdkNeeds.every((name) => typeof sdk[name] === "function"),
);
if (existsSync(cliPath)) {
  const help = sh(process.execPath, [cliPath, "runs", "--help"]);
  precondition(
    "the built CLI has the run index (woof runs)",
    /run index/.test(`${help.stdout}\n${help.stderr}`),
  );
}
if (herdrVersion.status === 0 && process.env["HERDR_ENV"] === "1") {
  const tabs = listTabs();
  const panes = listPanes();
  precondition(
    "herdr tab list and herdr pane list answer with JSON",
    tabs !== null && panes !== null,
    `${tabs?.length ?? "no"} tabs, ${panes?.length ?? "no"} panes`,
  );
  const own = herdrJson("pane", "get", process.env["HERDR_PANE_ID"] ?? "");
  precondition(
    "herdr pane get reports this pane's tab_id",
    typeof own.result?.pane?.tab_id === "string",
    `tab ${own.result?.pane?.tab_id ?? "unknown"}, workspace ${own.result?.pane?.workspace_id ?? "unknown"}`,
  );
}
if (sdk !== null && typeof sdk.claudeTrustStatus === "function") {
  const trust = sdk.claudeTrustStatus(fixtureRepo);
  precondition(
    `Claude Code folder trust for the fixture (${trust.path})`,
    trust.status === "trusted",
    trust.status === "trusted"
      ? "trusted"
      : `${trust.status}: ${existsSync(fixtureRepo) ? "" : `create it with node scripts/live/build-review.mjs --fixture-only, then `}open \`claude\` in ${fixtureRepo} once and accept the folder-trust question`,
    // Advisory: the file is Claude Code's own and its format is not a contract.
    { advisory: true },
  );
}
const unmet = preconditions.filter((item) => !item.pass && !item.advisory);
if (probe) {
  section("probe result");
  const warned = preconditions.filter((item) => !item.pass && item.advisory);
  log(
    unmet.length === 0
      ? `PROBE PASS: ${preconditions.length - warned.length}/${preconditions.length} preconditions met${warned.length > 0 ? `; advisory: ${warned.map((item) => item.title).join("; ")}` : ""}`
      : `PROBE FAIL: ${unmet.map((item) => item.title).join("; ")}`,
  );
  log("nothing was started: no fixture re-init, no tab, no agent");
  process.exit(unmet.length === 0 ? 0 : 1);
}
if (unmet.length > 0) {
  log(`precondition failed: ${unmet.map((item) => item.title).join("; ")}`);
  process.exit(1);
}
const { foldEvents, readSnapshot } = sdk;

// ---------------------------------------------------------------- fixture and input
const AGENT = { kind: "claude", model: "sonnet", args: ["--permission-mode", "auto"] };

/** Re-initializes the shared fixture through its one writer, scripts/live/build-review.mjs. */
function initFixture(tag) {
  const result = sh(
    process.execPath,
    [join(woofRoot, "scripts", "live", "build-review.mjs"), "--fixture-only"],
    {
      cwd: woofRoot,
    },
  );
  evidence(
    `${tag}/fixture-init.txt`,
    `exit ${result.status}\n${result.stdout}\n${result.stderr}\n`,
  );
  const path = result.stdout.split("\n").at(-1) ?? "";
  const clean = sh("git", ["-C", fixtureRepo, "status", "--porcelain"]).stdout === "";
  log(`[fixture] re-initialized ${path} (exit ${result.status}, clean ${clean})`);
  return result.status === 0 && resolve(path) === resolve(fixtureRepo) && clean;
}

/** The deterministic task of build-review.mjs: a reviewer-only convention forces fail → repair → pass. */
function repairLoopInput(requiredLine) {
  return {
    schemaVersion: 1,
    repo: fixtureRepo,
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
    agents: { builder: AGENT, reviewer: AGENT },
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
}

/** A small task: the point is a hosted run doing real work, not the task. */
function shortInput() {
  return {
    schemaVersion: 1,
    repo: fixtureRepo,
    task: {
      title: "Implement reverseWords",
      description:
        "Implement `reverseWords(text)` in `src/reverse-words.mjs`: the words of `text` in reverse order, separated by single spaces.",
      acceptanceCriteria: ["reverseWords reverses the order of the words"],
    },
    agents: { builder: AGENT, reviewer: AGENT },
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
}

/** Runs this script started; the exit path cancels what is still open and closes journaled tabs. */
const runs = [];

function startRun(tag, input) {
  const stamp = stampNow();
  const live = join(phaseDir, "live", `tabs-${tag.toLowerCase()}-${stamp}`);
  const run = {
    tag,
    runId: `live-tabs-${tag.toLowerCase()}-${stamp}`,
    runDir: join(live, "run"),
    inputPath: join(live, "input.json"),
    startedAt: new Date().toISOString(),
    launched: null,
    hostTabId: null,
  };
  mkdirSync(live, { recursive: true });
  writeFileSync(run.inputPath, `${JSON.stringify(input, null, 2)}\n`);
  copyFileSync(run.inputPath, evidence(`${tag}/input.json`, ""));
  const args = [
    "run",
    "start",
    "--workflow",
    "build-review",
    "--input",
    run.inputPath,
    "--project",
    fixtureRepo,
    "--run-dir",
    run.runDir,
    "--run-id",
    run.runId,
    "--host",
    "herdr-pane",
  ];
  log(`run id: ${run.runId}`);
  log(`run dir: ${run.runDir}`);
  log(`command: woof ${args.join(" ")}`);
  runs.push(run);
  const started = woofSaved(`${tag}/run-start.txt`, ...args);
  run.launched = started.json;
  run.hostTabId = started.json?.host?.tabId ?? null;
  log(`launcher exit ${started.status}: ${started.stdout.split("\n").at(-1) ?? ""}`);
  if (started.stderr !== "") log(`launcher stderr: ${started.stderr}`);
  const host = started.json?.host;
  run.started =
    started.status === 0 &&
    started.json?.outcome === "started" &&
    typeof host?.paneId === "string" &&
    typeof host?.tabId === "string" &&
    Number.isSafeInteger(host?.pid) &&
    host.pid > 0;
  return run;
}

/** Tab ids the journal (and the launcher) name for this run: the only tabs this script may close. */
function journaledTabs(run) {
  const records = recordsOf(run.runDir);
  const agents = ofType(records, "agent.assigned")
    .filter((record) => typeof record.tabId === "string")
    .map((record) => ({ agentId: record.agentId, tabId: record.tabId }));
  const host = ofType(records, "host.claimed")[0]?.tabId ?? run.hostTabId ?? null;
  return { agents, host };
}

/** Closes the named tabs that Herdr still lists; returns what happened to each. */
function closeTabs(tabIds, why) {
  const listed = new Set((listTabs() ?? []).map((tab) => tab.tab_id));
  return tabIds.map((tabId) => {
    if (!listed.has(tabId)) return { tabId, state: "already_closed" };
    if (keepTabs) return { tabId, state: "left_open (--keep-tabs)" };
    const closed = sh("herdr", ["tab", "close", tabId]);
    log(`[cleanup] herdr tab close ${tabId} (${why}): exit ${closed.status} ${closed.stderr}`);
    return {
      tabId,
      state: closed.status === 0 ? "closed_by_script" : `close_failed: ${closed.stderr}`,
    };
  });
}

/** Leaves Herdr clean for a run that did not end by itself: cancel, wait for the host, close its tabs. */
async function abandon(run, reason) {
  if (!existsSync(join(run.runDir, "journal.jsonl"))) {
    if (run.hostTabId !== null) closeTabs([run.hostTabId], `${run.tag}: no run was opened`);
    return;
  }
  if (!terminatedIn(recordsOf(run.runDir))) {
    const cancelled = woofSaved(
      `${run.tag}/abandon-cancel.txt`,
      "run",
      "cancel",
      run.runDir,
      "--reason",
      reason,
    );
    log(`[cleanup] woof run cancel ${run.runId}: exit ${cancelled.status}`);
    // A live host stops at its next tick and closes the agent tabs it created.
    await waitFor(
      "the host to exit after the cancel",
      () =>
        ofType(recordsOf(run.runDir), "host.exited").length > 0 ||
        woofSaved(`${run.tag}/abandon-status.txt`, "status", run.runDir).json?.status?.liveness
          ?.owner !== "alive",
      60_000,
      2000,
    );
  }
  const tabs = journaledTabs(run);
  closeTabs(
    tabs.agents.map((item) => item.tabId),
    `${run.tag}: leftover agent tab`,
  );
}

let exiting = false;
async function finish(code) {
  if (exiting) return;
  exiting = true;
  for (const run of runs) {
    if (run.done === true) continue;
    // oxlint-disable-next-line no-await-in-loop
    await abandon(run, "tabs-observability: the script is ending before this run did");
  }
  process.exit(code);
}
process.on("SIGINT", () => void finish(130));
process.on("SIGTERM", () => void finish(143));

// ---------------------------------------------------------------- Part C machinery
/** Follows `woof events <runId> --follow` in child processes and keeps every complete event line. */
function createFollower(run) {
  const tag = parts.has("A") ? "A" : "C";
  const connections = [];
  function connect(after) {
    const args = ["events", run.runId, "--follow", "--timeout-ms", String(runTimeoutMs)];
    if (after !== undefined) args.push("--after", after);
    const connection = {
      index: connections.length + 1,
      after: after ?? null,
      events: [],
      end: null,
      buffer: "",
      closed: false,
      exitCode: null,
      signal: null,
    };
    const file = evidence(`${tag}/reconnect/connection-${connection.index}.ndjson`, "");
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: woofRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    connection.child = child;
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      connection.buffer += chunk;
      let newline = connection.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = connection.buffer.slice(0, newline);
        connection.buffer = connection.buffer.slice(newline + 1);
        newline = connection.buffer.indexOf("\n");
        const item = parseJson(line);
        if (item === null) continue;
        appendFileSync(file, `${line}\n`);
        if (item.kind === "woof.run.event") connection.events.push(item);
        else if (item.kind === "woof.events.end") connection.end = item;
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => appendFileSync(`${file}.stderr`, chunk));
    connection.done = new Promise((done) =>
      child.on("close", (code, signal) => {
        connection.closed = true;
        connection.exitCode = code;
        connection.signal = signal;
        done();
      }),
    );
    connections.push(connection);
    log(`[follow] connection ${connection.index}: woof ${args.join(" ")}`);
    return connection;
  }
  const state = { phase: "first", killedAt: null, recordsAtKill: 0, cursorAtKill: null };
  const first = connect(undefined);

  /** Called from the sampling loop: kills the first connection mid-run, then resumes from its last cursor. */
  function tick(records) {
    if (state.phase === "first") {
      const midRun =
        first.events.some((event) => event.type === "request.dispatched") && !terminatedIn(records);
      if (!midRun && !first.closed) return;
      // Only complete lines were kept, so the last event's cursor is the last one this consumer handled.
      state.cursorAtKill = first.events.at(-1)?.cursor ?? null;
      state.killedMidRun = midRun && !first.closed;
      if (!first.closed) first.child.kill("SIGKILL");
      state.killedAt = Date.now();
      state.recordsAtKill = records.length;
      state.phase = "gap";
      log(
        `[follow] connection 1 ${state.killedMidRun ? "killed mid-run" : "had already ended"} after seq ${first.events.at(-1)?.seq ?? "none"}; cursor ${state.cursorAtKill}`,
      );
      return;
    }
    if (state.phase === "gap") {
      // Resume once the journal moved on while nobody was listening (bounded: 90 s), so the
      // resumed connection has to deliver records written during the gap.
      const moved = records.length > state.recordsAtKill;
      if (!moved && Date.now() - state.killedAt < 90_000 && !terminatedIn(records)) return;
      state.recordsDuringGap = records.length - state.recordsAtKill;
      connect(state.cursorAtKill ?? undefined);
      state.phase = "resumed";
    }
  }

  /** After the run and its host ended: end the follow, then read what followed the termination. */
  async function settle() {
    if (state.phase === "first") tick(recordsOf(run.runDir));
    if (state.phase === "gap") {
      state.recordsDuringGap = recordsOf(run.runDir).length - state.recordsAtKill;
      connect(state.cursorAtKill ?? undefined);
      state.phase = "resumed";
    }
    const resumed = connections.at(-1);
    const ended = await Promise.race([
      resumed.done.then(() => true),
      sleep(60_000).then(() => false),
    ]);
    if (!ended) {
      log("[follow] the resumed connection did not end within 60 s of the run; killing it");
      resumed.child.kill("SIGKILL");
      await resumed.done;
    }
    // A follow ends at run.terminated; host.exited follows it. One plain read from the last
    // cursor delivers the rest (observability.md: `--after <cursor at or past the termination>`).
    const lastCursor = connections.flatMap((item) => item.events).at(-1)?.cursor;
    const tail = woofSaved(
      `${tag}/reconnect/catch-up.txt`,
      "events",
      run.runId,
      ...(lastCursor === undefined ? [] : ["--after", lastCursor]),
    );
    const tailEvents = tail.stdout
      .split("\n")
      .map((line) => parseJson(line))
      .filter((item) => item?.kind === "woof.run.event");
    return { state, connections, tailEvents, tailExit: tail.status };
  }
  return { tick, settle, state };
}

function reconnectGates(run, followed) {
  const { state, connections, tailEvents, tailExit } = followed;
  const records = recordsOf(run.runDir);
  const all = [...connections.flatMap((item) => item.events), ...tailEvents];
  const bySeq = new Map();
  const conflicting = [];
  let repeats = 0;
  for (const event of all) {
    const held = bySeq.get(event.seq);
    if (held === undefined) bySeq.set(event.seq, event);
    else {
      repeats += 1;
      if (!isDeepStrictEqual(held, event)) conflicting.push(event.seq);
    }
  }
  const ordered = [...bySeq.values()].toSorted((a, b) => a.seq - b.seq);
  const lastSeq = records.at(-1)?.seq ?? 0;
  const missing = [];
  for (let seq = 1; seq <= lastSeq; seq += 1) if (!bySeq.has(seq)) missing.push(seq);
  evidence(`${run.tag}/reconnect/summary.json`, {
    runId: run.runId,
    killedMidRun: state.killedMidRun ?? false,
    cursorAtKill: state.cursorAtKill,
    recordsDuringGap: state.recordsDuringGap ?? 0,
    connections: connections.map((item) => ({
      index: item.index,
      after: item.after,
      events: item.events.length,
      firstSeq: item.events[0]?.seq ?? null,
      lastSeq: item.events.at(-1)?.seq ?? null,
      end: item.end,
      exitCode: item.exitCode,
      signal: item.signal,
    })),
    catchUp: { exit: tailExit, events: tailEvents.length },
    journalLastSeq: lastSeq,
    missing,
    repeats,
    conflicting,
  });
  const resumed = connections[1];
  gate(
    "C1",
    "the first follow was killed mid-run and the resume used its last cursor",
    state.killedMidRun === true &&
      connections.length === 2 &&
      typeof state.cursorAtKill === "string" &&
      resumed?.after === state.cursorAtKill &&
      connections[0].signal === "SIGKILL",
    `killed mid-run ${state.killedMidRun === true}, cursor ${state.cursorAtKill}, ${state.recordsDuringGap ?? 0} record(s) written during the gap`,
  );
  gate(
    "C2",
    "the resumed follow starts right after the stored cursor and ends at the termination",
    resumed !== undefined &&
      resumed.events.length > 0 &&
      resumed.events[0].seq === (connections[0].events.at(-1)?.seq ?? 0) + 1 &&
      resumed.end?.reason === "terminated" &&
      resumed.exitCode === 0,
    `first resumed seq ${resumed?.events[0]?.seq ?? "none"}, end ${JSON.stringify(resumed?.end ?? null)}, exit ${resumed?.exitCode}`,
  );
  gate(
    "C3",
    "no seq is missing and no repeated seq differs in content",
    lastSeq > 0 && missing.length === 0 && conflicting.length === 0,
    `journal seq 1..${lastSeq}, collected ${bySeq.size}, missing ${JSON.stringify(missing)}, repeats ${repeats}, conflicting ${JSON.stringify(conflicting)}`,
  );

  const folded = foldEvents(null, ordered);
  const fresh = readSnapshot(run.runDir);
  // `liveness` is the read-time probe of host.json, not journal state (observability.md): a fold
  // cannot know it. Everything else is compared in JSON form, because per-key maps are
  // null-prototype objects in memory.
  const foldedForm = folded.ok ? withoutLiveness(folded.projection.snapshot) : null;
  const freshForm = fresh.ok ? withoutLiveness(fresh.snapshot) : null;
  const differing =
    foldedForm === null || freshForm === null
      ? ["(unavailable)"]
      : [...new Set([...Object.keys(foldedForm), ...Object.keys(freshForm)])].filter(
          (key) => !isDeepStrictEqual(foldedForm[key], freshForm[key]),
        );
  evidence(`${run.tag}/reconnect/folded-snapshot.json`, foldedForm ?? { error: folded });
  evidence(`${run.tag}/reconnect/read-snapshot.json`, freshForm ?? { error: fresh });
  gate(
    "C4",
    "foldEvents over the collected events equals readSnapshot (JSON form, liveness excluded)",
    folded.ok === true && fresh.ok === true && differing.length === 0,
    folded.ok !== true
      ? `fold refused: ${folded.reason}: ${folded.message}`
      : fresh.ok !== true
        ? `readSnapshot refused: ${fresh.reason}`
        : `revision ${freshForm.revision}, status ${freshForm.status}, differing keys ${JSON.stringify(differing)}`,
  );
}

// ---------------------------------------------------------------- hosted run to its end
/**
 * Waits (bounded) for a hosted run to terminate, sampling Herdr's tab and pane listings and
 * driving the follower. Returns the samples taken while the run had not terminated.
 */
async function observeToEnd(run, follower) {
  const samples = [];
  const samplesFile = evidence(`${run.tag}/herdr-samples.ndjson`, "");
  const deadline = Date.now() + runTimeoutMs;
  let startupBlockReported = false;
  while (Date.now() < deadline) {
    const records = recordsOf(run.runDir);
    const terminated = terminatedIn(records);
    const tabs = listTabs();
    const panes = listPanes();
    const row = {
      at: new Date().toISOString(),
      records: records.length,
      terminated,
      tabs:
        tabs?.map((tab) => ({
          tab_id: tab.tab_id,
          label: tab.label,
          workspace_id: tab.workspace_id,
          pane_count: tab.pane_count,
        })) ?? null,
      panes:
        panes?.map((pane) => ({
          pane_id: pane.pane_id,
          tab_id: pane.tab_id,
          agent: pane.agent ?? null,
          agent_status: pane.agent_status ?? null,
        })) ?? null,
    };
    appendFileSync(samplesFile, `${JSON.stringify(row)}\n`);
    if (!terminated) samples.push(row);
    const block = ofType(records, "run.blocked").at(-1);
    if (block?.reason === "startup_blocked" && !startupBlockReported) {
      startupBlockReported = true;
      log(
        `[startup blocked] ${block.requiredAction ?? ""} precondition: ${trustPrecondition} Nothing answers it; the run exhausts blockedWaitMs as designed.`,
      );
    }
    log(
      `[sample] ${row.at} records=${row.records} terminated=${terminated} tabs=${row.tabs?.length ?? "?"} last=${records.at(-1)?.type ?? "none"}`,
    );
    follower?.tick(records);
    if (terminated) break;
    // oxlint-disable-next-line no-await-in-loop
    await sleep(5000);
  }
  const ended = terminatedIn(recordsOf(run.runDir));
  if (ended) {
    // The host journals host.exited after the termination, then releases its claim.
    await waitFor(
      "host.exited in the journal",
      () => ofType(recordsOf(run.runDir), "host.exited").length > 0,
      60_000,
    );
  }
  return { samples, ended };
}

function saveRunEvidence(run) {
  const journal = join(run.runDir, "journal.jsonl");
  if (existsSync(journal)) copyFileSync(journal, evidence(`${run.tag}/journal.jsonl`, ""));
  for (const name of [
    "host.json",
    "host-exit.json",
    "outcome.json",
    "config.json",
    "launch.json",
  ]) {
    const path = join(run.runDir, name);
    if (existsSync(path)) copyFileSync(path, evidence(`${run.tag}/${name}`, ""));
  }
  evidence(`${run.tag}/herdr-tab-list-final.json`, herdrJson("tab", "list").raw.stdout);
  evidence(`${run.tag}/herdr-pane-list-final.json`, herdrJson("pane", "list").raw.stdout);
}

let blocked = false;

// ---------------------------------------------------------------- Part A
async function partA() {
  section("Part A: hosted build-review run, one tab per participant");
  const nonce = randomBytes(6).toString("hex");
  const requiredLine = `// woof-acceptance: ${nonce}`;
  if (!initFixture("A")) {
    gate(
      "A1",
      "the fixture was re-initialized and the run started in a Herdr tab",
      false,
      "fixture re-init failed",
    );
    return;
  }
  const run = startRun("A", repairLoopInput(requiredLine));
  log(`nonce: ${nonce}`);
  const host = run.launched?.host ?? {};
  gate(
    "A1",
    "woof run start --host herdr-pane started the run in its own tab",
    run.started === true,
    `outcome ${run.launched?.outcome ?? "none"} (${run.launched?.reason ?? "-"}), host pane ${host.paneId ?? "none"}, tab ${host.tabId ?? "none"}, pid ${host.pid ?? "none"}`,
  );
  if (run.started !== true) {
    await abandon(run, "tabs-observability: launch failed");
    run.done = true;
    return;
  }

  // One pane per run: the host's tab holds only the host's pane, which prints the human view; the
  // technical log is <run-dir>/host.log. Herdr's own pane record says which tab holds the host.
  const hostPane = herdrJson("pane", "get", host.paneId);
  evidence("A/herdr-pane-get-host.json", hostPane.raw.stdout);

  const follower = parts.has("C") ? createFollower(run) : null;
  const { samples, ended } = await observeToEnd(run, follower);
  const followed = follower === null ? null : await follower.settle();
  saveRunEvidence(run);

  const records = recordsOf(run.runDir);
  if (ofType(records, "run.blocked").length > 0) blocked = true;
  const terminated = ofType(records, "run.terminated")[0];
  const waited = woofSaved(
    "A/status-wait-by-id.txt",
    "status",
    run.runId,
    "--wait",
    "--timeout-ms",
    "30000",
  );
  gate(
    "A2",
    "the run completed (journal and woof status <runId> --wait)",
    ended && terminated?.outcome === "completed" && waited.status === 0,
    `run.terminated ${terminated?.outcome ?? "none"} (${terminated?.reason ?? "-"}), status --wait exit ${waited.status}`,
  );

  const claimed = ofType(records, "host.claimed")[0];
  gate(
    "A3",
    "host.claimed is journaled with the host's pane and tab",
    claimed !== undefined &&
      records[1]?.type === "host.claimed" &&
      claimed.paneId === host.paneId &&
      claimed.tabId === host.tabId &&
      claimed.pid === host.pid,
    `seq ${claimed?.seq ?? "none"}, pane ${claimed?.paneId ?? "none"}, tab ${claimed?.tabId ?? "none"}, pid ${claimed?.pid ?? "none"}`,
  );

  const assignments = ofType(records, "agent.assigned");
  const tabOf = (agentId) =>
    assignments.find((record) => record.agentId === agentId)?.tabId ?? null;
  const agentTabs = assignments.map((record) => record.tabId ?? null);
  gate(
    "A4",
    "agent.assigned ×2 with two different non-null tab ids, neither the host's tab",
    assignments.length === 2 &&
      agentTabs.every(
        (tabId) => typeof tabId === "string" && tabId !== "" && tabId !== host.tabId,
      ) &&
      new Set(agentTabs).size === 2 &&
      tabOf("builder") !== null &&
      tabOf("reviewer") !== null,
    `builder ${tabOf("builder")}, reviewer ${tabOf("reviewer")}, host ${host.tabId}`,
  );

  const seenTab = (tabId) => samples.find((row) => row.tabs?.some((tab) => tab.tab_id === tabId));
  const labels = assignments.map((record) => {
    const row = seenTab(record.tabId);
    return `${record.agentId}=${record.tabId}:${row?.tabs.find((tab) => tab.tab_id === record.tabId)?.label ?? "never listed"}`;
  });
  gate(
    "A5",
    "herdr tab list showed the host tab and both agent tabs while the run was active",
    assignments.length === 2 &&
      assignments.every((record) => seenTab(record.tabId) !== undefined) &&
      seenTab(host.tabId) !== undefined,
    `${samples.length} active samples; ${labels.join(", ")}`,
  );

  const soleOccupant = assignments.map((record) => {
    const rows = samples.filter((row) => row.panes?.some((pane) => pane.tab_id === record.tabId));
    const ok =
      rows.length > 0 &&
      rows.every((row) => {
        const inTab = row.panes.filter((pane) => pane.tab_id === record.tabId);
        return inTab.length === 1 && inTab[0].pane_id === record.runtime.paneId;
      });
    return { agentId: record.agentId, rows: rows.length, ok };
  });
  gate(
    "A6",
    "one agent per tab: each agent tab held exactly its agent's pane in every active sample",
    soleOccupant.length === 2 && soleOccupant.every((item) => item.ok),
    JSON.stringify(soleOccupant),
  );

  // The host tab in every active sample: exactly the host's pane, no watch split or anything else.
  const hostTabRows = samples.filter((row) =>
    row.panes?.some((pane) => pane.tab_id === host.tabId),
  );
  const hostTabSole =
    hostTabRows.length > 0 &&
    hostTabRows.every((row) => {
      const inTab = row.panes.filter((pane) => pane.tab_id === host.tabId);
      return inTab.length === 1 && inTab[0].pane_id === host.paneId;
    });
  const hostLogPath = join(run.runDir, "host.log");
  const hostLog = existsSync(hostLogPath) ? readFileSync(hostLogPath, "utf8") : null;
  if (hostLog !== null) evidence("A/host.log", hostLog);
  const dispatchLines = (hostLog ?? "")
    .split("\n")
    .filter((line) => /^\S+Z dispatch \S+ visit \d+ attempt \d+ /.test(line));
  gate(
    "A7",
    "one pane per run: the host tab held exactly the host's pane in every active sample (no watch split), and <run-dir>/host.log holds the technical dispatch lines",
    hostTabSole &&
      hostPane.result?.pane?.tab_id === host.tabId &&
      run.launched?.watch === undefined &&
      dispatchLines.length >= 2,
    `host pane ${host.paneId} in tab ${hostPane.result?.pane?.tab_id ?? "unknown"}; ${hostTabRows.length} active samples of the host tab, sole occupant ${hostTabSole}; watch field ${JSON.stringify(run.launched?.watch ?? null)}; host.log ${hostLog === null ? "missing" : `${dispatchLines.length} dispatch lines`}`,
  );

  const accepted = ofType(records, "submission.accepted");
  const reviews = accepted.filter((record) => record.stageId === "review");
  const gateOf = (review) =>
    ofType(records, "gate.recorded").find((record) => record.subject?.acceptedSeq === review?.seq);
  const firstGate = gateOf(reviews[0]);
  const lastGate = gateOf(reviews.at(-1));
  const firstReviewPath =
    reviews[0] === undefined ? null : join(run.runDir, reviews[0].artifact.acceptedPath);
  const firstReviewText =
    firstReviewPath !== null && existsSync(firstReviewPath)
      ? readFileSync(firstReviewPath, "utf8")
      : "";
  for (const [index, review] of reviews.entries()) {
    const path = join(run.runDir, review.artifact.acceptedPath);
    if (existsSync(path))
      copyFileSync(path, evidence(`A/review-${index + 1}-${review.verdict}.md`, ""));
  }
  gate(
    "A8",
    "the first review fails (gate reject → repair) citing the nonce line; a later review passes on a newer revision",
    reviews.length >= 2 &&
      reviews[0].verdict === "fail" &&
      firstGate?.decision === "reject" &&
      firstGate?.next?.stageId === "repair" &&
      firstReviewText.includes(requiredLine) &&
      reviews.at(-1).verdict === "pass" &&
      lastGate?.decision === "pass" &&
      lastGate.seq > firstGate.seq &&
      typeof lastGate?.revision?.tree === "string" &&
      lastGate.revision.tree !== firstGate?.revision?.tree,
    `reviews ${reviews.map((review) => review.verdict).join(" → ")}; gates ${firstGate?.decision ?? "none"}@${firstGate?.revision?.tree ?? "?"} → ${lastGate?.decision ?? "none"}@${lastGate?.revision?.tree ?? "?"}; cites line ${firstReviewText.includes(requiredLine)}`,
  );

  const builder = assignments.find((record) => record.agentId === "builder");
  const expected = JSON.stringify([
    builder?.runtime.paneId ?? null,
    builder?.terminalId ?? null,
    builder?.sessionId ?? null,
  ]);
  const dispatches = ofType(records, "request.dispatched");
  const builds = dispatches.filter((record) => record.stageId === "build");
  const repairs = dispatches.filter((record) => record.stageId === "repair");
  gate(
    "A9",
    "repair reused the builder: same agent, pane, terminal and session as the build, and no replacement",
    builds.length > 0 &&
      repairs.length > 0 &&
      [...builds, ...repairs].every(
        (record) => record.agentId === "builder" && identity(record) === expected,
      ) &&
      !JSON.parse(expected).includes(null) &&
      assignments.filter((record) => record.agentId === "builder").length === 1,
    `builder ${expected}; ${builds.length} build and ${repairs.length} repair dispatch(es)`,
  );

  const shown = woofSaved(
    "A/run-show-verify-artifacts.txt",
    "run",
    "show",
    run.runId,
    "--verify-artifacts",
  );
  const integrity = shown.json?.snapshot?.integrity?.artifacts;
  gate(
    "A10",
    "woof run show --verify-artifacts reports no altered artifact",
    shown.status === 0 &&
      Array.isArray(integrity?.altered) &&
      integrity.altered.length === 0 &&
      integrity.checked > 0,
    `exit ${shown.status}, checked ${integrity?.checked ?? "none"}, altered ${JSON.stringify(integrity?.altered ?? null)}`,
  );

  const slugifyPath = join(fixtureRepo, "src", "slugify.mjs");
  const slugify = existsSync(slugifyPath) ? readFileSync(slugifyPath, "utf8") : "";
  const nodeTest = sh(process.execPath, ["--test"], { cwd: fixtureRepo });
  evidence("A/repo-slugify.mjs.txt", slugify);
  evidence(
    "A/repo-node-test.txt",
    `exit ${nodeTest.status}\n${nodeTest.stdout}\n${nodeTest.stderr}\n`,
  );
  evidence(
    "A/repo-git.txt",
    `${sh("git", ["-C", fixtureRepo, "log", "--oneline"]).stdout}\n---\n${sh("git", ["-C", fixtureRepo, "status", "--porcelain"]).stdout}\n`,
  );
  gate(
    "A11",
    "the repository holds the repaired change: nonce line first, tests exist, node --test passes",
    slugify.startsWith(requiredLine) &&
      existsSync(join(fixtureRepo, "test", "slugify.test.mjs")) &&
      nodeTest.status === 0,
    `first line ${JSON.stringify(slugify.split("\n")[0])}, node --test exit ${nodeTest.status}`,
  );

  const listed = woofSaved("A/runs.txt", "runs");
  const entry = listed.json?.runs?.find((item) => item.runId === run.runId);
  gate(
    "A12",
    "woof runs (no path flags) lists the run from the run index",
    listed.status === 0 &&
      entry !== undefined &&
      resolve(entry.runDir) === resolve(run.runDir) &&
      entry.status === "completed",
    `entry ${JSON.stringify(entry ?? null)}`,
  );

  const byId = woofSaved("A/status-by-id.txt", "status", run.runId);
  gate(
    "A13",
    "woof status <runId> resolves the run by id",
    byId.status === 0 &&
      byId.json?.outcome === "status" &&
      byId.json?.status?.status === "completed" &&
      byId.json?.result?.outcome === "completed",
    `exit ${byId.status}, status ${byId.json?.status?.status ?? "none"}, owner ${byId.json?.status?.liveness?.owner ?? "none"}`,
  );

  const everything = woofSaved("A/events-all.txt", "events", "--all", "--since", run.startedAt);
  const lines = everything.stdout
    .split("\n")
    .map((line) => parseJson(line))
    .filter((item) => item !== null);
  const intro = lines.find((item) => item.kind === "woof.events.run" && item.runId === run.runId);
  const crossSeqs = lines
    .filter((item) => item.kind === "woof.run.event" && item.runId === run.runId)
    .map((item) => item.seq);
  const journalSeqs = recordsOf(run.runDir).map((record) => record.seq);
  gate(
    "A14",
    "woof events --all introduces the run and carries every one of its events",
    everything.status === 0 &&
      intro !== undefined &&
      resolve(intro.runDir) === resolve(run.runDir) &&
      isDeepStrictEqual(
        crossSeqs.toSorted((a, b) => a - b),
        journalSeqs,
      ),
    `exit ${everything.status}, intro ${intro === undefined ? "missing" : "present"}, ${crossSeqs.length}/${journalSeqs.length} events`,
  );

  const final = recordsOf(run.runDir);
  const exited = ofType(final, "host.exited")[0];
  gate(
    "A15",
    "host.exited is recorded after run.terminated, as the last record, by the claiming pid",
    exited !== undefined &&
      terminated !== undefined &&
      exited.seq > terminated.seq &&
      final.at(-1)?.type === "host.exited" &&
      exited.pid === claimed?.pid &&
      exited.exitCode === 0 &&
      exited.reason === "completed",
    `run.terminated seq ${terminated?.seq ?? "none"}, host.exited ${JSON.stringify(exited ?? null)}`,
  );

  const keepPanes = parseJson(
    existsSync(join(run.runDir, "config.json"))
      ? readFileSync(join(run.runDir, "config.json"), "utf8")
      : "null",
  )?.settings?.keepPanes?.value;
  const after = new Set((listTabs() ?? []).map((tab) => tab.tab_id));
  if (keepPanes === true) {
    log(
      "[note] the run's configuration sets keepPanes: agent tabs are kept by design; A16 is not evaluated",
    );
  } else {
    gate(
      "A16",
      "after the run the agent tabs are closed and the host tab remains",
      assignments.length === 2 &&
        agentTabs.every((tabId) => !after.has(tabId)) &&
        after.has(host.tabId),
      `agent tabs still listed ${JSON.stringify(agentTabs.filter((tabId) => after.has(tabId)))}, host tab listed ${after.has(host.tabId)}`,
    );
  }

  if (followed !== null) {
    section("Part C: event reconnect (on Part A's run)");
    reconnectGates(run, followed);
  }
  run.done = true;
  const leftovers = closeTabs(
    agentTabs.filter((tabId) => typeof tabId === "string"),
    "A: leftover agent tab",
  );
  log(`[cleanup] Part A agent tabs: ${JSON.stringify(leftovers)}`);
  log(
    `[cleanup] Part A host tab ${host.tabId} is left open (its last lines stay readable); close it with: herdr tab close ${host.tabId}`,
  );
}

// ---------------------------------------------------------------- Part B
async function partB() {
  section("Part B: the host is killed mid-run");
  if (!initFixture("B")) {
    gate(
      "B1",
      "the fixture was re-initialized and the run started in a Herdr tab",
      false,
      "fixture re-init failed",
    );
    return;
  }
  const run = startRun("B", shortInput());
  gate(
    "B1",
    "woof run start --host herdr-pane started the run",
    run.started === true,
    `outcome ${run.launched?.outcome ?? "none"} (${run.launched?.reason ?? "-"})`,
  );
  if (run.started !== true) {
    await abandon(run, "tabs-observability: launch failed");
    run.done = true;
    return;
  }

  const dispatched = await waitFor(
    "request.dispatched",
    () =>
      ofType(recordsOf(run.runDir), "request.dispatched").length > 0 ||
      terminatedIn(recordsOf(run.runDir)),
    600_000,
  );
  const working = dispatched && !terminatedIn(recordsOf(run.runDir));
  // Killing a lock holder is a separate documented limit (a stale journal.lock); never exercise it here.
  const lockPath = join(run.runDir, "journal.lock");
  const unlocked =
    working && (await waitFor("journal.lock absent", () => !existsSync(lockPath), 60_000, 100));
  const claim = parseJson(
    existsSync(join(run.runDir, "host.json"))
      ? readFileSync(join(run.runDir, "host.json"), "utf8")
      : "null",
  );
  const hostPid = claim?.pid;
  const command =
    Number.isSafeInteger(hostPid) && hostPid > 0
      ? sh("ps", ["-p", String(hostPid), "-o", "command="]).stdout
      : "";
  const isThisHost =
    command.includes("run") && command.includes("host") && command.includes(run.runDir);
  let killed = false;
  if (!working || !unlocked)
    log("refusing to kill: the run never reached a dispatched attempt with the lock absent");
  else if (!isThisHost)
    log(
      `refusing to kill pid ${String(hostPid)}: ps does not show this run's host (${command || "no such process"})`,
    );
  else if (existsSync(lockPath)) log("refusing to kill: journal.lock reappeared");
  else {
    const signalled = sh("kill", ["-9", String(hostPid)]);
    await sleep(2000);
    const alive = sh("ps", ["-p", String(hostPid)]).status === 0;
    killed = signalled.status === 0 && !alive;
    log(
      `kill -9 ${hostPid}: exit ${signalled.status}; afterwards ${alive ? "still present" : "gone"}`,
    );
  }
  const atKill = recordsOf(run.runDir);
  gate(
    "B2",
    "the host (pid from host.json) was killed after a dispatch, with journal.lock absent",
    killed && hostPid === run.launched?.host?.pid,
    `pid ${String(hostPid)} (launcher ${run.launched?.host?.pid ?? "none"}), ${atKill.length} records, last ${atKill.at(-1)?.type ?? "none"}`,
  );
  if (!killed) {
    await abandon(run, "tabs-observability: Part B could not kill the host");
    saveRunEvidence(run);
    run.done = true;
    return;
  }

  const shown = woofSaved("B/status-after-kill.txt", "status", run.runId);
  const waited = woofSaved(
    "B/status-wait-after-kill.txt",
    "status",
    run.runId,
    "--wait",
    "--timeout-ms",
    "60000",
  );
  gate(
    "B3",
    "woof status <runId> reports owner lost and --wait exits 8",
    shown.json?.status?.liveness?.owner === "lost" && waited.status === 8,
    `owner ${shown.json?.status?.liveness?.owner ?? "none"}, --wait exit ${waited.status}`,
  );

  const listed = woofSaved("B/runs-after-kill.txt", "runs");
  const entry = listed.json?.runs?.find((item) => item.runId === run.runId);
  const TERMINAL = ["completed", "failed", "cancelled", "exhausted"];
  gate(
    "B4",
    "woof runs (no path flags) still lists the run as not ended, with owner lost",
    entry !== undefined && !TERMINAL.includes(entry.status) && entry.owner === "lost",
    `entry ${JSON.stringify(entry ?? null)}`,
  );

  const beforeCancel = recordsOf(run.runDir).length;
  const cancelled = woofSaved(
    "B/run-cancel.txt",
    "run",
    "cancel",
    run.runId,
    "--reason",
    "tabs-observability: host killed",
  );
  const tail = recordsOf(run.runDir).slice(beforeCancel);
  const tailTypes = tail.map((record) => record.type);
  gate(
    "B5",
    "woof run cancel <runId> journals host.lost → run.cancel_requested → run.terminated{cancelled}",
    cancelled.status === 0 &&
      isDeepStrictEqual(tailTypes, ["host.lost", "run.cancel_requested", "run.terminated"]) &&
      tail[0].pid === hostPid &&
      tail[2].outcome === "cancelled" &&
      !existsSync(join(run.runDir, "host-exit.json")),
    `exit ${cancelled.status}, appended ${JSON.stringify(tailTypes)}, outcome ${tail.at(-1)?.outcome ?? "none"}, host-exit.json ${existsSync(join(run.runDir, "host-exit.json")) ? "present" : "absent"}`,
  );

  // A late result for the attempt the dead host had dispatched: run_closed wins before any
  // artifact check, so the envelope only has to be schema-valid.
  const attempt = ofType(recordsOf(run.runDir), "request.dispatched").at(-1);
  const envelopePath = evidence("B/late-envelope.json", {
    schemaVersion: 1,
    runId: run.runId,
    agentId: attempt?.agentId ?? "builder",
    stageId: attempt?.stageId ?? "build",
    visit: attempt?.visit ?? 1,
    attempt: attempt?.attempt ?? 1,
    status: "completed",
    verdict: null,
    artifact: { path: "artifacts/late/result.md", sha256: "0".repeat(64) },
  });
  const beforeSubmit = recordsOf(run.runDir).length;
  const late = woofSaved(
    "B/late-submit.txt",
    "submit",
    "--run-dir",
    run.runDir,
    "--envelope",
    envelopePath,
  );
  const afterSubmit = recordsOf(run.runDir);
  gate(
    "B6",
    "a late woof submit is rejected (run_closed) and accepts nothing",
    late.status === 2 &&
      late.json?.outcome === "rejected" &&
      late.json?.reason === "run_closed" &&
      ofType(afterSubmit.slice(beforeSubmit), "submission.accepted").length === 0,
    `exit ${late.status}, ${late.json?.outcome ?? "none"}/${late.json?.reason ?? "none"}, records ${beforeSubmit} → ${afterSubmit.length}`,
  );

  saveRunEvidence(run);
  if (ofType(recordsOf(run.runDir), "run.blocked").length > 0) blocked = true;
  // Nobody is left to close the dead host's agent tabs; say which were left and close exactly those.
  const tabs = journaledTabs(run);
  const agentTabs = closeTabs(
    tabs.agents.map((item) => item.tabId),
    "B: agent tab of a killed host",
  );
  const hostTab = tabs.host === null ? [] : closeTabs([tabs.host], "B: tab of the killed host");
  const stillListed = new Set((listTabs() ?? []).map((tab) => tab.tab_id));
  const report = { agents: tabs.agents, agentTabs, hostTab };
  evidence("B/tab-cleanup.json", report);
  const leftOpen = agentTabs.filter((item) => item.state !== "already_closed");
  log(
    leftOpen.length === 0
      ? "[tabs] every agent tab of the killed host was already closed when the script looked"
      : `[tabs] REPORTED: the killed host left ${leftOpen.length} agent tab(s) open (${leftOpen.map((item) => item.tabId).join(", ")}); woof run cancel does not close them; this script ${keepTabs ? "left them open (--keep-tabs)" : "closed them with herdr tab close"}`,
  );
  gate(
    "B7",
    "agent tabs of the killed host are cleaned up or reported",
    tabs.agents.length > 0 &&
      agentTabs.every((item) => !item.state.startsWith("close_failed")) &&
      (keepTabs || tabs.agents.every((item) => !stillListed.has(item.tabId))),
    `${leftOpen.length === 0 ? "cleaned up by Woof" : "reported, then closed by this script"}: ${JSON.stringify(report)}`,
  );
  run.done = true;
}

// ---------------------------------------------------------------- Part C alone
async function partC() {
  section("Part C: event reconnect (short run)");
  if (!initFixture("C")) {
    gate(
      "C0",
      "the fixture was re-initialized and the run started in a Herdr tab",
      false,
      "fixture re-init failed",
    );
    return;
  }
  const run = startRun("C", shortInput());
  gate(
    "C0",
    "woof run start --host herdr-pane started the run",
    run.started === true,
    `outcome ${run.launched?.outcome ?? "none"} (${run.launched?.reason ?? "-"})`,
  );
  if (run.started !== true) {
    await abandon(run, "tabs-observability: launch failed");
    run.done = true;
    return;
  }
  const follower = createFollower(run);
  const { ended } = await observeToEnd(run, follower);
  const followed = await follower.settle();
  saveRunEvidence(run);
  if (ofType(recordsOf(run.runDir), "run.blocked").length > 0) blocked = true;
  if (!ended) await abandon(run, "tabs-observability: Part C run did not end in time");
  reconnectGates(run, followed);
  run.done = true;
  const tabs = journaledTabs(run);
  log(
    `[cleanup] Part C agent tabs: ${JSON.stringify(
      closeTabs(
        tabs.agents.map((item) => item.tabId),
        "C: leftover agent tab",
      ),
    )}`,
  );
  if (tabs.host !== null)
    log(
      `[cleanup] Part C host tab ${tabs.host} is left open; close it with: herdr tab close ${tabs.host}`,
    );
}

// ---------------------------------------------------------------- main
try {
  if (parts.has("A")) await partA();
  if (parts.has("B")) await partB();
  if (parts.has("C") && !parts.has("A")) await partC();
} catch (error) {
  log(`unexpected error: ${error?.stack ?? error}`);
  gate("X0", "the script ran to its end", false, String(error?.message ?? error));
}

section("script hygiene");
const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
const forbidden = [
  ["agent", "read"],
  ["pane", "read"],
  ["send", "keys"],
].map((words) => words.join(words[0] === "send" ? "-" : " "));
const hits = forbidden.filter((needle) => source.includes(needle));
const worktreeStatusAfter = sh("git", ["-C", woofRoot, "status", "--porcelain"]).stdout;
gate(
  "H1",
  "Woof worktree unchanged; the script never reads pane text or sends keys",
  hits.length === 0 && worktreeStatusAfter === worktreeStatusBefore,
  `source grep for ${forbidden.join(", ")}: ${hits.length === 0 ? "no matches" : hits.join(", ")}; worktree unchanged ${worktreeStatusAfter === worktreeStatusBefore}`,
);

section("summary");
for (const run of runs) log(`run ${run.tag}: ${run.runId}  ${run.runDir}`);
const failed = gates.filter((item) => !item.pass);
evidence("gates.json", {
  at: new Date().toISOString(),
  parts: [...parts],
  runs: runs.map(({ tag, runId, runDir }) => ({ tag, runId, runDir })),
  gates,
  blocked,
});
log(`evidence dir: ${evidenceDir}`);
log(
  `${gates.length - failed.length}/${gates.length} gates passed${failed.length > 0 ? `; failed: ${failed.map((item) => item.id).join(", ")}` : ""}`,
);
if (blocked) log("a journal holds run.blocked: nothing was auto-approved");
await finish(blocked ? 4 : failed.length === 0 ? 0 : 1);
