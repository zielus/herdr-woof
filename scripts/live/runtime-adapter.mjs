#!/usr/bin/env node
// Live Herdr runtime adapter check (plan p2 §6c). Not part of `bun run verify`:
// it starts a real Claude Code agent in a new Herdr pane, so a person runs it
// from inside Herdr after `bun run build`.
//
//   node scripts/live/runtime-adapter.mjs --probe   open, start, observe, stop, observe
//   node scripts/live/runtime-adapter.mjs           full run with hard gates
//
// Exit 0 when every gate passes, 1 on a gate or precondition failure, 4 when the
// worker is blocked (nothing is auto-approved). Every read of agent state goes
// through the adapter; the script never reads terminal text or sends keys. The
// pane it opened is always stopped on exit.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sdk = await import(pathToFileURL(join(repo, "dist", "index.js")).href);
const probe = process.argv.includes("--probe");

const PROMPT = "Reply with exactly the word pong. Do not use any tools and do not edit files.";
const START_TIMEOUT_MS = 120_000;
const DELIVERY_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 120_000;

const print = (label, value) =>
  console.log(
    `== ${label.padEnd(26)} ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
const gates = [];
const gate = (number, name, pass, detail) => {
  gates.push({ number, name, pass });
  console.log(
    `${pass ? "PASS" : "FAIL"} gate ${number}: ${name}${detail === undefined ? "" : ` (${detail})`}`,
  );
};
const capture = (command, args, cwd = repo) => {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
  } catch (error) {
    return `unavailable: ${error.message.split("\n")[0]}`;
  }
};

class Blocked extends Error {}

if (process.env.HERDR_ENV !== "1") {
  console.error("precondition failed: HERDR_ENV is not 1; run this from inside a Herdr pane");
  process.exit(1);
}

const stamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace("T", "-").slice(0, 15);
const runId = `live-adapter-${stamp}`;
const runDir = join(
  homedir(),
  ".herdr-dev",
  "runs",
  "herdr-woof",
  "p2-sdk-contracts",
  "live",
  runId,
);
const runtimeName = sdk.herdrRuntimeName(runId, "pinger");
const adapter = sdk.createHerdrCliRuntime({ bin: "herdr", env: process.env });
const gitStatus = () => capture("git", ["status", "--porcelain"]);

print("environment", {
  mode: probe ? "probe" : "full",
  commit: capture("git", ["rev-parse", "HEAD"]),
  herdr: capture("herdr", ["--version"]),
  claude: capture("claude", ["--version"]),
  node: process.version,
  runId,
  runDir,
  runtimeName,
  verifierPane: process.env.HERDR_PANE_ID ?? null,
});

let handle;
let stopped = false;
let cleaning;
async function cleanup(failed) {
  if (handle === undefined || stopped) return;
  cleaning ??= (async () => {
    if (failed) print("observe (on failure)", await adapter.observe(handle));
    const result = await adapter.stop(handle, { timeoutMs: 15_000 });
    stopped = result.ok;
    print("stop (cleanup)", result);
  })();
  await cleaning;
}
process.on("SIGINT", () => {
  void cleanup(true).finally(() => process.exit(130));
});

/** Fails the run as blocked when an observation shows the worker waiting for a person. */
function assertNotBlocked(observation, where) {
  if (observation?.lifecycle === "blocked") throw new Blocked(`worker blocked at ${where}`);
}

async function startWorker() {
  const pane = await adapter.openPane({ near: "current", cwd: runDir, direction: "down" });
  print("openPane", pane);
  if (!pane.ok) throw new Error("openPane failed");
  handle = {
    adapter: "herdr",
    runtimeName,
    kind: "claude",
    paneId: pane.value.paneId,
    paneOwned: true,
    terminalId: null,
    sessionId: null,
  };
  const started = await adapter.startAgent({
    runtimeName,
    kind: "claude",
    paneId: pane.value.paneId,
    paneOwned: true,
    args: ["--permission-mode", "auto", "--add-dir", runDir],
    timeoutMs: START_TIMEOUT_MS,
  });
  print("startAgent", started);
  if (!started.ok) {
    if (started.error.code === "agent_not_ready")
      throw new Blocked("worker blocked during startup");
    throw new Error("startAgent failed");
  }
  handle = started.value;
  return started;
}

async function runProbe() {
  await startWorker();
  const before = await adapter.observe(handle);
  print("observe (before)", before);
  assertNotBlocked(before.ok ? before.value : undefined, "startup");
  const stop = await adapter.stop(handle, { timeoutMs: 15_000 });
  stopped = stop.ok;
  print("stop", stop);
  const after = await adapter.observe(handle);
  print("observe (after)", after);
  const pass =
    before.ok &&
    before.value.lifecycle === "ready" &&
    stop.ok &&
    after.ok &&
    after.value.lifecycle === "gone";
  console.log(pass ? "PROBE PASS" : "PROBE FAIL");
  return pass ? 0 : 1;
}

async function runFull() {
  const statusBefore = gitStatus();
  mkdirSync(runDir, { recursive: true });
  const plan = {
    workflow: { name: "live-adapter-check", version: "1" },
    agents: [{ agentId: "pinger", role: "probe", kind: "claude", model: null }],
    stages: [{ stageId: "ping", agentId: "pinger", verdicts: [] }],
    limits: {
      maxAttemptsPerVisit: 1,
      maxVisitsPerStage: 1,
      maxRounds: 1,
      runTimeoutMs: 600_000,
      readinessWaitMs: 600_000,
      blockedWaitMs: 600_000,
      deliveryTimeoutMs: 600_000,
    },
  };
  print("openRun", await sdk.openRun({ runDir, runId, plan }));

  const started = await startWorker();
  gate(
    1,
    "startAgent ok with terminalId and sessionId",
    started.ok && handle.terminalId !== null && handle.sessionId !== null,
  );

  print(
    "assignAgent",
    await sdk.assignAgent({
      runDir,
      agentId: "pinger",
      runtime: { adapter: "herdr", runtimeName, paneId: handle.paneId },
      terminalId: handle.terminalId,
      sessionId: handle.sessionId,
    }),
  );

  const tracker = new sdk.ObservationTracker();
  const accepted = [];
  const see = (observation, label) => {
    const result = tracker.accept(observation);
    if (result.kind !== "stale" && result.kind !== "duplicate") accepted.push(observation);
    print(label, {
      kind: result.kind,
      lifecycle: observation.lifecycle,
      runtimeStatus: observation.runtimeStatus,
      stateChangeSeq: observation.order.stateChangeSeq,
      terminalId: observation.order.terminalId,
    });
    assertNotBlocked(observation, label);
  };

  const before = await adapter.observe(handle);
  print("observe (before)", before);
  if (before.ok) see(before.value, "track (before)");
  gate(
    2,
    "first observe is ready",
    before.ok && before.value.lifecycle === "ready",
    before.ok ? before.value.runtimeStatus : before.error.code,
  );

  print(
    "openAttempt",
    await sdk.openAttempt({
      runDir,
      runId,
      agentId: "pinger",
      stageId: "ping",
      visit: 1,
      attempt: 1,
      verdicts: [],
      paneId: handle.paneId,
    }),
  );

  const missingName = "w-missing-000000";
  const negative = await adapter.deliver({ ...handle, runtimeName: missingName }, PROMPT, {
    timeoutMs: 5000,
  });
  print("negative deliver", negative);
  const list = await adapter.inspect(["agent", "list"]);
  const names = list.ok ? (list.result.agents ?? []).map((agent) => agent.name) : [];
  print("agent list names", list.ok ? names : list.error);
  gate(
    3,
    "negative deliver is not_delivered/not_found and no such agent exists",
    negative.outcome === "not_delivered" &&
      negative.error.code === "not_found" &&
      list.ok &&
      !names.includes(missingName),
  );

  const delivery = await adapter.deliver(handle, PROMPT, { timeoutMs: DELIVERY_TIMEOUT_MS });
  print("deliver", delivery);
  const reason =
    delivery.outcome === "started"
      ? `observed_${delivery.observation.lifecycle}`
      : delivery.error.code;
  print(
    "recordDispatch",
    await sdk.recordDispatch({
      runDir,
      agentId: "pinger",
      stageId: "ping",
      visit: 1,
      attempt: 1,
      delivery: delivery.outcome,
      reason,
      paneId: handle.paneId,
    }),
  );
  gate(4, "deliver outcome is started", delivery.outcome === "started", delivery.outcome);
  if (delivery.outcome === "started") see(delivery.observation, "track (deliver)");

  if (delivery.outcome !== "not_delivered") {
    if (delivery.outcome === "started") {
      const watch = sdk.watchAgent(adapter, handle, { intervalMs: 500, maxPolls: 240, tracker });
      for await (const item of watch) {
        accepted.push(item.observation);
        print("watch", {
          kind: item.kind,
          lifecycle: item.observation.lifecycle,
          runtimeStatus: item.observation.runtimeStatus,
          stateChangeSeq: item.observation.order.stateChangeSeq,
          terminalId: item.observation.order.terminalId,
        });
        assertNotBlocked(item.observation, "watch");
        if (item.observation.lifecycle === "ready") break;
      }
      print("watch dropped", { ...watch.dropped, error: watch.error ?? null });
    }
    // An ambiguous delivery is never resent: wait for the worker to settle and keep the evidence.
    const ready = await adapter.waitFor(handle, ["ready"], READY_TIMEOUT_MS);
    print("waitFor ready", ready);
    if (ready.ok) see(ready.value, "track (waitFor)");
  }

  const working = accepted.find((observation) => observation.lifecycle === "working");
  const readyAfter = accepted.findLast((observation) => observation.lifecycle === "ready");
  const s0 = before.ok ? before.value.order.stateChangeSeq : null;
  const s1 = working?.order.stateChangeSeq ?? null;
  const s2 = readyAfter?.order.stateChangeSeq ?? null;
  print("sequence", { S0: s0, S1: s1, S2: s2, dropped: tracker.dropped });
  gate(
    5,
    "working then a later ready from the same terminal with a greater stateChangeSeq",
    working !== undefined &&
      readyAfter !== undefined &&
      readyAfter !== before.value &&
      working.order.terminalId === readyAfter.order.terminalId &&
      s1 !== null &&
      s2 !== null &&
      s2 > s1 &&
      (s0 === null || s0 < s1),
    `stale ${tracker.dropped.stale}`,
  );

  const snapshot = sdk.readSnapshot(runDir);
  const overlaid = snapshot.ok ? sdk.overlayRuntime(snapshot.snapshot, tracker) : undefined;
  const attempt = overlaid?.stages[0]?.visits[0]?.attempts[0];
  print("snapshot (worker ready)", {
    status: overlaid?.status,
    attempt: attempt === undefined ? null : { status: attempt.status, delivery: attempt.delivery },
    runtime: overlaid?.agents[0]?.runtime ?? null,
  });
  const recordsNow = sdk.readJournal(runDir);
  gate(
    6,
    "attempt still open after ready; no submission record",
    attempt?.status === "open" &&
      recordsNow.ok &&
      !recordsNow.records.some((record) => record.type.startsWith("submission.")),
  );

  const stop = await adapter.stop(handle, { timeoutMs: 15_000 });
  stopped = stop.ok;
  print("stop", stop);
  const after = await adapter.observe(handle);
  print("observe (after)", after);
  const paneAfter = await adapter.inspect(["pane", "get", handle.paneId]);
  print("pane get (after)", paneAfter.ok ? paneAfter.result : paneAfter.error);
  gate(
    7,
    "stop ok, then gone and pane_not_found",
    stop.ok &&
      after.ok &&
      after.value.lifecycle === "gone" &&
      !paneAfter.ok &&
      paneAfter.error.runtimeCode === "pane_not_found",
  );

  print(
    "terminateRun",
    await sdk.terminateRun({ runDir, outcome: "cancelled", reason: "live adapter check finished" }),
  );

  const journal = sdk.readJournal(runDir);
  const types = journal.ok ? journal.records.map((record) => record.type) : [];
  gate(
    8,
    "journal replays with exactly the expected records",
    journal.ok &&
      JSON.stringify(types) ===
        JSON.stringify([
          "run.opened",
          "agent.assigned",
          "attempt.opened",
          "request.dispatched",
          "run.terminated",
        ]),
    types.join(","),
  );

  let shown;
  try {
    shown = JSON.parse(
      execFileSync("node", [join(repo, "dist", "cli.js"), "run", "show", runDir], {
        encoding: "utf8",
      }),
    );
  } catch (error) {
    shown = { outcome: "failed", message: error.message };
  }
  const shownAttempt = shown.snapshot?.stages[0]?.visits[0]?.attempts[0];
  print("woof run show", {
    outcome: shown.outcome,
    status: shown.snapshot?.status,
    paneId: shown.snapshot?.agents[0]?.assignment?.paneId,
    attempt:
      shownAttempt === undefined
        ? null
        : { status: shownAttempt.status, delivery: shownAttempt.delivery },
    runtime: shown.snapshot?.agents[0]?.runtime,
  });
  gate(
    9,
    "run show: cancelled, pane recorded, attempt abandoned, delivery started, runtime null",
    shown.outcome === "snapshot" &&
      shown.snapshot.status === "cancelled" &&
      shown.snapshot.agents[0]?.assignment?.paneId === handle.paneId &&
      shownAttempt?.status === "abandoned" &&
      shownAttempt?.delivery === "started" &&
      shown.snapshot.agents[0]?.runtime === null,
  );

  gate(10, "git status unchanged (the agent edited nothing)", gitStatus() === statusBefore);

  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const forbidden = [
    ["agent", "read"],
    ["pane", "read"],
    ["send", "keys"],
  ].map((parts) => parts.join(parts[0] === "send" ? "-" : " "));
  const hits = forbidden.filter((text) => source.includes(text));
  print("forbidden command grep", { searched: forbidden, hits });
  gate(11, "the script never names terminal-read or key-sending commands", hits.length === 0);

  console.log(
    "HUMAN INSPECTION: confirm stateChangeSeq values above are monotonic within the terminal, and record whether state_change_seq looks server-global or per-agent (open question R2).",
  );
  const failed = gates.filter((item) => !item.pass);
  console.log(
    failed.length === 0
      ? "ALL GATES PASS"
      : `GATES FAILED: ${failed.map((item) => item.number).join(", ")}`,
  );
  return failed.length === 0 ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = probe ? await runProbe() : await runFull();
} catch (error) {
  exitCode = error instanceof Blocked ? 4 : 1;
  console.error(`${error instanceof Blocked ? "BLOCKED" : "ERROR"}: ${error.message}`);
} finally {
  await cleanup(exitCode !== 0);
}
process.exit(exitCode);
