import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { repoRoot } from "./helpers/process.js";

// Every scenario drives the real scheduler, store, submission path and git in a child process.
const fixture = join(repoRoot, "test", "fixtures", "scheduler-scenarios.mjs");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
  snapshot: Json & { counters: Json; attention: Json; status: string };
  names: { builder: string; reviewer: string };
  runDir: string;
  repo: string;
}

function runScenario(name: string): Report {
  const tmp = mkdtempSync(join(tmpdir(), `woof-scenario-${name}-`));
  dirs.push(tmp);
  const result = spawnSync("node", [fixture, name, tmp], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, HERDR_PANE_ID: undefined, WOOF_RUN_DIR: undefined },
  });
  if (result.status !== 0)
    throw new Error(`scenario ${name} exited ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1) as string) as Report;
}

const ofType = (report: Report, type: string) =>
  report.journal.filter((record) => record.type === type);

describe("scheduler scenarios (scripted runtime, real processes)", () => {
  it("1. happy path: identity continuity, handoff and the completion gate", () => {
    const report = runScenario("happy");
    expect(report.error).toBeNull();
    expect(report.result).toMatchObject({ outcome: "completed", limit: null, reason: "approved" });
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
  });
});
