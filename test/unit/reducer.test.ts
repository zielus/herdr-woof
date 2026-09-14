import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDist, repoRoot } from "../helpers/dist.js";
import {
  HEX,
  PLAN,
  accepted,
  assigned,
  attempt,
  dispatched,
  journalOf as buildJournal,
  opened,
  terminated,
} from "../helpers/records.js";

type Json = Record<string, unknown>;
interface AttemptStateJson {
  opened: Json;
  status: string;
  accepted?: Json;
  rejections: Record<string, number>;
}
interface StateJson {
  runId: string | undefined;
  plan: Json | null;
  revision: number;
  status: string;
  attempts: Map<string, AttemptStateJson>;
  assignments: Map<string, Json[]>;
  dispatches: Map<string, Json>;
  termination: Json | undefined;
  counters: Json;
}
type ReplayResult =
  { ok: true; state: StateJson } | { ok: false; line: number; message: string; reason: string };

let replay: (records: readonly Json[]) => ReplayResult;
let refuseAppend: (records: readonly Json[], record: Json) => ReplayResult | undefined;
let parseRecordLine: (line: string) => Json | string;

beforeAll(async () => {
  ({ replay, refuseAppend } = await loadDist<{
    replay: typeof replay;
    refuseAppend: typeof refuseAppend;
  }>("state/reducer.js"));
  ({ parseRecordLine } = await loadDist<{ parseRecordLine: typeof parseRecordLine }>(
    "journal/records.js",
  ));
});

const journalOf = (...bodies: Json[]): Json[] => buildJournal(parseRecordLine, ...bodies);

function expectOk(records: Json[]): StateJson {
  const result = replay(records);
  if (!result.ok) throw new Error(`replay refused line ${result.line}: ${result.message}`);
  return result.state;
}

function expectRefused(records: Json[], reason: string): void {
  const result = replay(records);
  expect(result.ok, "replay should refuse").toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe(reason);
  expect(result.line).toBe(records.length);
}

describe("p1 journal compatibility", () => {
  it("replays the committed p1 journal to the same attempt states", () => {
    const lines = readFileSync(join(repoRoot, "test", "fixtures", "p1-journal.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "");
    const records = lines.map((line) => parseRecordLine(line));
    for (const record of records) expect(typeof record).toBe("object");
    const state = expectOk(records as Json[]);

    expect(state.runId).toBe("fixture-run");
    expect(state.plan).toBeNull();
    expect(state.revision).toBe(5);
    expect(state.status).toBe("created");
    expect([...state.attempts.keys()]).toEqual(["report/1/1"]);
    const only = state.attempts.get("report/1/1");
    expect(only?.status).toBe("accepted");
    expect(only?.opened).toEqual(records[1]);
    expect(only?.accepted).toEqual(records[3]);
    expect(only?.rejections).toEqual({ artifact_missing: 1 });
    expect(state.counters).toEqual({
      attemptsOpened: 1,
      visitsByStage: { report: 1 },
      attemptsByVisit: { "report/1": 1 },
      submissionsAccepted: 1,
      submissionsDuplicate: 1,
      submissionsRejected: 1,
      rejectionsByReason: { artifact_missing: 1 },
      dispatches: { started: 0, not_delivered: 0, ambiguous: 0 },
      replacementsByAgent: {},
    });
  });

  it("skips every plan check for a plan-less run", () => {
    const state = expectOk(
      journalOf(
        opened(null),
        attempt("anything", "anyone", 1, 1, ["x"]),
        assigned("anyone"),
        assigned("stranger"),
        dispatched("anything", "anyone"),
      ),
    );
    expect(state.plan).toBeNull();
    expect(state.status).toBe("running");
  });
});

describe("record field contracts", () => {
  const bad: Array<[string, Json]> = [
    ["run.opened: unexpected field", { ...opened(), extra: 1 }],
    ["run.opened: invalid plan", opened({ ...PLAN, limits: { ...PLAN.limits, maxRounds: 0 } })],
    [
      "agent.assigned: missing runtime.paneId",
      { ...assigned("builder"), runtime: { adapter: "herdr", runtimeName: "w-b" } },
    ],
    ["agent.assigned: empty terminalId", { ...assigned("builder"), terminalId: "" }],
    ["request.dispatched: unknown delivery", dispatched("build", "builder", 1, 1, "maybe")],
    [
      "request.dispatched: reason not in the set for its delivery",
      dispatched("build", "builder", 1, 1, "started", "timeout"),
    ],
    ["request.dispatched: unexpected field", { ...dispatched("build", "builder"), runId: "run-1" }],
    ["run.terminated: exhausted without limit", terminated("exhausted")],
    ["run.terminated: limit on a non-exhausted outcome", terminated("cancelled", "maxRounds")],
    ["run.terminated: exhausted naming an unknown limit", terminated("exhausted", "maxGates")],
    ["run.terminated: unknown outcome", terminated("paused")],
    ["unknown record type", { type: "gate.recorded" }],
  ];
  for (const [name, body] of bad) {
    it(`fails closed on ${name}`, () => {
      const line = JSON.stringify({
        schemaVersion: 1,
        seq: 2,
        ts: "2026-09-14T10:00:00.000Z",
        ...body,
      });
      expect(typeof parseRecordLine(line)).toBe("string");
    });
  }

  it("accepts exhausted with a limit and optional assignment ids", () => {
    for (const body of [
      terminated("exhausted", "maxAttemptsPerVisit"),
      { ...assigned("builder"), terminalId: "term_1", sessionId: "s-1" },
      { ...dispatched("build", "builder", 1, 1, "ambiguous", "stalled"), paneId: "w1:p1" },
    ]) {
      const line = JSON.stringify({
        schemaVersion: 1,
        seq: 2,
        ts: "2026-09-14T10:00:00.000Z",
        ...body,
      });
      expect(typeof parseRecordLine(line)).toBe("object");
    }
  });
});

describe("attempt.opened rules", () => {
  it("accepts a planned stage, its agent and its verdict set in any order", () => {
    expectOk(journalOf(opened(), attempt("review", "reviewer", 1, 1, ["reject", "approve"])));
  });
  it("refuses a stage outside the plan", () => {
    expectRefused(journalOf(opened(), attempt("deploy", "builder")), "stage_unknown");
  });
  it("refuses an agent other than the stage's agent", () => {
    expectRefused(journalOf(opened(), attempt("build", "reviewer")), "owner_mismatch");
  });
  it("refuses verdicts that differ from the stage's", () => {
    expectRefused(
      journalOf(opened(), attempt("review", "reviewer", 1, 1, ["approve"])),
      "verdicts_mismatch",
    );
    expectRefused(
      journalOf(opened(), attempt("review", "reviewer", 1, 1, ["approve", "approve"])),
      "verdicts_mismatch",
    );
  });
  it("refuses another run and attempts that are not newer", () => {
    expectRefused(
      journalOf(opened(), attempt("build", "builder", 1, 1, [], "run-2")),
      "run_mismatch",
    );
    expectRefused(
      journalOf(opened(), attempt("build", "builder", 2, 1), attempt("build", "builder", 1, 5)),
      "attempt_open_conflict",
    );
  });
  it("refuses an attempt after termination", () => {
    expectRefused(journalOf(opened(), terminated(), attempt("build", "builder")), "run_closed");
  });
  it("records attempts beyond the declared limit without refusing them", () => {
    const state = expectOk(
      journalOf(
        opened(),
        attempt("build", "builder", 1, 1),
        attempt("build", "builder", 1, 2),
        attempt("build", "builder", 1, 3),
      ),
    );
    expect(state.counters["attemptsByVisit"]).toEqual({ "build/1": 3 });
    expect(state.attempts.get("build/1/2")?.status).toBe("superseded");
    expect(state.attempts.get("build/1/3")?.status).toBe("open");
  });
});

describe("agent.assigned rules", () => {
  it("accepts a planned agent and counts a replacement on another pane", () => {
    const state = expectOk(
      journalOf(opened(), assigned("builder", "w1:p1"), assigned("builder", "w1:p2")),
    );
    expect(state.assignments.get("builder")).toHaveLength(2);
    expect(state.counters["replacementsByAgent"]).toEqual({ builder: 1 });
    expect(state.status).toBe("starting");
  });
  it("refuses an agent outside the plan", () => {
    expectRefused(journalOf(opened(), assigned("ghost")), "agent_unknown");
  });
  it("refuses reassignment to the same pane", () => {
    expectRefused(
      journalOf(opened(), assigned("builder", "w1:p1"), assigned("builder", "w1:p1")),
      "assignment_unchanged",
    );
  });
  it("refuses reassignment while the agent owns a dispatched open attempt", () => {
    expectRefused(
      journalOf(
        opened(),
        assigned("builder", "w1:p1"),
        attempt("build", "builder"),
        dispatched("build", "builder"),
        assigned("builder", "w1:p2"),
      ),
      "agent_busy",
    );
  });
  it("allows reassignment once the dispatched attempt is superseded", () => {
    expectOk(
      journalOf(
        opened(),
        assigned("builder", "w1:p1"),
        attempt("build", "builder"),
        dispatched("build", "builder", 1, 1, "ambiguous", "timeout"),
        attempt("build", "builder", 1, 2),
        assigned("builder", "w1:p2"),
      ),
    );
  });
  it("refuses assignment after termination", () => {
    expectRefused(journalOf(opened(), terminated(), assigned("builder")), "run_closed");
  });
});

describe("request.dispatched rules", () => {
  const base = () => [opened(), assigned("builder"), attempt("build", "builder")];

  it("accepts one dispatch per open owned attempt of an assigned agent", () => {
    const state = expectOk(journalOf(...base(), dispatched("build", "builder")));
    expect(state.dispatches.get("build/1/1")).toMatchObject({ delivery: "started" });
    expect(state.status).toBe("running");
  });
  it("refuses an attempt that was never opened", () => {
    expectRefused(journalOf(...base(), dispatched("build", "builder", 1, 2)), "attempt_unknown");
  });
  it("refuses a dispatch by an agent that does not own the attempt", () => {
    expectRefused(
      journalOf(...base(), assigned("reviewer"), dispatched("build", "reviewer")),
      "owner_mismatch",
    );
  });
  it("refuses a second dispatch for the same attempt, whatever the first delivery", () => {
    for (const [delivery, reason] of [
      ["ambiguous", "stalled"],
      ["not_delivered", "not_found"],
      ["started", "observed_blocked"],
    ] as const) {
      expectRefused(
        journalOf(
          ...base(),
          dispatched("build", "builder", 1, 1, delivery, reason),
          dispatched("build", "builder"),
        ),
        "dispatch_exists",
      );
    }
  });
  it("refuses a dispatch for a superseded attempt", () => {
    expectRefused(
      journalOf(...base(), attempt("build", "builder", 1, 2), dispatched("build", "builder")),
      "attempt_unknown",
    );
  });
  it("refuses a dispatch to an unassigned agent", () => {
    expectRefused(
      journalOf(opened(), attempt("build", "builder"), dispatched("build", "builder")),
      "agent_unassigned",
    );
  });
  it("refuses a dispatch after termination", () => {
    expectRefused(journalOf(...base(), terminated(), dispatched("build", "builder")), "run_closed");
  });
});

describe("run.terminated rules", () => {
  it("accepts one termination and derives the status from its outcome", () => {
    for (const outcome of ["completed", "failed", "cancelled"]) {
      expect(expectOk(journalOf(opened(), terminated(outcome))).status).toBe(outcome);
    }
    const exhausted = expectOk(journalOf(opened(), terminated("exhausted", "maxRounds")));
    expect(exhausted.status).toBe("exhausted");
    expect(exhausted.termination).toMatchObject({ limit: "maxRounds" });
  });
  it("refuses a second termination", () => {
    expectRefused(journalOf(opened(), terminated(), terminated("failed")), "run_closed");
  });
  it("refuses an acceptance after termination", () => {
    expectRefused(
      journalOf(
        opened(),
        attempt("build", "builder"),
        terminated(),
        accepted(4, "build", "builder", null),
      ),
      "run_closed",
    );
  });
  it("keeps an open attempt open in reducer state after termination", () => {
    const state = expectOk(journalOf(opened(), attempt("build", "builder"), terminated()));
    expect(state.attempts.get("build/1/1")?.status).toBe("open");
  });
});

describe("derived status", () => {
  it("moves created → starting → running → terminal", () => {
    const steps = [
      opened(),
      assigned("builder"),
      attempt("build", "builder"),
      dispatched("build", "builder"),
      terminated("completed"),
    ];
    const statuses = steps.map(
      (_, index) => expectOk(journalOf(...steps.slice(0, index + 1))).status,
    );
    expect(statuses).toEqual(["created", "starting", "starting", "running", "completed"]);
  });
});

describe("counters", () => {
  const ZERO = {
    attemptsOpened: 0,
    visitsByStage: {},
    attemptsByVisit: {},
    submissionsAccepted: 0,
    submissionsDuplicate: 0,
    submissionsRejected: 0,
    rejectionsByReason: {},
    dispatches: { started: 0, not_delivered: 0, ambiguous: 0 },
    replacementsByAgent: {},
  };
  // Each step names only the counters that must change; everything else must not.
  const steps: Array<[Json, Json]> = [
    [opened(), {}],
    [assigned("builder", "w1:p1"), {}],
    [
      attempt("build", "builder", 1, 1),
      { attemptsOpened: 1, visitsByStage: { build: 1 }, attemptsByVisit: { "build/1": 1 } },
    ],
    [
      dispatched("build", "builder", 1, 1, "ambiguous", "timeout"),
      { dispatches: { started: 0, not_delivered: 0, ambiguous: 1 } },
    ],
    [attempt("build", "builder", 1, 2), { attemptsOpened: 2, attemptsByVisit: { "build/1": 2 } }],
    [assigned("builder", "w1:p2"), { replacementsByAgent: { builder: 1 } }],
    [
      dispatched("build", "builder", 1, 2, "not_delivered", "not_found"),
      { dispatches: { started: 0, not_delivered: 1, ambiguous: 1 } },
    ],
    [
      attempt("build", "builder", 2, 1),
      {
        attemptsOpened: 3,
        visitsByStage: { build: 2 },
        attemptsByVisit: { "build/1": 2, "build/2": 1 },
      },
    ],
    [
      dispatched("build", "builder", 2, 1),
      { dispatches: { started: 1, not_delivered: 1, ambiguous: 1 } },
    ],
    [
      {
        type: "submission.rejected",
        reason: "artifact_missing",
        message: "missing",
        details: [],
        identity: { runId: "run-1", agentId: "builder", stageId: "build", visit: 2, attempt: 1 },
      },
      { submissionsRejected: 1, rejectionsByReason: { artifact_missing: 1 } },
    ],
    [
      {
        type: "submission.rejected",
        reason: "envelope_malformed",
        message: "bad",
        details: [],
      },
      {
        submissionsRejected: 2,
        rejectionsByReason: { artifact_missing: 1, envelope_malformed: 1 },
      },
    ],
  ];

  it("changes each counter exactly where its record lands", () => {
    const expected: Json = structuredClone(ZERO);
    for (let index = 0; index < steps.length; index += 1) {
      const [, change] = steps[index]!;
      Object.assign(expected, change);
      const state = expectOk(journalOf(...steps.slice(0, index + 1).map(([body]) => body)));
      expect(state.counters, `after step ${index + 1}`).toEqual(expected);
    }
  });

  it("counts accepted and duplicate submissions and per-attempt rejections", () => {
    const records = journalOf(
      opened(null),
      attempt("build", "builder"),
      {
        type: "submission.rejected",
        reason: "verdict_not_allowed",
        message: "no",
        details: [],
        identity: { runId: "run-1", agentId: "builder", stageId: "build", visit: 1, attempt: 1 },
      },
      accepted(4, "build", "builder", null),
      {
        type: "submission.duplicate",
        receiptId: `rcpt-4-${HEX.slice(0, 12)}`,
        acceptedSeq: 4,
        envelopeDigest: HEX,
      },
    );
    const state = expectOk(records);
    expect(state.counters).toMatchObject({
      submissionsAccepted: 1,
      submissionsDuplicate: 1,
      submissionsRejected: 1,
    });
    expect(state.attempts.get("build/1/1")?.rejections).toEqual({ verdict_not_allowed: 1 });
  });
});

describe("refuseAppend", () => {
  it("returns the named refusal for a candidate and nothing for a valid one", () => {
    const records = journalOf(opened(), assigned("builder"));
    expect(refuseAppend(records, attempt("build", "builder"))).toBeUndefined();
    expect(refuseAppend(records, assigned("ghost"))).toMatchObject({
      ok: false,
      reason: "agent_unknown",
      line: 3,
    });
  });
  it("throws a TypeError for a candidate that breaks its field contract", () => {
    const records = journalOf(opened());
    expect(() => refuseAppend(records, terminated("exhausted"))).toThrow(TypeError);
  });
});
