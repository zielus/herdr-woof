import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
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
  readSnapshotOf,
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
function writeAliveHost(runDir: string, heartbeatMs = 60_000): void {
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
      heartbeatMs,
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
      "checkout",
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

  it("I2: a terminated run prints the derived result and exits 0; --wait no longer exists", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    terminateRunOk(runDir, "cancelled");
    const shown = woof(["status", runDir]);
    expect(shown.status, shown.stdout).toBe(0);
    expect(shown.stdout.trim().split("\n")).toHaveLength(1);
    const json = shown.json as Json;
    expect(json["status"]["status"]).toBe("cancelled");
    expect(json["result"]).toEqual(derivedResult(realpathSync(runDir), null));
    for (const flag of ["--wait", "--allow-blocked", "--timeout-ms=10", "--poll-ms=10"])
      expect(woof(["status", runDir, flag]).status, flag).toBe(1);
  });

  it("I2: a recorded configuration supplies the result's repository", () => {
    const runDir = makeRunDir();
    const repo = tempDir("woof-status-repo-");
    openRunWith(runDir, "run-1", { repository: repo, roots: { project: { root: repo } } });
    terminateRunOk(runDir, "failed");
    const shown = woof(["status", runDir]);
    expect(shown.status, shown.stdout).toBe(0);
    const json = shown.json as Json;
    expect(json["status"]["config"]).toEqual({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(json["result"]).toEqual(derivedResult(realpathSync(runDir), repo));
    expect(json["result"]["repository"]["path"]).toBe(repo);
  });

  it("I4: a blocked run names what it needs in attention.blocked", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    runSdk(
      runDir,
      `await store.assignAgent({ runDir, agentId: "worker", runtime: { adapter: "scripted", runtimeName: "w-worker", paneId: "w1:p1" }, terminalId: "term_1", sessionId: null });
out = await store.blockRun({ runDir, agentId: "worker", reason: "blocked_on_input", requiredAction: "answer the prompt", observed: { runtimeStatus: "blocked", terminalId: "term_1", stateChangeSeq: 7 } });`,
    );
    const blocked = woof(["status", runDir]);
    expect(blocked.status, blocked.stdout).toBe(0);
    expect(blocked.json).toMatchObject({
      status: { attention: { blocked: { agentId: "worker", reason: "blocked_on_input" } } },
      result: null,
    });
  });

  it("reports a lost owner, and a recorded outcome alongside it once the run ends", () => {
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
    const lost = woof(["status", runDir]);
    expect(lost.status, lost.stdout).toBe(0);
    expect(lost.json).toMatchObject({ status: { liveness: { owner: "lost" } }, result: null });
    terminateRunOk(runDir, "cancelled");
    const ended = woof(["status", runDir]);
    expect(ended.status, ended.stdout).toBe(0);
    expect(ended.json).toMatchObject({
      status: { liveness: { owner: "lost" } },
      result: { outcome: "cancelled" },
    });
  });

  it("PR #6 (status.ts:81): an owner that exited without a terminal record is shown with the host's outcome", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    // What a pane host interrupted by a second signal before the run recorded its end leaves.
    writeAliveHost(runDir);
    writeFileSync(
      join(runDir, "host-exit.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "woof.host.exit",
        pid: process.pid,
        exitedAt: new Date().toISOString(),
        exitCode: 130,
      }),
    );
    const hostOutcome = {
      outcome: "rejected",
      reason: "host_interrupted",
      message:
        "the run host received a second signal and exited without waiting for the run to settle",
      details: [],
    };
    writeFileSync(join(runDir, "outcome.json"), JSON.stringify(hostOutcome));
    const shown = woof(["status", runDir]);
    expect(shown.status, shown.stdout).toBe(0);
    expect(shown.stdout.trim().split("\n")).toHaveLength(1);
    expect(shown.json).toMatchObject({
      outcome: "status",
      status: { status: "created", liveness: { owner: "exited", host: { exitCode: 130 } } },
      result: null,
      hostOutcome,
    });
    // A foreground host writes no outcome.json: still exited, without hostOutcome.
    rmSync(join(runDir, "outcome.json"));
    const foreground = woof(["status", runDir]);
    expect(foreground.json).toMatchObject({ status: { liveness: { owner: "exited" } } });
    expect(foreground.json).not.toHaveProperty("hostOutcome");
    // A recorded end is the answer: the host's outcome is no longer attached.
    writeFileSync(join(runDir, "outcome.json"), JSON.stringify(hostOutcome));
    terminateRunOk(runDir, "cancelled");
    const ended = woof(["status", runDir]);
    expect(ended.json).toMatchObject({ result: { outcome: "cancelled" } });
    expect(ended.json).not.toHaveProperty("hostOutcome");
  });
});

describe("woof status --pretty", () => {
  it("I9: prints the human header instead of JSON, with the same exit codes", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    openAttemptOk(runDir);
    writeAliveHost(runDir);
    const pretty = woof(["status", runDir, "--pretty"]);
    expect(pretty.status, pretty.stdout + pretty.stderr).toBe(0);
    expect(pretty.stdout.trim().split("\n")).toEqual([
      "run      run-1  report-review@1  created",
      `dir      ${realpathSync(runDir)}`,
      "now      report v1 a1 (worker)",
      `owner    alive pane w1:p9 pid ${process.pid}`,
      "agent    worker  role writer kind claude model -",
      "agent    reviewer  role reviewer kind claude model -",
    ]);
    expect(pretty.json).toBeUndefined();
    // Without --pretty the JSON line is unchanged.
    expect(woof(["status", runDir]).json).toMatchObject({ outcome: "status" });

    terminateRunOk(runDir, "cancelled");
    const ended = woof(["status", runDir, "--pretty"]);
    expect(ended.status, ended.stdout).toBe(0);
    const lines = ended.stdout.trim().split("\n");
    expect(lines[0]).toBe("run      run-1  report-review@1  cancelled");
    expect(lines.at(-1)).toBe("outcome  cancelled: test termination");

    const empty = makeRunDir();
    const refused = woof(["status", empty, "--pretty"]);
    expect(refused.status).toBe(3);
    expect(refused.stdout).toMatch(/^woof status: run_dir_invalid: /);
  });

  it("I9: --pretty names the host outcome when the owner exited without a terminal record", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    writeAliveHost(runDir);
    writeFileSync(
      join(runDir, "host-exit.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "woof.host.exit",
        pid: process.pid,
        exitedAt: new Date().toISOString(),
        exitCode: 130,
      }),
    );
    writeFileSync(
      join(runDir, "outcome.json"),
      JSON.stringify({
        outcome: "rejected",
        reason: "host_interrupted",
        message: "the run host received a second signal",
        details: [],
      }),
    );
    const shown = woof(["status", runDir, "--pretty"]);
    expect(shown.status, shown.stdout).toBe(0);
    expect(shown.stdout.trim().split("\n").at(-1)).toBe(
      "host     rejected host_interrupted: the run host received a second signal",
    );
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
      // Without --runs-dir the run index is read too (test/index.cli.test.ts).
      indexDir: join(home, ".woof", "index"),
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

  it("PR #6 (events.ts:123): --follow --after a terminated run's last cursor ends at once with terminated", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    terminateRunOk(runDir, "cancelled");
    const recorded = lines(woof(["events", runDir]).stdout);
    const last = recorded.at(-1) as Json;
    expect(last).toMatchObject({ terminal: true, reason: "end" });
    const started = Date.now();
    const resumed = woof(
      [
        "events",
        runDir,
        "--follow",
        "--after",
        last["cursor"],
        "--poll-ms",
        "20",
        "--timeout-ms",
        "5000",
      ],
      { timeoutMs: 20_000 },
    );
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(lines(resumed.stdout)).toEqual([
      { kind: "woof.events.end", cursor: last["cursor"], terminal: true, reason: "terminated" },
    ]);
    // An earlier cursor still delivers the terminal event before the end line.
    const first = recorded[0] as Json;
    const earlier = woof(
      [
        "events",
        runDir,
        "--follow",
        "--after",
        first["cursor"],
        "--poll-ms",
        "20",
        "--timeout-ms",
        "5000",
      ],
      { timeoutMs: 20_000 },
    );
    expect(earlier.status, earlier.stdout).toBe(0);
    const printed = lines(earlier.stdout);
    expect(printed.at(-2)).toMatchObject({ type: "run.terminated" });
    expect(printed.at(-1)).toEqual({
      kind: "woof.events.end",
      cursor: last["cursor"],
      terminal: true,
      reason: "terminated",
    });
  });

  it("--follow --after a terminated run's cursor delivers the host's later host.exited and ends at once", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    // A host journals its claim, the run ends, and the host's own exit follows the termination.
    const written = runSdk<{ outcomes: string[] }>(
      runDir,
      `const claimed = await store.recordHostClaimed({ runDir, pid: 4242, hostname: "test-host",
  startedAt: "2026-09-15T10:00:00.000Z", heartbeatMs: 2000, paneId: null, workspaceId: null });
const cancelled = await store.cancelRun({ runDir, source: "cli", reason: "stop", probeHost: false });
const stranger = await store.recordHostExited({ runDir, pid: 7, exitCode: 0, reason: "cancelled" });
const exited = await store.recordHostExited({ runDir, pid: 4242, exitCode: 6, reason: "cancelled" });
out = { outcomes: [claimed, cancelled, stranger, exited].map((item) => item.reason ?? item.outcome) };`,
    );
    expect(written.outcomes).toEqual(["recorded", "recorded", "host_unknown", "recorded"]);
    const recorded = lines(woof(["events", runDir]).stdout);
    expect(recorded.map((line) => line["type"] ?? line["kind"])).toEqual([
      "run.opened",
      "host.claimed",
      "run.cancel_requested",
      "run.terminated",
      "host.exited",
      "woof.events.end",
    ]);
    const terminated = recorded[3] as Json;
    const started = Date.now();
    const resumed = woof(
      ["events", runDir, "--follow", "--after", terminated["cursor"], "--timeout-ms", "5000"],
      { timeoutMs: 20_000 },
    );
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(lines(resumed.stdout)).toMatchObject([
      { type: "host.exited", data: { pid: 4242, exitCode: 6 } },
      { kind: "woof.events.end", cursor: recorded[4]?.["cursor"], terminal: true },
    ]);
    // The host's exit never reopens the run, and the snapshot shows it as the last host fact.
    expect(readSnapshotOf(runDir)).toMatchObject({
      snapshot: {
        status: "cancelled",
        lifecycle: { host: { state: "exited", pid: 4242, exitCode: 6 } },
      },
    });
  });

  // A host records the termination, drains for a while and only then journals host.exited. The
  // three tests below write that record (or never write it) while a follower is already running:
  // a journal that holds it beforehand cannot show a follower ending too early.
  const claimHostAs = (runDir: string, pid: number, heartbeatMs: number): void => {
    writeAliveHost(runDir, heartbeatMs);
    if (pid !== process.pid) {
      const claim = JSON.parse(readFileSync(join(runDir, "host.json"), "utf8")) as Json;
      writeFileSync(join(runDir, "host.json"), JSON.stringify({ ...claim, pid }));
    }
    const claimed = runSdk<{ outcome: string }>(
      runDir,
      `out = await store.recordHostClaimed({ runDir, pid: input.pid, hostname: input.hostname,
  startedAt: "2026-09-15T10:00:00.000Z", heartbeatMs: input.heartbeatMs, paneId: null, workspaceId: null });`,
      { pid, hostname: hostname(), heartbeatMs },
    );
    expect(claimed.outcome).toBe("recorded");
  };
  const cancelHosted = (runDir: string): void => {
    const cancelled = runSdk<{ outcome: string }>(
      runDir,
      `out = await store.cancelRun({ runDir, source: "cli", reason: "stop", probeHost: false });`,
    );
    expect(cancelled.outcome).toBe("recorded");
  };
  const exitHost = (runDir: string, pid: number): void => {
    const exited = runSdk<{ outcome: string }>(
      runDir,
      `out = await store.recordHostExited({ runDir, pid: input.pid, exitCode: 6, reason: "cancelled" });`,
      { pid },
    );
    expect(exited.outcome).toBe("recorded");
  };

  it("--follow delivers a host.exited journaled after the follower saw run.terminated, then ends", async () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    claimHostAs(runDir, process.pid, 2000);
    const following = woofAsync([
      "events",
      runDir,
      "--follow",
      "--poll-ms",
      "20",
      "--timeout-ms",
      "20000",
    ]);
    await delay(400);
    cancelHosted(runDir);
    // The follower has delivered run.terminated by now; its live host is still "draining".
    await delay(800);
    exitHost(runDir, process.pid);
    const followed = await following;
    expect(followed.status, followed.stdout + followed.stderr).toBe(0);
    const printed = lines(followed.stdout);
    expect(printed.map((line) => line["type"] ?? line["kind"])).toEqual([
      "run.opened",
      "host.claimed",
      "run.cancel_requested",
      "run.terminated",
      "host.exited",
      "woof.events.end",
    ]);
    expect(printed.at(-1)).toEqual({
      kind: "woof.events.end",
      cursor: printed.at(-2)?.["cursor"],
      terminal: true,
      reason: "terminated",
    });
  }, 30_000);

  it("--follow --after the terminated cursor waits for a live host's host.exited, before and after it is written", async () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    claimHostAs(runDir, process.pid, 2000);
    cancelHosted(runDir);
    // The cursor `woof status` reports once the run ended: the termination, no host.exited yet.
    const shown = woof(["status", runDir]);
    expect(shown.json).toMatchObject({ result: { outcome: "cancelled" } });
    const cursor = (shown.json as Json)["status"]["cursor"] as string;
    expect(lines(woof(["events", runDir]).stdout).at(-1)).toMatchObject({ cursor, terminal: true });
    const resume = ["events", runDir, "--follow", "--after", cursor, "--poll-ms", "20"];
    const following = woofAsync([...resume, "--timeout-ms", "20000"]);
    await delay(800);
    exitHost(runDir, process.pid);
    const before = await following;
    expect(before.status, before.stdout + before.stderr).toBe(0);
    const printed = lines(before.stdout);
    expect(printed).toMatchObject([
      { type: "host.exited", data: { pid: process.pid, exitCode: 6 } },
      { kind: "woof.events.end", terminal: true, reason: "terminated" },
    ]);
    expect(printed[1]?.["cursor"]).toBe(printed[0]?.["cursor"]);
    // Once the exit is written, the same resume delivers it and ends at once.
    const started = Date.now();
    const after = woof([...resume, "--timeout-ms", "20000"], { timeoutMs: 30_000 });
    expect(after.status, after.stdout + after.stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(lines(after.stdout)).toEqual(printed);
  }, 30_000);

  it("--follow ends within a few heartbeats when a live host never journals host.exited, and at once when the host is gone", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    // Alive (this process) with a 400 ms heartbeat: waited for three heartbeats, never longer.
    claimHostAs(runDir, process.pid, 400);
    cancelHosted(runDir);
    writeAliveHost(runDir, 400); // a fresh heartbeat right before the follower starts
    const started = Date.now();
    const followed = woof(["events", runDir, "--follow", "--poll-ms", "20"], {
      timeoutMs: 30_000,
    });
    const elapsed = Date.now() - started;
    expect(followed.status, followed.stdout + followed.stderr).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(8000);
    const printed = lines(followed.stdout);
    expect(printed.map((line) => line["type"] ?? line["kind"])).toEqual([
      "run.opened",
      "host.claimed",
      "run.cancel_requested",
      "run.terminated",
      "woof.events.end",
    ]);
    expect(printed.at(-1)).toEqual({
      kind: "woof.events.end",
      cursor: printed.at(-2)?.["cursor"],
      terminal: true,
      reason: "terminated",
    });

    // A host killed right after the termination: its pid is gone, so nothing is waited for even
    // though its claim still says "hosting" with a heartbeat far from stale.
    const goneDir = makeRunDir();
    openPlannedRun(goneDir);
    const dead = spawnSync("node", ["-e", ""]).pid;
    claimHostAs(goneDir, dead, 60_000);
    cancelHosted(goneDir);
    const goneStarted = Date.now();
    const gone = woof(["events", goneDir, "--follow", "--poll-ms", "20"], { timeoutMs: 30_000 });
    expect(gone.status, gone.stdout + gone.stderr).toBe(0);
    expect(Date.now() - goneStarted).toBeLessThan(3000);
    expect(lines(gone.stdout).at(-1)).toMatchObject({ terminal: true, reason: "terminated" });
  }, 60_000);

  it("openRun journals host.claimed under run.opened's lock: a concurrent cancel never comes between them", () => {
    // A cancel racing the open used to be able to close the run between run.opened and
    // host.claimed; the claim was then refused run_closed and the host wrote no host.exited.
    for (let round = 0; round < 8; round += 1) {
      const runDir = join(makeRunDir(), "race");
      const out = runSdk<{ types: string[]; hostClaimed: Json | null; exited: string }>(
        runDir,
        `const cancel = (async () => {
  for (;;) {
    let cancelled;
    try {
      cancelled = await store.cancelRun({ runDir, source: "cli", reason: "race", probeHost: false });
    } catch {
      cancelled = { outcome: "rejected" };
    }
    if (cancelled.outcome === "recorded") return;
    await new Promise((resolve) => setImmediate(resolve));
  }
})();
const opened = await store.openRun({ runDir, runId: "run-race", plan: input.plan, host: {
  pid: 4242, hostname: "test-host", startedAt: "2026-09-15T10:00:00.000Z", heartbeatMs: 2000,
  paneId: "w1:p1", workspaceId: null } });
await cancel;
const exited = await store.recordHostExited({ runDir, pid: 4242, exitCode: 6, reason: "cancelled" });
const read = readJournal(runDir);
out = { types: read.records.map((record) => record.type), hostClaimed: opened.hostClaimed, exited: exited.outcome };`,
        { plan: testPlan() },
      );
      expect(out.types).toEqual([
        "run.opened",
        "host.claimed",
        "run.cancel_requested",
        "run.terminated",
        "host.exited",
      ]);
      expect(out.hostClaimed).toMatchObject({ type: "host.claimed", seq: 2, pid: 4242 });
      expect(out.exited).toBe("recorded");
    }
  }, 60_000);

  it("PR #6 (events.ts:118): --follow never takes the journal lock; a persistent torn tail ends with journal_corrupt after the grace period", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    // A partial final line that never completes, while a sentinel holds journal.lock throughout: a
    // follower that tried to decide the tail under the lock would wait on it until its timeout.
    appendFileSync(join(runDir, "journal.jsonl"), '{"schemaVersion":1,"seq":2,"ts":"2026-09-15T');
    const lockPath = join(runDir, "journal.lock");
    const sentinel = `woof-pr6-follow-sentinel ${Date.now()}\n`;
    writeFileSync(lockPath, sentinel);
    const before = statSync(lockPath);
    const started = Date.now();
    const followed = woof(
      ["events", runDir, "--follow", "--poll-ms", "20", "--timeout-ms", "15000"],
      { timeoutMs: 30_000 },
    );
    const elapsed = Date.now() - started;
    expect(followed.status, followed.stdout + followed.stderr).toBe(3);
    const printed = lines(followed.stdout);
    expect(printed[0]).toMatchObject({ type: "run.opened" });
    expect(printed.at(-2)).toEqual({
      type: "error",
      reason: "journal_corrupt",
      message: expect.stringContaining("lock-free subscription"),
    });
    expect(printed.at(-1)).toEqual({
      kind: "woof.events.end",
      cursor: printed[0]?.["cursor"],
      terminal: false,
      reason: "error",
    });
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(10_000);
    const after = statSync(lockPath);
    expect(readFileSync(lockPath, "utf8")).toBe(sentinel);
    expect([after.ino, after.size, after.mtimeMs]).toEqual([
      before.ino,
      before.size,
      before.mtimeMs,
    ]);
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
      kinds: expect.any(Array),
      trust: { dir: repo, status: "unknown" },
      config: { ok: true, project: repo, warnings: [] },
      problems: ["trust_unknown"],
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

  /** A PATH holding node, the given shims and nothing else a probe could find. */
  function probeBin(root: string): { bin: string; path: string } {
    const bin = join(root, "bin");
    const nodeBin = join(root, "node-bin");
    for (const dir of [bin, nodeBin]) mkdirSync(dir, { recursive: true });
    symlinkSync(process.execPath, join(nodeBin, "node"));
    return { bin, path: `${bin}:${nodeBin}:/usr/bin:/bin` };
  }

  function gitInit(dir: string): void {
    const git = spawnSync("git", ["init", "-q", dir], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    expect(git.status).toBe(0);
  }

  it("F-016: reads trust for the git top level of --repo by its exact key; an ancestor's trust never counts", () => {
    const root = tempDir("woof-doctor-top-");
    const home = join(root, "home");
    const repo = join(root, "repo");
    const sub = join(repo, "packages", "sub");
    const plain = join(root, "plain");
    for (const dir of [home, sub, plain]) mkdirSync(dir, { recursive: true });
    gitInit(repo);
    const { bin, path } = probeBin(root);
    const env = { ...doctorEnv(home, bin), PATH: path };
    const trustOf = (dir: string) => {
      const result = woof(["doctor", "--json", "--repo", dir], { env });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return (result.json as Json)["trust"];
    };
    const claudeJson = join(home, ".claude.json");

    writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    );
    expect(trustOf(sub)).toEqual({ dir: repo, status: "trusted" });
    expect(trustOf(repo)).toEqual({ dir: repo, status: "trusted" });

    // A trusted parent of the repository is not the repository (p4 D10).
    writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } }),
    );
    expect(trustOf(sub)).toEqual({ dir: repo, status: "untrusted" });
    // The sub directory's own key does not count either: the key is the top level.
    writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [sub]: { hasTrustDialogAccepted: true } } }),
    );
    expect(trustOf(sub)).toEqual({ dir: repo, status: "untrusted" });

    // Outside a work tree the directory itself is the key.
    writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [plain]: { hasTrustDialogAccepted: true } } }),
    );
    expect(trustOf(plain)).toEqual({ dir: plain, status: "trusted" });
  });

  it("F-016: human and --json doctor run the same --version probes and report the same facts", () => {
    const root = tempDir("woof-doctor-same-");
    const home = join(root, "home");
    const repo = join(root, "repo");
    for (const dir of [home, repo]) mkdirSync(dir);
    gitInit(repo);
    const { bin, path } = probeBin(root);
    const argvLog = join(root, "herdr-argv.log");
    writeFileSync(
      join(bin, "fake-herdr"),
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(argvLog)}\necho herdr 0.0.0-fake\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '9.9.9 (Claude Code)'\n", { mode: 0o755 });
    const env = { ...doctorEnv(home, bin), PATH: path };

    const json = woof(["doctor", "--json", "--repo", repo], { env });
    expect(json.status, json.stdout + json.stderr).toBe(0);
    const human = woof(["doctor", "--repo", repo], { env });
    expect(human.status, human.stdout + human.stderr).toBe(0);
    expect(readFileSync(argvLog, "utf8")).toBe("--version\n--version\n");

    const report = json.json as Json;
    expect(report["problems"]).toEqual(["trust_unknown"]);
    const out = human.stdout;
    expect(out).toMatch(
      new RegExp(`^woof ${report["woof"]["version"].replaceAll(".", "\\.")}$`, "m"),
    );
    expect(out).toContain(`  cli: ${report["woof"]["cli"]}`);
    expect(out).toMatch(/^herdr: available \(herdr 0\.0\.0-fake\)$/m);
    expect(out).toMatch(/^  env: HERDR_ENV is not 1$/m);
    expect(out).toMatch(/^claude: available \(9\.9\.9 \(Claude Code\)\)$/m);
    expect(out).toContain(`\ntrust: unknown (${repo})\n`);
    expect(out).toContain(`\nconfig: ok (project ${repo})\n`);
    expect(out).toMatch(/^problems: trust_unknown$/m);
  });

  it("F-016: --strict exits 2 when the report names a problem, in both modes; without it doctor exits 0", () => {
    const root = tempDir("woof-doctor-strict-");
    const home = join(root, "home");
    const repo = join(root, "repo");
    for (const dir of [home, repo]) mkdirSync(dir);
    gitInit(repo);
    const { bin, path } = probeBin(root);
    writeFileSync(join(bin, "fake-herdr"), "#!/bin/sh\necho herdr 0.0.0-fake\n", { mode: 0o755 });
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    );
    const env = { ...doctorEnv(home, bin), PATH: path };
    const run = (...args: string[]) => woof(["doctor", "--repo", repo, ...args], { env });

    // Claude Code is not installed.
    const lenient = run("--json");
    expect(lenient.status, lenient.stdout + lenient.stderr).toBe(0);
    expect((lenient.json as Json)["problems"]).toEqual(["claude_unavailable"]);
    const strictJson = run("--json", "--strict");
    expect(strictJson.status, strictJson.stdout + strictJson.stderr).toBe(2);
    expect((strictJson.json as Json)["problems"]).toEqual(["claude_unavailable"]);
    const strictHuman = run("--strict");
    expect(strictHuman.status, strictHuman.stdout + strictHuman.stderr).toBe(2);
    expect(strictHuman.stdout).toMatch(/^problems: claude_unavailable$/m);
    expect(run().status).toBe(0);

    // Every problem id the report can name, at once: nothing installed, untrusted, bad config.
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: {} }));
    mkdirSync(join(repo, ".woof"));
    writeFileSync(join(repo, ".woof", "woof.json"), "{");
    const broken = woof(["doctor", "--json", "--strict", "--repo", repo], {
      env: { ...env, WOOF_HERDR_BIN: join(root, "missing-herdr") },
    });
    expect(broken.status).toBe(2);
    expect((broken.json as Json)["problems"]).toEqual([
      "herdr_unavailable",
      "claude_unavailable",
      "trust_untrusted",
      "config_invalid",
    ]);

    // Nothing wrong: --strict is exit 0 with an empty list.
    rmSync(join(repo, ".woof"), { recursive: true });
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    );
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '9.9.9 (Claude Code)'\n", { mode: 0o755 });
    const healthy = run("--json", "--strict");
    expect(healthy.status, healthy.stdout + healthy.stderr).toBe(0);
    expect((healthy.json as Json)["problems"]).toEqual([]);
    const healthyHuman = run("--strict");
    expect(healthyHuman.status).toBe(0);
    expect(healthyHuman.stdout).toMatch(/^problems: none$/m);
  });

  it("agent kinds: probes every kind; a kind other than claude is a problem only when a role uses it", () => {
    const root = tempDir("woof-doctor-kinds-");
    const home = join(root, "home");
    const repo = join(root, "repo");
    for (const dir of [home, repo]) mkdirSync(dir);
    gitInit(repo);
    const { bin, path } = probeBin(root);
    writeFileSync(join(bin, "fake-herdr"), "#!/bin/sh\necho herdr 0.0.0-fake\n", { mode: 0o755 });
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '9.9.9 (Claude Code)'\n", { mode: 0o755 });
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    );
    const env = { ...doctorEnv(home, bin), PATH: path };
    const doctor = () => {
      const result = woof(["doctor", "--json", "--repo", repo], { env });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result.json as Json;
    };
    const kind = (report: Json, name: string) =>
      (report["kinds"] as Json[]).find((entry) => entry["kind"] === name) as Json;

    // pi is not installed and no role uses it: reported, but not a problem.
    const unused = doctor();
    expect(kind(unused, "pi")).toEqual({
      kind: "pi",
      executable: "pi",
      status: "not_found",
      version: null,
      roles: [],
      readiness: [],
      trust: null,
    });
    expect(kind(unused, "claude")).toMatchObject({
      status: "available",
      roles: ["builder", "planner", "reviewer"],
    });
    expect(unused["problems"]).toEqual([]);

    // A pi role makes a missing pi a problem.
    mkdirSync(join(repo, ".woof", "roles"), { recursive: true });
    writeFileSync(
      join(repo, ".woof", "roles", "builder.json"),
      JSON.stringify({ schemaVersion: 1, kind: "pi", provider: "github-copilot", model: "m" }),
    );
    expect(doctor()["problems"]).toEqual(["pi_unavailable"]);

    // A fake pi: --version, and `auth check` answering from its arguments (never real credentials).
    const argvLog = join(root, "pi-argv.log");
    writeFileSync(
      join(bin, "pi"),
      `#!/bin/sh
echo "$@" >> ${JSON.stringify(argvLog)}
if [ "$1" = "--version" ]; then echo 0.86.0; exit 0; fi
if [ "$4" = "github-copilot" ]; then echo '{"status":"ready","provider":"github-copilot","authType":"oauth"}'; exit 0; fi
echo '{"status":"not_ready","provider":"'"$4"'","reason":"provider_not_found"}'; exit 1
`,
      { mode: 0o755 },
    );
    const ready = doctor();
    expect(kind(ready, "pi")).toEqual({
      kind: "pi",
      executable: "pi",
      status: "available",
      version: "0.86.0",
      roles: ["builder"],
      readiness: [
        {
          roles: ["builder"],
          subject: "provider github-copilot",
          ready: true,
          detail: "ready (oauth)",
        },
      ],
      trust: null,
    });
    expect(ready["problems"]).toEqual([]);
    expect(readFileSync(argvLog, "utf8")).toBe(
      "--version\nauth check --provider github-copilot --json --no-refresh\n",
    );
    const human = woof(["doctor", "--repo", repo], { env });
    expect(human.stdout).toMatch(/^pi: available \(0\.86\.0\) \(roles: builder\)$/m);
    expect(human.stdout).toMatch(
      /^  provider github-copilot: ready \(oauth\) \(roles: builder\)$/m,
    );

    // A provider pi reports not ready is pi_not_ready.
    writeFileSync(
      join(repo, ".woof", "roles", "builder.json"),
      JSON.stringify({ schemaVersion: 1, kind: "pi", provider: "nosuch", model: "m" }),
    );
    const notReady = doctor();
    expect(kind(notReady, "pi")["readiness"]).toEqual([
      {
        roles: ["builder"],
        subject: "provider nosuch",
        ready: false,
        detail: "not ready (provider_not_found)",
      },
    ]);
    expect(notReady["problems"]).toEqual(["pi_not_ready"]);

    // A codex role: `codex login status` is its readiness probe.
    writeFileSync(
      join(repo, ".woof", "roles", "reviewer.json"),
      JSON.stringify({ schemaVersion: 1, kind: "codex", model: null }),
    );
    writeFileSync(
      join(repo, ".woof", "roles", "builder.json"),
      JSON.stringify({ schemaVersion: 1, kind: "claude", model: null }),
    );
    expect(doctor()["problems"]).toEqual(["codex_unavailable"]);
    const codexLogin = join(root, "codex-login");
    writeFileSync(
      join(bin, "codex"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo codex-cli 0.0.0-fake; exit 0; fi
if [ "$1 $2" = "login status" ] && [ -f ${JSON.stringify(codexLogin)} ]; then echo "Logged in using ChatGPT"; exit 0; fi
echo "Not logged in"; exit 1
`,
      { mode: 0o755 },
    );
    const loggedOut = doctor();
    expect(kind(loggedOut, "codex")).toMatchObject({
      status: "available",
      version: "codex-cli 0.0.0-fake",
      roles: ["reviewer"],
      readiness: [{ roles: ["reviewer"], subject: "login", ready: false, detail: "Not logged in" }],
      trust: null,
    });
    expect(loggedOut["problems"]).toEqual(["codex_not_ready"]);
    writeFileSync(codexLogin, "");
    const loggedIn = doctor();
    expect(kind(loggedIn, "codex")["readiness"]).toEqual([
      { roles: ["reviewer"], subject: "login", ready: true, detail: "Logged in using ChatGPT" },
    ]);
    expect(loggedIn["problems"]).toEqual([]);

    // A grok role: grok has no readiness probe, only its --version.
    writeFileSync(
      join(repo, ".woof", "roles", "planner.json"),
      JSON.stringify({ schemaVersion: 1, kind: "grok", model: null }),
    );
    expect(doctor()["problems"]).toEqual(["grok_unavailable"]);
    writeFileSync(join(bin, "grok"), "#!/bin/sh\necho 'grok 0.0.0-fake'\n", { mode: 0o755 });
    const withGrok = doctor();
    expect(kind(withGrok, "grok")).toEqual({
      kind: "grok",
      executable: "grok",
      status: "available",
      version: "grok 0.0.0-fake",
      roles: ["planner"],
      readiness: [],
      trust: null,
    });
    expect(withGrok["problems"]).toEqual([]);
  });

  it("F-023: never follows a symlinked ~/.claude.json; trust is unknown", () => {
    const root = tempDir("woof-doctor-link-");
    const home = join(root, "home");
    const repo = join(root, "repo");
    const elsewhere = join(root, "elsewhere");
    for (const dir of [home, repo, elsewhere]) mkdirSync(dir);
    gitInit(repo);
    const { bin, path } = probeBin(root);
    const env = { ...doctorEnv(home, bin), PATH: path };
    const trusting = join(elsewhere, "claude.json");
    writeFileSync(
      trusting,
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    );

    symlinkSync(trusting, join(home, ".claude.json"));
    const linked = woof(["doctor", "--json", "--repo", repo], { env });
    expect((linked.json as Json)["trust"]).toEqual({ dir: repo, status: "unknown" });

    rmSync(join(home, ".claude.json"));
    copyFileSync(trusting, join(home, ".claude.json"));
    const regular = woof(["doctor", "--json", "--repo", repo], { env });
    expect((regular.json as Json)["trust"]).toEqual({ dir: repo, status: "trusted" });
  });

  it("PR #6 (doctor.ts:87): human-mode doctor bounds a hung probe at 10 s and reports it failed", () => {
    const root = tempDir("woof-doctor-hung-");
    const bin = join(root, "bin");
    const nodeBin = join(root, "node-bin");
    const home = join(root, "home");
    for (const dir of [bin, nodeBin, home]) mkdirSync(dir);
    // Human mode resolves claude on PATH (a hung shim here) and herdr through WOOF_HERDR_BIN (missing here).
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
    symlinkSync(process.execPath, join(nodeBin, "node"));
    for (const dir of ["/usr/bin", "/bin"]) expect(existsSync(join(dir, "herdr")), dir).toBe(false);
    const started = Date.now();
    const result = woof(["doctor"], {
      env: { ...doctorEnv(home, bin), PATH: `${bin}:${nodeBin}:/usr/bin:/bin` },
      timeoutMs: 40_000,
    });
    const elapsed = Date.now() - started;
    expect(result.status, result.stdout + result.stderr).toBe(0);
    // F-016: human mode renders the --json report, so both probes are `--version`.
    expect(result.stdout).toMatch(/^herdr: not found$/m);
    expect(result.stdout).toMatch(/^claude: failed$/m);
    expect(elapsed).toBeGreaterThanOrEqual(9_500);
    expect(elapsed).toBeLessThan(25_000);
  }, 60_000);

  it("PR #6 (doctor.ts:43): human-mode doctor probes WOOF_HERDR_BIN, never a herdr from PATH", () => {
    const root = tempDir("woof-doctor-bin-");
    const bin = join(root, "bin");
    const home = join(root, "home");
    for (const dir of [bin, home]) mkdirSync(dir);
    const guardLog = join(root, "guard.log");
    // A herdr first on PATH that must never run, and the configured fake by absolute path.
    writeFileSync(
      join(bin, "herdr"),
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(guardLog)}\nexit 1\n`,
      {
        mode: 0o755,
      },
    );
    writeFileSync(join(bin, "fake-herdr"), '#!/bin/sh\necho "fake herdr $1"\n', { mode: 0o755 });
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '9.9.9 (Claude Code)'\n", { mode: 0o755 });
    const result = woof(["doctor"], { env: doctorEnv(home, bin), timeoutMs: 30_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^herdr: available \(fake herdr --version\)$/m);
    expect(result.stdout).toMatch(/^claude: available \(9\.9\.9 \(Claude Code\)\)$/m);
    expect(existsSync(guardLog)).toBe(false);
    // A configured executable that does not exist is reported as not found, not replaced by PATH.
    const missing = woof(["doctor"], {
      env: { ...doctorEnv(home, bin), WOOF_HERDR_BIN: join(root, "missing-herdr") },
      timeoutMs: 30_000,
    });
    expect(missing.status).toBe(0);
    expect(missing.stdout).toMatch(/^herdr: not found$/m);
    expect(existsSync(guardLog)).toBe(false);
  });
});

describe("inspection is read-only", () => {
  it("I8: status, runs, events, watch and config show never create journal.lock or run herdr", async () => {
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
      woofAsync(["status", runDir, "--verify-artifacts"], { env }),
      woofAsync(["runs", "--runs-dir", runsDir], { env }),
      woofAsync(["events", runDir], { env }),
      woofAsync(["events", runDir, "--follow", "--poll-ms", "20", "--timeout-ms", "400"], {
        env,
      }),
      woofAsync(["config", "show", "--project", root], { env }),
      woofAsync(["watch", runDir], { env }),
      woofAsync(["watch", runDir, "--follow", "--poll-ms", "20", "--timeout-ms", "400"], { env }),
      woofAsync(["events", runDir, "--pretty"], { env }),
      woofAsync(["status", runDir, "--pretty"], { env }),
    ]);
    expect(results.map((result) => result.status)).toEqual([0, 0, 0, 0, 7, 0, 0, 7, 0, 0]);
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
