import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { cliPath, distUrl, repoRoot, runNode, testPlan } from "./helpers/process.js";

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

/**
 * The host claim, or undefined while it is missing or still being written: claimHost creates
 * host.json exclusively and writes it afterwards, so a read can see a partial file.
 */
function hostClaim(runDir: string): Json | undefined {
  try {
    const host = JSON.parse(readFileSync(join(runDir, "host.json"), "utf8")) as unknown;
    return typeof host === "object" && host !== null ? (host as Json) : undefined;
  } catch {
    return undefined;
  }
}

/** Waits until host.json parses with a numeric pid, and returns that pid. */
async function waitForHostPid(runDir: string, timeoutMs = 30_000): Promise<number> {
  let pid: number | undefined;
  await waitFor(
    () => {
      const claimed = hostClaim(runDir)?.["pid"];
      if (typeof claimed === "number") pid = claimed;
      return pid !== undefined;
    },
    "the host to claim the run",
    timeoutMs,
  );
  return pid as number;
}
const dirs: string[] = [];
const runDirs: string[] = [];
afterEach(async () => {
  // Detached hosts outlive a failed assertion: kill any that still hold a claim, and wait until
  // every host process is gone before anything is removed. A dying host still writes into its run
  // directory, and removing it underneath the writer fails with ENOTEMPTY (F-002).
  for (const runDir of runDirs.splice(0)) {
    const host = hostClaim(runDir);
    const pid = host?.["pid"];
    if (typeof pid !== "number") continue;
    if (
      host?.["state"] === "hosting" &&
      !existsSync(join(runDir, "host-exit.json")) &&
      processAlive(pid)
    )
      process.kill(pid, "SIGKILL");
    const deadline = Date.now() + 10_000;
    while (processAlive(pid) && Date.now() < deadline) await delay(50);
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
      "-c",
      "maintenance.auto=false",
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

/** The tab id the fake Herdr reports for a host tab whose root pane is `paneId` (w9:p2 → w9:t2). */
const tabIdOf = (paneId: string) => paneId.replace(":p", ":t");

/** `herdr tab create` output (Herdr 0.9.1 shape) for a new tab whose root pane is `paneId`. */
const tabCreated = (paneId: string) =>
  JSON.stringify({
    id: "cli:tab:create",
    result: {
      root_pane: { pane_id: paneId, tab_id: tabIdOf(paneId), workspace_id: "w9" },
      tab: { tab_id: tabIdOf(paneId), label: "woof:build-review", number: 2, pane_count: 1 },
      type: "tab_created",
    },
  });

/** `herdr pane get` output placing `paneId` in `workspaceId`. */
const paneGot = (paneId: string, workspaceId: string) =>
  JSON.stringify({
    id: "cli:pane:get",
    result: { pane: { pane_id: paneId, workspace_id: workspaceId }, type: "pane_info" },
  });

/**
 * The host's tab and the host typed into its root pane (spawned for real with `spawnHost`; its
 * stdout and stderr land in `<root>/pane.log`, standing in for the pane's screen). No `pane split`
 * is scripted: a launcher that split anything would hit an unscripted fake and fail.
 */
function writeScenario(ws: Workspace, paneId: string, spawnHost: boolean): void {
  writeFileSync(
    ws.scenario,
    JSON.stringify([
      // Herdr places the launcher's pane (HERDR_PANE_ID w9:p1) in workspace w9.
      { match: ["pane", "get", "w9:p1"], stdout: paneGot("w9:p1", "w9") },
      { match: ["tab", "create"], stdout: tabCreated(paneId) },
      {
        match: ["pane", "run", paneId],
        stdout: "{}",
        ...(spawnHost
          ? {
              spawn: {
                commandIndex: 3,
                env: { HERDR_ENV: "1", HERDR_PANE_ID: paneId, TZ: "UTC" },
                log: join(ws.root, "pane.log"),
              },
            }
          : {}),
      },
      { match: ["pane", "run"], stdout: "{}" },
      { match: ["tab", "close"], stdout: "{}" },
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
    HERDR_WORKSPACE_ID: "w9",
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
  it("S1: launches the host in the root pane of a new tab (no pane split for the host), returns once it opened the run, and the host finishes it", async () => {
    const ws = workspace();
    const runDir = join(ws.root, "run");
    // The launcher's HERDR_WORKSPACE_ID is stale: the workspace Herdr reports for its pane decides.
    const started = woofIn(ws, startArgs(ws, runDir, ["--run-id", "s1-run"]), {
      WOOF_TEST_SCRIPT: "slow",
      HERDR_WORKSPACE_ID: "w-stale",
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
    expect(calls[0]).toEqual(["pane", "get", "w9:p1"]);
    expect(calls[1]).toEqual([
      "tab",
      "create",
      "--workspace",
      "w9",
      "--cwd",
      ws.repo,
      "--label",
      "woof:build-review",
      "--no-focus",
    ]);
    // One pane per run: nothing is split, and the started output names only the host.
    expect(calls.filter((argv) => argv[1] === "split")).toEqual([]);
    expect(started.json).toMatchObject({ host: { paneId: "w9:p2", tabId: "w9:t2" } });
    expect(started.json).not.toHaveProperty("watch");
    // The verified workspace of the created tab travels to the host process, over the stale value
    // its pane inherited: the host's claim (and its runtime adapter's agent tabs) use it.
    // The created tab's id travels the same way, so host.claimed journals it.
    expect(calls[2]?.slice(0, 6)).toEqual([
      "pane",
      "run",
      "w9:p2",
      "env",
      "HERDR_WORKSPACE_ID=w9",
      "WOOF_HOST_TAB_ID=w9:t2",
    ]);
    expect(calls[2]?.slice(7)).toEqual([cliPath, "run", "host", runDir]);
    expect(calls[2]?.[6]).toMatch(/^\/.*node[^/]*$/);
    expect(hostClaim(runDir)).toMatchObject({ workspaceId: "w9" });

    writeFileSync(ws.release, "go\n");
    const outcome = await waitForOutcome(runDir);
    expect(outcome).toMatchObject({
      outcome: "run",
      result: { outcome: "completed", runId: "s1-run" },
    });
    expect(records(runDir).find((record) => record["type"] === "host.claimed")).toMatchObject({
      paneId: "w9:p2",
      tabId: "w9:t2",
    });
    // outcome.json is the host's last stdout line. LV-004: the redirected stdout can reach pane.log
    // after outcome.json exists, so the line is awaited (bounded) rather than read once.
    let hostStdout: string | undefined;
    await waitFor(
      () => {
        hostStdout = existsSync(join(ws.root, "pane.log"))
          ? readFileSync(join(ws.root, "pane.log"), "utf8")
              .split("\n")
              .findLast((line) => line.startsWith("{"))
          : undefined;
        return hostStdout !== undefined;
      },
      "the host's result line in pane.log",
      15_000,
    );
    expect(JSON.parse(hostStdout ?? "null")).toEqual(outcome);
    // The pane shows the human view of the run (what woof watch prints), from the host's own
    // journal: opening block, rows as the records landed, the outcome summary; then the result.
    const pane = readFileSync(join(ws.root, "pane.log"), "utf8");
    const paneLines = pane.split("\n");
    // The configuration warning (the test HOME has no Claude trust file) reaches the pane through
    // stderr, before the human view opens; nothing else of the technical log does.
    expect(paneLines[0]).toMatch(/^woof: warning claude_trust_unknown: /);
    expect(paneLines[1]).toMatch(/^woof \/ build-review {2}repo · (master|main)$/);
    expect(paneLines).toContain("builder    claude   provider default   build, repair");
    expect(pane).toMatch(/^\d\d:\d\d:\d\d → builder {2}build {3}Task dispatched$/m);
    expect(pane).toMatch(/^\d\d:\d\d:\d\d ↻ gate {5}review {2}Changes requested → repair$/m);
    expect(pane).toMatch(/^\d\d:\d\d:\d\d → builder {2}repair {2}Task dispatched · same agent$/m);
    expect(pane).toMatch(/^\d\d:\d\d:\d\d → reviewer review {2}Task dispatched · visit 2$/m);
    expect(pane).toMatch(/^\d\d:\d\d:\d\d ✓ gate {5}review {2}Approved → completed$/m);
    expect(paneLines).toContain("✓ Completed · approved");
    expect(pane).toMatch(/^(\d+s|\d+m( \d+s)?) · 2 reviews · 1 repair$/m);
    expect(paneLines).toContain("changes  accepted/repair/visit-1/attempt-1/completion.md");
    expect(paneLines.at(-2)).toBe(hostStdout);
    // The pane's stdout is a file here, so no color; the technical log stays out of the pane.
    expect(pane).not.toContain("\u001B[");
    expect(pane).not.toContain("dispatch build visit 1 attempt 1");
    expect(paneLines.filter((line) => line.startsWith("woof: "))).toEqual([paneLines[0]]);
    // The technical log is <run-dir>/host.log: timestamped scheduler actions, never the human rows.
    const hostLog = readFileSync(join(runDir, "host.log"), "utf8");
    expect(hostLog).toMatch(
      /^\d{4}-\d\d-\d\dT[\d:.]+Z dispatch build visit 1 attempt 1 \(initial\) to builder$/m,
    );
    expect(hostLog).toMatch(/Z dispatch repair visit 1 attempt 1 \(initial\) to builder$/m);
    expect(hostLog).toMatch(/Z gate review pass \(approved\)$/m);
    expect(hostLog).toMatch(/Z run ended$/m);
    expect(hostLog).not.toContain("Task dispatched");
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

  it("PR #6 (claim.ts:68): a claim whose write fails leaves no partial claim, the launcher reports host_claim_failed at once and closes the directory", () => {
    const ws = workspace();
    const runDir = join(ws.root, "run");
    const preload = pathToFileURL(join(repoRoot, "test", "fixtures", "fail-claim-write.mjs")).href;
    const started = Date.now();
    const result = woofIn(ws, startArgs(ws, runDir, ["--host-start-timeout-ms", "20000"]), {
      NODE_OPTIONS: `--import=${preload}`,
    });
    const elapsed = Date.now() - started;
    expect(result.status, result.stdout + result.stderr).toBe(3);
    expect(result.json).toMatchObject({
      outcome: "rejected",
      reason: "host_claim_failed",
      message: expect.stringContaining("ENOSPC"),
    });
    expect(result.json?.["message"]).toContain(
      "the run directory is closed (abandoned) and no run will start there",
    );
    // The host rejected before it owned anything, so the tab opened for it is closed, not leaked.
    expect(result.json?.["message"]).toContain("the created tab w9:t2 was closed");
    expect(fakeCalls(ws).filter((argv) => argv[1] === "close")).toEqual([
      ["tab", "close", "w9:t2"],
    ]);
    // Promptly: well inside the 20 s host-start timeout the old launcher waited out.
    expect(elapsed).toBeLessThan(10_000);
    // The failed host removed its partial claim; the launcher's abandonment is the only claim.
    expect(JSON.parse(readFileSync(join(runDir, "host.json"), "utf8"))).toMatchObject({
      state: "abandoned",
      pid: null,
    });
    expect(JSON.parse(readFileSync(join(runDir, "outcome.json"), "utf8"))).toMatchObject({
      reason: "host_claim_failed",
      launch: {
        sha256: createHash("sha256")
          .update(readFileSync(join(runDir, "launch.json")))
          .digest("hex"),
      },
    });
    // A later host is refused explicitly: the directory was closed as abandoned, not left lost.
    const late = woofIn(ws, ["run", "host", runDir]);
    expect(late.status, late.stdout + late.stderr).toBe(2);
    expect(late.json).toMatchObject({
      reason: "run_host_claimed",
      message: expect.stringContaining("(abandoned)"),
    });
    expect(woofIn(ws, ["status", runDir]).json?.["status"]?.["liveness"]).toBeUndefined();
    expect(existsSync(join(runDir, "journal.jsonl"))).toBe(false);
  }, 60_000);

  it("PR #6 (launch.ts:135): a foreign journal opened after the preflight is run_exists, never started, and the other run is not exposed", async () => {
    // A pane that never runs the host: another SDK caller opens a run in the directory after
    // woof run start's occupancy check and launch request.
    const ws = workspace("w9:p2", false);
    const runDir = join(ws.root, "run");
    const launcher = spawn("node", [cliPath, ...startArgs(ws, runDir)], {
      cwd: ws.root,
      env: env(ws),
    });
    let stdout = "";
    launcher.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    const launched = new Promise<number | null>((resolve) =>
      launcher.on("close", (code) => resolve(code)),
    );
    await waitFor(() => existsSync(join(runDir, "launch.json")), "the launch request");
    const opened = runNode(
      `const store = await import(${JSON.stringify(distUrl("state/store.js"))});
console.log(JSON.stringify(await store.openRun({ runDir: process.argv[1], runId: "foreign-run-7", plan: JSON.parse(process.argv[2]) })));`,
      [runDir, JSON.stringify(testPlan())],
    );
    expect(opened.status, opened.stderr).toBe(0);
    expect(await launched, stdout).toBe(2);
    const last = JSON.parse(stdout.trim().split("\n").at(-1) ?? "null") as Json;
    expect(last).toMatchObject({ outcome: "rejected", reason: "run_exists" });
    expect(last["outcome"]).not.toBe("started");
    expect(stdout).not.toContain("foreign-run-7");
    // The foreign run is untouched.
    expect(records(runDir)[0]).toMatchObject({ type: "run.opened", runId: "foreign-run-7" });
  }, 60_000);

  it("PR #6 (launch.ts:56): an outcome.json that is not this launch's is ignored, and a host's own outcome names the launch", async () => {
    // A pane that never runs the host: the test plays the stale file and then the real host.
    const ws = workspace("w9:p2", false);
    const runDir = join(ws.root, "run");
    const launcher = spawn("node", [cliPath, ...startArgs(ws, runDir)], {
      cwd: ws.root,
      env: env(ws),
    });
    let stdout = "";
    launcher.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    const launched = new Promise<number | null>((resolve) =>
      launcher.on("close", (code) => resolve(code)),
    );
    await waitFor(() => existsSync(join(runDir, "launch.json")), "the launch request");
    const foreign = JSON.stringify({
      outcome: "rejected",
      reason: "definition_invalid",
      message: "an outcome left by another launch",
      details: [],
    });
    writeFileSync(join(runDir, "outcome.json"), foreign);
    await delay(1000);
    expect(launcher.exitCode, stdout).toBeNull();
    const host = spawn("node", [cliPath, "run", "host", runDir], {
      cwd: ws.root,
      env: env(ws, { HERDR_PANE_ID: "w9:p2" }),
      stdio: "ignore",
    });
    const hostExited = new Promise<number | null>((resolve) =>
      host.on("close", (code) => resolve(code)),
    );
    expect(await launched, stdout).toBe(0);
    expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "null")).toMatchObject({
      outcome: "started",
      runDir,
    });
    await hostExited;
    // The host ran the launch to its end; it could not replace the foreign file.
    // The host journals its own lifecycle around the run: its claim once the run is open, and its
    // exit (the one record that follows a termination) before it releases the claim.
    const journal = records(runDir);
    expect(journal.slice(0, 2).map((record) => record["type"])).toEqual([
      "run.opened",
      "host.claimed",
    ]);
    expect(journal[1]).toMatchObject({ pid: host.pid, paneId: "w9:p2" });
    expect(journal.at(-2)).toMatchObject({ type: "run.terminated", outcome: "completed" });
    expect(journal.at(-1)).toMatchObject({
      type: "host.exited",
      pid: host.pid,
      exitCode: 0,
      reason: "completed",
    });
    expect(readFileSync(join(runDir, "outcome.json"), "utf8")).toBe(foreign);

    // A normal launch: the host's outcome.json carries the digest of the launch request it served.
    const normal = workspace();
    const normalDir = join(normal.root, "run");
    expect(woofIn(normal, startArgs(normal, normalDir)).status).toBe(0);
    const outcome = await waitForOutcome(normalDir);
    expect(outcome).toMatchObject({
      outcome: "run",
      launch: {
        sha256: createHash("sha256")
          .update(readFileSync(join(normalDir, "launch.json")))
          .digest("hex"),
      },
    });
  }, 90_000);

  it("PR #6 (run.ts:293): with a slow Herdr and a 1 ms poll, the pane host's metadata reports stay bounded and it finalizes promptly", async () => {
    const ws = workspace();
    const scenario = JSON.parse(readFileSync(ws.scenario, "utf8")) as Json[];
    for (const entry of scenario)
      if (["report-metadata", "show"].includes(entry["match"][1] as string)) entry["hangMs"] = 1500;
    writeFileSync(ws.scenario, JSON.stringify(scenario));
    const runDir = join(ws.root, "run");
    const args = startArgs(ws, runDir).map((arg, index, all) =>
      all[index - 1] === "--poll-ms" ? "1" : arg,
    );
    const started = woofIn(ws, args);
    expect(started.status, started.stdout + started.stderr).toBe(0);
    const outcome = await waitForOutcome(runDir, 60_000);
    expect(outcome).toMatchObject({ outcome: "run", result: { outcome: "completed" } });
    const terminated = records(runDir).find((record) => record["type"] === "run.terminated");
    const exited = JSON.parse(readFileSync(join(runDir, "host-exit.json"), "utf8")) as Json;
    // After the run ends: at most the report in flight plus the final report and notification, each
    // Herdr call 1.5 s, for the host pane and two agent panes.
    const finalizingMs = Date.parse(exited["exitedAt"]) - Date.parse(terminated?.["ts"]);
    expect(finalizingMs).toBeLessThan(15_000);
    const reports = fakeCalls(ws).filter((argv) => argv[1] === "report-metadata");
    const runMs = Date.parse(exited["exitedAt"]) - Date.parse(records(runDir)[0]?.["ts"]);
    // One report round at a time: never more calls than 1.5 s rounds of three panes, plus the final.
    expect(reports.length).toBeLessThanOrEqual(3 * (Math.ceil(runMs / 1500) + 1));
  }, 90_000);

  it("PR #6 (run.ts:277): a signal between the pane host's claim and its own handlers still finalizes host_interrupted", async () => {
    const ws = workspace();
    const runDir = join(ws.root, "run");
    // The unstable test seam holds the host, synchronously, right after its claim: the signal lands
    // in the window before hostWorkflow installs its handlers.
    const launcher = spawn(
      "node",
      [cliPath, ...startArgs(ws, runDir, ["--host-start-timeout-ms", "10000"])],
      { cwd: ws.root, env: env(ws, { WOOF_TEST_CLAIM_HANDOFF_MS: "3000" }) },
    );
    let stdout = "";
    launcher.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    const launched = new Promise<number | null>((resolve) =>
      launcher.on("close", (code) => resolve(code)),
    );
    const pid = await waitForHostPid(runDir);
    process.kill(pid, "SIGINT");
    await waitFor(() => !processAlive(pid), "the host to exit", 15_000);
    expect(existsSync(join(runDir, "host-exit.json")), "host-exit.json").toBe(true);
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
      reason: "host_interrupted",
    });
  }, 60_000);

  it("PR #6 (run.ts:191): a runs directory that is a file or cannot be created is journal_write_failed (exit 3) for both hosts, never a throw", () => {
    const ws = workspace("w9:p2", false);
    const occupied = join(ws.root, "runs-file");
    writeFileSync(occupied, "not a directory\n");
    const readOnly = join(ws.root, "read-only");
    mkdirSync(readOnly, { mode: 0o555 });
    try {
      for (const runsDir of [occupied, join(readOnly, "runs")]) {
        mkdirSync(join(ws.home, ".woof"), { recursive: true });
        writeFileSync(
          join(ws.home, ".woof", "woof.json"),
          JSON.stringify({ schemaVersion: 1, defaults: { runsDir } }),
        );
        for (const host of ["foreground", "herdr-pane"]) {
          const args = startArgs(ws, "unused").filter(
            (arg, index, all) => arg !== "--run-dir" && all[index - 1] !== "--run-dir",
          );
          const result = woofIn(ws, [...args, "--host", host]);
          const label = `${host} ${runsDir}`;
          expect(result.status, label + result.stdout + result.stderr).toBe(3);
          expect(result.stderr, label).not.toMatch(/at .*\.js:\d+/);
          expect(result.json, label).toMatchObject({
            outcome: "rejected",
            reason: "journal_write_failed",
            message: expect.stringContaining(runsDir),
          });
        }
      }
      expect(fakeCalls(ws).filter((argv) => argv[0] === "tab" || argv[1] === "split")).toEqual([]);
    } finally {
      spawnSync("chmod", ["755", readOnly]);
    }
  });

  it("PR #6 (launch.ts:184, :200): a failed herdr tab create or pane run abandons the run directory, and a later run host is refused", () => {
    // "partial" and "foreign" are replies Herdr sent after it had already created a tab: one names
    // the tab but no root pane, the other a root pane that belongs to a different tab.
    const reply = (result: Json) => JSON.stringify({ id: "cli:tab:create", result });
    const tabCreate = {
      create: { stderr: "create refused\n", exit: 1 },
      run: { stdout: tabCreated("w9:p2") },
      partial: { stdout: reply({ tab: { tab_id: "w9:t2" }, type: "tab_created" }) },
      foreign: {
        stdout: reply({
          tab: { tab_id: "w9:t2" },
          root_pane: { pane_id: "w9:p2", tab_id: "w9:t7", workspace_id: "w9" },
        }),
      },
    };
    const expected = {
      create: { calls: ["pane get", "tab create"], says: "create refused" },
      run: { calls: ["pane get", "tab create", "pane run", "tab close"], says: "run refused" },
      partial: { calls: ["pane get", "tab create", "tab close"], says: "no root pane_id" },
      foreign: { calls: ["pane get", "tab create"], says: "a root pane of tab w9:t7" },
    };
    for (const failing of ["create", "run", "partial", "foreign"] as const) {
      const ws = workspace("w9:p2", false);
      writeFileSync(
        ws.scenario,
        JSON.stringify([
          { match: ["tab", "create"], ...tabCreate[failing] },
          { match: ["pane", "run"], stderr: "run refused\n", exit: 1 },
          { match: ["tab", "close"], stdout: "{}" },
        ]),
      );
      const runDir = join(ws.root, "run");
      const result = woofIn(ws, startArgs(ws, runDir));
      expect(result.status, failing + result.stdout + result.stderr).toBe(3);
      expect(result.json, failing).toMatchObject({
        outcome: "rejected",
        reason: "host_pane_failed",
        message: expect.stringContaining(
          "the run directory is closed (abandoned) and no run will start there",
        ),
      });
      expect(result.json?.["message"], failing).toContain(expected[failing].says);
      expect(JSON.parse(readFileSync(join(runDir, "host.json"), "utf8")), failing).toMatchObject({
        state: "abandoned",
        pid: null,
      });
      expect(
        fakeCalls(ws).map((argv) => argv.slice(0, 2).join(" ")),
        failing,
      ).toEqual(expected[failing].calls);
      // The abandonment proved no host owns the directory, so the tab Herdr created for that host
      // is closed and never leaked; a reply naming two tabs identifies none, and none is closed.
      const closes = fakeCalls(ws).filter((argv) => argv[1] === "close");
      if (failing === "run" || failing === "partial") {
        expect(closes, failing).toEqual([["tab", "close", "w9:t2"]]);
        expect(result.json?.["message"], failing).toContain("the created tab w9:t2 was closed");
      } else {
        expect(closes, failing).toEqual([]);
      }
      // What the failed pane would have typed, run by hand later: refused, nothing opens.
      const late = woofIn(ws, ["run", "host", runDir]);
      expect(late.status, failing + late.stdout + late.stderr).toBe(2);
      expect(late.json, failing).toMatchObject({ outcome: "rejected", reason: "run_host_claimed" });
      expect(existsSync(join(runDir, "journal.jsonl")), failing).toBe(false);
      expect(woofIn(ws, ["status", runDir]).status, failing).not.toBe(0);
    }
  });

  it("p5 C3 (launch.ts:200): herdr pane run failing after the host claimed reports the directory could not be closed", () => {
    // The uncovered half of launch.ts:200. The pane's command started and claimed
    // the run directory, and `pane run` still reported failure: the launcher
    // cannot abandon a directory a live host owns, and says exactly that instead
    // of claiming the run will never start.
    const ws = workspace("w9:p2", false);
    writeFileSync(
      ws.scenario,
      JSON.stringify([
        { match: ["tab", "create"], stdout: tabCreated("w9:p2") },
        {
          match: ["pane", "run"],
          // The pane types and starts the command, then `pane run` reports failure.
          spawn: {
            commandIndex: 3,
            env: { HERDR_ENV: "1", HERDR_PANE_ID: "w9:p2", WOOF_TEST_SCRIPT: "hang" },
            log: join(ws.root, "pane.log"),
          },
          hangMs: 4000,
          stderr: "run refused after the pane had started it\n",
          exit: 1,
        },
        { match: ["pane", "report-metadata"], stdout: "{}" },
        { match: ["notification", "show"], stdout: "{}" },
      ]),
    );
    const runDir = join(ws.root, "run");
    const result = woofIn(ws, startArgs(ws, runDir));

    expect(result.status, result.stdout + result.stderr).toBe(3);
    expect(result.json).toMatchObject({ outcome: "rejected", reason: "host_pane_failed" });
    const message = String(result.json?.["message"]);
    expect(message).toContain("run refused after the pane had started it");
    expect(message).toContain("the run directory could not be closed (abandoned)");
    expect(message).toContain("already claimed by a run host");
    // A live host owns the directory, so its tab is kept: closing it would kill that host.
    expect(message).toContain("the created tab w9:t2 is left open");
    expect(fakeCalls(ws).some((argv) => argv[0] === "tab" && argv[1] === "close")).toBe(false);
    // The claim is the live host's, not an abandonment: the launcher wrote nothing over it.
    expect(JSON.parse(readFileSync(join(runDir, "host.json"), "utf8"))).toMatchObject({
      state: "hosting",
    });
    // The run really is running, which is why the directory could not be closed.
    expect(woofIn(ws, ["run", "cancel", runDir, "--reason", "test cleanup"]).json).toMatchObject({
      outcome: "recorded",
    });
  }, 60_000);

  it("S3: a host that never starts is abandoned within hostStartTimeoutMs, and a late host is refused", () => {
    const ws = workspace("w9:p2", false);
    const runDir = join(ws.root, "run");
    const started = Date.now();
    const result = woofIn(ws, startArgs(ws, runDir, ["--host-start-timeout-ms", "1000"]));
    expect(result.status, result.stdout).toBe(3);
    expect(result.json).toMatchObject({ outcome: "rejected", reason: "host_not_started" });
    expect(Date.now() - started).toBeLessThan(10_000);
    // No host claimed and none can any more: the tab opened for it does not outlive the launch.
    expect(fakeCalls(ws).filter((argv) => argv[1] === "close")).toEqual([
      ["tab", "close", "w9:t2"],
    ]);
    expect(result.json?.["message"]).toContain("the created tab w9:t2 was closed");
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
    const pid = await waitForHostPid(runDir);
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
    // Inspection never writes: the probe said lost, but nothing journaled it yet.
    expect(records(runDir).some((record) => record["type"] === "host.lost")).toBe(false);
    const cancelled = woofIn(ws, ["run", "cancel", runDir]);
    expect(cancelled.status, cancelled.stdout).toBe(0);
    // The cancel is the first locked writer to act on the lost run: it journals the evidence, then
    // the request, then the termination, under one lock.
    expect(
      records(runDir)
        .slice(-3)
        .map((record) => record["type"]),
    ).toEqual(["host.lost", "run.cancel_requested", "run.terminated"]);
    expect(records(runDir).at(-3)).toMatchObject({
      pid,
      reason: "host_process_gone",
      heartbeatAt: expect.any(String),
      detectedBy: "cli",
    });
    expect(records(runDir).at(-2)).toMatchObject({ source: "cli" });
    expect(cancelled.json).toMatchObject({
      outcome: "recorded",
      record: { type: "run.terminated", outcome: "cancelled" },
      cancelRequest: { type: "run.cancel_requested" },
      hostLost: { type: "host.lost", pid },
    });
    expect(show(ws, runDir)).toMatchObject({
      status: "cancelled",
      liveness: { owner: "lost", host: { state: "hosting", pid } },
      lifecycle: { host: { state: "lost", pid }, cancelRequested: { source: "cli" } },
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
    const pid = await waitForHostPid(runDir);
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
    const pid = await waitForHostPid(runDir);
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
    expect(fakeCalls(a).filter((argv) => argv[0] === "tab")).toHaveLength(1);
    expect(fakeCalls(b).filter((argv) => argv[0] === "tab")).toHaveLength(1);
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
    // PR #6 (launch.ts:56): a pre-existing outcome.json occupies the directory as well.
    const outcomeOnly = join(ws.root, "run-outcome-only");
    mkdirSync(outcomeOnly);
    writeFileSync(
      join(outcomeOnly, "outcome.json"),
      JSON.stringify({
        outcome: "rejected",
        reason: "definition_invalid",
        message: "stale",
        details: [],
      }),
    );
    for (const host of ["herdr-pane", "foreground"]) {
      expect(woofIn(ws, [...startArgs(ws, outcomeOnly), "--host", host]), host).toMatchObject({
        status: 2,
        json: { reason: "run_exists", message: expect.stringContaining("(outcome.json)") },
      });
    }
    for (const name of ["journal.jsonl", "host.json", "launch.json"])
      expect(existsSync(join(outcomeOnly, name)), name).toBe(false);
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

describe("woof run start: the run host's pane shows the human view; no watch split", () => {
  /** The host typed into the tab's root pane, with its stdout and stderr captured in pane.log. */
  function writeHostScenario(ws: Workspace, extraEnv: Record<string, string> = {}): void {
    writeFileSync(
      ws.scenario,
      JSON.stringify([
        { match: ["pane", "get", "w9:p1"], stdout: paneGot("w9:p1", "w9") },
        { match: ["tab", "create"], stdout: tabCreated("w9:p2") },
        {
          match: ["pane", "run", "w9:p2"],
          stdout: "{}",
          spawn: {
            commandIndex: 3,
            env: { HERDR_ENV: "1", HERDR_PANE_ID: "w9:p2", TZ: "UTC", ...extraEnv },
            log: join(ws.root, "pane.log"),
          },
        },
        { match: ["tab", "close"], stdout: "{}" },
        { match: ["pane", "report-metadata"], stdout: "{}" },
        { match: ["notification", "show"], stdout: "{}" },
      ]),
    );
  }

  const paneLog = (ws: Workspace) =>
    existsSync(join(ws.root, "pane.log")) ? readFileSync(join(ws.root, "pane.log"), "utf8") : "";

  it("S9: --plain, --ascii and --preview json travel to the typed run host command; --plain puts the technical log on the pane instead of the human view", async () => {
    const ws = workspace();
    writeHostScenario(ws);
    const runDir = join(ws.root, "run");
    const started = woofIn(
      ws,
      startArgs(ws, runDir, ["--run-id", "s9-run", "--plain", "--ascii", "--preview", "json"]),
    );
    expect(started.status, started.stdout + started.stderr).toBe(0);
    expect(started.json).toMatchObject({ outcome: "started", host: { paneId: "w9:p2" } });
    expect(started.json).not.toHaveProperty("watch");
    const calls = fakeCalls(ws);
    // One typed command, into the tab's root pane, carrying the view flags after the run dir.
    const typed = calls.filter((argv) => argv[1] === "run");
    expect(typed).toHaveLength(1);
    expect(typed[0]?.slice(7)).toEqual([
      cliPath,
      "run",
      "host",
      runDir,
      "--plain",
      "--ascii",
      "--input",
      "json",
    ]);
    expect(calls.filter((argv) => argv[1] === "split")).toEqual([]);

    const outcome = await waitForOutcome(runDir);
    expect(outcome).toMatchObject({ outcome: "run", result: { outcome: "completed" } });
    await waitFor(() => paneLog(ws).includes("Z run ended"), "the host's last log line", 15_000);
    const pane = paneLog(ws);
    // The technical form: the timestamped host.log lines, and the result last.
    expect(pane).toMatch(
      /^\d{4}-\d\d-\d\dT[\d:.]+Z dispatch build visit 1 attempt 1 \(initial\) to builder$/m,
    );
    expect(pane).toMatch(/Z gate review pass \(approved\)$/m);
    expect(pane).not.toContain("Task dispatched");
    expect(pane).not.toContain("AGENTS");
    expect(pane.trim().split("\n").at(-1)?.startsWith("{")).toBe(true);
    // host.log holds the same lines whatever the pane shows.
    const hostLog = readFileSync(join(runDir, "host.log"), "utf8");
    for (const line of pane.trim().split("\n"))
      if (!line.startsWith("{")) expect(hostLog).toContain(line);
  }, 60_000);

  it("S10: --preview json and --ascii shape the pane's human view; --no-keep-panes types no close and splits nothing", async () => {
    const ws = workspace();
    writeHostScenario(ws);
    const runDir = join(ws.root, "run");
    const started = woofIn(
      ws,
      startArgs(ws, runDir, ["--ascii", "--preview", "json", "--no-keep-panes"]),
    );
    expect(started.status, started.stdout + started.stderr).toBe(0);
    const typed = fakeCalls(ws).filter((argv) => argv[1] === "run");
    expect(typed).toHaveLength(1);
    expect(typed[0]?.slice(7)).toEqual([
      cliPath,
      "run",
      "host",
      runDir,
      "--ascii",
      "--input",
      "json",
    ]);
    // The host's own tab is never closed by the launcher, and no shell script is typed for it.
    expect(typed[0]).not.toContain("sh");
    expect(await waitForOutcome(runDir)).toMatchObject({ result: { outcome: "completed" } });
    await waitFor(() => paneLog(ws).includes("v Completed"), "the pane's summary", 15_000);
    const pane = paneLog(ws);
    // ASCII marks and arrows, and the input shown as indented JSON.
    expect(pane).toMatch(/^\d\d:\d\d:\d\d -> builder {2}build {3}Task dispatched$/m);
    expect(pane).toMatch(/^\d\d:\d\d:\d\d v {2}gate {5}review {2}Approved -> completed$/m);
    expect(pane).toContain("build -> verify -> review -> completed");
    expect(pane).toContain('  "title": "Change the fixture",');
    expect(pane).toMatch(/^v Completed - approved$/m);
    expect(pane).not.toMatch(/[→✓↻·]/u);
    expect(fakeCalls(ws).filter((argv) => argv[1] === "split" || argv[1] === "close")).toEqual([]);
  }, 60_000);

  it("S11: --watch and --no-watch are gone (usage error, exit 1); --preview takes only summary or json; run host --help names the view flags", () => {
    const ws = workspace();
    const runDir = join(ws.root, "run");
    for (const flag of ["--watch", "--no-watch"]) {
      const result = woofIn(ws, startArgs(ws, runDir, [flag]));
      expect(result.status, flag + result.stdout + result.stderr).toBe(1);
    }
    const preview = woofIn(ws, startArgs(ws, runDir, ["--preview", "table"]));
    expect(preview.status, preview.stdout + preview.stderr).toBe(1);
    expect(preview.stderr).toContain("--preview must be summary or json");
    const hostInput = woofIn(ws, ["run", "host", runDir, "--input", "table"]);
    expect(hostInput.status).toBe(1);
    expect(hostInput.stderr).toContain("--input must be summary or json");
    expect(fakeCalls(ws)).toEqual([]);
    expect(existsSync(runDir)).toBe(false);
    const help = woofIn(ws, ["run", "start", "--help"]).stdout;
    expect(help).not.toContain("--watch");
    expect(help).toContain("[--plain] [--ascii] [--preview summary|json]");
    expect(help).toContain("host.log");
    const hostHelp = woofIn(ws, ["run", "host", "--help"]).stdout;
    expect(hostHelp).toContain("[--plain] [--ascii] [--input summary|json]");
  });

  it("S12: a foreground host prints the human view to stdout, the technical log to host.log and nothing to stderr; --plain swaps the view for the log", () => {
    const ws = workspace();
    const runDir = join(ws.root, "run");
    const result = woofIn(ws, startArgs(ws, runDir, ["--host", "foreground"]), {
      HERDR_ENV: undefined,
      HERDR_PANE_ID: undefined,
      TZ: "UTC",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.json).toMatchObject({ outcome: "run", result: { outcome: "completed" } });
    const lines = result.stdout.split("\n");
    expect(lines[0]).toMatch(/^woof \/ build-review {2}repo · (master|main)$/);
    expect(lines.slice(0, 12)).toContain("AGENTS");
    expect(lines).toContain("builder    claude   provider default   build, repair");
    expect(lines).toContain("reviewer   claude   provider default   review");
    expect(lines).toContain("build → verify → review → completed");
    expect(lines).toContain("Change the fixture");
    expect(lines).toContain("1 acceptance criterion · full input: input.json");
    const rows = lines.filter((line) => /^\d\d:\d\d:\d\d /.test(line));
    expect(rows.map((row) => row.slice(9))).toEqual(
      expect.arrayContaining([
        "· run              Started",
        "+ builder          Agent started · claude / provider default",
        "→ builder  build   Task dispatched",
        "✓ builder  build   Completion report accepted",
        "✓ gate     build   Passed → review",
        "→ reviewer review  Task dispatched",
        "↓ reviewer review  Review received · changes requested",
        "↻ gate     review  Changes requested → repair",
        "→ builder  repair  Task dispatched · same agent",
        "→ reviewer review  Task dispatched · visit 2",
        "↓ reviewer review  Review received · approval recommended",
        "✓ gate     review  Approved → completed",
      ]),
    );
    // The rows come from the host's own journal, in journal order, once each.
    const dispatched = rows.filter((row) => row.includes("Task dispatched"));
    expect(dispatched.map((row) => row.slice(11, 19).trim())).toEqual([
      "builder",
      "reviewer",
      "builder",
      "reviewer",
    ]);
    expect(lines).toContain("✓ Completed · approved");
    expect(lines.filter((line) => line.startsWith("✓ Completed"))).toHaveLength(1);
    expect(result.stdout).toMatch(/^(\d+s|\d+m( \d+s)?) · 2 reviews · 1 repair$/m);
    expect(lines).toContain("ARTIFACTS · relative to run directory");
    expect(lines).toContain("changes  accepted/repair/visit-1/attempt-1/completion.md");
    expect(lines).toContain("review   accepted/review/visit-2/attempt-1/review.md");
    expect(lines.at(-2)?.startsWith("{")).toBe(true);
    expect(lines.filter((line) => line.startsWith("{"))).toHaveLength(1);
    expect(result.stdout).not.toContain("\u001B[");
    // Only the operator-facing configuration warnings reach stderr (the fresh HOME has no Claude
    // trust file); the scheduler's technical lines never do.
    expect(result.stderr.trim().split("\n")).toEqual([
      expect.stringMatching(/^woof: warning claude_trust_unknown: /),
    ]);
    const hostLog = readFileSync(join(runDir, "host.log"), "utf8");
    expect(hostLog).toMatch(/Z dispatch build visit 1 attempt 1 \(initial\) to builder$/m);
    expect(hostLog).toMatch(/Z warning claude_trust_unknown: /m);
    expect(hostLog).toMatch(/Z run ended$/m);
    expect(hostLog).not.toContain("Task dispatched");

    const plainDir = join(ws.root, "run-plain");
    const plain = woofIn(ws, startArgs(ws, plainDir, ["--host", "foreground", "--plain"]), {
      HERDR_ENV: undefined,
      HERDR_PANE_ID: undefined,
    });
    expect(plain.status, plain.stdout + plain.stderr).toBe(0);
    expect(plain.json).toMatchObject({ outcome: "run", result: { outcome: "completed" } });
    expect(plain.stdout).toMatch(/Z dispatch build visit 1 attempt 1 \(initial\) to builder$/m);
    expect(plain.stdout).not.toContain("Task dispatched");
    // With --plain the echoed log already shows the warning on stdout: once, not on stderr too.
    expect(plain.stdout.split("warning claude_trust_unknown")).toHaveLength(2);
    expect(plain.stderr).toBe("");
    const plainLog = readFileSync(join(plainDir, "host.log"), "utf8").trim().split("\n");
    expect(plain.stdout.trim().split("\n").slice(0, -1)).toEqual(plainLog);
  }, 120_000);

  it("host.log replaced by a FIFO before the pane host starts: the host never blocks on it, completes the run with outcome.json and host.exited, and names the problem once on stderr", async () => {
    // A worker agent has write access to the run directory: a FIFO at host.log with no reader
    // would block the first appendFileSync forever, and with it the scheduler.
    const ws = workspace();
    writeHostScenario(ws);
    const runDir = join(ws.root, "run");
    mkdirSync(runDir);
    expect(spawnSync("mkfifo", [join(runDir, "host.log")]).status).toBe(0);
    const started = woofIn(ws, startArgs(ws, runDir, ["--run-id", "fifo-run"]));
    expect(started.status, started.stdout + started.stderr).toBe(0);
    const outcome = await waitForOutcome(runDir);
    expect(outcome).toMatchObject({
      outcome: "run",
      result: { outcome: "completed", runId: "fifo-run" },
    });
    expect(records(runDir).at(-1)).toMatchObject({ type: "host.exited", exitCode: 0 });
    await waitFor(() => paneLog(ws).includes("✓ Completed"), "the pane's summary", 15_000);
    const pane = paneLog(ws);
    // The pane (stdout and stderr) still carries the human view; the refusal is said exactly once.
    // Configuration warnings also go to stderr by design; only the log refusal is counted here.
    const notices = pane
      .split("\n")
      .filter((line) => line.startsWith("woof: ") && !line.startsWith("woof: warning "));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(join(runDir, "host.log"));
    expect(notices[0]).toMatch(/cannot be opened \(ENXIO\)|is not a regular file/);
    expect(notices[0]).toContain("the technical log is dropped");
    expect(pane).toMatch(/^\d\d:\d\d:\d\d → builder {2}build {3}Task dispatched$/m);
    // The FIFO was neither followed, written through nor replaced.
    expect(statSync(join(runDir, "host.log")).isFIFO()).toBe(true);
  }, 60_000);

  it("a check argv carrying ESC, CR and LF reaches host.log and the --plain stdout with those characters as spaces", () => {
    const ws = workspace();
    const hostile = "\u001B[31mred\ninjected\rline";
    writeFileSync(
      ws.inputPath,
      JSON.stringify(
        input(ws.repo, {
          verify: { command: ["node", "-e", "process.exit(0)", hostile], timeoutMs: 20_000 },
        }),
      ),
    );
    const runDir = join(ws.root, "run");
    const plain = woofIn(ws, startArgs(ws, runDir, ["--host", "foreground", "--plain"]), {
      HERDR_ENV: undefined,
      HERDR_PANE_ID: undefined,
    });
    expect(plain.status, plain.stdout + plain.stderr).toBe(0);
    expect(plain.json).toMatchObject({ outcome: "run", result: { outcome: "completed" } });
    const sanitized = "check verify: node -e process.exit(0)  [31mred injected line";
    expect(plain.stdout).toContain(sanitized);
    const hostLog = readFileSync(join(runDir, "host.log"), "utf8");
    expect(hostLog).toContain(sanitized);
    // No ESC, CR or other control character anywhere; LF only between lines.
    // oxlint-disable-next-line no-control-regex
    const control = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u;
    expect(hostLog).not.toMatch(control);
    const stdoutLines = plain.stdout.trim().split("\n");
    for (const line of stdoutLines.slice(0, -1)) expect(line).not.toMatch(control);
    expect(stdoutLines.slice(0, -1)).toEqual(hostLog.trim().split("\n"));
    expect(plain.stderr).toBe("");
  }, 60_000);

  it("a foreground host whose stdout reader goes away (EPIPE) finishes the run and exits with its code", async () => {
    const ws = workspace();
    const runDir = join(ws.root, "run");
    const child = spawn("node", [cliPath, ...startArgs(ws, runDir, ["--host", "foreground"])], {
      cwd: ws.root,
      env: env(ws, { HERDR_ENV: undefined, HERDR_PANE_ID: undefined, WOOF_TEST_SCRIPT: "slow" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const exited = new Promise<number | null>((resolve) =>
      child.on("close", (code) => resolve(code)),
    );
    // The pane closes once the view has started printing; every later view write hits EPIPE.
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    child.stdout.destroy();
    await waitFor(
      () => records(runDir).some((record) => record["type"] === "request.dispatched"),
      "a dispatch",
    );
    writeFileSync(ws.release, "go\n");
    expect(await exited).toBe(0);
    // Only the operator trust warning reaches stderr; EPIPE on stdout is silent.
    expect(
      stderr.split("\n").filter((line) => line !== "" && !line.startsWith("woof: warning ")),
    ).toEqual([]);
    expect(JSON.parse(readFileSync(join(runDir, "host-exit.json"), "utf8"))).toMatchObject({
      exitCode: 0,
    });
    expect(records(runDir).at(-2)).toMatchObject({ type: "run.terminated", outcome: "completed" });
    const hostLog = readFileSync(join(runDir, "host.log"), "utf8");
    expect(hostLog).toMatch(/Z gate review pass \(approved\)$/m);
    expect(hostLog).toMatch(/Z run ended$/m);
  }, 60_000);

  it("S14: the Herdr runtime opens an agent in its own new tab (no pane split) and closes that tab when the run ends", () => {
    const ws = workspace("w9:p2", false);
    const herdrError = (code: string) => ({
      stderr: `${JSON.stringify({ error: { code, message: `${code} message` }, id: "cli:agent" })}\n`,
      exit: 1,
    });
    writeFileSync(
      ws.scenario,
      JSON.stringify([
        { match: ["tab", "create"], stdout: tabCreated("w9:p5") },
        { match: ["agent", "start"], ...herdrError("agent_kind_unknown") },
        {
          match: ["tab", "close"],
          stdout: JSON.stringify({ id: "cli:tab:close", result: { type: "ok" } }),
        },
        { match: ["agent", "get"], ...herdrError("agent_not_found") },
        { match: ["pane", "get"], ...herdrError("pane_not_found") },
        { match: ["pane", "report-metadata"], stdout: "{}" },
        { match: ["notification", "show"], stdout: "{}" },
      ]),
    );
    const runDir = join(ws.root, "run");
    // No --runtime-module: the real Herdr CLI adapter drives the fake Herdr.
    const args = startArgs(ws, runDir, ["--host", "foreground"]).filter(
      (arg) => arg !== "--runtime-module" && arg !== runtimeModule,
    );
    const result = woofIn(ws, args);
    expect(result.status, result.stdout + result.stderr).toBe(4);
    expect(JSON.stringify(result.json)).toContain("agent_start_failed");
    const calls = fakeCalls(ws);
    expect(calls.filter((argv) => argv[0] === "tab" && argv[1] === "create")).toEqual([
      [
        "tab",
        "create",
        "--workspace",
        "w9",
        "--cwd",
        ws.repo,
        "--label",
        "woof:builder",
        "--no-focus",
        "--env",
        `WOOF_RUN_DIR=${runDir}`,
      ],
    ]);
    expect(calls.find((argv) => argv[0] === "agent" && argv[1] === "start")).toEqual(
      expect.arrayContaining(["--pane", "w9:p5"]),
    );
    expect(calls.filter((argv) => argv[1] === "split")).toEqual([]);
    // The tab Woof created for the agent is what gets closed, never a bare pane.
    expect(calls.filter((argv) => argv[1] === "close")).toEqual([["tab", "close", "w9:t5"]]);
  }, 60_000);
});
