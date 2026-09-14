import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDist, repoRoot } from "../helpers/dist.js";
import {
  PLAN,
  accepted,
  assigned,
  attempt,
  dispatched,
  journalOf,
  opened,
  rejected,
  terminated,
} from "../helpers/records.js";

type Json = Record<string, unknown>;
type Parse = (line: string) => Json | string;
interface Snapshot {
  runId: string;
  revision: number;
  cursor: string;
  status: string;
  workflow: Json | null;
  limits: Json | null;
  outcome: Json | null;
  counters: Json;
  journal: Json;
  agents: Array<Json & { agentId: string; activeAttempt: Json | null }>;
  stages: Array<{
    stageId: string;
    agentId: string | null;
    verdicts: string[] | null;
    visits: Array<{ visit: number; attempts: Array<Json & { status: string }> }>;
  }>;
  attention: { ambiguousDeliveries: Json[] };
  outputs: { latestAcceptedByStage: Record<string, Json> };
  liveness: Json;
  integrity: Json;
}
type Derive = (
  records: readonly Json[],
  options?: { anchor?: string; tailPending?: boolean },
) => { ok: true; snapshot: Snapshot } | { ok: false; reason: string; message: string };

let parse: Parse;
let deriveSnapshot: Derive;

beforeAll(async () => {
  ({ parseRecordLine: parse } = await loadDist<{ parseRecordLine: Parse }>("journal/records.js"));
  ({ deriveSnapshot } = await loadDist<{ deriveSnapshot: Derive }>("state/snapshot.js"));
});

function snapshotOf(...bodies: Json[]): Snapshot {
  const result = deriveSnapshot(journalOf(parse, ...bodies));
  if (!result.ok) throw new Error(result.message);
  return result.snapshot;
}

const attemptAt = (snapshot: Snapshot, stageId: string, visit: number, attemptNo: number) =>
  snapshot.stages
    .find((stage) => stage.stageId === stageId)
    ?.visits.find((item) => item.visit === visit)
    ?.attempts.find((item) => item["attempt"] === attemptNo);

describe("deriveSnapshot status", () => {
  it("derives each run status from the records", () => {
    expect(snapshotOf(opened()).status).toBe("created");
    expect(snapshotOf(opened(), assigned("builder")).status).toBe("starting");
    expect(
      snapshotOf(
        opened(),
        assigned("builder"),
        attempt("build", "builder"),
        dispatched("build", "builder"),
      ).status,
    ).toBe("running");
    for (const outcome of ["completed", "failed", "cancelled"]) {
      expect(snapshotOf(opened(), terminated(outcome)).status).toBe(outcome);
    }
    const exhausted = snapshotOf(opened(), terminated("exhausted", "maxAttemptsPerVisit"));
    expect(exhausted.status).toBe("exhausted");
    expect(exhausted.outcome).toMatchObject({
      outcome: "exhausted",
      limit: "maxAttemptsPerVisit",
      reason: "test",
    });
  });

  it("marks attempts open at termination abandoned and clears active attempts", () => {
    const before = snapshotOf(opened(), assigned("builder"), attempt("build", "builder"));
    expect(attemptAt(before, "build", 1, 1)?.status).toBe("open");
    expect(before.agents[0]?.activeAttempt).toEqual({ stageId: "build", visit: 1, attempt: 1 });

    const after = snapshotOf(
      opened(),
      assigned("builder"),
      attempt("build", "builder"),
      terminated(),
    );
    expect(attemptAt(after, "build", 1, 1)?.status).toBe("abandoned");
    expect(after.agents[0]?.activeAttempt).toBeNull();
    expect(after.outcome).toMatchObject({ outcome: "cancelled", limit: null });
  });
});

describe("deriveSnapshot documents", () => {
  it("lists planned agents and stages with plan metadata, limits and counters", () => {
    const snapshot = snapshotOf(
      opened(),
      assigned("builder", "w1:p7"),
      attempt("build", "builder"),
      dispatched("build", "builder", 1, 1, "not_delivered", "agent_busy"),
    );
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      kind: "woof.run.snapshot",
      runId: "run-1",
      revision: 4,
      journal: { records: 4, tailPending: false },
      workflow: PLAN.workflow,
      limits: PLAN.limits,
      liveness: { owner: "unhosted", runtime: "not_observed" },
      integrity: { artifacts: "unchecked" },
    });
    expect(snapshot.agents).toEqual([
      {
        agentId: "builder",
        role: "builder",
        kind: "claude",
        model: null,
        assignment: {
          adapter: "scripted",
          runtimeName: "w-builder",
          paneId: "w1:p7",
          terminalId: null,
          sessionId: null,
          at: expect.any(String),
        },
        activeAttempt: { stageId: "build", visit: 1, attempt: 1 },
        runtime: null,
      },
      {
        agentId: "reviewer",
        role: "reviewer",
        kind: "claude",
        model: "opus",
        assignment: null,
        activeAttempt: null,
        runtime: null,
      },
    ]);
    expect(snapshot.stages.map((stage) => [stage.stageId, stage.agentId, stage.verdicts])).toEqual([
      ["build", "builder", []],
      ["review", "reviewer", ["approve", "reject"]],
    ]);
    expect(attemptAt(snapshot, "build", 1, 1)).toMatchObject({
      agentId: "builder",
      status: "open",
      paneId: null,
      delivery: "not_delivered",
      accepted: null,
    });
    expect(snapshot.counters["dispatches"]).toEqual({ started: 0, not_delivered: 1, ambiguous: 0 });
  });

  it("derives a p1 journal without a plan", () => {
    const records = readFileSync(join(repoRoot, "test", "fixtures", "p1-journal.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => parse(line) as Json);
    const result = deriveSnapshot(records);
    if (!result.ok) throw new Error(result.message);
    const snapshot = result.snapshot;
    expect(snapshot.workflow).toBeNull();
    expect(snapshot.limits).toBeNull();
    expect(snapshot.status).toBe("created");
    expect(snapshot.agents).toEqual([
      {
        agentId: "worker",
        role: null,
        kind: null,
        model: null,
        assignment: null,
        activeAttempt: null,
        runtime: null,
      },
    ]);
    expect(snapshot.stages).toEqual([
      {
        stageId: "report",
        agentId: null,
        verdicts: null,
        visits: [
          {
            visit: 1,
            attempts: [
              {
                attempt: 1,
                agentId: "worker",
                status: "accepted",
                openedAt: "2026-09-10T10:00:01.000Z",
                paneId: "w1:p1",
                delivery: "undispatched",
                rejections: { artifact_missing: 1 },
                accepted: {
                  receiptId: "rcpt-4-ace34e83039e",
                  status: "completed",
                  verdict: "pass",
                  artifact: {
                    path: "artifacts/report/visit-1/attempt-1/report.md",
                    acceptedPath: "accepted/report/visit-1/attempt-1/report.md",
                    sha256: "fee2183d0bca324428fcd2f491d264ed18fc979fb454e7035c99271360c7b9f0",
                    bytes: 71,
                  },
                  at: "2026-09-10T10:02:00.000Z",
                },
              },
            ],
          },
        ],
      },
    ]);
    expect(snapshot.outputs.latestAcceptedByStage).toEqual({
      report: {
        stageId: "report",
        visit: 1,
        attempt: 1,
        receiptId: "rcpt-4-ace34e83039e",
        acceptedPath: "accepted/report/visit-1/attempt-1/report.md",
      },
    });
    // The fixture was written like the engine writes, so the default anchor is the raw one.
    const firstLine = readFileSync(
      join(repoRoot, "test", "fixtures", "p1-journal.jsonl"),
      "utf8",
    ).split("\n")[0] as string;
    const anchor = createHash("sha256").update(firstLine).digest("hex").slice(0, 12);
    expect(snapshot.cursor).toBe(`v1.5.${anchor}`);
  });

  it("never embeds artifact bodies or envelope digests", () => {
    const snapshot = snapshotOf(
      opened(null),
      attempt("build", "builder"),
      accepted(3, "build", "builder", null),
    );
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("envelopeDigest");
    expect(Object.keys(attemptAt(snapshot, "build", 1, 1)?.["accepted"] as Json)).toEqual([
      "receiptId",
      "status",
      "verdict",
      "artifact",
      "at",
    ]);
  });

  it("uses the given anchor and tail state", () => {
    const result = deriveSnapshot(journalOf(parse, opened()), {
      anchor: "0123456789ab",
      tailPending: true,
    });
    expect(result.ok && result.snapshot.cursor).toBe("v1.1.0123456789ab");
    expect(result.ok && result.snapshot.journal).toEqual({ records: 1, tailPending: true });
  });

  it("reports a journal without run.opened as run_dir_invalid", () => {
    expect(deriveSnapshot([])).toMatchObject({ ok: false, reason: "run_dir_invalid" });
  });
});

describe("deriveSnapshot attention and outputs", () => {
  it("lists an ambiguous delivery until its attempt is superseded", () => {
    const base = [
      opened(),
      assigned("builder"),
      attempt("build", "builder"),
      dispatched("build", "builder", 1, 1, "ambiguous", "stalled"),
    ];
    expect(snapshotOf(...base).attention.ambiguousDeliveries).toEqual([
      { stageId: "build", visit: 1, attempt: 1, agentId: "builder", reason: "stalled" },
    ]);
    const superseded = snapshotOf(...base, attempt("build", "builder", 1, 2));
    expect(superseded.attention.ambiguousDeliveries).toEqual([]);
    expect(attemptAt(superseded, "build", 1, 1)).toMatchObject({
      status: "superseded",
      delivery: "ambiguous",
    });
  });

  it("drops an ambiguous delivery once its attempt is accepted", () => {
    const snapshot = snapshotOf(
      opened(null),
      assigned("builder"),
      attempt("build", "builder"),
      dispatched("build", "builder", 1, 1, "ambiguous", "timeout"),
      accepted(5, "build", "builder", null),
    );
    expect(snapshot.attention.ambiguousDeliveries).toEqual([]);
  });

  it("keeps the older accepted visit as the latest output while a newer visit is open or rejected", () => {
    const snapshot = snapshotOf(
      opened(null),
      attempt("build", "builder"),
      accepted(3, "build", "builder", null),
      attempt("build", "builder", 2, 1),
      rejected("artifact_missing", {
        runId: "run-1",
        agentId: "builder",
        stageId: "build",
        visit: 2,
        attempt: 1,
      }),
    );
    expect(snapshot.outputs.latestAcceptedByStage["build"]).toMatchObject({
      visit: 1,
      attempt: 1,
      receiptId: `rcpt-3-${"a".repeat(12)}`,
    });
    expect(attemptAt(snapshot, "build", 2, 1)).toMatchObject({
      status: "open",
      accepted: null,
      rejections: { artifact_missing: 1 },
    });
  });

  it("moves the latest output to a newer accepted visit", () => {
    const snapshot = snapshotOf(
      opened(null),
      attempt("build", "builder"),
      accepted(3, "build", "builder", null),
      attempt("build", "builder", 2, 1),
      accepted(5, "build", "builder", null, 2, 1),
    );
    expect(snapshot.outputs.latestAcceptedByStage["build"]).toMatchObject({ visit: 2, attempt: 1 });
  });
});
