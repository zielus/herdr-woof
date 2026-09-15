import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { cliPath, distUrl, repoRoot, runNode } from "./helpers/process.js";

// `woof run start` / `woof run host` (plan T5) as real processes. The Herdr CLI
// is the fake fixture by absolute path (WOOF_HERDR_BIN); its `pane run` entry
// spawns the typed host command detached, standing in for a fresh pane.
const fakeHerdr = join(repoRoot, "test", "fixtures", "fake-herdr.mjs");
const runtimeModule = join(repoRoot, "test", "fixtures", "scripted-runtime-module.mjs");
const slowStopModule = join(repoRoot, "test", "fixtures", "slow-stop-runtime-module.mjs");
const pendingModule = join(repoRoot, "test", "fixtures", "pending-runtime-module.mjs");

function withRuntime(args: string[], module: string): string[] {
  return args.map((arg) => (arg === runtimeModule ? module : arg));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const dirs: string[] = [];
const runDirs: string[] = [];
afterEach(() => {
  // Detached hosts outlive a failed assertion: kill any that still hold a claim.
  for (const runDir of runDirs.splice(0)) {
    try {
      const host = JSON.parse(readFileSync(join(runDir, "host.json"), "utf8")) as Json;
      if (
        host["state"] === "hosting" &&
        !existsSync(join(runDir, "host-exit.json")) &&
        typeof host["pid"] === "number"
      )
        process.kill(host["pid"], "SIGKILL");
    } catch {
      // No claim, or the host is already gone.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Json = Record<string, any>; // oxlint-disable-line no-explicit-any

interface Workspace {
  root: string;
  home: string;
  repo: string;
  log: string;
  scenario: string;
  inputPath: string;
  release: string;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Woof Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
  );
  expect(result.status, result.stderr).toBe(0);
}

function workspace(paneId = "w9:p2", spawnHost = true): Workspace {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "woof-run-start-")));
  dirs.push(root);
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  // Configuration is not part of the reviewed tree: a mid-run edit must not move the revision.
  appendFileSync(join(repo, ".git", "info", "exclude"), ".woof/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const ws: Workspace = {
    root,
    home,
    repo,
    log: join(root, "herdr.log"),
    scenario: join(root, "scenario.json"),
    inputPath: join(root, "input.json"),
    release: join(root, "release"),
  };
  writeScenario(ws, paneId, spawnHost);
  writeFileSync(ws.inputPath, JSON.stringify(input(repo)));
  return ws;
}

function writeScenario(ws: Workspace, paneId: string, spawnHost: boolean): void {
  writeFileSync(
    ws.scenario,
    JSON.stringify([
      {
        match: ["pane", "split"],
        stdout: JSON.stringify({ result: { pane: { pane_id: paneId } } }),
      },
      {
        match: ["pane", "run"],
        stdout: "{}",
        ...(spawnHost
          ? {
              spawn: {
                commandIndex: 3,
                env: { HERDR_ENV: "1", HERDR_PANE_ID: paneId },
                log: join(ws.root, "host.log"),
              },
            }
          : {}),
      },
      { match: ["pane", "report-metadata"], stdout: "{}" },
      { match: ["notification", "show"], stdout: "{}" },
    ]),
  );
}

function input(repo: string, overrides: Json = {}): Json {
  return {
    schemaVersion: 1,
    repo,
    task: {
      title: "Change the fixture",
      description: "Write src/change.txt.",
      acceptanceCriteria: ["the file exists"],
    },
    limits: {
      runTimeoutMs: 60_000,
      readinessWaitMs: 10_000,
      blockedWaitMs: 10_000,
      deliveryTimeoutMs: 10_000,
    },
    ...overrides,
  };
}

function env(ws: Workspace, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: ws.home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w9:p1",
    WOOF_HERDR_BIN: fakeHerdr,
    FAKE_HERDR_LOG: ws.log,
    FAKE_HERDR_SCENARIO: ws.scenario,
    WOOF_TEST_SCRIPT: "happy",
    WOOF_TEST_RELEASE: ws.release,
    WOOF_HOST_HEARTBEAT_MS: "200",
    ...extra,
  };
  Reflect.deleteProperty(childEnv, "WOOF_RUN_DIR");
  for (const [key, value] of Object.entries(childEnv))
    if (value === undefined) Reflect.deleteProperty(childEnv, key);
  return childEnv;
}

function woofIn(ws: Workspace, args: string[], extra: Record<string, string | undefined> = {}) {
  const result = spawnSync("node", [cliPath, ...args], {
    cwd: ws.root,
    env: env(ws, extra),
    encoding: "utf8",
    timeout: 60_000,
  });
  const last = result.stdout.trim().split("\n").at(-1) ?? "";
  let json: Json | undefined;
  try {
    json = JSON.parse(last) as Json;
  } catch {
    json = undefined;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function startArgs(ws: Workspace, runDir: string, extra: string[] = []): string[] {
  runDirs.push(runDir);
  return [
    "run",
    "start",
    "--input",
    ws.inputPath,
    "--project",
    ws.repo,
    "--run-dir",
    runDir,
    "--runtime-module",
    runtimeModule,
    "--poll-ms",
    "5",
    ...extra,
  ];
}

function fakeCalls(ws: Workspace): string[][] {
  return existsSync(ws.log)
    ? readFileSync(ws.log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as string[])
    : [];
}

function records(runDir: string): Json[] {
  return existsSync(join(runDir, "journal.jsonl"))
    ? readFileSync(join(runDir, "journal.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Json)
    : [];
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(50);
  }
}

/** Waits until the host has written outcome.json (the run ended and the claim was released). */
async function waitForOutcome(runDir: string, timeoutMs = 30_000): Promise<Json> {
  await waitFor(
    () => existsSync(join(runDir, "outcome.json")),
    `outcome.json in ${runDir}`,
    timeoutMs,
  );
  await waitFor(
    () => existsSync(join(runDir, "host-exit.json")),
    "the host to record its exit",
    timeoutMs,
  );
  return JSON.parse(readFileSync(join(runDir, "outcome.json"), "utf8")) as Json;
}

function show(ws: Workspace, runDir: string): Json {
  const shown = woofIn(ws, ["run", "show", runDir]);
  expect(shown.status, shown.stdout + shown.stderr).toBe(0);
  return shown.json?.["snapshot"] as Json;
}

describe("woof run start --host herdr-pane", () => {
  it("S1: launches the host in a split pane, returns once it opened the run, and the host finishes it", async () => {
    const ws = workspace();
    const runDir = join(ws.root, "run");
    const started = woofIn(ws, startArgs(ws, runDir, ["--run-id", "s1-run"]), {
      WOOF_TEST_SCRIPT: "slow",
    });
    const launcherExitedAt = new Date().toISOString();
    expect(started.status, started.stdout + started.stderr).toBe(0);
    expect(started.stdout.trim().split("\n")).toHaveLength(1);
    expect(started.json).toMatchObject({
      outcome: "started",
      runId: "s1-run",
      runDir,
      workflow: { name: "build-review", version: "1" },
      host: { mode: "herdr-pane", paneId: "w9:p2", pid: expect.any(Number) },
      configuration: {
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        agents: {
          builder: { kind: "claude", model: null, source: "builtin", path: null },
          reviewer: { kind: "claude", model: null, source: "builtin", path: null },
        },
      },
      next: {
        status: ["woof", "status", runDir, "--wait"],
        cancel: ["woof", "run", "cancel", runDir],
      },
    });

    const calls = fakeCalls(ws);
    expect(calls[0]).toEqual([
      "pane",
      "split",
      "--current",
      "--direction",
      "right",
      "--cwd",
      ws.repo,
      "--no-focus",
    ]);
    expect(calls[1]?.slice(0, 3)).toEqual(["pane", "run", "w9:p2"]);
    expect(calls[1]?.slice(4)).toEqual([cliPath, "run", "host", runDir]);
    expect(calls[1]?.[3]).toMatch(/^\/.*node[^/]*$/);

    writeFileSync(ws.release, "go\n");
    const outcome = await waitForOutcome(runDir);
    expect(outcome).toMatchObject({
      outcome: "run",
      result: { outcome: "completed", runId: "s1-run" },
    });
    // outcome.json is the host's stdout line. LV-004: the redirected stdout can reach host.log after
    // outcome.json exists, so the line is awaited (bounded) rather than read once.
    let hostStdout: string | undefined;
    await waitFor(
      () => {
        hostStdout = existsSync(join(ws.root, "host.log"))
          ? readFileSync(join(ws.root, "host.log"), "utf8")
              .split("\n")
              .findLast((line) => line.startsWith("{"))
          : undefined;
        return hostStdout !== undefined;
      },
      "the host's result line in host.log",
      15_000,
    );
    expect(JSON.parse(hostStdout ?? "null")).toEqual(outcome);
    // The caller's wait returns the same result (plan §3.9 step 5).
    const waited = woofIn(ws, ["status", runDir, "--wait", "--poll-ms", "50"]);
    expect(waited.status, waited.stdout + waited.stderr).toBe(0);
    expect(waited.json?.["result"]).toEqual(outcome["result"]);
    expect(waited.json?.["status"]["liveness"]).toMatchObject({ owner: "exited" });

    const derived = runNode(
      `const { readSnapshot } = await import(${JSON.stringify(distUrl("state/snapshot.js"))});
const { deriveRunResult } = await import(${JSON.stringify(distUrl("state/result.js"))});
const read = readSnapshot(process.argv[1]);
console.log(JSON.stringify({ result: deriveRunResult(read.snapshot, { runDir: process.argv[1], repository: process.argv[2] }), liveness: read.snapshot.liveness }));`,
      [runDir, ws.repo],
    );
    expect(derived.status, derived.stderr).toBe(0);
    const parsed = JSON.parse(derived.stdout.trim()) as Json;
    expect(parsed["result"]).toEqual(outcome["result"]);
    expect(parsed["liveness"]).toMatchObject({
      owner: "exited",
      host: { state: "exited", exitCode: 0, paneId: "w9:p2" },
    });

    const terminated = records(runDir).find((record) => record["type"] === "run.terminated");
    expect(String(terminated?.["ts"]) > launcherExitedAt).toBe(true);
    // The host reported state on its own pane through the fake Herdr.
    expect(fakeCalls(ws).some((argv) => argv[1] === "report-metadata" && argv[2] === "w9:p2")).toBe(
      true,
    );
  }, 60_000);

  it("S2: invalid input is rejected before any pane or run directory exists", () => {
    const ws = workspace();
    writeFileSync(ws.inputPath, JSON.stringify(input(ws.repo, { task: { title: "" } })));
    const runDir = join(ws.root, "run");
    const result = woofIn(ws, startArgs(ws, runDir));
    expect(result.status).toBe(2);
    expect(result.json).toMatchObject({ outcome: "rejected", reason: "input_invalid" });
    expect(fakeCalls(ws)).toEqual([]);
    expect(existsSync(runDir)).toBe(false);
  });

  it("S3: a host that never starts is abandoned within hostStartTimeoutMs, and a late host is refused", () => {
    const ws = workspace("w9:p2", false);
    const runDir = join(ws.root, "run");
    const started = Date.now();
    const result = woofIn(ws, startArgs(ws, runDir, ["--host-start-timeout-ms", "1000"]));
    expect(result.status, result.stdout).toBe(3);
    expect(result.json).toMatchObject({ outcome: "rejected", reason: "host_not_started" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(JSON.parse(readFileSync(join(runDir, "host.json"), "utf8"))).toMatchObject({
      state: "abandoned",
    });
    const late = woofIn(ws, ["run", "host", runDir]);
    expect(late.status).toBe(2);
    expect(late.json).toMatchObject({ outcome: "rejected", reason: "run_host_claimed" });
    expect(existsSync(join(runDir, "journal.jsonl"))).toBe(false);
  });

  it("S4: a host killed with SIGKILL leaves a lost owner that woof run cancel can close", async () => {
    const ws = workspace();
    const runDir = join(ws.root, "run");
    const started = woofIn(ws, startArgs(ws, runDir), { WOOF_TEST_SCRIPT: "hang" });
    expect(started.status, started.stdout + started.stderr).toBe(0);
    await waitFor(
      () => records(runDir).some((record) => record["type"] === "request.dispatched"),
      "a dispatch",
    );
    // PI-009: a journal record can be visible before its writer removes journal.lock. A kill inside
    // that window leaves a stale lock (carry-over C1): run cancel then exits 3 journal_busy and the
    // lock is removed by hand. This case kills a host that holds no lock.
    await waitFor(() => !existsSync(join(runDir, "journal.lock")), "the journal lock to be free");
    const pid = (JSON.parse(readFileSync(join(runDir, "host.json"), "utf8")) as Json)[
      "pid"
    ] as number;
    process.kill(pid, "SIGKILL");
    await waitFor(() => show(ws, runDir)["liveness"]["owner"] === "lost", "owner lost", 15_000);
    const waitedLost = woofIn(ws, [
      "status",
      runDir,
      "--wait",
      "--poll-ms",
      "50",
      "--timeout-ms",
      "15000",
    ]);
    expect(waitedLost.status, waitedLost.stdout).toBe(8);
    expect(waitedLost.json?.["status"]["liveness"]).toMatchObject({ owner: "lost" });
    const cancelled = woofIn(ws, ["run", "cancel", runDir]);
    expect(cancelled.status, cancelled.stdout).toBe(0);
    expect(show(ws, runDir)).toMatchObject({
      status: "cancelled",
      liveness: { owner: "lost", host: { state: "hosting", pid } },
    });
    // A recorded outcome wins over a lost owner.
    expect(woofIn(ws, ["status", runDir, "--wait"]).status).toBe(6);
  }, 60_000);

  it("PI-001: a pane host signalled twice releases its claim with exit 130 and records outcome.json", async () => {
    const ws = workspace();
    const runDir = join(ws.root, "run");
    const started = woofIn(ws, withRuntime(startArgs(ws, runDir), slowStopModule), {
      WOOF_TEST_SCRIPT: "hang",
    });
    expect(started.status, started.stdout + started.stderr).toBe(0);
    await waitFor(
      () => records(runDir).some((record) => record["type"] === "request.dispatched"),
      "a dispatch",
    );
    const pid = (JSON.parse(readFileSync(join(runDir, "host.json"), "utf8")) as Json)[
      "pid"
    ] as number;
    process.kill(pid, "SIGINT");
    await delay(300);
    process.kill(pid, "SIGTERM");
    await waitFor(() => !processAlive(pid), "the host to exit", 15_000);
    expect(JSON.parse(readFileSync(join(runDir, "host-exit.json"), "utf8"))).toMatchObject({
      exitCode: 130,
    });
    expect(JSON.parse(readFileSync(join(runDir, "outcome.json"), "utf8"))).toMatchObject({
      outcome: "rejected",
      reason: "host_interrupted",
    });
    expect(woofIn(ws, ["status", runDir]).json?.["status"]["liveness"]).toMatchObject({
      owner: "exited",
      host: { state: "exited", exitCode: 130 },
    });
  }, 60_000);

  it("PI-001: a foreground host signalled twice exits 130 and records its exit", async () => {
    const ws = workspace();
    const runDir = join(ws.root, "run");
    const child = spawn(
      "node",
      [cliPath, ...withRuntime(startArgs(ws, runDir), slowStopModule), "--host", "foreground"],
      { cwd: ws.root, env: env(ws, { WOOF_TEST_SCRIPT: "hang" }), stdio: "ignore" },
    );
    const exited = new Promise<number | null>((resolve) =>
      child.on("close", (code) => resolve(code)),
    );
    await waitFor(
      () => records(runDir).some((record) => record["type"] === "request.dispatched"),
      "a dispatch",
    );
    child.kill("SIGINT");
    await delay(300);
    child.kill("SIGTERM");
    expect(await exited).toBe(130);
    expect(JSON.parse(readFileSync(join(runDir, "host-exit.json"), "utf8"))).toMatchObject({
      exitCode: 130,
    });
    expect(existsSync(join(runDir, "outcome.json"))).toBe(false);
  }, 60_000);

  it("PI-102: a foreign exit marker during a live run reads alive with the claim problem, never exited, and lost once the host is gone", async () => {
    const ws = workspace();
    const runDir = join(ws.root, "run");
    const started = woofIn(ws, withRuntime(startArgs(ws, runDir), slowStopModule), {
      WOOF_TEST_SCRIPT: "hang",
    });
    expect(started.status, started.stdout + started.stderr).toBe(0);
    await waitFor(
      () => records(runDir).some((record) => record["type"] === "request.dispatched"),
      "a dispatch",
    );
    const pid = (JSON.parse(readFileSync(join(runDir, "host.json"), "utf8")) as Json)[
      "pid"
    ] as number;
    const forged = JSON.stringify({
      schemaVersion: 1,
      kind: "woof.host.exit",
      pid: 1,
      exitedAt: "2000-01-01T00:00:00.000Z",
      exitCode: 99,
    });
    writeFileSync(join(runDir, "host-exit.json"), forged);
    const problem = `host-exit.json records pid 1, but host.json was claimed by pid ${pid}`;
    const running = woofIn(ws, ["status", runDir]).json?.["status"];
    expect(processAlive(pid)).toBe(true);
    expect(running["status"]).toBe("running");
    expect(running["liveness"]).toMatchObject({
      owner: "alive",
      host: { state: "hosting", pid, exitCode: null },
      claimProblem: problem,
    });

    process.kill(pid, "SIGINT");
    await delay(300);
    process.kill(pid, "SIGTERM");
    await waitFor(() => !processAlive(pid), "the host to exit", 15_000);
    expect(JSON.parse(readFileSync(join(runDir, "outcome.json"), "utf8"))).toMatchObject({
      reason: "host_interrupted",
    });
    // The host could not create its own marker: the foreign one stays, and the gone host is lost.
    expect(readFileSync(join(runDir, "host-exit.json"), "utf8")).toBe(forged);
    expect(woofIn(ws, ["status", runDir]).json?.["status"]["liveness"]).toMatchObject({
      owner: "lost",
      host: { state: "hosting", pid },
      claimProblem: problem,
    });
  }, 60_000);

  it("PI-101: a pane host signalled once while its runtime factory is pending exits 130 and the launcher reports host_interrupted", async () => {
    const ws = workspace();
    const runDir = join(ws.root, "run");
    const entered = join(ws.root, "entered");
    const launcher = spawn(
      "node",
      [cliPath, ...withRuntime(startArgs(ws, runDir), pendingModule)],
      {
        cwd: ws.root,
        env: env(ws, { WOOF_TEST_ENTERED: entered }),
      },
    );
    let stdout = "";
    launcher.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    const launched = new Promise<number | null>((resolve) =>
      launcher.on("close", (code) => resolve(code)),
    );
    await waitFor(() => existsSync(entered), "the pane host to enter its runtime factory");
    const pid = Number(readFileSync(entered, "utf8").trim());
    expect((JSON.parse(readFileSync(join(runDir, "host.json"), "utf8")) as Json)["pid"]).toBe(pid);
    process.kill(pid, "SIGINT");
    await waitFor(() => !processAlive(pid), "the host to exit after one signal", 10_000);
    expect(JSON.parse(readFileSync(join(runDir, "host-exit.json"), "utf8"))).toMatchObject({
      pid,
      exitCode: 130,
    });
    expect(JSON.parse(readFileSync(join(runDir, "outcome.json"), "utf8"))).toMatchObject({
      outcome: "rejected",
      reason: "host_interrupted",
    });
    expect(existsSync(join(runDir, "journal.jsonl"))).toBe(false);
    expect(await launched).toBe(3);
    expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "null")).toMatchObject({
      outcome: "rejected",
      reason: "host_interrupted",
    });
  }, 60_000);

  it("PI-101: a foreground host signalled once while its runtime factory is pending exits 130 with host_interrupted", async () => {
    const ws = workspace();
    const runDir = join(ws.root, "run");
    const entered = join(ws.root, "entered");
    const child = spawn(
      "node",
      [cliPath, ...withRuntime(startArgs(ws, runDir), pendingModule), "--host", "foreground"],
      { cwd: ws.root, env: env(ws, { WOOF_TEST_ENTERED: entered }) },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    const exited = new Promise<number | null>((resolve) =>
      child.on("close", (code) => resolve(code)),
    );
    try {
      await waitFor(() => existsSync(entered), "the host to enter its runtime factory");
      child.kill("SIGINT");
      await waitFor(() => child.exitCode !== null, "the host to exit after one signal", 10_000);
    } finally {
      // A host that ignores the signal holds no claim for afterEach to find.
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    expect(await exited).toBe(130);
    expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "null")).toMatchObject({
      outcome: "rejected",
      reason: "host_interrupted",
    });
    // A foreground host claims only once its runtime exists: nothing was claimed or opened.
    for (const name of ["host.json", "host-exit.json", "journal.jsonl"])
      expect(existsSync(join(runDir, name)), name).toBe(false);
  }, 60_000);

  it("a pane host that claimed the run and then fails to create its runtime reports the rejection and releases", () => {
    const ws = workspace();
    const runDir = join(ws.root, "run");
    const started = Date.now();
    const result = woofIn(
      ws,
      startArgs(ws, runDir).map((arg) =>
        arg === runtimeModule ? join(repoRoot, "test", "fixtures", "bad-runtime-module.mjs") : arg,
      ),
    );
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.json).toMatchObject({ outcome: "rejected" });
    expect(result.json?.["reason"]).not.toBe("host_unresponsive");
    // The launcher does not load the runtime module; the pane host claimed first, then failed.
    expect(JSON.parse(readFileSync(join(runDir, "host-exit.json"), "utf8"))).toMatchObject({
      exitCode: result.status,
    });
    expect(JSON.parse(readFileSync(join(runDir, "outcome.json"), "utf8"))).toEqual(result.json);
    expect(existsSync(join(runDir, "journal.jsonl"))).toBe(false);
  }, 60_000);

  it("S5: outside Herdr the launcher refuses and names --host foreground", () => {
    const ws = workspace();
    const runDir = join(ws.root, "run");
    const result = woofIn(ws, startArgs(ws, runDir), {
      HERDR_ENV: undefined,
      HERDR_PANE_ID: undefined,
    });
    expect(result.status).toBe(3);
    expect(result.json).toMatchObject({ outcome: "rejected", reason: "runtime_unavailable" });
    expect(result.json?.["message"]).toContain("--host foreground");
    expect(fakeCalls(ws)).toEqual([]);
    expect(existsSync(runDir)).toBe(false);
  });

  it("S6: a project workflow module is loaded once, in the host", async () => {
    const ws = workspace();
    const counter = join(ws.root, "loaded.txt");
    const module = join(ws.repo, ".woof", "workflows", "build-review.mjs");
    mkdirSync(dirname(module), { recursive: true });
    writeFileSync(
      module,
      `import { appendFileSync } from "node:fs";
import { buildReviewWorkflow } from ${JSON.stringify(distUrl("workflows/build-review.js"))};
appendFileSync(${JSON.stringify(counter)}, "loaded\\n");
export default buildReviewWorkflow;
`,
    );
    const runDir = join(ws.root, "run");
    const started = woofIn(ws, startArgs(ws, runDir));
    expect(started.status, started.stdout + started.stderr).toBe(0);
    expect(await waitForOutcome(runDir)).toMatchObject({ result: { outcome: "completed" } });
    expect(readFileSync(counter, "utf8")).toBe("loaded\n");
    const recorded = JSON.parse(readFileSync(join(runDir, "config.json"), "utf8")) as Json;
    expect(recorded["workflow"]).toMatchObject({
      source: "project",
      path: module,
      value: { name: "build-review", version: "1" },
    });
  }, 60_000);

  it("S7: editing configuration mid-run changes nothing in the run; config show reports the edit", async () => {
    const ws = workspace();
    const roleFile = join(ws.repo, ".woof", "roles", "builder.json");
    const settingsFile = join(ws.repo, ".woof", "woof.json");
    mkdirSync(dirname(roleFile), { recursive: true });
    writeFileSync(roleFile, JSON.stringify({ schemaVersion: 1, kind: "claude", model: "sonnet" }));
    writeFileSync(
      settingsFile,
      JSON.stringify({ schemaVersion: 1, defaults: { limits: { maxRounds: 5 } } }),
    );
    const runDir = join(ws.root, "run");
    const runtimeLog = join(ws.root, "runtime.log");
    const started = woofIn(ws, startArgs(ws, runDir), {
      WOOF_TEST_SCRIPT: "slow",
      WOOF_TEST_RUNTIME_LOG: runtimeLog,
    });
    expect(started.status, started.stdout + started.stderr).toBe(0);
    await waitFor(
      () => records(runDir).some((record) => record["type"] === "request.dispatched"),
      "a dispatch",
    );

    writeFileSync(roleFile, JSON.stringify({ schemaVersion: 1, kind: "claude", model: "opus" }));
    writeFileSync(
      settingsFile,
      JSON.stringify({ schemaVersion: 1, defaults: { limits: { maxRounds: 1 } } }),
    );
    writeFileSync(ws.release, "go\n");
    expect(await waitForOutcome(runDir)).toMatchObject({ result: { outcome: "completed" } });

    const opened = records(runDir)[0] as Json;
    expect(opened["plan"]["agents"][0]).toMatchObject({ agentId: "builder", model: "sonnet" });
    expect(opened["plan"]["limits"]["maxRounds"]).toBe(5);
    const configBytes = readFileSync(join(runDir, "config.json"));
    expect(opened["config"]).toMatchObject({
      sha256: runNode(
        `import { createHash } from "node:crypto"; import { readFileSync } from "node:fs";
console.log(JSON.stringify({ h: createHash("sha256").update(readFileSync(process.argv[1])).digest("hex") }));`,
        [join(runDir, "config.json")],
      ).json?.["h" as never],
      bytes: configBytes.byteLength,
    });
    const recorded = JSON.parse(configBytes.toString("utf8")) as Json;
    expect(recorded["agents"]["builder"]).toMatchObject({
      source: "project",
      path: roleFile,
      value: { model: "sonnet" },
    });
    expect(recorded["settings"]["limits"]["maxRounds"]).toMatchObject({
      value: 5,
      source: "project",
    });
    expect(readFileSync(runtimeLog, "utf8")).toContain('"model":"sonnet"');

    const now = woofIn(ws, ["config", "show", "--project", ws.repo]);
    expect(now.status).toBe(0);
    expect(now.json?.["configuration"]["roles"]["builder"]).toMatchObject({
      source: "project",
      value: { model: "opus" },
    });
    expect(now.json?.["configuration"]["settings"]["limits"]["maxRounds"]).toMatchObject({
      value: 1,
      source: "project",
    });
  }, 60_000);

  it("S8: two concurrent launches host two runs in two panes without cross-talk", async () => {
    const [a, b] = [workspace("w9:p2"), workspace("w9:p3")];
    const launch = (ws: Workspace, runDir: string) =>
      new Promise<{ status: number | null; stdout: string }>((resolve) => {
        const child = spawn("node", [cliPath, ...startArgs(ws, runDir)], {
          cwd: ws.root,
          env: env(ws),
        });
        let stdout = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
        child.on("close", (status) => resolve({ status, stdout }));
      });
    const [runA, runB] = [join(a.root, "run"), join(b.root, "run")];
    const [first, second] = await Promise.all([launch(a, runA), launch(b, runB)]);
    expect(first.status, first.stdout).toBe(0);
    expect(second.status, second.stdout).toBe(0);
    const [outA, outB] = await Promise.all([waitForOutcome(runA), waitForOutcome(runB)]);
    expect(outA).toMatchObject({ result: { outcome: "completed", runDir: runA } });
    expect(outB).toMatchObject({ result: { outcome: "completed", runDir: runB } });
    const paneOf = (runDir: string) =>
      (JSON.parse(readFileSync(join(runDir, "host.json"), "utf8")) as Json)["paneId"];
    expect([paneOf(runA), paneOf(runB)]).toEqual(["w9:p2", "w9:p3"]);
    expect(fakeCalls(a).filter((argv) => argv[1] === "split")).toHaveLength(1);
    expect(fakeCalls(b).filter((argv) => argv[1] === "split")).toHaveLength(1);
  }, 90_000);

  it("refuses a run directory that already holds a run and checks its flags", () => {
    const ws = workspace();
    const runDir = join(ws.root, "run");
    mkdirSync(runDir);
    writeFileSync(join(runDir, "launch.json"), "{}");
    expect(woofIn(ws, startArgs(ws, runDir))).toMatchObject({
      status: 2,
      json: { reason: "run_exists" },
    });
    // PI-003: an empty journal already present occupies the directory for both hosts.
    const emptyJournal = join(ws.root, "run-empty-journal");
    mkdirSync(emptyJournal);
    writeFileSync(join(emptyJournal, "journal.jsonl"), "");
    for (const host of ["herdr-pane", "foreground"]) {
      expect(woofIn(ws, [...startArgs(ws, emptyJournal), "--host", host]), host).toMatchObject({
        status: 2,
        json: { reason: "run_exists" },
      });
    }
    expect(readFileSync(join(emptyJournal, "journal.jsonl"), "utf8")).toBe("");
    // PI-102: an exit marker alone is engine-owned and occupies the directory too.
    const markerOnly = join(ws.root, "run-marker-only");
    mkdirSync(markerOnly);
    writeFileSync(
      join(markerOnly, "host-exit.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "woof.host.exit",
        pid: 1,
        exitedAt: "2000-01-01T00:00:00.000Z",
        exitCode: 99,
      }),
    );
    for (const host of ["herdr-pane", "foreground"]) {
      expect(woofIn(ws, [...startArgs(ws, markerOnly), "--host", host]), host).toMatchObject({
        status: 2,
        json: { reason: "run_exists", message: expect.stringContaining("(host-exit.json)") },
      });
    }
    for (const name of ["journal.jsonl", "host.json", "launch.json"])
      expect(existsSync(join(markerOnly, name)), name).toBe(false);
    expect(fakeCalls(ws).filter((argv) => argv[1] === "split")).toEqual([]);
    expect(woofIn(ws, ["run", "start", "--input", ws.inputPath, "--host", "cloud"]).status).toBe(1);
    expect(
      woofIn(ws, [
        "run",
        "start",
        "--input",
        ws.inputPath,
        "--run-dir",
        runDir,
        "--runs-dir",
        ws.root,
      ]).status,
    ).toBe(1);
    const help = woofIn(ws, ["run", "start", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--host herdr-pane|foreground");
  });
});
