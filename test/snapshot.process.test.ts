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
  distUrl,
  makeRunDir,
  openAttemptOk,
  openPlannedRun,
  readSnapshotOf,
  readyAttempt,
  repoRoot,
  runSdk,
  submit,
  terminateRunOk,
  testPlan,
} from "./helpers/process.js";

// `readSnapshot` of the built package, read in a child process as a consumer reads it. These
// cases covered the removed `woof run show`, which printed exactly this result.
afterEach(() => cleanupRunDirs());

type Json = Record<string, unknown>;
interface Shown {
  ok: boolean;
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

function show(runDir: string, verifyArtifacts = false): { ok: boolean; json: Shown } {
  const json = readSnapshotOf(runDir, { verifyArtifacts }) as Shown;
  return { ok: json.ok, json };
}

describe("readSnapshot", () => {
  it("shows a p1-shaped run without a plan", () => {
    const { runDir, envelope } = readyAttempt();
    expect(submit(runDir, envelope).json?.outcome).toBe("accepted");

    const { ok, json } = show(runDir);

    expect(ok).toBe(true);
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

    const { ok, json } = show(runDir);

    expect(ok).toBe(true);
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

    const { ok, json } = show(runDir);

    expect(ok).toBe(true);
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

  it("reports a missing run directory and a corrupt journal", () => {
    const missing = show(join(makeRunDir(), "nope"));
    expect(missing.json).toMatchObject({ ok: false, reason: "run_dir_invalid" });

    const runDir = makeRunDir();
    openAttemptOk(runDir);
    appendFileSync(join(runDir, "journal.jsonl"), '{"not":"a record"}\n');
    const corrupt = show(runDir);
    expect(corrupt.json).toMatchObject({ ok: false, reason: "journal_corrupt", line: 3 });
    expect(corrupt.json.message).toContain("line 3");
  });

  it("reports a write in flight as tailPending with the previous revision", () => {
    const runDir = makeRunDir();
    openAttemptOk(runDir);
    appendFileSync(join(runDir, "journal.jsonl"), '{"schemaVersion":1,"seq":3');

    const { ok, json } = show(runDir);

    expect(ok).toBe(true);
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
    const { ok } = show(runDir);

    expect(ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("never runs herdr", () => {
    const runDir = makeRunDir();
    openAttemptOk(runDir);
    const emptyBin = mkdtempSync(join(tmpdir(), "woof-no-herdr-"));
    try {
      const script = `const { readSnapshot } = await import(${JSON.stringify(distUrl("state/snapshot.js"))});
console.log(JSON.stringify(readSnapshot(process.argv[1])));`;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", script, runDir],
        { encoding: "utf8", env: { PATH: emptyBin } },
      );
      expect(result.status, result.stderr).toBe(0);
      expect((JSON.parse(result.stdout) as Shown).ok).toBe(true);
    } finally {
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  it("keeps prototype-named ids as ordinary keys and round-trips them through JSON", () => {
    const runDir = makeRunDir();
    const plan = testPlan({
      agents: [
        { agentId: "hasOwnProperty", role: "writer", kind: "claude", model: null },
        { agentId: "valueOf", role: "reviewer", kind: "claude", model: null },
      ],
      stages: [
        { stageId: "constructor", agentId: "hasOwnProperty", verdicts: [] },
        { stageId: "toString", agentId: "valueOf", verdicts: [] },
      ],
    });
    const steps = runSdk<string[]>(
      runDir,
      `import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
const content = "# Report\\n\\nPrototype-named ids stay ordinary keys.\\n";
const sha = createHash("sha256").update(content).digest("hex");
const steps = [];
steps.push((await store.openRun({ runDir, runId: "run-1", plan: input })).outcome);
for (const paneId of ["w1:a", "w1:b"]) {
  steps.push((await store.assignAgent({ runDir, agentId: "hasOwnProperty", runtime: { adapter: "scripted", runtimeName: "w-a", paneId } })).outcome);
}
const submitFor = async (stageId, agentId, visit, write) => {
  steps.push((await openAttempt({ runDir, runId: "run-1", agentId, stageId, visit, attempt: 1 })).outcome);
  const dir = "artifacts/" + stageId + "/visit-" + visit + "/attempt-1";
  if (write) {
    mkdirSync(runDir + "/" + dir, { recursive: true });
    writeFileSync(runDir + "/" + dir + "/report.md", content);
  }
  const envelope = { schemaVersion: 1, runId: "run-1", agentId, stageId, visit, attempt: 1, status: "completed", verdict: null, artifact: { path: dir + "/report.md", sha256: sha } };
  steps.push((await submitResult({ runDir, envelopeRaw: JSON.stringify(envelope) })).outcome);
};
await submitFor("constructor", "hasOwnProperty", 1, true);
await submitFor("toString", "valueOf", 1, false);
await submitFor("constructor", "hasOwnProperty", 2, true);
out = steps;`,
      plan,
    );
    expect(steps).toEqual([
      "recorded",
      "recorded",
      "recorded",
      "opened",
      "accepted",
      "opened",
      "rejected",
      "opened",
      "accepted",
    ]);

    const { ok, json } = show(runDir);

    expect(ok).toBe(true);
    const snapshot = json.snapshot as NonNullable<Shown["snapshot"]> & {
      outputs: { latestAcceptedByStage: Record<string, Json> };
    };
    expect(snapshot.counters).toMatchObject({
      attemptsOpened: 3,
      visitsByStage: { constructor: 2, toString: 1 },
      attemptsByVisit: { "constructor/1": 1, "constructor/2": 1, "toString/1": 1 },
      rejectionsByReason: { artifact_missing: 1 },
      replacementsByAgent: { hasOwnProperty: 1 },
      submissionsAccepted: 2,
      submissionsRejected: 1,
    });
    expect(Object.keys(snapshot.outputs.latestAcceptedByStage)).toEqual(["constructor"]);
    expect(snapshot.outputs.latestAcceptedByStage["constructor"]).toMatchObject({
      stageId: "constructor",
      visit: 2,
      attempt: 1,
    });
  });

  it("verifies accepted copies on request", () => {
    const { runDir, envelope } = readyAttempt();
    const receipt = submit(runDir, envelope).json?.receipt;
    const copy = join(runDir, receipt?.artifact.acceptedPath ?? "missing");
    expect(show(runDir, true).json.snapshot?.integrity.artifacts).toEqual({
      checked: 1,
      altered: [],
    });

    chmodSync(copy, 0o644);
    writeFileSync(copy, `${readFileSync(copy, "utf8")}tampered\n`);
    const verified = show(runDir, true);

    expect(verified.ok).toBe(true);
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
    expect(show(runDir).json.snapshot?.integrity.artifacts).toBe("unchecked");
  });
});
