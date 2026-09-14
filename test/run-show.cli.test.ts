import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupRunDirs,
  cliPath,
  makeRunDir,
  openAttemptOk,
  openPlannedRun,
  readyAttempt,
  repoRoot,
  runSdk,
  submit,
  terminateRunOk,
  woof,
} from "./helpers/process.js";

afterEach(() => cleanupRunDirs());

type Json = Record<string, unknown>;
interface Shown {
  outcome: string;
  reason?: string;
  message?: string;
  snapshot?: Json & {
    status: string;
    workflow: Json | null;
    counters: Json;
    attention: { ambiguousDeliveries: Json[] };
    agents: Array<Json & { runtime: unknown }>;
    stages: Array<{ visits: Array<{ attempts: Array<Json & { status: string }> }> }>;
    journal: Json;
    integrity: { artifacts: unknown };
  };
}

function show(args: string[]): { status: number | null; json: Shown; stderr: string } {
  const result = woof(["run", "show", ...args]);
  return {
    status: result.status,
    json: JSON.parse(result.stdout || "{}") as Shown,
    stderr: result.stderr,
  };
}

describe("woof run show", () => {
  it("shows a p1-shaped run without a plan", () => {
    const { runDir, envelope } = readyAttempt();
    expect(submit(runDir, envelope).json?.outcome).toBe("accepted");

    const { status, json } = show([runDir]);

    expect(status).toBe(0);
    expect(json.outcome).toBe("snapshot");
    expect(json.snapshot).toMatchObject({
      runId: "run-1",
      workflow: null,
      status: "created",
      limits: null,
    });
    expect(json.snapshot?.stages[0]?.visits[0]?.attempts[0]).toMatchObject({
      status: "accepted",
      delivery: "undispatched",
    });
    expect(json.snapshot?.integrity.artifacts).toBe("unchecked");
  });

  it("shows the committed p1 journal fixture", () => {
    const runDir = makeRunDir();
    copyFileSync(
      join(repoRoot, "test", "fixtures", "p1-journal.jsonl"),
      join(runDir, "journal.jsonl"),
    );

    const { status, json } = show([runDir]);

    expect(status).toBe(0);
    expect(json.snapshot).toMatchObject({ runId: "fixture-run", revision: 5 });
  });

  it("shows a planned, terminated run with counters and attention", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    runSdk(
      runDir,
      `out = await store.assignAgent({ runDir, agentId: "worker", runtime: { adapter: "herdr", runtimeName: "w-worker-abc123", paneId: "w1:p5" }, terminalId: "term_9" });`,
    );
    openAttemptOk(runDir, { pane: "w1:p5" });
    runSdk(
      runDir,
      `out = await store.recordDispatch({ runDir, agentId: "worker", stageId: "report", visit: 1, attempt: 1, delivery: "ambiguous", reason: "stalled" });`,
    );
    expect(
      submit(runDir, {
        schemaVersion: 1,
        runId: "run-1",
        agentId: "worker",
        stageId: "report",
        visit: 1,
        attempt: 1,
        status: "completed",
        verdict: "pass",
        artifact: { path: "artifacts/report/visit-1/attempt-1/missing.md", sha256: "a".repeat(64) },
      }).json?.reason,
    ).toBe("artifact_missing");
    terminateRunOk(runDir);

    const { status, json } = show([runDir]);

    expect(status).toBe(0);
    const snapshot = json.snapshot;
    expect(snapshot).toMatchObject({
      status: "cancelled",
      workflow: { name: "report-review", version: "1" },
      outcome: { outcome: "cancelled", reason: "test termination", limit: null },
      liveness: { owner: "unhosted", runtime: "not_observed" },
    });
    expect(snapshot?.counters).toMatchObject({
      attemptsOpened: 1,
      submissionsRejected: 1,
      rejectionsByReason: { artifact_missing: 1 },
      dispatches: { started: 0, not_delivered: 0, ambiguous: 1 },
    });
    expect(snapshot?.attention.ambiguousDeliveries).toEqual([
      { stageId: "report", visit: 1, attempt: 1, agentId: "worker", reason: "stalled" },
    ]);
    expect(snapshot?.agents[0]).toMatchObject({
      agentId: "worker",
      role: "writer",
      assignment: { adapter: "herdr", paneId: "w1:p5", terminalId: "term_9", sessionId: null },
      activeAttempt: null,
      runtime: null,
    });
    expect(snapshot?.stages[0]?.visits[0]?.attempts[0]).toMatchObject({
      status: "abandoned",
      delivery: "ambiguous",
      paneId: "w1:p5",
      rejections: { artifact_missing: 1 },
    });
  });

  it("reports a missing run directory and a corrupt journal with exit 3", () => {
    const missing = show([join(makeRunDir(), "nope")]);
    expect(missing.status).toBe(3);
    expect(missing.json).toMatchObject({ outcome: "rejected", reason: "run_dir_invalid" });

    const runDir = makeRunDir();
    openAttemptOk(runDir);
    appendFileSync(join(runDir, "journal.jsonl"), '{"not":"a record"}\n');
    const corrupt = show([runDir]);
    expect(corrupt.status).toBe(3);
    expect(corrupt.json).toMatchObject({ outcome: "rejected", reason: "journal_corrupt", line: 3 });
    expect(corrupt.json.message).toContain("line 3");
  });

  it("reports a write in flight as tailPending with the previous revision", () => {
    const runDir = makeRunDir();
    openAttemptOk(runDir);
    appendFileSync(join(runDir, "journal.jsonl"), '{"schemaVersion":1,"seq":3');

    const { status, json } = show([runDir]);

    expect(status).toBe(0);
    expect(json.snapshot).toMatchObject({
      revision: 2,
      journal: { records: 2, tailPending: true },
    });
  });

  it("takes no journal lock", () => {
    const runDir = makeRunDir();
    openAttemptOk(runDir);
    writeFileSync(
      join(runDir, "journal.lock"),
      JSON.stringify({ pid: process.pid, host: hostname(), ts: new Date().toISOString() }),
    );

    const started = Date.now();
    const { status } = show([runDir]);

    expect(status).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("never runs herdr", () => {
    const runDir = makeRunDir();
    openAttemptOk(runDir);
    const emptyBin = mkdtempSync(join(tmpdir(), "woof-no-herdr-"));
    try {
      const result = spawnSync(process.execPath, [cliPath, "run", "show", runDir], {
        encoding: "utf8",
        env: { PATH: emptyBin },
      });
      expect(result.status, result.stderr).toBe(0);
      expect((JSON.parse(result.stdout) as Shown).outcome).toBe("snapshot");
    } finally {
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  it("requires exactly one run directory", () => {
    for (const args of [[], ["a", "b"], ["--bogus", "a"]]) {
      const result = woof(["run", "show", ...args]);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr).toContain("Usage: woof run show");
    }
    expect(woof(["run", "list"]).status).toBe(1);
    const help = woof(["run", "show", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--verify-artifacts");
  });

  it("verifies accepted copies on request", () => {
    const { runDir, envelope } = readyAttempt();
    const receipt = submit(runDir, envelope).json?.receipt;
    const copy = join(runDir, receipt?.artifact.acceptedPath ?? "missing");
    expect(show([runDir, "--verify-artifacts"]).json.snapshot?.integrity.artifacts).toEqual({
      checked: 1,
      altered: [],
    });

    chmodSync(copy, 0o644);
    writeFileSync(copy, `${readFileSync(copy, "utf8")}tampered\n`);
    const verified = show(["--verify-artifacts", runDir]);

    expect(verified.status).toBe(0);
    expect(verified.json.snapshot?.integrity.artifacts).toEqual({
      checked: 1,
      altered: [
        {
          receiptId: receipt?.receiptId,
          acceptedPath: receipt?.artifact.acceptedPath,
          problem: expect.stringContaining("no longer matches"),
        },
      ],
    });
    expect(show([runDir]).json.snapshot?.integrity.artifacts).toBe("unchecked");
  });
});
