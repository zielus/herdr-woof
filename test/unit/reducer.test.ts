import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDist, repoRoot } from "../helpers/dist.js";
import {
  HEX,
  PLAN,
  REV,
  accepted,
  activity,
  assigned,
  attempt,
  blocked,
  cancelRequested,
  checkGate,
  dispatched,
  duplicate,
  gate,
  hostClaimed,
  hostExited,
  hostLost,
  journalOf as buildJournal,
  lifecycleChanged,
  observationLost,
  observationRecovered,
  opened,
  reconciled,
  rejected,
  terminated,
  unblocked,
} from "../helpers/records.js";

type Json = Record<string, unknown>;
interface AttemptStateJson {
  opened: Json;
  status: string;
  accepted?: Json;
  rejections: Record<string, number>;
  rejectionLog: Json[];
  cause: string;
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
  gates: Json[];
  blocks: Array<{ blocked: Json; unblocked?: Json }>;
  reconciliations: Map<number, Json>;
  host: { claimed?: Json; exited?: Json; lost?: Json };
  cancelRequests: Json[];
  observationLost: Map<string, Json>;
  lifecycles: Map<string, Json>;
  activities: Map<string, Json>;
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
      rounds: 0,
      gatesByDecision: { pass: 0, reject: 0 },
      gatesByGate: {},
      formatRepairsByVisit: {},
      workRetriesByVisit: {},
      blocks: 0,
      reconciliations: { delivered: 0, abandoned: 0 },
      lifecycleChangesByAgent: {},
      activitiesByKind: {},
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

describe("run.opened rules", () => {
  it("refuses a second run.opened instead of mixing two runs", () => {
    expectRefused(journalOf(opened(PLAN, "run-one"), opened(null, "run-two")), "run_exists");
    expectRefused(journalOf(opened(null, "run-one"), opened(PLAN, "run-one")), "run_exists");
    expectRefused(
      journalOf(opened(), attempt("build", "builder"), opened(PLAN, "run-two")),
      "run_exists",
    );
  });
  it("refuses any record before run.opened", () => {
    for (const first of [terminated(), assigned("builder"), rejected("envelope_malformed")]) {
      expectRefused(journalOf(first), "invalid_transition");
    }
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
  it("accepts exactly one started dispatch for an attempt accepted before its dispatch was recorded", () => {
    const acceptedFirst = () => [...base(), accepted(4, "build", "builder", null)];
    const state = expectOk(journalOf(...acceptedFirst(), dispatched("build", "builder")));
    expect(state.dispatches.get("build/1/1")).toMatchObject({ delivery: "started" });
    expect(state.attempts.get("build/1/1")?.status).toBe("accepted");
    expectRefused(
      journalOf(...acceptedFirst(), dispatched("build", "builder"), dispatched("build", "builder")),
      "dispatch_exists",
    );
    for (const [delivery, reason] of [
      ["ambiguous", "stalled"],
      ["not_delivered", "agent_busy"],
    ] as const) {
      expectRefused(
        journalOf(...acceptedFirst(), dispatched("build", "builder", 1, 1, delivery, reason)),
        "attempt_unknown",
      );
    }
  });
  it("refuses a started dispatch for an accepted attempt once a newer attempt of the stage opened", () => {
    expectRefused(
      journalOf(
        ...base(),
        accepted(4, "build", "builder", null),
        attempt("build", "builder", 1, 2),
        dispatched("build", "builder"),
      ),
      "dispatch_not_latest",
    );
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
  it("refuses a duplicate after termination", () => {
    expectRefused(
      journalOf(
        opened(),
        attempt("build", "builder"),
        accepted(3, "build", "builder", null),
        terminated(),
        duplicate(3),
      ),
      "run_closed",
    );
  });
  it("keeps an open attempt open in reducer state after termination", () => {
    const state = expectOk(journalOf(opened(), attempt("build", "builder"), terminated()));
    expect(state.attempts.get("build/1/1")?.status).toBe("open");
  });
  it("closes every open activity at termination and refuses an end for it afterwards", () => {
    // A journal whose writer could not end its activities (a killed host) reads as nothing in
    // progress once the run terminated; the start counters keep what was started.
    const state = expectOk(
      journalOf(
        opened(),
        assigned("builder"),
        activity("readiness_wait", "started", { agentId: "builder" }),
        activity("check_run", "started", { attempt: ["build", 1, 1] }, { detail: "bun test" }),
        terminated("failed"),
      ),
    );
    expect(state.activities.size).toBe(0);
    expect(state.counters["activitiesByKind"]).toEqual({ readiness_wait: 1, check_run: 1 });
    expectRefused(
      journalOf(
        opened(),
        assigned("builder"),
        activity("readiness_wait", "started", { agentId: "builder" }),
        terminated("failed"),
        activity("readiness_wait", "ended", { agentId: "builder" }, { result: "failed" }),
      ),
      "run_closed",
    );
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
    rounds: 0,
    gatesByDecision: { pass: 0, reject: 0 },
    gatesByGate: {},
    formatRepairsByVisit: {},
    workRetriesByVisit: {},
    blocks: 0,
    reconciliations: { delivered: 0, abandoned: 0 },
    lifecycleChangesByAgent: {},
    activitiesByKind: {},
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
    [
      attempt("build", "builder", 1, 2),
      {
        attemptsOpened: 2,
        attemptsByVisit: { "build/1": 2 },
        workRetriesByVisit: { "build/1": 1 },
      },
    ],
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
    [lifecycleChanged("builder", null, "ready"), { lifecycleChangesByAgent: { builder: 1 } }],
    [
      activity("readiness_wait", "started", { agentId: "builder" }),
      { activitiesByKind: { readiness_wait: 1 } },
    ],
    // An end changes no counter: only starts are counted.
    [activity("readiness_wait", "ended", { agentId: "builder" }, { result: "ready" }), {}],
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

function readFixture(name: string): Json[] {
  return readFileSync(join(repoRoot, "test", "fixtures", name), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const record = parseRecordLine(line);
      if (typeof record === "string") throw new Error(`${name}: ${record}`);
      return record;
    });
}

describe("p2 journal compatibility (p3 reader)", () => {
  it("replays the committed p2 journal to the same attempt and dispatch state", () => {
    const records = readFixture("p2-journal.jsonl");
    const state = expectOk(records);
    expect(state.runId).toBe("p2-fixture");
    expect(state.revision).toBe(11);
    expect(state.status).toBe("exhausted");
    expect(state.plan).toEqual(records[0]?.["plan"]);
    expect([...state.attempts].map(([key, value]) => [key, value.status, value.cause])).toEqual([
      ["build/1/1", "superseded", "initial"],
      ["build/1/2", "accepted", "work_retry"],
      ["review/1/1", "open", "initial"],
    ]);
    expect(
      [...state.dispatches].map(([key, value]) => [key, value["delivery"], value["reason"]]),
    ).toEqual([
      ["build/1/1", "ambiguous", "stalled"],
      ["build/1/2", "started", "observed_working"],
      ["review/1/1", "not_delivered", "agent_busy"],
    ]);
    expect([...state.assignments.keys()]).toEqual(["builder", "reviewer"]);
    expect(state.termination).toMatchObject({ outcome: "exhausted", limit: "maxAttemptsPerVisit" });
    expect(state.gates).toEqual([]);
    expect(state.blocks).toEqual([]);
    expect(state.counters).toMatchObject({
      attemptsOpened: 3,
      submissionsAccepted: 1,
      dispatches: { started: 1, not_delivered: 1, ambiguous: 1 },
      rounds: 0,
      workRetriesByVisit: { "build/1": 1 },
      formatRepairsByVisit: {},
    });
  });
});

describe("p3 record field contracts", () => {
  const line = (body: Json, seq = 9) =>
    JSON.stringify({ schemaVersion: 1, seq, ts: "2026-09-14T10:00:00.000Z", ...body });
  const without = (body: Json, key: string): Json => {
    const copy = { ...body };
    Reflect.deleteProperty(copy, key);
    return copy;
  };
  const stageGate = gate(4, "build");
  const verifyGate = checkGate(4, "verify", "build");

  const good: Array<[string, Json]> = [
    ["stage gate", stageGate],
    [
      "stage gate with reviewed and outcome",
      { ...stageGate, reviewed: REV, next: { outcome: "completed" } },
    ],
    ["check gate", verifyGate],
    [
      "check gate that timed out",
      {
        ...verifyGate,
        check: {
          ...(verifyGate["check"] as Json),
          exitCode: null,
          signal: "SIGTERM",
          timedOut: true,
        },
      },
    ],
    ["revision without head", { ...stageGate, revision: { head: null, tree: "d".repeat(64) } }],
    ["run.blocked", blocked("builder")],
    ["run.blocked with attempt", blocked("builder", ["build", 1, 1])],
    [
      "run.blocked on startup",
      {
        ...blocked("builder"),
        reason: "startup_blocked",
        observed: { runtimeStatus: null, terminalId: null, stateChangeSeq: null },
      },
    ],
    ["run.unblocked", unblocked("builder")],
    ["delivery.reconciled delivered", reconciled(4, "build", "builder")],
    [
      "delivery.reconciled by submission",
      reconciled(4, "build", "builder", 1, 1, "delivered", "submission_recorded"),
    ],
    [
      "delivery.reconciled abandoned",
      reconciled(4, "build", "builder", 1, 1, "abandoned", "no_evidence_before_deadline"),
    ],
    [
      "request.dispatched with request, target and revision",
      {
        ...dispatched("build", "builder"),
        request: { path: "requests/build/visit-1/attempt-1/request.md", sha256: HEX, bytes: 120 },
        target: { terminalId: "term-1", sessionId: null },
        revision: REV,
      },
    ],
    [
      "run.opened with input",
      { ...opened(), input: { path: "input.json", sha256: HEX, bytes: 12 } },
    ],
    [
      "run.opened with a p3 plan",
      opened({
        ...PLAN,
        checks: ["verify"],
        limits: { ...PLAN.limits, maxFormatRepairs: 0 },
        agents: PLAN.agents.map((agent) => ({ ...agent, args: ["--add-dir", "/tmp"] })),
      }),
    ],
    ["run.terminated exhausting maxFormatRepairs", terminated("exhausted", "maxFormatRepairs")],
  ];
  for (const [name, body] of good) {
    it(`accepts ${name}`, () => {
      expect(parseRecordLine(line(body))).toMatchObject({ type: body["type"] });
    });
  }

  const bad: Array<[string, Json]> = [
    ["gate: unexpected field", { ...stageGate, extra: 1 }],
    ["gate: stage gate without verdict", without(stageGate, "verdict")],
    ["gate: stage gate with check", { ...stageGate, check: verifyGate["check"] }],
    ["gate: check gate without check", without(verifyGate, "check")],
    ["gate: check gate with verdict", { ...verifyGate, verdict: null }],
    ["gate: check gate with reviewed", { ...verifyGate, reviewed: REV }],
    [
      "gate: evidence path not derived from the gate",
      {
        ...verifyGate,
        check: {
          ...(verifyGate["check"] as Json),
          evidence: { path: "checks/other/build-v1-a1/output.log", sha256: HEX, bytes: 1 },
        },
      },
    ],
    [
      "gate: empty check command",
      { ...verifyGate, check: { ...(verifyGate["check"] as Json), command: [] } },
    ],
    ["gate: unknown kind", { ...stageGate, kind: "vote" }],
    ["gate: unknown decision", { ...stageGate, decision: "maybe" }],
    ["gate: empty reason", { ...stageGate, reason: "" }],
    ["gate: reason over 200 characters", { ...stageGate, reason: "x".repeat(201) }],
    ["gate: negative round", { ...stageGate, round: -1 }],
    [
      "gate: next with both shapes",
      { ...stageGate, next: { stageId: "review", outcome: "completed" } },
    ],
    ["gate: next outcome cancelled", { ...stageGate, next: { outcome: "cancelled" } }],
    ["gate: acceptedSeq 0", gate(0, "build")],
    [
      "gate: bad receipt id",
      { ...stageGate, subject: { ...(stageGate["subject"] as Json), receiptId: "r-1" } },
    ],
    ["gate: short tree", { ...stageGate, revision: { head: null, tree: "abc" } }],
    ["gate: uppercase head", { ...stageGate, revision: { head: "B".repeat(40), tree: REV.tree } }],
    ["run.blocked: unknown reason", { ...blocked("builder"), reason: "tired" }],
    ["run.blocked: partial attempt fields", { ...blocked("builder"), stageId: "build" }],
    ["run.blocked: empty requiredAction", { ...blocked("builder"), requiredAction: "" }],
    [
      "run.blocked: requiredAction over 2000 characters",
      { ...blocked("builder"), requiredAction: "x".repeat(2001) },
    ],
    [
      "run.blocked: observed with extra field",
      {
        ...blocked("builder"),
        observed: { runtimeStatus: null, terminalId: null, stateChangeSeq: null, pane: "x" },
      },
    ],
    ["run.unblocked: other resolution", { ...unblocked("builder"), resolution: "cancelled" }],
    [
      "delivery.reconciled: not_delivered resolution",
      reconciled(4, "build", "builder", 1, 1, "not_delivered", "observed_activity"),
    ],
    [
      "delivery.reconciled: evidence of another resolution",
      reconciled(4, "build", "builder", 1, 1, "abandoned", "observed_activity"),
    ],
    ["delivery.reconciled: dispatchSeq 0", reconciled(0, "build", "builder")],
    [
      "request.dispatched: request path of another attempt",
      {
        ...dispatched("build", "builder"),
        request: { path: "requests/build/visit-1/attempt-2/request.md", sha256: HEX, bytes: 1 },
      },
    ],
    [
      "request.dispatched: target without sessionId",
      { ...dispatched("build", "builder"), target: { terminalId: "t" } },
    ],
    [
      "request.dispatched: invalid revision",
      { ...dispatched("build", "builder"), revision: { tree: REV.tree } },
    ],
    [
      "run.opened: input with another path",
      { ...opened(), input: { path: "in.json", sha256: HEX, bytes: 1 } },
    ],
    [
      "run.opened: plan with invalid maxFormatRepairs",
      opened({ ...PLAN, limits: { ...PLAN.limits, maxFormatRepairs: 1001 } }),
    ],
  ];
  for (const [name, body] of bad) {
    it(`fails closed on ${name}`, () => {
      expect(typeof parseRecordLine(line(body))).toBe("string");
    });
  }
});

describe("attempt cause derivation", () => {
  const causes = (...bodies: Json[]) => {
    const state = expectOk(journalOf(opened(), assigned("builder"), ...bodies));
    return Object.fromEntries([...state.attempts].map(([key, value]) => [key, value.cause]));
  };

  it("derives initial, format_repair and work_retry from the previous attempt of the visit", () => {
    expect(causes(attempt("build", "builder"))).toEqual({ "build/1/1": "initial" });
    // Started and not accepted → format repair.
    expect(
      causes(
        attempt("build", "builder"),
        dispatched("build", "builder"),
        attempt("build", "builder", 1, 2),
      ),
    ).toMatchObject({ "build/1/2": "format_repair" });
    // Not delivered → work retry.
    expect(
      causes(
        attempt("build", "builder"),
        dispatched("build", "builder", 1, 1, "not_delivered", "agent_busy"),
        attempt("build", "builder", 1, 2),
      ),
    ).toMatchObject({ "build/1/2": "work_retry" });
    // No dispatch → work retry.
    expect(causes(attempt("build", "builder"), attempt("build", "builder", 1, 2))).toMatchObject({
      "build/1/2": "work_retry",
    });
    // Accepted with status failed → work retry.
    expect(
      causes(
        attempt("build", "builder"),
        dispatched("build", "builder"),
        { ...accepted(5, "build", "builder", null), status: "failed" },
        attempt("build", "builder", 1, 2),
      ),
    ).toMatchObject({ "build/1/2": "work_retry" });
    // Ambiguous reconciled delivered → format repair; unreconciled → work retry.
    expect(
      causes(
        attempt("build", "builder"),
        dispatched("build", "builder", 1, 1, "ambiguous", "stalled"),
        reconciled(4, "build", "builder"),
        attempt("build", "builder", 1, 2),
      ),
    ).toMatchObject({ "build/1/2": "format_repair" });
    expect(
      causes(
        attempt("build", "builder"),
        dispatched("build", "builder", 1, 1, "ambiguous", "stalled"),
        attempt("build", "builder", 1, 2),
      ),
    ).toMatchObject({ "build/1/2": "work_retry" });
    // A new visit starts initial again.
    expect(
      causes(
        attempt("build", "builder"),
        dispatched("build", "builder"),
        attempt("build", "builder", 2, 1),
      ),
    ).toMatchObject({ "build/2/1": "initial" });
  });

  it("counts format repairs and work retries per visit and logs rejection messages", () => {
    const state = expectOk(
      journalOf(
        opened(),
        assigned("builder"),
        attempt("build", "builder"),
        dispatched("build", "builder"),
        {
          ...rejected("artifact_hash_mismatch", {
            runId: "run-1",
            agentId: "builder",
            stageId: "build",
            visit: 1,
            attempt: 1,
          }),
          message: "sha256 differs",
        },
        attempt("build", "builder", 1, 2),
        dispatched("build", "builder", 1, 2, "not_delivered", "agent_busy"),
        attempt("build", "builder", 1, 3),
      ),
    );
    expect(state.counters).toMatchObject({
      formatRepairsByVisit: { "build/1": 1 },
      workRetriesByVisit: { "build/1": 1 },
    });
    expect(state.attempts.get("build/1/1")?.rejectionLog).toEqual([
      { seq: 5, reason: "artifact_hash_mismatch", message: "sha256 differs" },
    ]);
  });
});

describe("request.dispatched target rule", () => {
  it("refuses a target terminal that differs from the current assignment", () => {
    const base = [
      opened(),
      { ...assigned("builder"), terminalId: "term-1" },
      attempt("build", "builder"),
    ];
    const target = (terminalId: string | null) => ({
      ...dispatched("build", "builder"),
      target: { terminalId, sessionId: null },
    });
    expectOk(journalOf(...base, target("term-1")));
    expectOk(journalOf(...base, target(null)));
    expectRefused(journalOf(...base, target("term-2")), "assignment_mismatch");
    // An assignment without a terminal id cannot be contradicted.
    expectOk(
      journalOf(opened(), assigned("builder"), attempt("build", "builder"), target("term-9")),
    );
  });
});

describe("gate.recorded rules", () => {
  // seq 3 attempt, 4 dispatch, 5 accepted build/1/1.
  const built = () => [
    opened(),
    assigned("builder"),
    attempt("build", "builder"),
    dispatched("build", "builder"),
    accepted(5, "build", "builder", null),
  ];

  it("records a stage gate and counts it", () => {
    const state = expectOk(journalOf(...built(), gate(5, "build")));
    expect(state.gates).toHaveLength(1);
    expect(state.counters).toMatchObject({
      rounds: 0,
      gatesByDecision: { pass: 1, reject: 0 },
      gatesByGate: { build: 1 },
    });
  });
  it("refuses a gate after termination", () => {
    expectRefused(journalOf(...built(), terminated(), gate(5, "build")), "run_closed");
  });
  it("refuses a subject that is not an acceptance of exactly that attempt and receipt", () => {
    expectRefused(journalOf(...built(), gate(4, "build")), "gate_subject_unknown");
    expectRefused(journalOf(...built(), gate(5, "build", 1, 2)), "gate_subject_unknown");
    expectRefused(
      journalOf(...built(), {
        ...gate(5, "build"),
        subject: {
          stageId: "build",
          visit: 1,
          attempt: 1,
          acceptedSeq: 5,
          receiptId: "rcpt-5-000000000000",
        },
      }),
      "gate_subject_unknown",
    );
  });
  it("refuses a subject that a newer attempt superseded", () => {
    expectRefused(
      journalOf(...built(), attempt("build", "builder", 2, 1), gate(5, "build")),
      "gate_subject_stale",
    );
  });
  it("refuses a stage gate naming another stage or verdict, and a check gate naming a plan stage", () => {
    expectRefused(
      journalOf(...built(), gate(5, "build", 1, 1, { gate: "review" })),
      "gate_mismatch",
    );
    expectRefused(
      journalOf(...built(), gate(5, "build", 1, 1, { verdict: "approve" })),
      "gate_mismatch",
    );
    expectRefused(journalOf(...built(), checkGate(5, "review", "build")), "gate_mismatch");
    expectOk(journalOf(...built(), checkGate(5, "verify", "build")));
  });
  it("refuses a second gate with the same id for the same acceptance", () => {
    expectRefused(journalOf(...built(), gate(5, "build"), gate(5, "build")), "gate_exists");
    expectOk(journalOf(...built(), gate(5, "build"), checkGate(5, "verify", "build")));
  });
  it("with planned checks, refuses an unplanned check or next target", () => {
    const planned = [opened({ ...PLAN, checks: ["verify"] }), ...built().slice(1)];
    expectOk(journalOf(...planned, checkGate(5, "verify", "build")));
    expectOk(journalOf(...planned, gate(5, "build", 1, 1, { next: { stageId: "verify" } })));
    expectRefused(journalOf(...planned, checkGate(5, "lint", "build")), "stage_unknown");
    expectRefused(
      journalOf(...planned, gate(5, "build", 1, 1, { next: { stageId: "deploy" } })),
      "stage_unknown",
    );
    // Without planned checks the next target is only an id.
    expectOk(journalOf(...built(), gate(5, "build", 1, 1, { next: { stageId: "deploy" } })));
  });
  it("refuses a round below the highest or more than one above it", () => {
    expectRefused(journalOf(...built(), gate(5, "build", 1, 1, { round: 2 })), "round_invalid");
    const state = expectOk(
      journalOf(
        ...built(),
        gate(5, "build", 1, 1, { round: 1 }),
        checkGate(5, "verify", "build", 1, 1, { round: 1 }),
      ),
    );
    expect(state.counters["rounds"]).toBe(1);
    expectRefused(
      journalOf(...built(), gate(5, "build", 1, 1, { round: 1 }), checkGate(5, "verify", "build")),
      "round_invalid",
    );
  });
});

describe("run.blocked and run.unblocked rules", () => {
  const base = () => [
    opened(),
    assigned("builder"),
    attempt("build", "builder"),
    dispatched("build", "builder"),
  ];

  it("derives blocked and returns to running after unblock", () => {
    const blockedState = expectOk(journalOf(...base(), blocked("builder", ["build", 1, 1])));
    expect(blockedState.status).toBe("blocked");
    const resumed = expectOk(journalOf(...base(), blocked("builder"), unblocked("builder")));
    expect(resumed.status).toBe("running");
    expect(resumed.blocks).toHaveLength(1);
    expect(resumed.counters["blocks"]).toBe(1);
    const again = expectOk(
      journalOf(...base(), blocked("builder"), unblocked("builder"), blocked("builder")),
    );
    expect(again.status).toBe("blocked");
    expect(again.counters["blocks"]).toBe(2);
  });
  it("allows termination while blocked and keeps the block in history", () => {
    const state = expectOk(journalOf(...base(), blocked("builder"), terminated()));
    expect(state.status).toBe("cancelled");
    expect(state.blocks).toHaveLength(1);
  });
  it("refuses a block after termination, for an unknown or unassigned agent, or while blocked", () => {
    expectRefused(journalOf(...base(), terminated(), blocked("builder")), "run_closed");
    expectRefused(journalOf(...base(), blocked("ghost")), "agent_unknown");
    expectRefused(journalOf(...base(), blocked("reviewer")), "agent_unassigned");
    expectRefused(journalOf(...base(), blocked("builder"), blocked("builder")), "run_blocked");
  });
  it("refuses a block naming an attempt that is not open or not the agent's", () => {
    expectRefused(journalOf(...base(), blocked("builder", ["build", 1, 2])), "attempt_unknown");
    expectRefused(
      journalOf(...base(), assigned("reviewer"), blocked("reviewer", ["build", 1, 1])),
      "owner_mismatch",
    );
  });
  it("refuses an unblock without a block by that agent, or after termination", () => {
    expectRefused(journalOf(...base(), unblocked("builder")), "not_blocked");
    expectRefused(
      journalOf(...base(), assigned("reviewer"), blocked("builder"), unblocked("reviewer")),
      "not_blocked",
    );
    expectRefused(
      journalOf(...base(), blocked("builder"), terminated(), unblocked("builder")),
      "run_closed",
    );
  });
});

describe("delivery.reconciled rules", () => {
  // seq 4 is the dispatch.
  const base = (delivery = "ambiguous", reason = "stalled") => [
    opened(),
    assigned("builder"),
    attempt("build", "builder"),
    dispatched("build", "builder", 1, 1, delivery, reason),
  ];

  it("records one reconciliation and drops nothing else", () => {
    const state = expectOk(journalOf(...base(), reconciled(4, "build", "builder")));
    expect(state.reconciliations.get(4)).toMatchObject({ resolution: "delivered" });
    expect(state.counters["reconciliations"]).toEqual({ delivered: 1, abandoned: 0 });
  });
  it("refuses a reconciliation of a dispatch that is not ambiguous for exactly that agent and attempt", () => {
    expectRefused(
      journalOf(...base("started", "observed_working"), reconciled(4, "build", "builder")),
      "dispatch_not_ambiguous",
    );
    expectRefused(
      journalOf(...base(), reconciled(3, "build", "builder")),
      "dispatch_not_ambiguous",
    );
    expectRefused(
      journalOf(...base(), reconciled(4, "build", "builder", 1, 2)),
      "dispatch_not_ambiguous",
    );
    expectRefused(
      journalOf(...base(), assigned("reviewer"), reconciled(4, "build", "reviewer")),
      "dispatch_not_ambiguous",
    );
  });
  it("refuses a second reconciliation and one after termination", () => {
    expectRefused(
      journalOf(
        ...base(),
        reconciled(4, "build", "builder"),
        reconciled(4, "build", "builder", 1, 1, "abandoned", "no_evidence_before_deadline"),
      ),
      "reconcile_exists",
    );
    expectRefused(
      journalOf(...base(), terminated(), reconciled(4, "build", "builder")),
      "run_closed",
    );
  });
});

describe("lifecycle record rules", () => {
  const base = () => [opened(), assigned("builder")];

  it("keeps a cancellation request distinct from the termination it leads to", () => {
    const requested = expectOk(journalOf(...base(), cancelRequested("web", "stop")));
    expect(requested.status).toBe("starting");
    expect(requested.termination).toBeUndefined();
    expect(requested.cancelRequests).toMatchObject([{ seq: 3, source: "web", reason: "stop" }]);
    const ended = expectOk(journalOf(...base(), cancelRequested(), terminated()));
    expect(ended.status).toBe("cancelled");
    expectRefused(journalOf(...base(), terminated(), cancelRequested()), "run_closed");
  });

  it("records one host claim, and the host's exit even after termination", () => {
    const state = expectOk(journalOf(...base(), hostClaimed(), terminated(), hostExited()));
    expect(state.host.claimed).toMatchObject({ seq: 3, pid: 4242 });
    expect(state.host.exited).toMatchObject({ seq: 5, exitCode: 0, reason: "completed" });
    expect(state.status).toBe("cancelled");
    expectRefused(journalOf(...base(), hostClaimed(), hostClaimed(7)), "host_exists");
    expectRefused(journalOf(...base(), terminated(), hostClaimed()), "run_closed");
    expectRefused(journalOf(...base(), hostExited()), "host_unknown");
    expectRefused(journalOf(...base(), hostClaimed(), hostExited(7)), "host_unknown");
    expectRefused(journalOf(...base(), hostClaimed(), hostExited(), hostExited()), "host_gone");
  });

  it("records a lost host once, with or without a journaled claim, and never after an exit", () => {
    expect(
      expectOk(journalOf(...base(), hostLost(null, "claim_invalid: torn"))).host.lost,
    ).toBeDefined();
    const state = expectOk(journalOf(...base(), hostClaimed(), hostLost(), hostExited(4242, 130)));
    expect(state.host.lost).toMatchObject({ seq: 4, reason: "host_process_gone" });
    expect(state.host.exited).toMatchObject({ seq: 5 });
    expectRefused(journalOf(...base(), hostClaimed(), hostLost(), hostLost()), "host_gone");
    expectRefused(journalOf(...base(), hostClaimed(), hostExited(), hostLost()), "host_gone");
    expectRefused(journalOf(...base(), terminated(), hostLost()), "run_closed");
  });

  it("holds one unresolved observation loss per agent until it recovers", () => {
    const lost = expectOk(journalOf(...base(), observationLost("builder")));
    expect(lost.observationLost.get("builder")).toMatchObject({ seq: 3, code: "timeout" });
    const recovered = expectOk(
      journalOf(...base(), observationLost("builder"), observationRecovered("builder", 3)),
    );
    expect(recovered.observationLost.size).toBe(0);
    const again = expectOk(
      journalOf(
        ...base(),
        observationLost("builder"),
        observationRecovered("builder", 3),
        observationLost("builder", "runtime_unavailable"),
      ),
    );
    expect(again.observationLost.get("builder")).toMatchObject({ seq: 5 });
    // Termination keeps the unresolved loss: it is what the run ended with.
    expect(
      expectOk(journalOf(...base(), observationLost("builder"), terminated("failed")))
        .observationLost.size,
    ).toBe(1);
  });

  it("refuses impossible observation records", () => {
    expectRefused(
      journalOf(...base(), observationLost("builder"), observationLost("builder")),
      "observation_lost",
    );
    expectRefused(journalOf(...base(), observationLost("ghost")), "agent_unknown");
    expectRefused(journalOf(...base(), observationLost("reviewer")), "agent_unassigned");
    expectRefused(journalOf(...base(), observationRecovered("builder", 2)), "observation_not_lost");
    expectRefused(
      journalOf(...base(), observationLost("builder"), observationRecovered("builder", 2)),
      "observation_not_lost",
    );
    expectRefused(journalOf(...base(), terminated(), observationLost("builder")), "run_closed");
    expectRefused(
      journalOf(
        ...base(),
        observationLost("builder"),
        terminated(),
        observationRecovered("builder", 3),
      ),
      "run_closed",
    );
  });

  it("refuses lifecycle records that break their field contract", () => {
    const line = (body: Json) =>
      parseRecordLine(
        JSON.stringify({ schemaVersion: 1, seq: 2, ts: "2026-09-14T10:00:00.000Z", ...body }),
      );
    expect(line({ ...cancelRequested(), source: "telepathy" })).toMatch(/source is not one of/);
    expect(line({ ...hostClaimed(), pid: 0 })).toMatch(/pid is not a positive integer/);
    expect(line({ ...hostExited(), exitCode: -1 })).toMatch(/exitCode/);
    expect(line({ ...hostLost(), extra: 1 })).toMatch(/unexpected field extra/);
    expect(line({ ...observationLost("builder"), code: "" })).toMatch(/code is not a non-empty/);
    expect(line({ ...observationRecovered("builder", 0) })).toMatch(/lostSeq is invalid/);
  });

  it("tab ids are additive: optional on host.claimed and agent.assigned, validated when present", () => {
    const line = (body: Json) =>
      parseRecordLine(
        JSON.stringify({ schemaVersion: 1, seq: 2, ts: "2026-09-14T10:00:00.000Z", ...body }),
      );
    // A journal written before tab ids has neither field and still reads.
    expect(line(hostClaimed())).toMatchObject({ type: "host.claimed" });
    expect(line(assigned("builder"))).toMatchObject({ type: "agent.assigned" });
    expect(line({ ...hostClaimed(), tabId: "w1:t1" })).toMatchObject({ tabId: "w1:t1" });
    expect(line({ ...hostClaimed(), tabId: null })).toMatchObject({ tabId: null });
    expect(line({ ...assigned("builder"), tabId: "w1:t2" })).toMatchObject({ tabId: "w1:t2" });
    expect(line({ ...hostClaimed(), tabId: 7 })).toMatch(/tabId/);
    expect(line({ ...assigned("builder"), tabId: "" })).toMatch(/tabId/);
    expect(line({ ...assigned("builder"), tabId: null })).toMatch(/tabId/);
  });
});

describe("activity record rules", () => {
  const base = () => [opened(), assigned("builder")];
  const wait = { agentId: "builder" };
  const check = { attempt: ["build", 1, 1] as [string, number, number] };

  it("holds the last journaled lifecycle per agent and accepts only transitions from it", () => {
    const first = expectOk(journalOf(...base(), lifecycleChanged("builder", null, "ready")));
    expect(first.lifecycles.get("builder")).toMatchObject({ seq: 3, from: null, to: "ready" });
    expect(first.counters["lifecycleChangesByAgent"]).toEqual({ builder: 1 });
    const chain = expectOk(
      journalOf(
        ...base(),
        lifecycleChanged("builder", null, "ready", { raw: "idle" }),
        lifecycleChanged("builder", "ready", "working", { raw: "working" }),
        lifecycleChanged("builder", "working", "gone", { terminalId: null }),
      ),
    );
    expect(chain.lifecycles.get("builder")).toMatchObject({ seq: 5, to: "gone", terminalId: null });
    expect(chain.counters["lifecycleChangesByAgent"]).toEqual({ builder: 3 });
    // A replaced pane occupant is a transition even to the same lifecycle.
    const replaced = expectOk(
      journalOf(
        ...base(),
        lifecycleChanged("builder", null, "working"),
        lifecycleChanged("builder", "working", "working", { replaced: true, terminalId: "term-2" }),
      ),
    );
    expect(replaced.lifecycles.get("builder")).toMatchObject({ seq: 4, replaced: true });
  });

  it("refuses a repeated sample, a transition from another lifecycle than the journaled one, and impossible agents", () => {
    expectRefused(
      journalOf(
        ...base(),
        lifecycleChanged("builder", null, "ready"),
        lifecycleChanged("builder", "ready", "ready"),
      ),
      "lifecycle_unchanged",
    );
  });

  it("refuses a from that is not the journaled lifecycle", () => {
    expectRefused(
      journalOf(...base(), lifecycleChanged("builder", "ready", "working")),
      "lifecycle_mismatch",
    );
    expectRefused(
      journalOf(
        ...base(),
        lifecycleChanged("builder", null, "ready"),
        lifecycleChanged("builder", null, "working"),
      ),
      "lifecycle_mismatch",
    );
    expectRefused(journalOf(...base(), lifecycleChanged("ghost", null, "ready")), "agent_unknown");
    expectRefused(
      journalOf(...base(), lifecycleChanged("reviewer", null, "ready")),
      "agent_unassigned",
    );
    expectRefused(
      journalOf(...base(), terminated(), lifecycleChanged("builder", null, "ready")),
      "run_closed",
    );
  });

  it("keeps an activity open from its start to its end, per kind and subject", () => {
    const open = expectOk(
      journalOf(
        ...base(),
        activity("readiness_wait", "started", wait),
        activity("check_run", "started", check, { detail: "bun test" }),
      ),
    );
    expect([...open.activities.values()].map((record) => [record["seq"], record["kind"]])).toEqual([
      [3, "readiness_wait"],
      [4, "check_run"],
    ]);
    expect(open.counters["activitiesByKind"]).toEqual({ readiness_wait: 1, check_run: 1 });
    const ended = expectOk(
      journalOf(
        ...base(),
        activity("readiness_wait", "started", wait),
        activity("check_run", "started", check, { detail: "bun test" }),
        activity("readiness_wait", "ended", wait, { result: "ready" }),
        // The same kind on another subject is another activity.
        activity("readiness_wait", "started", { agentId: "reviewer" }),
        activity("check_run", "ended", check, { result: "exit 0" }),
      ),
    );
    expect([...ended.activities.values()].map((record) => record["agentId"])).toEqual(["reviewer"]);
    // Ended, an activity can start again for the same subject.
    expect(
      expectOk(
        journalOf(
          ...base(),
          activity("readiness_wait", "started", wait),
          activity("readiness_wait", "ended", wait),
          activity("readiness_wait", "started", wait),
        ),
      ).activities.size,
    ).toBe(1);
    // An activity open at termination is closed by it: the run ended during it.
    expect(
      expectOk(journalOf(...base(), activity("readiness_wait", "started", wait), terminated()))
        .activities.size,
    ).toBe(0);
  });

  it("refuses a second start without an end, an end without a start, and any activity after termination", () => {
    expectRefused(
      journalOf(
        ...base(),
        activity("readiness_wait", "started", wait),
        activity("readiness_wait", "started", wait),
      ),
      "activity_open",
    );
    expectRefused(
      journalOf(...base(), activity("readiness_wait", "ended", wait)),
      "activity_not_open",
    );
    // Another subject of the same kind is not this one.
    expectRefused(
      journalOf(
        ...base(),
        activity("check_run", "started", check),
        activity("check_run", "ended", { attempt: ["build", 1, 2] }),
      ),
      "activity_not_open",
    );
    expectRefused(
      journalOf(
        ...base(),
        activity("readiness_wait", "started", wait),
        activity("readiness_wait", "ended", { agentId: "reviewer" }),
      ),
      "activity_not_open",
    );
    expectRefused(
      journalOf(...base(), terminated(), activity("readiness_wait", "started", wait)),
      "run_closed",
    );
  });

  it("refuses activity records that break their field contract", () => {
    const line = (body: Json) =>
      parseRecordLine(
        JSON.stringify({ schemaVersion: 1, seq: 2, ts: "2026-09-14T10:00:00.000Z", ...body }),
      );
    expect(line(lifecycleChanged("builder", null, "napping"))).toMatch(/to is not one of/);
    expect(line(lifecycleChanged("builder", "asleep", "ready"))).toMatch(/from is not one of/);
    expect(line(lifecycleChanged("builder", null, "ready", { replaced: false }))).toMatch(
      /replaced is not true/,
    );
    expect(line(lifecycleChanged("builder", null, "ready", { raw: "" }))).toMatch(/raw is not/);
    expect(line(lifecycleChanged("builder", null, "ready", { terminalId: "" }))).toMatch(
      /terminalId/,
    );
    expect(line(activity("nap", "started"))).toMatch(/kind is not one of/);
    expect(line({ ...activity("check_run", "started"), phase: "paused" })).toMatch(
      /phase is not one of/,
    );
    expect(line({ ...activity("check_run", "started", check), visit: undefined })).toMatch(
      /stageId, visit and attempt must be given together/,
    );
    expect(line(activity("check_run", "started", check, { result: "exit 0" }))).toMatch(
      /result is only carried by an ended activity/,
    );
    expect(line(activity("check_run", "ended", check, { result: "" }))).toMatch(/result is not/);
    expect(line(activity("check_run", "ended", check, { extra: 1 }))).toMatch(
      /unexpected field extra/,
    );
    // The minimal forms parse: a bare lifecycle transition and a subject-less activity.
    expect(line(lifecycleChanged("builder", null, "ready"))).toMatchObject({
      type: "agent.lifecycle_changed",
    });
    expect(line(activity("revision_check", "started"))).toMatchObject({ type: "run.activity" });
  });
});
