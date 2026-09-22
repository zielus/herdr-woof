import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { distUrl, repoRoot, runNode } from "./helpers/process.js";

// Host claim, heartbeat and the metadata reporter (plan T4) as real child
// processes with a temporary HOME. Herdr is only ever the fake fixture.
const fakeHerdr = join(repoRoot, "test", "fixtures", "fake-herdr.mjs");
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  // A killed claim holder may still be writing into its run directory: wait until it is gone
  // (bounded) before anything is removed, and let rmSync retry a directory emptied late (F-002).
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await Promise.race([exited, delay(10_000)]);
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

type Json = Record<string, any>; // oxlint-disable-line no-explicit-any

function temp(prefix = "woof-host-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: temp("woof-host-home-"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...extra,
  };
  for (const key of ["HERDR_PANE_ID", "HERDR_ENV", "WOOF_RUN_DIR"])
    Reflect.deleteProperty(env, key);
  return env;
}

const CLAIM = `const { claimHost } = await import(${JSON.stringify(distUrl("host/claim.js"))});
const [runDir, hold] = [process.argv[1], process.argv[2]];
const claimed = claimHost(runDir, { paneId: "w1:p5", workspaceId: "w1" });
process.stdout.write(JSON.stringify(claimed.ok ? { ok: true, heartbeatMs: claimed.heartbeatMs } : claimed) + "\\n");
if (claimed.ok) {
  if (hold === "hang") setInterval(() => {}, 1000);
  else { await new Promise((done) => setTimeout(done, Number(hold))); claimed.release(4); }
}`;

function startClaim(runDir: string, hold: string, extra: Record<string, string> = {}) {
  const child = spawn("node", ["--input-type=module", "--eval", CLAIM, runDir, hold], {
    env: childEnv(extra),
    cwd: repoRoot,
  });
  children.push(child);
  let stdout = "";
  const firstLine = new Promise<Json>((resolve, reject) => {
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      const end = stdout.indexOf("\n");
      if (end !== -1) resolve(JSON.parse(stdout.slice(0, end)) as Json);
    });
    child.on("error", reject);
  });
  const exit = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return { child, firstLine, exit };
}

function probe(runDir: string, fn = "probeHost"): Json {
  const result = runNode(
    `const probes = await import(${JSON.stringify(distUrl("host/probe.js"))});
console.log(JSON.stringify(probes[process.argv[2]](process.argv[1])));`,
    [runDir, fn],
    { timeoutMs: 5000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.json as unknown as Json;
}

describe("run host claim", () => {
  it("H1: two processes claiming one run directory at once: exactly one wins", async () => {
    const runDir = temp();
    const [a, b] = [startClaim(runDir, "300"), startClaim(runDir, "300")];
    const results = await Promise.all([a.firstLine, b.firstLine]);
    expect(results.filter((result) => result["ok"] === true)).toHaveLength(1);
    expect(results.find((result) => result["ok"] !== true)).toMatchObject({
      ok: false,
      reason: "run_host_claimed",
    });
    await Promise.all([a.exit, b.exit]);
  });

  it("H2: the heartbeat advances the claim's mtime and the probe reports alive", async () => {
    const runDir = temp();
    const host = startClaim(runDir, "2000", { WOOF_HOST_HEARTBEAT_MS: "100" });
    expect(await host.firstLine).toEqual({ ok: true, heartbeatMs: 100 });
    const first = statSync(join(runDir, "host.json")).mtimeMs;
    await delay(450);
    expect(statSync(join(runDir, "host.json")).mtimeMs).toBeGreaterThan(first);
    expect(probe(runDir)).toMatchObject({
      owner: "alive",
      host: {
        state: "hosting",
        pid: host.child.pid,
        paneId: "w1:p5",
        workspaceId: "w1",
        heartbeatMs: 100,
      },
    });
  });

  it("H3: a host killed with SIGKILL is reported lost", async () => {
    const runDir = temp();
    const host = startClaim(runDir, "hang", { WOOF_HOST_HEARTBEAT_MS: "100" });
    await host.firstLine;
    expect(probe(runDir)["owner"]).toBe("alive");
    host.child.kill("SIGKILL");
    await host.exit;
    let owner = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      owner = probe(runDir)["owner"] as string;
      if (owner === "lost") break;
      await delay(100);
    }
    expect(owner).toBe("lost");
    expect(probe(runDir)["host"]).toMatchObject({ state: "hosting", pid: host.child.pid });
    // The evidence a locked writer journals as host.lost; the plain probe's shape is unchanged.
    expect(probe(runDir, "probeHostEvidence")["lostReason"]).toBe("host_process_gone");
    expect(probe(runDir)).not.toHaveProperty("lostReason");
  });

  it("H4 (PI-008): a clean release never rewrites the claim; it records the exit in an exclusive marker", async () => {
    const runDir = temp();
    const host = startClaim(runDir, "100");
    await host.firstLine;
    const claimed = readFileSync(join(runDir, "host.json"), "utf8");
    expect(await host.exit).toBe(0);
    expect(readFileSync(join(runDir, "host.json"), "utf8")).toBe(claimed);
    expect(JSON.parse(claimed)).toMatchObject({ state: "hosting", pid: host.child.pid });
    expect(JSON.parse(readFileSync(join(runDir, "host-exit.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      kind: "woof.host.exit",
      pid: host.child.pid,
      exitedAt: expect.any(String),
      exitCode: 4,
    });
    expect(statSync(join(runDir, "host.json")).mode & 0o777).toBe(0o644);
    expect(statSync(join(runDir, "host-exit.json")).mode & 0o777).toBe(0o444);
    expect(probe(runDir)).toMatchObject({
      owner: "exited",
      host: { state: "exited", exitCode: 4, exitedAt: expect.any(String) },
    });
    expect(probe(runDir, "probeHostEvidence")).not.toHaveProperty("lostReason");
  });

  it("H5: an abandoned run directory refuses a late host", async () => {
    const runDir = temp();
    const abandoned = runNode(
      `const { abandonHost } = await import(${JSON.stringify(distUrl("host/claim.js"))});
console.log(JSON.stringify([abandonHost(process.argv[1], "test launcher"), abandonHost(process.argv[1], "again")]));`,
      [runDir],
    );
    expect(abandoned.status, abandoned.stderr).toBe(0);
    const [first, second] = JSON.parse(abandoned.stdout) as Json[];
    expect(first).toEqual({ ok: true });
    expect(second).toMatchObject({ ok: false, host: { state: "abandoned" } });
    const late = startClaim(runDir, "100");
    expect(await late.firstLine).toMatchObject({
      ok: false,
      reason: "run_host_claimed",
      host: { state: "abandoned" },
    });
    expect(probe(runDir)).toMatchObject({ owner: "unhosted", host: { state: "abandoned" } });
  });

  it("H8 (PI-008): a claim file that exists but does not parse is lost, never unhosted, and refuses a late host", async () => {
    const runDir = temp();
    // What a host killed in the middle of writing its claim leaves behind.
    writeFileSync(join(runDir, "host.json"), '{"schemaVersion":1,"kind":"woof.host","state":"host');
    expect(probe(runDir)).toEqual({
      owner: "lost",
      host: null,
      problem: "host.json exists but is not a valid run host claim",
    });
    const late = startClaim(runDir, "100");
    expect(await late.firstLine).toMatchObject({
      ok: false,
      reason: "run_host_claimed",
      host: null,
    });
  });

  it("H9 (PI-008, PI-105, PI-201): a claim invalid at the first read is read again after a delay; a claim filled in between wins", () => {
    // The internal read seam (readHostClaim, not the package entry) runs at the boundary between
    // the first (empty) read and the delayed re-read, so the claim is filled exactly after one
    // invalid read, never before it.
    const result = runNode(
      `const { readHostClaim } = await import(${JSON.stringify(distUrl("host/probe.js"))});
const { mkdirSync, writeFileSync } = await import("node:fs");
const { hostname } = await import("node:os");
const [root, pid] = [process.argv[1], Number(process.argv[2])];
const claim = JSON.stringify({ schemaVersion: 1, kind: "woof.host", state: "hosting", pid, hostname: hostname(), startedAt: new Date().toISOString(), heartbeatMs: 60000 });
const out = {};
for (const name of ["filled", "never"]) {
  const runDir = root + "/" + name;
  mkdirSync(runDir);
  writeFileSync(runDir + "/host.json", "");
  const reads = [];
  let filledAt = null;
  const claimed = readHostClaim(runDir, {
    onInvalidRead(problem, retry) {
      reads.push({ problem, retry, at: performance.now() });
      if (name === "filled" && retry === 1) {
        writeFileSync(runDir + "/host.json", claim);
        filledAt = performance.now();
      }
    },
  });
  const done = performance.now();
  out[name] = { claimed, retries: reads.map(({ problem, retry }) => ({ problem, retry })), waitedMs: done - (filledAt ?? reads[0]?.at ?? done) };
}
console.log(JSON.stringify(out));`,
      [temp(), String(process.pid)],
      { timeoutMs: 10_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const out = result.json as unknown as Json;
    const problem = "host.json exists but is not a valid run host claim";
    expect(out["filled"]["retries"]).toEqual([{ problem, retry: 1 }]);
    // The re-read came after the retry delay, not straight after the fill.
    expect(out["filled"]["waitedMs"]).toBeGreaterThanOrEqual(45);
    expect(out["filled"]["claimed"]).toMatchObject({
      kind: "valid",
      host: { state: "hosting", pid: process.pid },
    });
    expect(out["never"]["retries"]).toEqual([1, 2, 3].map((retry) => ({ problem, retry })));
    expect(out["never"]["waitedMs"]).toBeGreaterThanOrEqual(135);
    expect(out["never"]["claimed"]).toEqual({ kind: "invalid", problem });
  });

  it("PR #6 (claim.ts:160): a claim whose fchmod fails reports host_claim_failed and closes the descriptor", () => {
    const runDir = temp();
    const result = runNode(
      `const { createRequire, syncBuiltinESMExports } = await import("node:module");
const fs = createRequire(import.meta.url)("node:fs");
const opened = [];
const openSync = fs.openSync;
fs.openSync = (...args) => { const fd = openSync(...args); if (String(args[0]).endsWith("host.json")) opened.push(fd); return fd; };
fs.fchmodSync = () => { const error = new Error("EPERM: operation not permitted, fchmod"); error.code = "EPERM"; throw error; };
syncBuiltinESMExports();
const { claimHost } = await import(${JSON.stringify(distUrl("host/claim.js"))});
const claimed = claimHost(process.argv[1], { paneId: null, workspaceId: null });
const closed = opened.map((fd) => { try { fs.fstatSync(fd); return false; } catch (error) { return error.code === "EBADF"; } });
console.log(JSON.stringify({ claimed, opened: opened.length, closed }));`,
      [runDir],
      { timeoutMs: 10_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toEqual({
      claimed: {
        ok: false,
        reason: "host_claim_failed",
        message: expect.stringContaining("EPERM"),
        host: null,
      },
      opened: 1,
      closed: [true],
    });
  });

  it("PI-104: a release that throws is logged and retried once, and the first result stays authoritative", () => {
    const runDir = temp();
    const result = runNode(
      `const { hostWorkflow } = await import(${JSON.stringify(distUrl("host/run.js"))});
const { readFileSync } = await import("node:fs");
const [runDir, homeDir] = [process.argv[1], process.argv[2]];
const logs = [];
let releases = 0;
const returned = await hostWorkflow({
  runDir, runId: "pi-104", projectDir: null, input: { schemaVersion: 1 }, flags: {}, homeDir,
  createRuntime: async () => ({ ok: false, message: "not reached" }),
  submitCommand: [process.execPath], claimBeforeOpen: false,
  release: () => { releases += 1; throw new Error("close failed"); },
  writeOutcome: true, paneId: null, workspaceId: null, metadata: null,
  log: (line) => logs.push(line),
});
console.log(JSON.stringify({ returned, outcome: JSON.parse(readFileSync(runDir + "/outcome.json", "utf8")), releases, logs }));`,
      [runDir, temp("woof-host-home-")],
      { timeoutMs: 10_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const out = result.json as unknown as Json;
    expect(out["returned"]["output"]["outcome"]).toBe("rejected");
    expect(out["returned"]["output"]["reason"]).not.toBe("engine_invariant");
    expect(out["outcome"]).toEqual(out["returned"]["output"]);
    expect(out["returned"]["code"]).toBe(2);
    expect(out["releases"]).toBe(2);
    expect(
      (out["logs"] as string[]).filter(
        (line) => line === "cannot release the run host claim: close failed",
      ),
    ).toHaveLength(2);
  });

  it("H6: a FIFO or symlink at host.json refuses the claim and probes lost with the problem, without blocking", () => {
    for (const kind of ["fifo", "symlink"]) {
      const runDir = temp();
      const path = join(runDir, "host.json");
      if (kind === "fifo") expect(spawnSync("mkfifo", [path]).status).toBe(0);
      else symlinkSync(join(temp(), "elsewhere.json"), path);
      const result = spawnSync("node", ["--input-type=module", "--eval", CLAIM, runDir, "10"], {
        env: childEnv(),
        encoding: "utf8",
        timeout: 5000,
        killSignal: "SIGKILL",
      });
      expect(result.error, kind).toBeUndefined();
      expect(JSON.parse(result.stdout.trim()), kind).toMatchObject({
        ok: false,
        reason: "run_host_claimed",
        host: null,
      });
      expect(probe(runDir), kind).toEqual({
        owner: "lost",
        host: null,
        problem: "host.json is not a regular file",
      });
    }
  });
});

describe("p5 C3: the probe checks a hosting claim's fields, not only their presence", () => {
  it("refuses a startedAt that is not a date, and defers to the heartbeat for a foreign hostname", () => {
    const result = runNode(
      `const { parseHostInfo, ownerOf } = await import(${JSON.stringify(distUrl("host/probe.js"))});
const { hostname } = await import("node:os");
const mtime = new Date("2026-09-16T00:00:00.000Z");
const claim = (overrides) =>
  JSON.stringify({
    schemaVersion: 1,
    kind: "woof.host",
    state: "hosting",
    pid: process.pid,
    hostname: hostname(),
    startedAt: "2026-09-16T00:00:00.000Z",
    heartbeatMs: 1000,
    ...overrides,
  });
const parsed = (overrides) => parseHostInfo(claim(overrides), mtime) ?? null;
// A dead pid this machine owns; 2^22 - 1 is above every pid_max in practice.
const deadPid = 4194303;
const now = mtime.getTime();
console.log(
  JSON.stringify({
    valid: parsed({}) !== null,
    unparseable: parsed({ startedAt: "not a date" }),
    empty: parsed({ startedAt: "" }),
    numeric: parsed({ startedAt: 1758000000000 }),
    // An exited claim carries no liveness fields, so the rule does not reach it.
    exitedKeepsLooseStartedAt:
      parseHostInfo(claim({ state: "exited", startedAt: "whenever" }), mtime) !== null,
    // A claim from another machine: this machine's pid table says nothing about it,
    // so freshness alone decides. Fresh → alive even though the pid is dead here.
    foreignFresh: ownerOf(
      { ...parsed({ hostname: "another-machine" }), pid: deadPid, heartbeatAt: mtime.toISOString() },
      { now },
    ),
    foreignStale: ownerOf(
      { ...parsed({ hostname: "another-machine" }), pid: deadPid, heartbeatAt: mtime.toISOString() },
      { now: now + 60_000 },
    ),
    // The same claim on this machine with a dead pid is lost at once, fresh or not.
    localDead: ownerOf(
      { ...parsed({}), pid: deadPid, heartbeatAt: mtime.toISOString() },
      { now },
    ),
  }),
);`,
    );
    expect(result.status, result.stderr).toBe(0);
    const out = result.json as unknown as Json;
    expect(out["valid"]).toBe(true);
    // Presence and type are no longer enough: the value must be a date.
    expect(out["unparseable"]).toBeNull();
    expect(out["empty"]).toBeNull();
    expect(out["numeric"]).toBeNull();
    expect(out["exitedKeepsLooseStartedAt"]).toBe(true);
    expect(out["foreignFresh"]).toBe("alive");
    expect(out["foreignStale"]).toBe("lost");
    expect(out["localDead"]).toBe("lost");
  });
});

describe("metadata refresh coalescing (PR #6 run.ts:293)", () => {
  it("runs one report at a time, folds a burst of requests into one follow-up each round and drains promptly", () => {
    const result = runNode(
      `const { createCoalescer } = await import(${JSON.stringify(distUrl("host/metadata.js"))});
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let calls = 0;
let active = 0;
let maxActive = 0;
const coalescer = createCoalescer(async () => {
  calls += 1;
  active += 1;
  maxActive = Math.max(maxActive, active);
  await sleep(200);
  active -= 1;
});
const burstStart = performance.now();
for (let i = 0; i < 500; i += 1) {
  coalescer.request();
  await sleep(1);
}
const burstMs = performance.now() - burstStart;
const callsAtDrain = calls;
const drainStart = performance.now();
await coalescer.drain();
const drainMs = performance.now() - drainStart;
coalescer.request();
await sleep(300);
console.log(JSON.stringify({ calls, callsAtDrain, maxActive, burstMs, drainMs }));`,
      [],
      { timeoutMs: 20_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const out = result.json as unknown as Json;
    expect(out["maxActive"]).toBe(1);
    // 500 requests over the burst: one run per 200 ms task, plus the first and the final follow-up.
    expect(out["calls"]).toBeLessThanOrEqual(Math.ceil(out["burstMs"] / 200) + 2);
    expect(out["calls"]).toBeGreaterThanOrEqual(2);
    // Drain waits for the run in flight only, and nothing runs after it.
    expect(out["drainMs"]).toBeLessThanOrEqual(450);
    expect(out["calls"]).toBe(out["callsAtDrain"]);
  });
});

describe("metadata reporter against the fake herdr", () => {
  const REPORT = `const store = await import(${JSON.stringify(distUrl("state/store.js"))});
const { readSnapshot } = await import(${JSON.stringify(distUrl("state/snapshot.js"))});
const { openAttempt } = await import(${JSON.stringify(distUrl("submission/attempt.js"))});
const { createMetadataReporter } = await import(${JSON.stringify(distUrl("host/metadata.js"))});
const [runDir, bin] = [process.argv[1], process.argv[2]];
const snap = () => readSnapshot(runDir).snapshot;
const limits = { maxAttemptsPerVisit: 2, maxVisitsPerStage: 3, maxRounds: 3, runTimeoutMs: 600000, readinessWaitMs: 60000, blockedWaitMs: 60000, deliveryTimeoutMs: 10000 };
await store.openRun({ runDir, runId: "run-meta", plan: {
  workflow: { name: "report-review", version: "1" },
  agents: [{ agentId: "worker", role: "writer", kind: "claude", model: null }],
  stages: [{ stageId: "report", agentId: "worker", verdicts: [] }], limits } });
const logs = [];
const reporter = createMetadataReporter({ bin, env: process.env, hostPaneId: "w1:p1", workflow: "report-review", runId: "run-meta", log: (message) => logs.push(message) });
await reporter.report(snap());
await store.assignAgent({ runDir, agentId: "worker", runtime: { adapter: "herdr", runtimeName: "w-worker", paneId: "w1:p2" } });
await openAttempt({ runDir, runId: "run-meta", agentId: "worker", stageId: "report", visit: 1, attempt: 1 });
await store.recordDispatch({ runDir, agentId: "worker", stageId: "report", visit: 1, attempt: 1, delivery: "started", reason: "observed_working" });
await reporter.report(snap());
await reporter.report(snap());
await store.blockRun({ runDir, agentId: "worker", reason: "startup_blocked", requiredAction: "accept the folder trust question in the agent pane", observed: { runtimeStatus: "blocked", terminalId: null, stateChangeSeq: null } });
await reporter.report(snap());
await store.terminateRun({ runDir, outcome: "exhausted", reason: "the run hit maxRounds", limit: "maxRounds" });
await reporter.finish(snap());
console.log(JSON.stringify({ logs }));`;

  function runReporter(scenario: unknown[]) {
    const root = temp();
    const runDir = join(root, "run");
    const log = join(root, "herdr.log");
    const scenarioPath = join(root, "scenario.json");
    writeFileSync(scenarioPath, JSON.stringify(scenario));
    const result = spawnSync("node", ["--input-type=module", "--eval", REPORT, runDir, fakeHerdr], {
      env: childEnv({ FAKE_HERDR_LOG: log, FAKE_HERDR_SCENARIO: scenarioPath }),
      encoding: "utf8",
      cwd: repoRoot,
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as string[]);
    return { calls, logs: (JSON.parse(result.stdout.trim()) as { logs: string[] }).logs };
  }

  it("H7: reports schema-valid tokens on change, notifies on block and termination", () => {
    const { calls, logs } = runReporter([
      { match: ["pane", "report-metadata"], stdout: "{}" },
      { match: ["notification", "show"], stdout: "{}" },
    ]);
    expect(logs).toEqual([]);
    const reports = calls.filter((argv) => argv[0] === "pane");
    for (const argv of reports) {
      argv.forEach((part, index) => {
        if (argv[index - 1] !== "--token") return;
        const [name, ...rest] = part.split("=");
        expect(name).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
        expect(rest.join("=").length).toBeLessThanOrEqual(64);
      });
    }
    const host = (token: string, ttl: string) => [
      "pane",
      "report-metadata",
      "w1:p1",
      "--source",
      "woof",
      "--title",
      "woof report-review run-meta",
      "--token",
      `woof=${token}`,
      "--ttl-ms",
      ttl,
    ];
    const agent = (token: string, ttl: string) => [
      "pane",
      "report-metadata",
      "w1:p2",
      "--source",
      "woof",
      "--token",
      `woof=${token}`,
      "--token",
      "woof-role=writer",
      "--ttl-ms",
      ttl,
    ];
    expect(calls).toEqual([
      host("starting", "30000"),
      // The dispatched attempt changes both tokens; the unchanged third report sends nothing.
      host("running report v1 a1 r0", "30000"),
      agent("report v1 a1", "30000"),
      host("blocked startup_blocked", "30000"),
      agent("report v1 a1", "30000"),
      [
        "notification",
        "show",
        "Woof: run-meta blocked",
        "--body",
        "accept the folder trust question in the agent pane",
      ],
      host("exhausted maxRounds", "600000"),
      agent("idle", "600000"),
      ["notification", "show", "Woof: run-meta exhausted", "--body", "the run hit maxRounds"],
    ]);
  });

  it("H7: a failing herdr is logged and never throws", () => {
    const { calls, logs } = runReporter([{ match: [], exit: 1, stderr: "server unavailable\n" }]);
    expect(calls.length).toBeGreaterThan(0);
    expect(logs.length).toBe(calls.length);
    expect(logs[0]).toBe("metadata: herdr pane report-metadata failed: server unavailable");
  });
});
