import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { repoRoot } from "./helpers/process.js";

// Every scenario drives the real scheduler, store, submission path and git in a child process.
const fixture = join(repoRoot, "test", "fixtures", "scheduler-scenarios.mjs");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

type Json = Record<string, unknown>;
interface Report {
  result: Json & { outcome: string; limit: string | null; reason: string; artifacts: Json };
  error: Json | null;
  stats: { ticks: number; maxSnapshotMs: number };
  journal: Array<Json & { type: string; seq: number }>;
  types: string[];
  calls: Array<{ method: string; runtimeName: string | null; args: Json }>;
  requests: Array<{ path: string; text: string; sha256: string }>;
  submissions: Array<Json & { outcome: string }>;
  snapshot: Json & {
    counters: Json & Record<string, Record<string, number>>;
    attention: Json;
    status: string;
    agents: Array<Json & { agentId: string; assignment: Json | null }>;
  };
  marks: Json;
  names: { builder: string; reviewer: string };
  runDir: string;
  repo: string;
}

// The acceptance matrix's journal predicates (F-012): a test the matrix cites for a row asserts
// the row's predicate on its own journal.
type JournalPredicate = (journal: Report["journal"]) => boolean;
let PREDICATES: {
  "format-repair-corrected": JournalPredicate;
  "format-repair-exhausted": JournalPredicate;
};
beforeAll(async () => {
  ({ PREDICATES } = (await import(
    pathToFileURL(join(repoRoot, "scripts", "acceptance", "matrix.mjs")).href
  )) as { PREDICATES: typeof PREDICATES });
});

const cache = new Map<string, Report>();

function runScenario(name: string): Report {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const tmp = mkdtempSync(join(tmpdir(), `woof-scenario-${name}-`));
  dirs.push(tmp);
  const result = spawnSync("node", [fixture, name, tmp], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, HERDR_PANE_ID: undefined, WOOF_RUN_DIR: undefined },
  });
  if (result.status !== 0)
    throw new Error(`scenario ${name} exited ${result.status}: ${result.stderr}`);
  const report = JSON.parse(result.stdout.trim().split("\n").at(-1) as string) as Report;
  cache.set(name, report);
  return report;
}

// Journal records are plain JSON; fields are read by name in assertions.
// oxlint-disable-next-line typescript/no-explicit-any
type Loose = Json & { type: string; seq: number } & Record<string, any>;
const ofType = (report: Report, type: string): Loose[] =>
  report.journal.filter((record) => record.type === type) as Loose[];
const gatesOf = (report: Report) => ofType(report, "gate.recorded");
const attemptIn = (report: Report, stageId: string, visit: number, attemptNo: number) =>
  (
    report.snapshot["stages"] as Array<{
      stageId: string;
      visits: Array<{ visit: number; attempts: Array<Json & { cause: string }> }>;
    }>
  )
    .find((stage) => stage.stageId === stageId)
    ?.visits.find((item) => item.visit === visit)
    ?.attempts.find((item) => item["attempt"] === attemptNo);
const SCENARIO_TIMEOUT = 90_000;

describe("scheduler scenarios (scripted runtime, real processes)", () => {
  it(
    "1. happy path: identity continuity, handoff and the completion gate",
    () => {
      const report = runScenario("happy");
      expect(report.error).toBeNull();
      expect(report.result).toMatchObject({
        outcome: "completed",
        limit: null,
        reason: "approved",
      });
      expect(report.types).toEqual([
        "run.opened",
        "agent.assigned",
        "attempt.opened",
        "request.dispatched",
        "submission.accepted",
        "gate.recorded",
        "gate.recorded",
        "agent.assigned",
        "attempt.opened",
        "request.dispatched",
        "submission.accepted",
        "gate.recorded",
        "attempt.opened",
        "request.dispatched",
        "submission.accepted",
        "gate.recorded",
        "gate.recorded",
        "attempt.opened",
        "request.dispatched",
        "submission.accepted",
        "gate.recorded",
        "run.terminated",
      ]);

      // One start and one assignment per agent.
      const starts = report.calls.filter((call) => call.method === "startAgent");
      expect(starts.map((call) => call.runtimeName)).toEqual([
        report.names.builder,
        report.names.reviewer,
      ]);
      expect(ofType(report, "agent.assigned").map((record) => record["agentId"])).toEqual([
        "builder",
        "reviewer",
      ]);

      // Build and repair go to the same builder identity; reviews to the reviewer.
      const dispatches = ofType(report, "request.dispatched");
      const byStage = (stageId: string) =>
        dispatches.filter((record) => record["stageId"] === stageId);
      const builderTargets = [...byStage("build"), ...byStage("repair")].map((record) => [
        record["paneId"],
        record["target"],
      ]);
      expect(builderTargets).toHaveLength(2);
      expect(builderTargets[0]).toEqual(builderTargets[1]);
      expect(builderTargets[0]?.[1]).toEqual({
        terminalId: `term-${report.names.builder}`,
        sessionId: `session-${report.names.builder}`,
      });
      const reviewTargets = byStage("review").map((record) => [record["paneId"], record["target"]]);
      expect(reviewTargets[0]).toEqual(reviewTargets[1]);
      expect(reviewTargets[0]).not.toEqual(builderTargets[0]);

      // The repair request names the accepted review v1 by absolute path, receipt and sha256.
      const review1 = ofType(report, "submission.accepted").find(
        (record) => record["stageId"] === "review",
      ) as unknown as Json & {
        artifact: { acceptedPath: string; sha256: string };
        receiptId: string;
      };
      const repairRequest = report.requests.find(
        (request) => request.path === "requests/repair/visit-1/attempt-1/request.md",
      );
      expect(repairRequest?.text).toContain(join(report.runDir, review1.artifact.acceptedPath));
      expect(repairRequest?.text).toContain(review1.receiptId);
      expect(repairRequest?.text).toContain(review1.artifact.sha256);
      // Every persisted request is the one recorded and delivered.
      for (const record of dispatches) {
        const request = record["request"] as { path: string; sha256: string };
        expect(report.requests.find((item) => item.path === request.path)?.sha256).toBe(
          request.sha256,
        );
      }
      const delivered = report.calls
        .filter((call) => call.method === "deliver")
        .map((call) => call.args["text"]);
      expect(delivered).toEqual(
        dispatches.map((record) => (record["request"] as { sha256: string }).sha256),
      );

      // The completion gate names the exact repaired tree.
      const gates = ofType(report, "gate.recorded") as unknown as Array<
        Json & { gate: string; revision: { tree: string }; reviewed?: { tree: string } }
      >;
      const final = gates.at(-1);
      const repairGate = gates.findLast((gate) => gate.gate === "repair");
      expect(final).toMatchObject({
        gate: "review",
        decision: "pass",
        next: { outcome: "completed" },
        round: 2,
      });
      expect(final?.reviewed?.tree).toBe(final?.revision.tree);
      expect(repairGate?.revision.tree).toBe(final?.revision.tree);
      expect(gates.find((gate) => gate.gate === "build")?.revision.tree).not.toBe(
        final?.revision.tree,
      );
      expect(report.stats.ticks).toBeGreaterThan(0);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "2. a failed review is a completed review that routes to repair",
    () => {
      const report = runScenario("happy");
      const review1 = ofType(report, "submission.accepted").find(
        (record) => record["stageId"] === "review",
      );
      expect(review1).toMatchObject({ status: "completed", verdict: "fail", visit: 1 });
      const gate = gatesOf(report).find((record) => record["subject"].acceptedSeq === review1?.seq);
      expect(gate).toMatchObject({
        gate: "review",
        decision: "reject",
        reason: "changes_requested",
        next: { stageId: "repair" },
        round: 1,
      });
      expect(ofType(report, "run.terminated")).toHaveLength(1);
      expect(report.types.at(-1)).toBe("run.terminated");
      expect(report.snapshot.status).toBe("completed");
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "3. gates only on validated control data: a rejected claim or no submission never gates",
    () => {
      const report = runScenario("bad-submission");
      expect(report.result.outcome).toBe("completed");
      const rejectedClaim = ofType(report, "submission.rejected").find(
        (record) => record["reason"] === "artifact_hash_mismatch",
      );
      expect(rejectedClaim?.["identity"]).toMatchObject({
        stageId: "review",
        visit: 1,
        attempt: 1,
      });
      expect(
        gatesOf(report).filter(
          (gate) =>
            gate["subject"].stageId === "review" &&
            gate["subject"].visit === 1 &&
            gate["subject"].attempt === 1,
        ),
      ).toEqual([]);
      expect(attemptIn(report, "review", 1, 2)?.cause).toBe("format_repair");
      expect(
        gatesOf(report).find(
          (gate) => gate["subject"].stageId === "review" && gate["subject"].attempt === 2,
        ),
      ).toMatchObject({
        decision: "reject",
        verdict: "fail",
        next: { stageId: "repair" },
      });
      const repairRequest = report.requests.find(
        (request) => request.path === "requests/review/visit-1/attempt-2/request.md",
      );
      expect(repairRequest?.text).toContain("artifact_hash_mismatch");
      // The acceptance matrix's Format repair row: invalid control data, then corrected.
      expect(PREDICATES["format-repair-corrected"](report.journal)).toBe(true);

      const silent = runScenario("no-submission");
      expect(silent.result.outcome).toBe("completed");
      expect(PREDICATES["format-repair-corrected"](silent.journal)).toBe(false);
      expect(
        gatesOf(silent).filter(
          (gate) => gate["subject"].stageId === "build" && gate["subject"].attempt === 1,
        ),
      ).toEqual([]);
      expect(attemptIn(silent, "build", 1, 2)?.cause).toBe("format_repair");
      expect(
        silent.requests.find(
          (request) => request.path === "requests/build/visit-1/attempt-2/request.md",
        )?.text,
      ).toContain("none — no submission was recorded");
      expect(gatesOf(silent)[0]?.["subject"]).toMatchObject({ stageId: "build", attempt: 2 });
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "4. a pass on a moved revision starts another round; completion names the builder's tree",
    () => {
      const report = runScenario("revision-moved");
      expect(report.result).toMatchObject({ outcome: "completed", reason: "approved" });
      const reviews = gatesOf(report).filter((gate) => gate["gate"] === "review");
      expect(
        reviews.map((gate) => [gate["verdict"], gate["decision"], gate["reason"], gate["round"]]),
      ).toEqual([
        ["pass", "reject", "revision_moved", 1],
        ["pass", "pass", "approved", 2],
      ]);
      expect(reviews[0]?.["reviewed"].tree).not.toBe(reviews[0]?.["revision"].tree);
      const builder = gatesOf(report).findLast((gate) => gate["gate"] === "build");
      expect(reviews[1]?.["revision"].tree).toBe(builder?.["revision"].tree);
      expect(reviews[1]?.["reviewed"].tree).toBe(builder?.["revision"].tree);
      expect(report.snapshot.counters["rounds"]).toBe(2);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "5. a late pass for a superseded attempt is stale and never completes the run",
    () => {
      const report = runScenario("late-older-pass");
      const stale = ofType(report, "submission.rejected").find(
        (record) => record["reason"] === "attempt_stale",
      );
      expect(stale?.["identity"]).toMatchObject({ stageId: "review", visit: 1, attempt: 1 });
      expect(
        gatesOf(report).filter(
          (gate) =>
            gate["subject"].stageId === "review" &&
            gate["subject"].attempt === 1 &&
            gate["subject"].visit === 1,
        ),
      ).toEqual([]);
      expect(gatesOf(report).find((gate) => gate["gate"] === "review")).toMatchObject({
        verdict: "fail",
        subject: { visit: 1, attempt: 2 },
      });
      expect(report.result).toMatchObject({
        outcome: "completed",
        artifacts: { review: { stageId: "review", visit: 2, attempt: 1 } },
      });
    },
    SCENARIO_TIMEOUT,
  );
});

describe("scheduler bounds (each expired bound is exhausted with its limit)", () => {
  const exhaustedBy = (report: Report, limit: string) => {
    expect(report.error).toBeNull();
    expect(report.result).toMatchObject({ outcome: "exhausted", limit });
    expect(report.types.at(-1)).toBe("run.terminated");
    expect(ofType(report, "run.terminated")[0]).toMatchObject({ outcome: "exhausted", limit });
  };

  it(
    "6a. maxRounds: a reviewer that always fails gets two rounds and one repair visit",
    () => {
      const report = runScenario("max-rounds");
      exhaustedBy(report, "maxRounds");
      expect(report.snapshot.counters["visitsByStage"]).toEqual({ build: 1, review: 2, repair: 1 });
      expect(gatesOf(report).at(-1)).toMatchObject({
        gate: "review",
        decision: "reject",
        round: 2,
        next: { stageId: "repair" },
      });
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "6b. maxVisitsPerStage: a check that always fails stops repair at two visits, before any review",
    () => {
      const report = runScenario("max-visits");
      exhaustedBy(report, "maxVisitsPerStage");
      expect(report.snapshot.counters["visitsByStage"]).toEqual({ build: 1, repair: 2 });
      const checks = gatesOf(report).filter((gate) => gate["kind"] === "check");
      expect(checks.map((gate) => [gate["decision"], gate["check"].exitCode])).toEqual([
        ["reject", 1],
        ["reject", 1],
        ["reject", 1],
      ]);
      expect(
        ofType(report, "attempt.opened").some((record) => record["stageId"] === "review"),
      ).toBe(false);
      for (const gate of checks) {
        const evidence = gate["check"].evidence;
        expect(evidence.path).toMatch(/^checks\/verify\/(build|repair)-v\d-a1\/output\.log$/);
      }
      const repairRequest = report.requests.find(
        (request) => request.path === "requests/repair/visit-1/attempt-1/request.md",
      );
      expect(repairRequest?.text).toContain("verification output");
      expect(repairRequest?.text).toContain(
        `${report.runDir}/checks/verify/build-v1-a1/output.log`,
      );
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "6c. maxFormatRepairs: a worker that never submits gets one format repair",
    () => {
      const report = runScenario("max-format-repairs");
      exhaustedBy(report, "maxFormatRepairs");
      expect(report.snapshot.counters["attemptsByVisit"]).toEqual({ "build/1": 2 });
      expect(report.snapshot.counters["formatRepairsByVisit"]).toEqual({ "build/1": 1 });
      expect(gatesOf(report)).toEqual([]);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "6d. maxAttemptsPerVisit: undelivered work is retried in one new attempt",
    () => {
      const report = runScenario("max-attempts");
      exhaustedBy(report, "maxAttemptsPerVisit");
      expect(report.snapshot.counters["attemptsByVisit"]).toEqual({ "build/1": 2 });
      expect(report.snapshot.counters["workRetriesByVisit"]).toEqual({ "build/1": 1 });
      expect(report.snapshot.counters["dispatches"]).toEqual({
        started: 0,
        not_delivered: 2,
        ambiguous: 0,
      });
      expect(
        report.calls.filter((call) => call.method === "deliver").map((call) => call.args["sent"]),
      ).toEqual([false, false]);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "6e. readinessWaitMs: an agent that never becomes ready gets no attempt",
    () => {
      const report = runScenario("readiness-timeout");
      exhaustedBy(report, "readinessWaitMs");
      expect(report.types).toEqual(["run.opened", "agent.assigned", "run.terminated"]);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "6f. blockedWaitMs: a block is journaled, then the wait expires",
    () => {
      const report = runScenario("blocked-timeout");
      exhaustedBy(report, "blockedWaitMs");
      expect(ofType(report, "run.blocked")).toEqual([
        expect.objectContaining({
          agentId: "builder",
          reason: "blocked_on_input",
          stageId: "build",
          visit: 1,
          attempt: 1,
        }),
      ]);
      expect(ofType(report, "run.unblocked")).toEqual([]);
      expect(report.result["blocked"]).toMatchObject({ agentId: "builder" });
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "6g. deliveryTimeoutMs: an ambiguous delivery without evidence is abandoned, never resent",
    () => {
      const report = runScenario("delivery-timeout");
      exhaustedBy(report, "deliveryTimeoutMs");
      expect(ofType(report, "delivery.reconciled")).toEqual([
        expect.objectContaining({
          resolution: "abandoned",
          evidence: "no_evidence_before_deadline",
          stageId: "build",
          attempt: 1,
        }),
      ]);
      expect(report.calls.filter((call) => call.method === "deliver")).toHaveLength(1);
      expect(ofType(report, "attempt.opened")).toHaveLength(1);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "6i. maxFormatRepairs: a reviewer whose every envelope is schema-invalid is exhausted, and each format repair quotes envelope_invalid",
    () => {
      const report = runScenario("invalid-envelopes");
      exhaustedBy(report, "maxFormatRepairs");
      const reviews = ofType(report, "attempt.opened").filter(
        (record) => record["stageId"] === "review",
      );
      expect(reviews).toHaveLength(3);
      expect(
        ofType(report, "submission.rejected").map((record) => [
          record["reason"],
          record["identity"]?.attempt,
        ]),
      ).toEqual([
        ["envelope_invalid", 1],
        ["envelope_invalid", 2],
        ["envelope_invalid", 3],
      ]);
      for (const attempt of [2, 3]) {
        expect(attemptIn(report, "review", 1, attempt)?.cause).toBe("format_repair");
        const request = report.requests.find(
          (item) => item.path === `requests/review/visit-1/attempt-${attempt}/request.md`,
        );
        expect(request?.text, `attempt ${attempt}`).toContain("envelope_invalid");
        expect(request?.text, `attempt ${attempt}`).not.toContain("no submission was recorded");
      }
      expect(gatesOf(report).filter((gate) => gate["gate"] === "review")).toEqual([]);
      // The acceptance matrix's Exhausted repair row, and not the corrected shape.
      expect(PREDICATES["format-repair-exhausted"](report.journal)).toBe(true);
      expect(PREDICATES["format-repair-corrected"](report.journal)).toBe(false);
      expect(PREDICATES["format-repair-exhausted"](runScenario("max-format-repairs").journal)).toBe(
        false,
      );
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "6h. runTimeoutMs: a worker that works forever ends the run at the run timeout",
    () => {
      const report = runScenario("run-timeout");
      exhaustedBy(report, "runTimeoutMs");
      expect(ofType(report, "attempt.opened")).toHaveLength(1);
    },
    SCENARIO_TIMEOUT,
  );
});

describe("scheduler blocking, delivery, cancellation and failures", () => {
  it(
    "7. a blocked reviewer names the pane and the cancel command, and resumes when unblocked",
    () => {
      const report = runScenario("blocked-resolved");
      expect(report.result.outcome).toBe("completed");
      const blockedSnapshot = report.marks["blockedSnapshot"] as Json & {
        status: string;
        attention: { blocked: Json & { requiredAction: string } };
      };
      expect(blockedSnapshot.status).toBe("blocked");
      const reviewer = report.snapshot.agents.find((agent) => agent.agentId === "reviewer");
      expect(blockedSnapshot.attention.blocked.requiredAction).toContain(
        String(reviewer?.assignment?.["paneId"]),
      );
      expect(blockedSnapshot.attention.blocked.requiredAction).toContain(
        `woof run cancel ${report.runDir}`,
      );
      const order = report.types.filter(
        (type) => type === "run.blocked" || type === "run.unblocked" || type === "run.terminated",
      );
      expect(order).toEqual(["run.blocked", "run.unblocked", "run.terminated"]);
      expect(ofType(report, "run.unblocked")[0]).toMatchObject({
        agentId: "reviewer",
        observed: { runtimeStatus: "working" },
      });
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "8. an ambiguous delivery followed by observed work is reconciled delivered and completes",
    () => {
      const report = runScenario("ambiguous-delivered");
      expect(report.result.outcome).toBe("completed");
      expect(ofType(report, "delivery.reconciled")).toEqual([
        expect.objectContaining({
          stageId: "build",
          attempt: 1,
          resolution: "delivered",
          evidence: "observed_activity",
        }),
      ]);
      expect(
        report.calls.filter(
          (call) => call.method === "deliver" && call.runtimeName === report.names.builder,
        ),
      ).toHaveLength(1);
      expect(report.snapshot.attention["ambiguousDeliveries"]).toEqual([]);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "3b. a schema-invalid envelope naming its own attempt is quoted in the format repair (F-004)",
    () => {
      const report = runScenario("invalid-then-valid");
      expect(report.result.outcome).toBe("completed");
      expect(ofType(report, "submission.rejected")).toEqual([
        expect.objectContaining({
          reason: "envelope_invalid",
          identity: expect.objectContaining({ agentId: "reviewer", stageId: "review", attempt: 1 }),
        }),
      ]);
      expect(attemptIn(report, "review", 1, 2)?.cause).toBe("format_repair");
      const repair = report.requests.find(
        (request) => request.path === "requests/review/visit-1/attempt-2/request.md",
      );
      expect(repair?.text).toContain("envelope_invalid");
      expect(repair?.text).not.toContain("no submission was recorded");
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "8b. a failed precondition read (not_delivered precondition_failed) is retried as work and the run completes",
    () => {
      const report = runScenario("precondition-retry");
      expect(report.result.outcome).toBe("completed");
      const builds = ofType(report, "request.dispatched").filter(
        (record) => record["stageId"] === "build",
      );
      expect(
        builds.map((record) => [record["attempt"], record["delivery"], record["reason"]]),
      ).toEqual([
        [1, "not_delivered", "precondition_failed"],
        [2, "started", "observed_working"],
      ]);
      expect(attemptIn(report, "build", 1, 2)?.cause).toBe("work_retry");
      expect(report.snapshot.counters["workRetriesByVisit"]).toEqual({ "build/1": 1 });
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "8c. an owner_mismatch rejection naming an ambiguous attempt is not delivery evidence: the attempt is abandoned",
    () => {
      const report = runScenario("foreign-owner-mismatch");
      const foreign = ofType(report, "submission.rejected");
      expect(foreign).toEqual([
        expect.objectContaining({
          reason: "owner_mismatch",
          identity: expect.objectContaining({ agentId: "reviewer", stageId: "build", attempt: 1 }),
        }),
      ]);
      expect(ofType(report, "delivery.reconciled")).toEqual([
        expect.objectContaining({
          stageId: "build",
          attempt: 1,
          resolution: "abandoned",
          evidence: "no_evidence_before_deadline",
        }),
      ]);
      expect(report.error).toBeNull();
      expect(report.result).toMatchObject({ outcome: "exhausted", limit: "deliveryTimeoutMs" });
      expect(attemptIn(report, "build", 1, 2)).toBeUndefined();
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "9. cancellation stops owned panes and a late result cannot resurrect the run",
    () => {
      const report = runScenario("cancel-abort");
      expect(report.result).toMatchObject({ outcome: "cancelled", reason: "cancel requested" });
      const stops = report.calls
        .filter((call) => call.method === "stop")
        .map((call) => call.runtimeName);
      expect(stops.toSorted()).toEqual([report.names.builder, report.names.reviewer].toSorted());
      const termination = ofType(report, "run.terminated")[0];
      // The request is its own fact, journaled right before the termination it leads to.
      expect(ofType(report, "run.cancel_requested")).toMatchObject([
        { seq: (termination?.seq ?? 0) - 1, source: "abort_signal", reason: "cancel requested" },
      ]);
      expect(report.snapshot["lifecycle"]).toMatchObject({
        cancelRequested: { source: "abort_signal", seq: (termination?.seq ?? 0) - 1 },
      });
      expect(
        report.journal
          .filter((record) => record.seq > (termination?.seq ?? 0))
          .map((record) => [record.type, record["reason"]]),
      ).toEqual([["submission.rejected", "run_closed"]]);
      expect(report.submissions.at(-1)).toMatchObject({
        outcome: "rejected",
        reason: "run_closed",
      });

      const external = runScenario("cancel-external");
      expect(external.marks["externalStatus"]).toBe(0);
      expect(external.result).toMatchObject({
        outcome: "cancelled",
        reason: "cancelled from another process",
      });
      expect(external.types.slice(-2)).toEqual(["run.cancel_requested", "run.terminated"]);
      expect(ofType(external, "run.cancel_requested")[0]).toMatchObject({ source: "cli" });
      // A scheduler driven without a run host journals no host facts, and none is invented.
      expect(external.types.filter((type) => type.startsWith("host."))).toEqual([]);
      expect(external.calls.filter((call) => call.method === "stop")).toHaveLength(2);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "10. an identical duplicate submission is recorded once and gated once",
    () => {
      const report = runScenario("duplicates");
      expect(report.result.outcome).toBe("completed");
      const build = ofType(report, "submission.accepted").find(
        (record) => record["stageId"] === "build",
      );
      expect(
        ofType(report, "submission.duplicate").map((record) => record["acceptedSeq"]),
      ).toContain(build?.seq);
      expect(
        gatesOf(report).filter((gate) => gate["subject"].acceptedSeq === build?.seq),
      ).toHaveLength(1);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "11. a gone or replaced agent fails the run",
    () => {
      expect(runScenario("agent-gone").result).toMatchObject({
        outcome: "failed",
        reason: expect.stringMatching(/^agent_gone/),
      });
      const replaced = runScenario("agent-replaced");
      expect(replaced.result).toMatchObject({
        outcome: "failed",
        reason: expect.stringMatching(/^agent_replaced/),
      });
      expect(ofType(replaced, "agent.assigned")).toHaveLength(1);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "12. an altered accepted review fails the run before any repair is opened or sent",
    () => {
      const report = runScenario("altered-input");
      expect(report.result).toMatchObject({
        outcome: "failed",
        reason: expect.stringMatching(/^input_artifact_altered/),
      });
      expect(
        ofType(report, "attempt.opened").some((record) => record["stageId"] === "repair"),
      ).toBe(false);
      expect(
        ofType(report, "request.dispatched").some((record) => record["stageId"] === "repair"),
      ).toBe(false);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "13. a builder that reports status failed ends the run and names the stage",
    () => {
      const report = runScenario("builder-failed");
      expect(report.result).toMatchObject({
        outcome: "failed",
        reason: "stage build reported status failed (build visit 1 attempt 1)",
      });
      expect(gatesOf(report)).toEqual([]);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "BR-001. a repository change between revision and gate makes completion impossible",
    () => {
      const report = runScenario("moved-before-gate");
      expect(report.marks["move"]).toBe(true);
      expect(report.result).toMatchObject({ outcome: "exhausted", limit: "maxRounds" });
      expect(ofType(report, "run.terminated")).toHaveLength(1);
      const reviews = gatesOf(report).filter((gate) => gate["gate"] === "review");
      expect(reviews.length).toBeGreaterThan(0);
      expect(reviews.some((gate) => "outcome" in (gate["next"] as Json))).toBe(false);
      expect(reviews.map((gate) => gate["reason"])).toEqual(reviews.map(() => "revision_moved"));
      // Every recorded review gate carries the tree the repository actually has.
      const finalTree = (report as Report & { finalRevision: { revision: { tree: string } } })
        .finalRevision.revision.tree;
      for (const gate of reviews) expect((gate["revision"] as Json)["tree"]).toBe(finalTree);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "BR-007. a check longer than the remaining run budget is stopped at the run deadline",
    () => {
      const report = runScenario("run-timeout-check");
      expect(report.result).toMatchObject({ outcome: "exhausted", limit: "runTimeoutMs" });
      expect(
        ofType(report, "submission.accepted").some((record) => record["stageId"] === "build"),
      ).toBe(true);
      expect(gatesOf(report).some((gate) => gate["kind"] === "check")).toBe(false);
      // Bounded by the 1.5 s run budget plus the check's kill grace, not by its 600 s timeout.
      expect((report as Report & { elapsedMs: number }).elapsedMs).toBeLessThan(10_000);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "BR-006. a passing review altered after acceptance fails the run before its gate",
    () => {
      const report = runScenario("tamper-passing-review");
      expect(report.marks["tamper"]).toBe(true);
      expect(report.result).toMatchObject({ outcome: "failed", limit: null });
      expect(report.result.reason).toMatch(/^input_artifact_altered: /);
      expect(gatesOf(report).some((gate) => gate["gate"] === "review")).toBe(false);
      expect(ofType(report, "run.terminated")).toHaveLength(1);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "BR-001. a repository that moves before every review gate still makes bounded journal progress",
    () => {
      const report = runScenario("moving-repo");
      expect(report.result).toMatchObject({ outcome: "exhausted", limit: "maxRounds" });
      const reviews = gatesOf(report).filter((gate) => gate["gate"] === "review");
      expect(reviews.map((gate) => gate["reason"])).toEqual([
        "revision_moved",
        "revision_moved",
        "revision_moved",
      ]);
      // At most one re-decision per round: a pass attempt, then the appended rejection.
      expect(report.marks["moves"]).toBeLessThanOrEqual(2 * reviews.length);
      expect(ofType(report, "run.terminated")).toHaveLength(1);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "BR-101. a moving repository records a revision-bound reject → failed gate once",
    () => {
      const report = runScenario("moving-reject-fails");
      expect(report.marks["moves"]).toBeGreaterThanOrEqual(1);
      expect(report.result).toMatchObject({ outcome: "failed", limit: null });
      const judged = gatesOf(report).filter((gate) => gate["gate"] === "judge");
      expect(judged).toHaveLength(1);
      expect(judged[0]).toMatchObject({
        decision: "reject",
        reason: "unfixable",
        next: { outcome: "failed" },
      });
      // The reviewed revision is the judge's dispatch revision; the gate revision is the fresh tree.
      const dispatch = ofType(report, "request.dispatched").find(
        (record) => record["stageId"] === "judge",
      );
      expect(judged[0]?.["reviewed"]).toEqual(dispatch?.["revision"]);
      const finalTree = (report as Report & { finalRevision: { revision: { tree: string } } })
        .finalRevision.revision.tree;
      expect(judged[0]).toMatchObject({ revision: { tree: finalTree } });
      const terminations = ofType(report, "run.terminated");
      expect(terminations).toHaveLength(1);
      expect(terminations[0]).toMatchObject({ outcome: "failed" });
      expect(report.marks["nextCalls"]).toBeLessThanOrEqual(2);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "BR-103. a run budget that expires between decision and delivery opens, writes and sends nothing",
    () => {
      const report = runScenario("expired-before-dispatch");
      expect(report.marks["delay"]).toBe(true);
      expect(report.result).toMatchObject({ outcome: "exhausted", limit: "runTimeoutMs" });
      expect(report.types).not.toContain("attempt.opened");
      expect(report.types).not.toContain("request.dispatched");
      expect(report.requests).toEqual([]);
      expect(report.calls.filter((call) => call.method === "deliver")).toEqual([]);
      expect(ofType(report, "run.terminated")).toHaveLength(1);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "BR-201. a journal lock held through the run deadline before openAttempt creates no request and delivers nothing",
    () => {
      const report = runScenario("lock-held-past-deadline");
      expect(report.marks["held"]).toBe(true);
      // The lock was taken within the budget, before the dispatch effect's first write.
      expect(report.marks["lockHeldAt"]).toBeLessThan(1500);
      expect(report.result).toMatchObject({ outcome: "exhausted", limit: "runTimeoutMs" });
      expect(report.error).toBeNull();
      expect(report.types).not.toContain("attempt.opened");
      expect(report.types).not.toContain("request.dispatched");
      expect(report.requests).toEqual([]);
      expect(report.calls.filter((call) => call.method === "deliver")).toEqual([]);
      expect(ofType(report, "run.terminated")).toHaveLength(1);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "PR-C. the driver uses admission's repository and never calls repository(input) again",
    () => {
      const report = runScenario("repository-once");
      expect(report.marks["repositoryCalls"]).toBe(1);
      expect(report.result).toMatchObject({
        outcome: "completed",
        repository: { path: report.repo },
      });
      const panes = report.calls.filter((call) => call.method === "openPane");
      expect(panes.length).toBeGreaterThan(0);
      for (const pane of panes) expect(pane.args["cwd"]).toBe(report.repo);
      // One agent per tab: every agent pane is opened as a labelled new tab, never as a split.
      for (const pane of panes) {
        expect(pane.args).toMatchObject({
          placement: "tab",
          label: expect.stringMatching(/^woof:[a-z]/),
        });
        expect(pane.args).not.toHaveProperty("near");
      }
      const started = report.calls.filter((call) => call.method === "startAgent");
      expect(panes).toHaveLength(started.length);
      // The journal proves it: every assignment carries the tab its pane was opened in, all distinct.
      const tabIds = ofType(report, "agent.assigned").map((record) => record["tabId"]);
      expect(tabIds).toHaveLength(panes.length);
      for (const tabId of tabIds) expect(tabId).toMatch(/^scripted:t\d+$/);
      expect(new Set(tabIds).size).toBe(tabIds.length);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "PR-A. a slow observe is bounded by the remaining run budget",
    () => {
      const report = runScenario("slow-observe");
      expect(report.result).toMatchObject({ outcome: "exhausted", limit: "runTimeoutMs" });
      expect((report as Report & { elapsedMs: number }).elapsedMs).toBeLessThan(2500);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "PR-A. a slow repository fingerprint is bounded by the remaining run budget",
    () => {
      const report = runScenario("slow-fingerprint");
      expect(report.marks["slow"]).toBe(true);
      expect(report.result).toMatchObject({ outcome: "exhausted", limit: "runTimeoutMs" });
      expect(gatesOf(report)).toEqual([]);
      expect((report as Report & { elapsedMs: number }).elapsedMs).toBeLessThan(4000);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "PR-A. a Herdr start budget under 3001 ms is run-timeout exhaustion before startAgent",
    () => {
      const report = runScenario("herdr-start-budget");
      expect(report.result).toMatchObject({ outcome: "exhausted", limit: "runTimeoutMs" });
      expect(report.calls.filter((call) => call.method === "startAgent")).toEqual([]);
      expect(report.types).not.toContain("agent.assigned");
      expect((report as Report & { elapsedMs: number }).elapsedMs).toBeLessThan(1500);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "PR-E. an unresolved declared input fails the run before anything is opened or sent",
    () => {
      const report = runScenario("input-unresolved");
      expect(report.result).toMatchObject({ outcome: "failed", limit: null });
      expect(report.result.reason).toMatch(
        /^input_unresolved: prior review: stage review has no accepted artifact/,
      );
      expect(report.types).not.toContain("attempt.opened");
      expect(report.requests).toEqual([]);
      expect(report.calls.filter((call) => call.method === "deliver")).toEqual([]);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "PR-E. an observe runtime error fails the run with its code; timeouts only after three in a row",
    () => {
      const error = runScenario("observe-error");
      expect(error.result).toMatchObject({ outcome: "failed", limit: null });
      expect(error.result.reason).toMatch(/^runtime_error: runtime_unavailable: agent builder/);
      expect(ofType(error, "observation.lost")).toMatchObject([
        { agentId: "builder", code: "runtime_unavailable" },
      ]);

      const timeouts = runScenario("observe-timeouts");
      expect(timeouts.result).toMatchObject({ outcome: "failed", limit: null });
      expect(timeouts.result.reason).toMatch(/^runtime_error: timeout: agent builder/);
      // One record for the whole streak (a transition, not a sample), before the run fails on it.
      const lost = ofType(timeouts, "observation.lost");
      expect(lost).toMatchObject([{ agentId: "builder", code: "timeout" }]);
      expect(lost[0]?.seq).toBeLessThan(ofType(timeouts, "run.terminated")[0]?.seq ?? 0);
      expect(ofType(timeouts, "observation.recovered")).toEqual([]);
      expect(timeouts.snapshot["lifecycle"]).toMatchObject({
        observationLost: [{ agentId: "builder", seq: lost[0]?.seq, code: "timeout" }],
      });

      const recovered = runScenario("observe-two-timeouts");
      expect(recovered.result).toMatchObject({ outcome: "completed", limit: null });
      const outage = ofType(recovered, "observation.lost");
      expect(outage).toMatchObject([{ agentId: "builder", code: "timeout" }]);
      expect(ofType(recovered, "observation.recovered")).toMatchObject([
        { agentId: "builder", lostSeq: outage[0]?.seq },
      ]);
      expect(recovered.snapshot["lifecycle"]).toMatchObject({ observationLost: [] });
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "an unresolved observation.lost the scheduler did not write is paired from the journal: no second loss, and the recovery names it",
    () => {
      // The journal, never the scheduler's memory, says which losses are unresolved. A scheduler
      // that meets a loss it never journaled (one started on such a journal) must not answer the
      // next failed observe with a duplicate observation.lost (refused observation_lost, which was
      // fatal) and must resolve that very record at the next successful observe.
      const report = runScenario("observe-foreign-loss");
      expect(report.error).toBeNull();
      expect(report.result).toMatchObject({ outcome: "completed", limit: null });
      const lost = ofType(report, "observation.lost");
      expect(lost).toMatchObject([
        { agentId: "builder", message: "journaled by an earlier scheduler" },
      ]);
      expect(ofType(report, "observation.recovered")).toMatchObject([
        { agentId: "builder", lostSeq: lost[0]?.seq },
      ]);
      expect(report.snapshot["lifecycle"]).toMatchObject({ observationLost: [] });
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "PR2-2. a failed pane stop keeps the recorded outcome and returns an infrastructure error",
    () => {
      const report = runScenario("stop-fails");
      expect(report.result).toMatchObject({ outcome: "completed" });
      expect(report.error).toMatchObject({ reason: "runtime_cleanup_failed" });
      expect(String(report.error?.["message"])).toContain(report.names.builder);
      expect(String(report.error?.["message"])).toContain(report.names.reviewer);
      expect(ofType(report, "run.terminated")).toHaveLength(1);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "PR2-8. a relative run directory becomes one absolute canonical path in the result and requests",
    () => {
      const report = runScenario("relative-run-dir");
      const canonical = realpathSync(report.runDir);
      expect(report.result).toMatchObject({ outcome: "completed", runDir: canonical });
      expect(report.requests.length).toBeGreaterThan(0);
      for (const request of report.requests) {
        expect(request.text).toContain(`--run-dir ${canonical} `);
        expect(request.text).toContain(`Write your artifact to exactly: ${canonical}/artifacts/`);
      }
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "PR4-1. agents without a stateChangeSeq whose observations never change still dispatch and complete",
    () => {
      const report = runScenario("null-seq-agents");
      expect(report.result).toMatchObject({ outcome: "completed", limit: null });
      expect(ofType(report, "request.dispatched").map((record) => record["stageId"])).toEqual([
        "build",
        "review",
      ]);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "PR4-6. a pane split that times out on the run budget is exhausted, another pane error is failed",
    () => {
      const timedOut = runScenario("pane-timeout");
      expect(timedOut.result).toMatchObject({ outcome: "exhausted", limit: "runTimeoutMs" });
      expect(timedOut.types).not.toContain("agent.assigned");
      const broken = runScenario("pane-error");
      expect(broken.result).toMatchObject({ outcome: "failed", limit: null });
      expect(broken.result.reason).toMatch(/^agent_start_failed: builder: runtime_error/);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "PR4-7. an abort during the poll sleep ends the run cancelled and settles panes",
    () => {
      const report = runScenario("abort-in-sleep");
      expect(report.marks["abort"]).toBe(true);
      expect(report.result).toMatchObject({ outcome: "cancelled", limit: null });
      expect(report.error).toBeNull();
      expect(report.calls.some((call) => call.method === "stop")).toBe(true);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "BR-003. a worker that submits before its delivery returns keeps the dispatch revision and completes",
    () => {
      const report = runScenario("fast-worker");
      expect(report.result).toMatchObject({ outcome: "completed", limit: null });
      const acceptances = ofType(report, "submission.accepted");
      const dispatches = ofType(report, "request.dispatched");
      expect(dispatches.map((record) => [record["stageId"], record["delivery"]])).toEqual([
        ["build", "started"],
        ["review", "started"],
      ]);
      for (const dispatch of dispatches) {
        const acceptance = acceptances.find(
          (record) =>
            record["stageId"] === dispatch["stageId"] &&
            record["visit"] === dispatch["visit"] &&
            record["attempt"] === dispatch["attempt"],
        );
        // The acceptance won the race, and the dispatch fact is still journaled with its revision.
        expect(acceptance?.seq).toBeLessThan(dispatch.seq);
        expect(dispatch["revision"]).toMatchObject({ tree: expect.any(String) });
      }
      const review = gatesOf(report).find((gate) => gate["gate"] === "review");
      expect(review).toMatchObject({ decision: "pass", reason: "approved" });
      expect(review?.["reviewed"]).toEqual(
        dispatches.find((record) => record["stageId"] === "review")?.["revision"],
      );
      expect(gatesOf(report).some((gate) => gate["reason"] === "revision_moved")).toBe(false);
    },
    SCENARIO_TIMEOUT,
  );

  it(
    "14. another definition with its own ids and verdicts runs on the same engine",
    () => {
      const report = runScenario("reuse");
      expect(report.result).toMatchObject({
        outcome: "completed",
        workflow: { name: "draft-critique", version: "2" },
      });
      expect(
        gatesOf(report).map((gate) => [
          gate["gate"],
          gate["verdict"],
          gate["decision"],
          gate["round"],
        ]),
      ).toEqual([
        ["draft", null, "pass", 0],
        ["critique", "rework", "reject", 1],
        ["draft", null, "pass", 1],
        ["critique", "approve", "pass", 2],
      ]);
      const plan = report.journal[0]?.["plan"] as Json;
      expect(plan["checks"]).toEqual([]);
      expect(
        report.requests.find(
          (request) => request.path === "requests/draft/visit-2/attempt-1/request.md",
        )?.text,
      ).toContain("critique.md");
    },
    SCENARIO_TIMEOUT,
  );
});
