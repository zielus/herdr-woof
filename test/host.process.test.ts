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
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { distUrl, repoRoot, runNode, runNodeAsync } from "./helpers/process.js";

// Host claim, heartbeat and the metadata reporter (plan T4) as real child
// processes with a temporary HOME. Herdr is only ever the fake fixture.
const fakeHerdr = join(repoRoot, "test", "fixtures", "fake-herdr.mjs");
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

function probe(runDir: string): Json {
  const result = runNode(
    `const { probeHost } = await import(${JSON.stringify(distUrl("host/probe.js"))});
console.log(JSON.stringify(probeHost(process.argv[1])));`,
    [runDir],
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

  it("H9 (PI-008): a claim still being written when first read is read again after a short delay", async () => {
    const runDir = temp();
    const path = join(runDir, "host.json");
    const reader = runNodeAsync(
      `const { probeHost } = await import(${JSON.stringify(distUrl("host/probe.js"))});
const { existsSync } = await import("node:fs");
const path = process.argv[1] + "/host.json";
while (!existsSync(path)) await new Promise((done) => setTimeout(done, 1));
console.log(JSON.stringify(probeHost(process.argv[1])));`,
      [runDir],
      { timeoutMs: 20_000 },
    );
    // Let the reader start polling, then create the claim empty and fill it moments later.
    await delay(1000);
    writeFileSync(path, "");
    await delay(20);
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        kind: "woof.host",
        state: "hosting",
        pid: process.pid,
        hostname: hostname(),
        startedAt: new Date().toISOString(),
        heartbeatMs: 60_000,
      }),
    );
    const result = await reader;
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({ owner: "alive", host: { state: "hosting" } });
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
