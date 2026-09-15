import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONTENT,
  artifactRel,
  cleanupRunDirs,
  envelopeFor,
  journal,
  makeRunDir,
  ofType,
  openAttemptOk,
  openPlannedRun,
  readyAttempt,
  runNodeAsync,
  runSdk,
  sdkScript,
  sha256,
  submit,
  terminateRunOk,
  testPlan,
  writeArtifact,
} from "./helpers/process.js";

afterEach(() => cleanupRunDirs());

interface Outcome {
  outcome: string;
  reason?: string;
  message?: string;
  details?: Array<{ field: string; message: string }>;
  revision?: number;
  record?: Record<string, unknown>;
}

const ASSIGN_WORKER = `out = await store.assignAgent({
  runDir, agentId: input.agentId ?? "worker",
  runtime: { adapter: "scripted", runtimeName: "w-worker", paneId: input.paneId ?? "w1:p1" },
  terminalId: "term_1", sessionId: null,
});`;

const DISPATCH = `out = await store.recordDispatch({
  runDir, agentId: input.agentId ?? "worker", stageId: input.stageId ?? "report",
  visit: input.visit ?? 1, attempt: input.attempt ?? 1,
  delivery: input.delivery ?? "started", reason: input.reason ?? "observed_working",
});`;

const SNAPSHOT = `out = snapshots.readSnapshot(runDir);`;

function journalBytes(runDir: string): Buffer {
  return readFileSync(join(runDir, "journal.jsonl"));
}

describe("state store: openRun", () => {
  it("records the validated plan once and refuses a second run in the directory", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    const before = journalBytes(runDir);

    const again = runSdk<Outcome>(
      runDir,
      `out = await store.openRun({ runDir, runId: "run-2", plan: input });`,
      testPlan(),
    );

    expect(again).toMatchObject({ outcome: "rejected", reason: "run_exists" });
    expect(journalBytes(runDir).equals(before)).toBe(true);
    const lines = journal(runDir) as unknown as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: "run.opened", runId: "run-1", plan: testPlan() });
  });

  it("refuses an invalid plan with one detail per field and writes nothing", () => {
    const runDir = makeRunDir();
    const plan = testPlan({ limits: { ...(testPlan()["limits"] as object), maxRounds: 0 } });
    const out = runSdk<Outcome & { journal: boolean }>(
      runDir,
      `out = await store.openRun({ runDir, runId: "run-1", plan: input });
out.journal = (await import("node:fs")).existsSync(runDir + "/journal.jsonl");`,
      plan,
    );
    expect(out).toMatchObject({
      outcome: "rejected",
      reason: "plan_invalid",
      details: [{ field: "limits.maxRounds" }],
      journal: false,
    });
  });
});

describe("state store: refusals leave the journal untouched", () => {
  it("refuses an unplanned agent and a run mismatch", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    const before = journalBytes(runDir);

    const unknown = runSdk<Outcome>(runDir, ASSIGN_WORKER, { agentId: "ghost" });
    const mismatch = runSdk<Outcome>(
      runDir,
      `out = await store.terminateRun({ runDir, runId: "run-9", outcome: "failed", reason: "x" });`,
    );

    expect(unknown).toMatchObject({ outcome: "rejected", reason: "agent_unknown" });
    expect(mismatch).toMatchObject({ outcome: "rejected", reason: "run_mismatch" });
    expect(journalBytes(runDir).equals(before)).toBe(true);
  });

  it("refuses a second dispatch, a dispatch by another agent and reassignment of a busy agent", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    expect(runSdk<Outcome>(runDir, ASSIGN_WORKER)).toMatchObject({ outcome: "recorded" });
    expect(
      runSdk<Outcome>(runDir, ASSIGN_WORKER, { agentId: "reviewer", paneId: "w1:p2" }),
    ).toMatchObject({ outcome: "recorded" });
    openAttemptOk(runDir);
    expect(runSdk<Outcome>(runDir, DISPATCH)).toMatchObject({ outcome: "recorded", revision: 5 });
    const before = journalBytes(runDir);

    const twice = runSdk<Outcome>(runDir, DISPATCH, { delivery: "ambiguous", reason: "timeout" });
    const otherAgent = runSdk<Outcome>(runDir, DISPATCH, { agentId: "reviewer" });
    const busy = runSdk<Outcome>(runDir, ASSIGN_WORKER, { paneId: "w1:p9" });

    expect(twice).toMatchObject({ outcome: "rejected", reason: "dispatch_exists" });
    expect(otherAgent).toMatchObject({ outcome: "rejected", reason: "owner_mismatch" });
    expect(busy).toMatchObject({ outcome: "rejected", reason: "agent_busy" });
    expect(journalBytes(runDir).equals(before)).toBe(true);
  });

  it("refuses a dispatch to an unassigned agent and a second termination", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    openAttemptOk(runDir);

    expect(runSdk<Outcome>(runDir, DISPATCH)).toMatchObject({ reason: "agent_unassigned" });
    const terminate = `out = await store.terminateRun({ runDir, outcome: "cancelled", reason: "done" });`;
    expect(runSdk<Outcome>(runDir, terminate)).toMatchObject({ outcome: "recorded" });
    expect(runSdk<Outcome>(runDir, terminate)).toMatchObject({
      outcome: "rejected",
      reason: "run_closed",
    });
    expect(runSdk<Outcome>(runDir, ASSIGN_WORKER)).toMatchObject({ reason: "run_closed" });
  });

  it("reports a missing journal as run_dir_invalid and throws on a malformed fact before locking", () => {
    const runDir = makeRunDir();
    expect(runSdk<Outcome>(runDir, DISPATCH)).toMatchObject({
      outcome: "rejected",
      reason: "run_dir_invalid",
    });
    openPlannedRun(runDir);
    const thrown = runSdk<{ name: string; message: string }>(
      runDir,
      `try { await store.recordDispatch({ runDir, agentId: "worker", stageId: "report", visit: 1, attempt: 1, delivery: "started", reason: "timeout" }); out = { name: "none" }; }
catch (error) { out = { name: error.name, message: error.message }; }`,
    );
    expect(thrown.name).toBe("TypeError");
    expect(thrown.message).toContain("reason is not one of");
  });

  it("passes a malformed terminalId or sessionId to record validation instead of dropping it", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    const out = runSdk<{
      results: Array<{ name: string; message: string }>;
      unchanged: boolean;
      nulls: string;
    }>(
      runDir,
      `import { readFileSync } from "node:fs";
const journalPath = runDir + "/journal.jsonl";
const before = readFileSync(journalPath, "utf8");
const results = [];
for (const ids of [{ terminalId: 123 }, { sessionId: 123 }, { terminalId: "" }, { sessionId: {} }]) {
  try {
    await store.assignAgent({ runDir, agentId: "worker", runtime: { adapter: "herdr", runtimeName: "w-worker", paneId: "w1:p1" }, ...ids });
    results.push({ name: "none", message: "" });
  } catch (error) {
    results.push({ name: error.name, message: error.message });
  }
}
const unchanged = readFileSync(journalPath, "utf8") === before;
const nulls = (await store.assignAgent({ runDir, agentId: "worker", runtime: { adapter: "herdr", runtimeName: "w-worker", paneId: "w1:p1" }, terminalId: null, sessionId: null })).outcome;
out = { results, unchanged, nulls };`,
    );

    expect(out.results.map((result) => result.name)).toEqual([
      "TypeError",
      "TypeError",
      "TypeError",
      "TypeError",
    ]);
    expect(out.results[0]?.message).toContain("terminalId");
    expect(out.results[1]?.message).toContain("sessionId");
    expect(out.unchanged).toBe(true);
    expect(out.nulls).toBe("recorded");
  });
});

describe("state store: delivery certainty and limits", () => {
  it("keeps an ambiguous delivery in attention until an explicit new attempt supersedes it", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    runSdk(runDir, ASSIGN_WORKER);
    openAttemptOk(runDir);
    expect(
      runSdk<Outcome>(runDir, DISPATCH, { delivery: "ambiguous", reason: "stalled" }),
    ).toMatchObject({ outcome: "recorded" });

    interface Snap {
      ok: boolean;
      snapshot: {
        status: string;
        attention: { ambiguousDeliveries: unknown[] };
        stages: Array<{ visits: Array<{ attempts: Array<{ status: string; delivery: string }> }> }>;
      };
    }
    const pending = runSdk<Snap>(runDir, SNAPSHOT);
    expect(pending.snapshot.status).toBe("running");
    expect(pending.snapshot.attention.ambiguousDeliveries).toEqual([
      { stageId: "report", visit: 1, attempt: 1, agentId: "worker", reason: "stalled" },
    ]);

    openAttemptOk(runDir, { attempt: 2 });
    const superseded = runSdk<Snap>(runDir, SNAPSHOT);
    expect(superseded.snapshot.attention.ambiguousDeliveries).toEqual([]);
    expect(superseded.snapshot.stages[0]?.visits[0]?.attempts).toMatchObject([
      { status: "superseded", delivery: "ambiguous" },
      { status: "open", delivery: "undispatched" },
    ]);
  });

  it("records and counts attempts beyond the declared maxAttemptsPerVisit", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    for (const attemptNo of [1, 2, 3]) openAttemptOk(runDir, { attempt: attemptNo });

    const snap = runSdk<{
      snapshot: { limits: { maxAttemptsPerVisit: number }; counters: Record<string, unknown> };
    }>(runDir, SNAPSHOT);

    expect(snap.snapshot.limits.maxAttemptsPerVisit).toBe(2);
    expect(snap.snapshot.counters["attemptsByVisit"]).toEqual({ "report/1": 3 });
    expect(snap.snapshot.counters["attemptsOpened"]).toBe(3);
  });
});

describe("state store under concurrent writers", () => {
  it("keeps seq contiguous with dispatches and submissions from eight processes", async () => {
    const runDir = makeRunDir();
    const stages = ["s0", "s1", "s2", "s3"];
    openPlannedRun(
      runDir,
      testPlan({
        agents: [{ agentId: "worker", role: "writer", kind: "claude", model: null }],
        stages: stages.map((stageId) => ({ stageId, agentId: "worker", verdicts: [] })),
      }),
    );
    runSdk(runDir, ASSIGN_WORKER);
    const envelopes = stages.map((stage) => {
      openAttemptOk(runDir, { stage, verdicts: "" });
      const rel = artifactRel(stage);
      const sha = writeArtifact(runDir, rel, CONTENT);
      return JSON.stringify(
        envelopeFor({ stageId: stage, verdict: null, artifact: { path: rel, sha256: sha } }),
      );
    });

    const results = await Promise.all([
      ...stages.map((stageId) =>
        runNodeAsync(sdkScript(DISPATCH), [runDir, JSON.stringify({ stageId })]),
      ),
      ...envelopes.map((envelope) =>
        runNodeAsync(
          sdkScript(`out = await submitResult({ runDir, envelopeRaw: input.envelope });`),
          [runDir, JSON.stringify({ envelope })],
        ),
      ),
    ]);

    const outputs = results.map((result) => {
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as Outcome;
    });
    const dispatches = outputs.slice(0, 4);
    const submissions = outputs.slice(4);
    expect(submissions.map((output) => output.outcome)).toEqual(Array(4).fill("accepted"));
    for (const output of dispatches) {
      // A dispatch that lands after its attempt was accepted is refused, never recorded late.
      expect(
        output.outcome === "recorded" ||
          (output.outcome === "rejected" && output.reason === "attempt_unknown"),
        JSON.stringify(output),
      ).toBe(true);
    }

    const lines = journal(runDir);
    expect(lines.map((line) => line.seq)).toEqual(lines.map((_, index) => index + 1));
    expect(ofType(lines, "submission.accepted")).toHaveLength(4);
    expect(ofType(lines, "request.dispatched")).toHaveLength(
      dispatches.filter((output) => output.outcome === "recorded").length,
    );
    expect(runSdk<{ ok: boolean }>(runDir, `out = readJournal(runDir);`).ok).toBe(true);
  });
});

describe("snapshot artifact integrity (C2)", () => {
  it("reports an altered accepted copy only when asked to verify", () => {
    const { runDir, envelope } = readyAttempt();
    const first = submit(runDir, envelope);
    expect(first.json?.outcome).toBe("accepted");
    const receipt = first.json?.receipt;
    const verify = `out = { unchecked: snapshots.readSnapshot(runDir).snapshot.integrity, checked: snapshots.readSnapshot(runDir, { verifyArtifacts: true }).snapshot.integrity };`;

    expect(runSdk(runDir, verify)).toEqual({
      unchecked: { artifacts: "unchecked" },
      checked: { artifacts: { checked: 1, altered: [] } },
    });

    const copy = join(runDir, receipt?.artifact.acceptedPath ?? "missing");
    chmodSync(copy, 0o644);
    writeFileSync(copy, "# Tampered\n");
    const after = runSdk<{
      unchecked: { artifacts: string };
      checked: { artifacts: { checked: number; altered: Array<Record<string, string>> } };
    }>(runDir, verify);

    expect(after.unchecked).toEqual({ artifacts: "unchecked" });
    expect(after.checked.artifacts.checked).toBe(1);
    expect(after.checked.artifacts.altered).toEqual([
      {
        receiptId: receipt?.receiptId,
        acceptedPath: receipt?.artifact.acceptedPath,
        problem: expect.stringContaining("no longer matches its journal record"),
      },
    ]);
  });
});

describe("state store: p3 control records", () => {
  const RECEIPT_OF = (seq: number) => `"rcpt-${seq}-" + "a".repeat(12)`;
  const REV = `{ head: null, tree: "c".repeat(40) }`;
  const GATE = (seq: number, extra = "") => `out = await store.recordGate({
  runDir, gate: input.gate ?? "report", kind: input.kind ?? "stage",
  subject: { stageId: "report", visit: 1, attempt: input.attempt ?? 1, acceptedSeq: ${seq}, receiptId: input.receiptId ?? ${RECEIPT_OF(seq)} },
  decision: "pass", reason: "reported", round: 0, next: { stageId: "review" },
  revision: ${REV}, ${extra}
});`;
  const CHECK = `check: { command: ["node", "--test"], exitCode: 0, signal: null, timedOut: false,
  evidence: { path: "checks/verify/report-v1-a1/output.log", sha256: "a".repeat(64), bytes: 1 } },`;
  const OBSERVED = `{ runtimeStatus: "blocked", terminalId: "term_1", stateChangeSeq: 7 }`;
  const BLOCK = `out = await store.blockRun({ runDir, agentId: "worker", reason: "blocked_on_input", requiredAction: "answer the prompt", observed: ${OBSERVED} });`;
  const UNBLOCK = `out = await store.unblockRun({ runDir, agentId: "worker", observed: ${OBSERVED} });`;
  const RECONCILE = `out = await store.reconcileDelivery({ runDir, agentId: "worker", stageId: "report", visit: 1, attempt: input.attempt ?? 1, dispatchSeq: input.dispatchSeq, resolution: "delivered", evidence: "observed_activity" });`;

  it("refuses a gate on an unaccepted, already gated or superseded subject and writes nothing", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    runSdk(runDir, ASSIGN_WORKER);
    openAttemptOk(runDir); // seq 3
    let before = journalBytes(runDir);
    expect(runSdk<Outcome>(runDir, GATE(3, `verdict: "pass",`))).toMatchObject({
      outcome: "rejected",
      reason: "gate_subject_unknown",
    });
    expect(journalBytes(runDir).equals(before)).toBe(true);

    const rel = artifactRel();
    const sha = writeArtifact(runDir, rel, CONTENT);
    const accepted = submit(runDir, envelopeFor({ artifact: { path: rel, sha256: sha } }));
    expect(accepted.json?.outcome).toBe("accepted"); // seq 4
    const receiptId = accepted.json?.receipt?.receiptId;
    expect(runSdk<Outcome>(runDir, GATE(4, `verdict: "pass",`), { receiptId })).toMatchObject({
      outcome: "recorded",
      revision: 5,
    });
    before = journalBytes(runDir);
    expect(runSdk<Outcome>(runDir, GATE(4, `verdict: "pass",`), { receiptId })).toMatchObject({
      reason: "gate_exists",
    });
    expect(journalBytes(runDir).equals(before)).toBe(true);

    openAttemptOk(runDir, { attempt: 2 });
    before = journalBytes(runDir);
    expect(
      runSdk<Outcome>(runDir, GATE(4, CHECK), { receiptId, gate: "verify", kind: "check" }),
    ).toMatchObject({ reason: "gate_subject_stale" });
    expect(journalBytes(runDir).equals(before)).toBe(true);
  });

  it("refuses a second block, an unblock without a block and repeated or non-ambiguous reconciliation", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    runSdk(runDir, ASSIGN_WORKER);
    expect(runSdk<Outcome>(runDir, UNBLOCK)).toMatchObject({ reason: "not_blocked" });
    expect(runSdk<Outcome>(runDir, BLOCK)).toMatchObject({ outcome: "recorded" });
    let before = journalBytes(runDir);
    expect(runSdk<Outcome>(runDir, BLOCK)).toMatchObject({ reason: "run_blocked" });
    expect(journalBytes(runDir).equals(before)).toBe(true);
    expect(runSdk<{ snapshot: { status: string } }>(runDir, SNAPSHOT).snapshot.status).toBe(
      "blocked",
    );
    expect(runSdk<Outcome>(runDir, UNBLOCK)).toMatchObject({ outcome: "recorded" });

    openAttemptOk(runDir); // seq 5
    expect(runSdk<Outcome>(runDir, DISPATCH)).toMatchObject({ revision: 6 });
    before = journalBytes(runDir);
    expect(runSdk<Outcome>(runDir, RECONCILE, { dispatchSeq: 6 })).toMatchObject({
      reason: "dispatch_not_ambiguous",
    });
    expect(journalBytes(runDir).equals(before)).toBe(true);
    openAttemptOk(runDir, { attempt: 2 }); // seq 7
    expect(
      runSdk<Outcome>(runDir, DISPATCH, { attempt: 2, delivery: "ambiguous", reason: "stalled" }),
    ).toMatchObject({ revision: 8 });
    expect(runSdk<Outcome>(runDir, RECONCILE, { attempt: 2, dispatchSeq: 8 })).toMatchObject({
      outcome: "recorded",
      revision: 9,
    });
    before = journalBytes(runDir);
    expect(runSdk<Outcome>(runDir, RECONCILE, { attempt: 2, dispatchSeq: 8 })).toMatchObject({
      reason: "reconcile_exists",
    });
    expect(journalBytes(runDir).equals(before)).toBe(true);
  });

  it("refuses every control record after termination", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    runSdk(runDir, ASSIGN_WORKER);
    openAttemptOk(runDir);
    expect(
      runSdk<Outcome>(runDir, DISPATCH, { delivery: "ambiguous", reason: "timeout" }),
    ).toMatchObject({ revision: 4 });
    runSdk(runDir, BLOCK);
    const rel = artifactRel();
    const sha = writeArtifact(runDir, rel, CONTENT);
    const receiptId = submit(runDir, envelopeFor({ artifact: { path: rel, sha256: sha } })).json
      ?.receipt?.receiptId; // seq 6
    terminateRunOk(runDir);
    const before = journalBytes(runDir);
    for (const [body, input] of [
      [GATE(6, `verdict: "pass",`), { receiptId }],
      [BLOCK, {}],
      [UNBLOCK, {}],
      [RECONCILE, { dispatchSeq: 4 }],
    ] as const) {
      expect(runSdk<Outcome>(runDir, body, input), body).toMatchObject({
        outcome: "rejected",
        reason: "run_closed",
      });
    }
    expect(journalBytes(runDir).equals(before)).toBe(true);
  });

  it("persists the run input as a read-only input.json whose digest the record carries", () => {
    const runDir = makeRunDir();
    const input = { schemaVersion: 1, task: { title: "Implement slugify" } };
    const out = runSdk<Outcome>(
      runDir,
      `out = await store.openRun({ runDir, runId: "run-1", plan: input.plan, input: input.input });`,
      { plan: testPlan(), input },
    );
    expect(out).toMatchObject({ outcome: "recorded" });
    const path = join(runDir, "input.json");
    const bytes = readFileSync(path);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(input);
    expect(statSync(path).mode & 0o777).toBe(0o444);
    const record = journal(runDir)[0] as unknown as Record<string, unknown>;
    expect(record["input"]).toEqual({
      path: "input.json",
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    });
    const snapshot = runSdk<{ snapshot: { input: unknown } }>(runDir, SNAPSHOT).snapshot;
    expect(snapshot.input).toEqual(record["input"]);
  });

  it("makes input.json exactly 0444 under a restrictive umask", () => {
    const runDir = makeRunDir();
    const out = runSdk<Outcome>(
      runDir,
      `process.umask(0o077);
out = await store.openRun({ runDir, runId: "run-1", plan: input.plan, input: input.input });`,
      { plan: testPlan(), input: { schemaVersion: 1 } },
    );
    expect(out).toMatchObject({ outcome: "recorded" });
    expect(statSync(join(runDir, "input.json")).mode & 0o777).toBe(0o444);
  });
});
