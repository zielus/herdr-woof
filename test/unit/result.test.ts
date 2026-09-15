import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";
import {
  HEX,
  PLAN,
  REV,
  accepted,
  assigned,
  attempt,
  checkGate,
  dispatched,
  gate,
  journalOf,
  opened,
  terminated,
} from "../helpers/records.js";

type Json = Record<string, unknown>;
type Parse = (line: string) => Json | string;
type Derive = (records: readonly Json[]) => { ok: true; snapshot: Json } | { ok: false };
type DeriveResult = (
  snapshot: Json,
  options: { runDir: string; repository?: string | null },
) => Json & {
  artifacts: Json & { lastAcceptedByStage: Record<string, Json> };
};

let parse: Parse;
let deriveSnapshot: Derive;
let deriveRunResult: DeriveResult;

beforeAll(async () => {
  ({ parseRecordLine: parse } = await loadDist<{ parseRecordLine: Parse }>("journal/records.js"));
  ({ deriveSnapshot } = await loadDist<{ deriveSnapshot: Derive }>("state/snapshot.js"));
  ({ deriveRunResult } = await loadDist<{ deriveRunResult: DeriveResult }>("state/result.js"));
});

const PLAN_BR = {
  ...PLAN,
  stages: [
    { stageId: "build", agentId: "builder", verdicts: [] },
    { stageId: "review", agentId: "reviewer", verdicts: ["pass", "fail"] },
  ],
  checks: ["verify"],
};
const receipt = (seq: number) => `rcpt-${seq}-${HEX.slice(0, 12)}`;

function snapshotOf(...bodies: Json[]): Json {
  const result = deriveSnapshot(journalOf(parse, ...bodies));
  if (!result.ok) throw new Error("snapshot refused");
  return result.snapshot;
}

/** build accepted (5) → gate (6) → verify (7) → review accepted (11) with `verdict` → gate (12). */
function reviewed(verdict: string, next: Json, decision: string): Json[] {
  return [
    opened(PLAN_BR),
    assigned("builder"),
    attempt("build", "builder"),
    dispatched("build", "builder"),
    accepted(5, "build", "builder", null),
    gate(5, "build", 1, 1, { next: { stageId: "verify" } }),
    checkGate(5, "verify", "build"),
    assigned("reviewer"),
    attempt("review", "reviewer", 1, 1, ["pass", "fail"]),
    { ...dispatched("review", "reviewer"), revision: REV },
    accepted(11, "review", "reviewer", verdict),
    gate(11, "review", 1, 1, { verdict, decision, reason: "x", round: 1, reviewed: REV, next }),
  ];
}

describe("deriveRunResult", () => {
  it("reports the approving review, the completion it approved and the verification on completion", () => {
    const snapshot = snapshotOf(
      ...reviewed("pass", { outcome: "completed" }, "pass"),
      terminated("completed"),
    );
    const result = deriveRunResult(snapshot, { runDir: "/runs/r1", repository: "/repo" });
    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: "woof.run.result",
      runId: "run-1",
      runDir: "/runs/r1",
      workflow: PLAN.workflow,
      outcome: "completed",
      limit: null,
      revision: 13,
      location: { stageId: "review", visit: 1, attempt: 1 },
      repository: { path: "/repo", revision: REV },
      blocked: null,
    });
    expect(result["cursor"]).toMatch(/^v1\.13\.[0-9a-f]{12}$/);
    expect(result.artifacts).toEqual({
      completion: {
        stageId: "build",
        visit: 1,
        attempt: 1,
        receiptId: receipt(5),
        acceptedPath: "/runs/r1/accepted/build/visit-1/attempt-1/out.md",
        sha256: HEX,
      },
      review: {
        stageId: "review",
        visit: 1,
        attempt: 1,
        receiptId: receipt(11),
        acceptedPath: "/runs/r1/accepted/review/visit-1/attempt-1/out.md",
        sha256: HEX,
      },
      verification: {
        path: "/runs/r1/checks/verify/build-v1-a1/output.log",
        sha256: HEX,
        bytes: 10,
      },
      lastAcceptedByStage: {
        build: expect.objectContaining({ receiptId: receipt(5) }),
        review: expect.objectContaining({ receiptId: receipt(11) }),
      },
    });
  });

  it("never reports a passing review as approval on a run that did not complete", () => {
    // The review passed but the run ended exhausted (for example the revision moved).
    const records = reviewed("pass", { stageId: "review" }, "reject");
    for (const [outcome, limit] of [
      ["exhausted", "maxRounds"],
      ["cancelled", undefined],
      ["failed", undefined],
    ] as const) {
      const result = deriveRunResult(snapshotOf(...records, terminated(outcome, limit)), {
        runDir: "/runs/r1",
      });
      expect(result["outcome"]).toBe(outcome);
      expect(result["limit"]).toBe(limit ?? null);
      expect(result.artifacts["review"]).toBeNull();
      expect(result.artifacts.lastAcceptedByStage["review"]).toMatchObject({
        receiptId: receipt(11),
      });
      expect(result["repository"]).toEqual({ path: null, revision: REV });
    }
  });

  it("reports a run with no gates and refuses a run that has not terminated", () => {
    const result = deriveRunResult(snapshotOf(opened(), terminated("cancelled")), { runDir: "/r" });
    expect(result).toMatchObject({
      outcome: "cancelled",
      location: null,
      repository: { path: null, revision: null },
      artifacts: { completion: null, review: null, verification: null, lastAcceptedByStage: {} },
    });
    expect(() => deriveRunResult(snapshotOf(opened()), { runDir: "/r" })).toThrow(TypeError);
  });
});
