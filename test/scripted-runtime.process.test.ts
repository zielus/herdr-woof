import { afterEach, describe, expect, it } from "vitest";

import {
  CONTENT,
  cleanupRunDirs,
  distUrl,
  makeRunDir,
  runSdk,
  sha256,
  testPlan,
} from "./helpers/process.js";

// Scripted runtime driven together with the real store and submission path in
// a child process: the journal I/O is real, the runtime is scripted.
afterEach(() => cleanupRunDirs());

const SETUP = `
import { writeFileSync } from "node:fs";
const { createScriptedRuntime } = await import(${JSON.stringify(distUrl("runtime/scripted.js"))});
const { ObservationTracker } = await import(${JSON.stringify(distUrl("runtime/tracker.js"))});
const runtime = createScriptedRuntime({ agents: { "w-worker": input.agent } });
await store.openRun({ runDir, runId: "run-1", plan: input.plan });
const pane = (await runtime.openPane({ near: "current", cwd: runDir })).value;
const handle = (await runtime.startAgent({ runtimeName: "w-worker", kind: "claude", paneId: pane.paneId, paneOwned: true, timeoutMs: 1000 })).value;
await store.assignAgent({ runDir, agentId: "worker", runtime: { adapter: "scripted", runtimeName: handle.runtimeName, paneId: handle.paneId }, terminalId: handle.terminalId, sessionId: handle.sessionId });
const open = (attempt) => openAttempt({ runDir, runId: "run-1", agentId: "worker", stageId: "report", visit: 1, attempt, verdicts: ["pass", "fail"], paneId: handle.paneId });
const dispatch = (attempt, delivery) => store.recordDispatch({
  runDir, agentId: "worker", stageId: "report", visit: 1, attempt, paneId: handle.paneId,
  delivery: delivery.outcome,
  reason: delivery.outcome === "started" ? "observed_" + delivery.observation.lifecycle : delivery.error.code,
});
const envelopeFor = (attempt) => JSON.stringify({
  schemaVersion: 1, runId: "run-1", agentId: "worker", stageId: "report", visit: 1, attempt,
  status: "completed", verdict: "pass",
  artifact: { path: "artifacts/report/visit-1/attempt-" + attempt + "/report.md", sha256: input.sha },
});
const writeReport = (opened) => writeFileSync(opened.attempt.artifactDir + "/report.md", input.content);
const submitAs = (attempt) => submitResult({ runDir, envelopeRaw: envelopeFor(attempt), paneId: handle.paneId });
const delivers = () => runtime.calls().filter((call) => call.method === "deliver").map((call) => call.args.text);
const snapshot = () => snapshots.readSnapshot(runDir).snapshot;
`;

const input = (agent: Record<string, unknown>) => ({
  agent,
  plan: testPlan(),
  content: CONTENT,
  sha: sha256(CONTENT),
});

interface Snapshot {
  status: string;
  counters: Record<string, unknown>;
  attention: { ambiguousDeliveries: unknown[] };
  stages: Array<{
    visits: Array<{ attempts: Array<{ status: string; delivery: string; accepted: unknown }> }>;
  }>;
}

describe("scripted runtime with the store: duplicate delivery", () => {
  it("records one ambiguous dispatch, refuses a second, and dedupes the worker's repeated submission", () => {
    const runDir = makeRunDir();
    const out = runSdk<{
      delivery: { outcome: string; error: { code: string } };
      first: { outcome: string };
      second: { outcome: string; reason: string };
      accepted: { outcome: string; receipt: { receiptId: string } };
      duplicate: { outcome: string; receipt: { receiptId: string } };
      delivers: string[];
      snapshot: Snapshot;
    }>(
      runDir,
      `${SETUP}
const opened = await open(1);
const delivery = await runtime.deliver(handle, "attempt 1: write the report", { timeoutMs: 1000 });
const first = await dispatch(1, delivery);
const second = await store.recordDispatch({ runDir, agentId: "worker", stageId: "report", visit: 1, attempt: 1, delivery: "started", reason: "observed_working" });
// The prompt did reach the worker: it writes the artifact and submits twice.
writeReport(opened);
const accepted = await submitAs(1);
const duplicate = await submitAs(1);
out = { delivery, first, second, accepted, duplicate, delivers: delivers(), snapshot: snapshot() };`,
      input({
        timeline: [{ status: "idle", stateChangeSeq: 1, terminalId: "t1" }],
        onDeliver: "ambiguous:stalled",
        afterDeliver: [{ status: "working", stateChangeSeq: 2, terminalId: "t1" }],
      }),
    );

    expect(out.delivery).toMatchObject({ outcome: "ambiguous", error: { code: "stalled" } });
    expect(out.first.outcome).toBe("recorded");
    expect(out.second).toMatchObject({ outcome: "rejected", reason: "dispatch_exists" });
    expect(out.delivers).toEqual(["attempt 1: write the report"]);
    expect(out.accepted.outcome).toBe("accepted");
    expect(out.duplicate.outcome).toBe("duplicate");
    expect(out.duplicate.receipt.receiptId).toBe(out.accepted.receipt.receiptId);
    expect(out.snapshot.attention.ambiguousDeliveries).toEqual([]);
    expect(out.snapshot.stages[0]?.visits[0]?.attempts[0]).toMatchObject({
      status: "accepted",
      delivery: "ambiguous",
    });
  });

  it("allows trying again only as an explicit new attempt, and keeps the old attempt's late result out", () => {
    const runDir = makeRunDir();
    const out = runSdk<{
      deliveries: string[];
      dispatches: Array<{ outcome: string }>;
      late: { outcome: string; reason: string };
      delivers: string[];
      snapshot: Snapshot;
    }>(
      runDir,
      `${SETUP}
const first = await open(1);
const d1 = await runtime.deliver(handle, "attempt 1: write the report", { timeoutMs: 1000 });
const r1 = await dispatch(1, d1);
await open(2);
const d2 = await runtime.deliver(handle, "attempt 2: write the report", { timeoutMs: 1000 });
const r2 = await dispatch(2, d2);
writeReport(first);
const late = await submitAs(1);
out = { deliveries: [d1.outcome, d2.outcome], dispatches: [r1, r2], late, delivers: delivers(), snapshot: snapshot() };`,
      input({
        timeline: [{ status: "idle", stateChangeSeq: 1, terminalId: "t1" }],
        onDeliver: ["ambiguous:timeout", "started"],
        afterDeliver: [
          [{ status: "working", stateChangeSeq: 2, terminalId: "t1" }],
          [{ status: "working", stateChangeSeq: 4, terminalId: "t1" }],
        ],
      }),
    );

    expect(out.deliveries).toEqual(["ambiguous", "started"]);
    expect(out.dispatches.map((result) => result.outcome)).toEqual(["recorded", "recorded"]);
    expect(out.late).toMatchObject({ outcome: "rejected", reason: "attempt_stale" });
    // One deliver per attempt, never two for the same attempt.
    expect(out.delivers).toEqual(["attempt 1: write the report", "attempt 2: write the report"]);
    expect(out.snapshot.counters["dispatches"]).toEqual({
      started: 1,
      not_delivered: 0,
      ambiguous: 1,
    });
    expect(out.snapshot.stages[0]?.visits[0]?.attempts).toMatchObject([
      { status: "superseded", delivery: "ambiguous" },
      { status: "open", delivery: "started" },
    ]);
    expect(out.snapshot.attention.ambiguousDeliveries).toEqual([]);
  });
});

describe("scripted runtime with the store: stale signals", () => {
  it("does not complete an attempt when the agent is observed ready, and ignores a late ready after acceptance", () => {
    const runDir = makeRunDir();
    const out = runSdk<{
      kinds: string[];
      whileReady: Snapshot;
      types: string[];
      accepted: string;
      lateKind: string;
      unchanged: boolean;
    }>(
      runDir,
      `${SETUP}
const tracker = new ObservationTracker();
const opened = await open(1);
const delivery = await runtime.deliver(handle, "attempt 1: write the report", { timeoutMs: 1000 });
await dispatch(1, delivery);
const kinds = [tracker.accept(delivery.observation).kind];
const ready = await runtime.waitFor(handle, ["ready"], 1000);
kinds.push(tracker.accept(ready.value).kind);
const whileReady = snapshot();
const types = readJournal(runDir).records.map((record) => record.type);
writeReport(opened);
const accepted = (await submitAs(1)).outcome;
const before = JSON.stringify(snapshot());
runtime.emit("w-worker", { lifecycle: "ready", runtimeStatus: "idle", order: { terminalId: "t1", stateChangeSeq: 2 } });
const lateKind = tracker.accept((await runtime.observe(handle)).value).kind;
out = { kinds, whileReady, types, accepted, lateKind, unchanged: before === JSON.stringify(snapshot()) };`,
      input({
        timeline: [{ status: "idle", stateChangeSeq: 1, terminalId: "t1" }],
        afterDeliver: [
          { status: "working", stateChangeSeq: 2, terminalId: "t1" },
          { status: "done", stateChangeSeq: 3, terminalId: "t1" },
        ],
      }),
    );

    expect(out.kinds).toEqual(["new", "new"]);
    expect(out.whileReady.status).toBe("running");
    expect(out.whileReady.stages[0]?.visits[0]?.attempts[0]).toMatchObject({
      status: "open",
      delivery: "started",
      accepted: null,
    });
    expect(out.types).toEqual([
      "run.opened",
      "agent.assigned",
      "attempt.opened",
      "request.dispatched",
    ]);
    expect(out.accepted).toBe("accepted");
    expect(out.lateKind).toBe("stale");
    expect(out.unchanged).toBe(true);
  });
});
