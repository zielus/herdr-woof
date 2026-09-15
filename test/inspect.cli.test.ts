import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupRunDirs,
  distUrl,
  makeRunDir,
  openAttemptOk,
  openPlannedRun,
  repoRoot,
  runNode,
  runSdk,
  terminateRunOk,
  testPlan,
  woof,
  woofAsync,
} from "./helpers/process.js";

// Inspection commands (plan T6, §3.8) as real processes against runs written
// through the compiled store. None of them may lock the journal or call Herdr.
const dirs: string[] = [];
afterEach(() => {
  cleanupRunDirs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Json = Record<string, any>; // oxlint-disable-line no-explicit-any

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function lines(stdout: string): Json[] {
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Json);
}

function openRunWith(runDir: string, runId: string, configuration?: Json): void {
  const out = runSdk<{ outcome: string }>(
    runDir,
    `out = await store.openRun({ runDir, runId: input.runId, plan: input.plan, ...(input.configuration ? { configuration: input.configuration } : {}) });`,
    { runId, plan: testPlan(), ...(configuration !== undefined ? { configuration } : {}) },
  );
  expect(out.outcome).toBe("recorded");
}

/** A claim held by this (live) test process with a fresh heartbeat. */
function writeAliveHost(runDir: string): void {
  writeFileSync(
    join(runDir, "host.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "woof.host",
      state: "hosting",
      pid: process.pid,
      hostname: hostname(),
      paneId: "w1:p9",
      workspaceId: null,
      startedAt: new Date().toISOString(),
      heartbeatMs: 60_000,
    }),
  );
}

function derivedResult(runDir: string, repository: string | null): Json {
  const derived = runNode(
    `const { readSnapshot } = await import(${JSON.stringify(distUrl("state/snapshot.js"))});
const { deriveRunResult } = await import(${JSON.stringify(distUrl("state/result.js"))});
const read = readSnapshot(process.argv[1]);
console.log(JSON.stringify(deriveRunResult(read.snapshot, { runDir: process.argv[1], repository: process.argv[2] === "" ? null : process.argv[2] })));`,
    [runDir, repository ?? ""],
  );
  expect(derived.status, derived.stderr).toBe(0);
  return JSON.parse(derived.stdout.trim()) as Json;
}

describe("woof status", () => {
  it("I1: reads a p1 fixture journal as unhosted with no result", () => {
    const runDir = makeRunDir();
    copyFileSync(
      join(repoRoot, "test", "fixtures", "p1-journal.jsonl"),
      join(runDir, "journal.jsonl"),
    );
    const result = woof(["status", runDir]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const json = result.json as Json;
    expect(json).toMatchObject({
      outcome: "status",
      status: {
        schemaVersion: 1,
        kind: "woof.run.status",
        runId: "fixture-run",
        runDir: realpathSync(runDir),
        liveness: { owner: "unhosted", host: null },
        config: null,
        cursor: expect.stringMatching(/^v1\./),
      },
      result: null,
    });
    expect(Object.keys(json["status"])).toEqual([
      "schemaVersion",
      "kind",
      "runId",
      "runDir",
      "workflow",
      "status",
      "openedAt",
      "updatedAt",
      "liveness",
      "activeAttempts",
      "lastGate",
      "attention",
      "counters",
      "config",
      "cursor",
    ]);
  });

  it("I1: names an open attempt and refuses a directory without a run", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    openAttemptOk(runDir);
    expect(woof(["status", runDir]).json).toMatchObject({
      status: {
        status: "created",
        activeAttempts: [
          { agentId: "worker", stageId: "report", visit: 1, attempt: 1, dispatchedAt: null },
        ],
        lastGate: null,
      },
    });
    const empty = woof(["status", makeRunDir()]);
    expect(empty.status).toBe(3);
    expect(empty.json).toMatchObject({ outcome: "rejected", reason: "run_dir_invalid" });
    expect(woof(["status"]).status).toBe(1);
  });

  it("I2: --wait on a terminated run exits with the outcome code and the derived result", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    terminateRunOk(runDir, "cancelled");
    const waited = woof(["status", runDir, "--wait"], { timeoutMs: 20_000 });
    expect(waited.status, waited.stdout).toBe(6);
    expect(waited.stdout.trim().split("\n")).toHaveLength(1);
    const json = waited.json as Json;
    expect(json["status"]["status"]).toBe("cancelled");
    expect(json["result"]).toEqual(derivedResult(realpathSync(runDir), null));
    // Without --wait the same read exits 0.
    expect(woof(["status", runDir]).status).toBe(0);
  });

  it("I2: a recorded configuration supplies the result's repository", () => {
    const runDir = makeRunDir();
    const repo = tempDir("woof-status-repo-");
    openRunWith(runDir, "run-1", { repository: repo, roots: { project: { root: repo } } });
    terminateRunOk(runDir, "failed");
    const waited = woof(["status", runDir, "--wait"], { timeoutMs: 20_000 });
    expect(waited.status, waited.stdout).toBe(4);
    const json = waited.json as Json;
    expect(json["status"]["config"]).toEqual({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(json["result"]).toEqual(derivedResult(realpathSync(runDir), repo));
    expect(json["result"]["repository"]["path"]).toBe(repo);
  });

  it("I3: --wait on an open run exits 7 at the timeout", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    const started = Date.now();
    const waited = woof(["status", runDir, "--wait", "--timeout-ms", "300", "--poll-ms", "50"], {
      timeoutMs: 20_000,
    });
    expect(waited.status, waited.stdout).toBe(7);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(waited.json).toMatchObject({ status: { status: "created" }, result: null });
  });

  it("I4: a blocked run exits 9 at once; --allow-blocked keeps waiting", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    runSdk(
      runDir,
      `await store.assignAgent({ runDir, agentId: "worker", runtime: { adapter: "scripted", runtimeName: "w-worker", paneId: "w1:p1" }, terminalId: "term_1", sessionId: null });
out = await store.blockRun({ runDir, agentId: "worker", reason: "blocked_on_input", requiredAction: "answer the prompt", observed: { runtimeStatus: "blocked", terminalId: "term_1", stateChangeSeq: 7 } });`,
    );
    const started = Date.now();
    const blocked = woof(["status", runDir, "--wait", "--timeout-ms", "10000"], {
      timeoutMs: 20_000,
    });
    expect(blocked.status, blocked.stdout).toBe(9);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(blocked.json).toMatchObject({
      status: { attention: { blocked: { agentId: "worker", reason: "blocked_on_input" } } },
    });
    const allowed = woof(
      ["status", runDir, "--wait", "--allow-blocked", "--timeout-ms", "300", "--poll-ms", "50"],
      { timeoutMs: 20_000 },
    );
    expect(allowed.status, allowed.stdout).toBe(7);
  });

  it("exits 8 once the owner stays lost across two heartbeats, and a recorded outcome wins over lost", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    // A claim whose process is gone on this host is lost.
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
      encoding: "utf8",
    });
    writeFileSync(
      join(runDir, "host.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "woof.host",
        state: "hosting",
        pid: Number(dead.stdout),
        hostname: hostname(),
        startedAt: new Date().toISOString(),
        heartbeatMs: 150,
      }),
    );
    const started = Date.now();
    const lost = woof(["status", runDir, "--wait", "--poll-ms", "50", "--timeout-ms", "10000"], {
      timeoutMs: 20_000,
    });
    expect(lost.status, lost.stdout).toBe(8);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(lost.json).toMatchObject({ status: { liveness: { owner: "lost" } } });
    terminateRunOk(runDir, "cancelled");
    const ended = woof(["status", runDir, "--wait"], { timeoutMs: 20_000 });
    expect(ended.status, ended.stdout).toBe(6);
    expect(ended.json).toMatchObject({ status: { liveness: { owner: "lost" } } });
  });
});

describe("woof runs", () => {
  it("I5: lists runs newest first with owner and project, filters by project and skips non-runs", () => {
    const runsDir = tempDir("woof-runs-");
    const repo = tempDir("woof-runs-repo-");
    const done = join(runsDir, "done");
    const p3 = join(runsDir, "p3");
    const active = join(runsDir, "active");
    for (const dir of [done, p3, active, join(runsDir, "junk")]) mkdirSync(dir);
    writeFileSync(join(runsDir, "stray.txt"), "not a run\n");
    openRunWith(done, "done-run", { repository: repo, roots: { project: { root: repo } } });
    terminateRunOk(done, "failed");
    openRunWith(p3, "p3-run");
    openRunWith(active, "active-run", { repository: repo, roots: { project: { root: repo } } });
    writeAliveHost(active);

    const listed = woof(["runs", "--runs-dir", runsDir]);
    expect(listed.status, listed.stdout + listed.stderr).toBe(0);
    const json = listed.json as Json;
    expect(json).toMatchObject({ outcome: "runs", runsDir, exists: true });
    expect(json["runs"]).toEqual([
      {
        runId: "active-run",
        runDir: active,
        workflow: { name: "report-review", version: "1" },
        status: "created",
        owner: "alive",
        openedAt: expect.any(String),
        updatedAt: expect.any(String),
        project: repo,
      },
      expect.objectContaining({ runId: "p3-run", owner: "unhosted", project: null }),
      expect.objectContaining({ runId: "done-run", status: "failed", project: repo }),
    ]);
    expect(json["skipped"]).toEqual([{ path: join(runsDir, "junk"), reason: "run_dir_invalid" }]);

    const byProject = woof(["runs", "--runs-dir", runsDir, "--project", repo]).json as Json;
    expect(byProject["runs"].map((run: Json) => run["runId"])).toEqual(["active-run", "done-run"]);
    const limited = woof(["runs", "--runs-dir", runsDir, "--limit", "1"]).json as Json;
    expect(limited["runs"].map((run: Json) => run["runId"])).toEqual(["active-run"]);
    expect(woof(["runs", "--runs-dir", runsDir, "--limit", "0"]).status).toBe(1);
  });

  it("I5: the runs directory defaults to the user setting, else ~/.woof/runs, and a missing one lists nothing", () => {
    const home = tempDir("woof-runs-home-");
    const missing = woof(["runs"], { env: { HOME: home } });
    expect(missing.status, missing.stdout + missing.stderr).toBe(0);
    expect(missing.json).toEqual({
      outcome: "runs",
      runsDir: join(home, ".woof", "runs"),
      exists: false,
      runs: [],
      skipped: [],
    });
    const configured = tempDir("woof-runs-configured-");
    mkdirSync(join(home, ".woof"));
    writeFileSync(
      join(home, ".woof", "woof.json"),
      JSON.stringify({ schemaVersion: 1, defaults: { runsDir: configured } }),
    );
    expect(woof(["runs"], { env: { HOME: home } }).json).toMatchObject({
      runsDir: configured,
      exists: true,
      runs: [],
    });
  });
});

describe("woof events", () => {
  it("I6: prints the recorded events as NDJSON followed by the end line", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    openAttemptOk(runDir);
    const expected = runNode(
      `const { readEvents } = await import(${JSON.stringify(distUrl("observe/events.js"))});
console.log(JSON.stringify(readEvents(process.argv[1], { limit: 10000 })));`,
      [runDir],
    );
    const read = JSON.parse(expected.stdout.trim()) as Json;
    const printed = woof(["events", runDir]);
    expect(printed.status, printed.stdout + printed.stderr).toBe(0);
    expect(lines(printed.stdout)).toEqual([
      ...read["events"],
      { kind: "woof.events.end", cursor: read["cursor"], terminal: false, reason: "end" },
    ]);
    const after = woof(["events", runDir, "--after", read["events"][0]["cursor"]]);
    expect(lines(after.stdout)).toEqual([
      ...read["events"].slice(1),
      { kind: "woof.events.end", cursor: read["cursor"], terminal: false, reason: "end" },
    ]);
  });

  it("I6: --follow ends with terminated when a concurrent run cancel ends the run", async () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    const following = woofAsync(
      ["events", runDir, "--follow", "--poll-ms", "20", "--timeout-ms", "20000", "--stats"],
      { timeoutMs: 30_000 },
    );
    await delay(300);
    expect(woof(["run", "cancel", runDir]).status).toBe(0);
    const result = await following;
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const printed = lines(result.stdout);
    expect(printed.at(-2)).toMatchObject({ type: "run.terminated" });
    expect(printed.at(-1)).toEqual({
      kind: "woof.events.end",
      cursor: printed.at(-2)?.["cursor"],
      terminal: true,
      reason: "terminated",
    });
    const stats = JSON.parse(result.stderr.trim().split("\n").at(-1) ?? "null") as Json;
    expect(stats).toMatchObject({
      kind: "woof.events.stats",
      polls: expect.any(Number),
      maxProjectionMs: expect.any(Number),
      pollMs: 20,
    });
  });

  it("I6: a foreign cursor exits 2 with resync_required; --follow exits 7 at its timeout", () => {
    const runDir = makeRunDir();
    const other = makeRunDir();
    openPlannedRun(runDir);
    openRunWith(other, "other-run");
    const foreign = lines(woof(["events", other]).stdout).at(-1)?.["cursor"] as string;
    const resync = woof(["events", runDir, "--after", foreign]);
    expect(resync.status, resync.stdout).toBe(2);
    expect(lines(resync.stdout)).toEqual([
      { type: "resync_required", reason: "cursor_foreign", message: expect.any(String) },
      { kind: "woof.events.end", cursor: foreign, terminal: false, reason: "resync_required" },
    ]);
    const followed = woof(["events", runDir, "--after", foreign, "--follow", "--poll-ms", "20"], {
      timeoutMs: 20_000,
    });
    expect(followed.status, followed.stdout).toBe(2);
    expect(lines(followed.stdout).at(-1)).toMatchObject({ reason: "resync_required" });

    const timedOut = woof(
      ["events", runDir, "--follow", "--poll-ms", "20", "--timeout-ms", "300"],
      { timeoutMs: 20_000 },
    );
    expect(timedOut.status, timedOut.stdout).toBe(7);
    expect(lines(timedOut.stdout).at(-1)).toEqual({
      kind: "woof.events.end",
      cursor: expect.stringMatching(/^v1\.1\./),
      terminal: false,
      reason: "timeout",
    });
  });
});

describe("woof doctor --json", () => {
  function doctorEnv(home: string, bin: string): Record<string, string | undefined> {
    return {
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      WOOF_HERDR_BIN: join(bin, "fake-herdr"),
      HERDR_ENV: undefined,
    };
  }

  it("I7: reports the CLI, fake Herdr and Claude, config and each read-only trust state", () => {
    const root = tempDir("woof-doctor-");
    const bin = join(root, "bin");
    const home = join(root, "home");
    const repo = join(root, "repo");
    for (const dir of [bin, home, repo]) mkdirSync(dir);
    writeFileSync(join(bin, "fake-herdr"), "#!/bin/sh\necho herdr 0.0.0-fake\n", { mode: 0o755 });
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '9.9.9 (Claude Code)'\n", { mode: 0o755 });
    const git = spawnSync("git", ["init", "-q", repo], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    expect(git.status).toBe(0);

    const doctor = () => {
      const result = woof(["doctor", "--json", "--repo", repo], { env: doctorEnv(home, bin) });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result.json as Json;
    };

    const unknown = doctor();
    expect(unknown).toEqual({
      woof: {
        version: expect.any(String),
        cli: join(repoRoot, "dist", "cli.js"),
        node: expect.stringMatching(/^\//),
      },
      herdr: { env: false, paneId: null, status: "available", version: "herdr 0.0.0-fake" },
      claude: { status: "available", version: "9.9.9 (Claude Code)" },
      trust: { dir: repo, status: "unknown" },
      config: { ok: true, project: repo, warnings: [] },
    });

    const claudeJson = join(home, ".claude.json");
    writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    );
    expect(doctor()["trust"]).toEqual({ dir: repo, status: "trusted" });
    writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { "/elsewhere": { hasTrustDialogAccepted: true } } }),
    );
    const before = readFileSync(claudeJson, "utf8");
    expect(doctor()["trust"]).toEqual({ dir: repo, status: "untrusted" });
    expect(readFileSync(claudeJson, "utf8")).toBe(before);

    mkdirSync(join(repo, ".woof"));
    writeFileSync(join(repo, ".woof", "woof.json"), "{");
    expect(doctor()["config"]).toMatchObject({ ok: false, reason: "config_invalid" });
  });
});

describe("inspection is read-only", () => {
  it("I8: status, runs, events and config show never create journal.lock or run herdr", async () => {
    const root = tempDir("woof-readonly-");
    const bin = join(root, "bin");
    const log = join(root, "herdr.log");
    const runsDir = join(root, "runs");
    const runDir = join(runsDir, "run");
    mkdirSync(bin);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(bin, "herdr"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexit 1\n`, {
      mode: 0o755,
    });
    openPlannedRun(runDir);
    openAttemptOk(runDir);
    writeAliveHost(runDir);

    // PI-006: no watcher. A sentinel holds journal.lock for the whole call: any command that tried
    // to take the lock would meet O_EXCL and wait, time out or fail (journal_busy), changing its exit
    // code, and a command that removed or replaced the lock would change the sentinel.
    const lockPath = join(runDir, "journal.lock");
    const sentinel = `woof-i8-sentinel ${Date.now()}\n`;
    writeFileSync(lockPath, sentinel);
    const before = statSync(lockPath);
    const env = {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      WOOF_HERDR_BIN: undefined,
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const results = await Promise.all([
      woofAsync(["status", runDir], { env }),
      woofAsync(["status", runDir, "--wait", "--timeout-ms", "400", "--poll-ms", "20"], { env }),
      woofAsync(["runs", "--runs-dir", runsDir], { env }),
      woofAsync(["events", runDir], { env }),
      woofAsync(["events", runDir, "--follow", "--poll-ms", "20", "--timeout-ms", "400"], {
        env,
      }),
      woofAsync(["config", "show", "--project", root], { env }),
    ]);
    expect(results.map((result) => result.status)).toEqual([0, 7, 0, 0, 7, 0]);
    const after = statSync(lockPath);
    expect(readFileSync(lockPath, "utf8")).toBe(sentinel);
    expect([after.ino, after.size, after.mtimeMs]).toEqual([
      before.ino,
      before.size,
      before.mtimeMs,
    ]);
    // The sentinel really blocks a lock taker: run cancel meets it and gives up.
    const cancel = await woofAsync(["run", "cancel", runDir], { env, timeoutMs: 30_000 });
    expect(cancel.status, cancel.stdout).toBe(3);
    expect(cancel.json).toMatchObject({ outcome: "rejected", reason: "journal_busy" });
    expect(readFileSync(lockPath, "utf8")).toBe(sentinel);
    expect(existsSync(log)).toBe(false);
  });
});
