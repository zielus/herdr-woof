import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";
import {
  accepted,
  activity,
  assigned,
  attempt,
  blocked,
  checkGate,
  childOpened,
  childResult,
  COMPOSITE_PLAN,
  dispatched,
  gate,
  hostClaimed,
  journalOf,
  lifecycleChanged,
  opened,
  PLAN as MIN_PLAN,
  rejected,
  REV,
  terminated,
} from "../helpers/records.js";

// The run model behind woof tui (pure): header, step rows, notes and the Config document.
type Json = Record<string, unknown>;
interface Event {
  seq: number;
  ts: string;
  type: string;
  subject: Json;
  data: Json;
}
interface StateWord {
  word: string;
  mark: string;
  tone?: string;
}
interface DetailLine {
  label: string;
  value: string;
  tone?: string;
}
interface ArtifactRef {
  id: string;
  kind: string;
  label: string;
  path: string;
  relPath: string;
  stageId: string;
  visit: number;
  attempt: number | null;
  context: string;
  bytes: number | null;
  sha256: string | null;
}
interface StepNode {
  id: string;
  kind: string;
  name: string;
  participant: string;
  state: StateWord;
  startedAt: string | null;
  endedAt: string | null;
  details: DetailLine[];
  artifacts: ArtifactRef[];
}
interface RunHeader {
  title: string;
  workflow: string | null;
  state: StateWord;
  step: string | null;
  openedAt: string;
  endedAt: string | null;
  attention: StateWord | null;
}
interface ConfigDoc {
  agents: Array<{
    agentId: string;
    role: string | null;
    kind: string | null;
    model: string | null;
    stages: string[];
    observed: string | null;
  }>;
  input: unknown;
  inputPath: string | null;
  inputProblem: string | null;
  context: DetailLine[];
}
interface RunModel {
  runId: string;
  runDir: string;
  header: RunHeader;
  steps: StepNode[];
  stepsNote: StateWord | null;
  wait: { text: string; since: string } | null;
  activityNote: StateWord | null;
  config: ConfigDoc;
}
interface RunRow {
  runId: string;
  runDir: string;
  title: string;
  titleIsFallback: boolean;
  workflow: string | null;
  state: StateWord;
  step: string | null;
  openedAt: string;
  endedAt: string | null;
  attention: boolean;
}
type Snapshot = Json & { liveness: Json; outcome: Json | null };
interface ModelModule {
  deriveRunModel(input: {
    snapshot: Snapshot;
    status: Json;
    runDir: string;
    events: Event[];
    input: unknown;
    config: unknown;
    graph: unknown;
    timeZone?: string;
  }): RunModel;
  runRowOf(entry: Json, read: { snapshot: Snapshot; status: Json } | null, input: unknown): RunRow;
  titleOf(input: unknown): string | undefined;
}

let model: ModelModule;
let parse: (line: string) => Json | string;
let projectEvents: (records: Json[], anchor: string) => Event[];
let deriveSnapshot: (records: Json[]) => { ok: boolean; snapshot: Snapshot };
let runStatusOf: (snapshot: Json, runDir: string) => Json;
let graphOf: (definition: unknown, plan: Json, input: unknown) => unknown;
let builtInWorkflow: (name: string) => unknown;

const ANCHOR = "0123456789ab";
const RUN_DIR = "/tmp/woof-home/runs/run-1";

const PLAN = {
  workflow: { name: "build-review", version: "1" },
  agents: [
    { agentId: "builder", role: "builder", kind: "claude", model: "sonnet" },
    { agentId: "reviewer", role: "reviewer", kind: "codex", model: "gpt-5" },
  ],
  stages: [
    { stageId: "build", agentId: "builder", verdicts: [] },
    { stageId: "review", agentId: "reviewer", verdicts: ["pass", "fail"] },
    { stageId: "repair", agentId: "builder", verdicts: [] },
  ],
  limits: {
    maxAttemptsPerVisit: 2,
    maxVisitsPerStage: 3,
    maxRounds: 3,
    runTimeoutMs: 7_200_000,
    readinessWaitMs: 60_000,
    blockedWaitMs: 60_000,
    deliveryTimeoutMs: 10_000,
  },
  checks: ["verify"],
};

const INPUT = {
  schemaVersion: 1,
  repo: "/tmp/woof-home/fixture-repo",
  task: {
    title: "Fix empty-state rendering",
    description: "The list shows nothing when it is empty.",
    acceptanceCriteria: ["an empty list shows a hint"],
  },
  verify: { command: ["bun", "test"], timeoutMs: 60_000 },
};

const review = (visit: number) => attempt("review", "reviewer", visit, 1, ["pass", "fail"]);
const reviewGate = (acceptedSeq: number, visit: number, overrides: Json) =>
  gate(acceptedSeq, "review", visit, 1, { reviewed: REV, ...overrides });
const checkRun = (phase: "started" | "ended", stageId: string) =>
  activity("check_run", phase, { attempt: [stageId, 1, 1] }, { detail: "node --test" });

/** Record n (1-based) happens n - 1 seconds after 10:00:00 UTC. */
const at = (seq: number) => new Date(Date.UTC(2026, 8, 14, 10, 0, seq - 1)).toISOString();

/** build → verify → review (changes requested) → repair → verify 2 → review 2 (approved). */
const DESIGN_RUN: Json[] = [
  opened(PLAN), // 1
  hostClaimed(), // 2
  assigned("builder"), // 3
  attempt("build", "builder"), // 4
  dispatched("build", "builder"), // 5
  accepted(6, "build", "builder", null), // 6
  gate(6, "build", 1, 1, { next: { stageId: "verify" } }), // 7
  checkRun("started", "build"), // 8
  checkRun("ended", "build"), // 9
  checkGate(6, "verify", "build"), // 10
  assigned("reviewer"), // 11
  review(1), // 12
  dispatched("review", "reviewer"), // 13
  accepted(14, "review", "reviewer", "fail"), // 14
  reviewGate(14, 1, {
    decision: "reject",
    reason: "changes_requested",
    round: 1,
    next: { stageId: "repair" },
    verdict: "fail",
  }), // 15
  attempt("repair", "builder"), // 16
  dispatched("repair", "builder"), // 17
  accepted(18, "repair", "builder", null), // 18
  gate(18, "repair", 1, 1, { round: 1, next: { stageId: "verify" } }), // 19
  checkRun("started", "repair"), // 20
  checkRun("ended", "repair"), // 21
  checkGate(18, "verify", "repair", 1, 1, { round: 1 }), // 22
  review(2), // 23
  dispatched("review", "reviewer", 2), // 24
  accepted(25, "review", "reviewer", "pass", 2), // 25
  reviewGate(25, 2, {
    decision: "pass",
    reason: "approved",
    round: 2,
    next: { outcome: "completed" },
    verdict: "pass",
  }), // 26
  { type: "run.terminated", outcome: "completed", reason: "approved" }, // 27
];

beforeAll(async () => {
  model = await loadDist<ModelModule>("tui/model.js");
  ({ parseRecordLine: parse } = await loadDist<{ parseRecordLine: typeof parse }>(
    "journal/records.js",
  ));
  ({ projectEvents } = await loadDist<{ projectEvents: typeof projectEvents }>(
    "observe/events.js",
  ));
  ({ deriveSnapshot } = await loadDist<{ deriveSnapshot: typeof deriveSnapshot }>(
    "state/snapshot.js",
  ));
  ({ runStatusOf } = await loadDist<{ runStatusOf: typeof runStatusOf }>("inspect/status.js"));
  ({ graphOf } = await loadDist<{ graphOf: typeof graphOf }>("inspect/workflow-graph.js"));
  ({ builtInWorkflow } = await loadDist<{ builtInWorkflow: typeof builtInWorkflow }>(
    "workflows/catalog.js",
  ));
});

interface Built {
  snapshot: Snapshot;
  status: Json;
  events: Event[];
}

/**
 * Journal records one second apart, with the snapshot, status and events derived
 * from them. A derived snapshot is unhosted; like readSnapshot probing a live host,
 * a run without an outcome gets owner `alive` unless `edit` says otherwise.
 */
function build(bodies: Json[], edit?: (snapshot: Snapshot) => void): Built {
  const records = journalOf(parse, ...bodies);
  records.forEach((record, index) => {
    record["ts"] = at(index + 1);
  });
  const derived = deriveSnapshot(records);
  expect(derived.ok).toBe(true);
  const snapshot = derived.snapshot;
  if (snapshot.outcome === null) snapshot.liveness.owner = "alive";
  edit?.(snapshot);
  return {
    snapshot,
    status: runStatusOf(snapshot, RUN_DIR),
    events: projectEvents(records, ANCHOR),
  };
}

function modelOf(built: Built, extra: Json = {}): RunModel {
  return model.deriveRunModel({
    snapshot: built.snapshot,
    status: built.status,
    runDir: RUN_DIR,
    events: built.events,
    input: INPUT,
    config: undefined,
    graph: graphOf(builtInWorkflow("build-review"), PLAN, INPUT),
    timeZone: "UTC",
    ...extra,
  });
}

const entry = (workflow: Json | null = PLAN.workflow): Json => ({
  runId: "run-1",
  runDir: RUN_DIR,
  workflow,
  status: "running",
  owner: "alive",
  openedAt: at(1),
  updatedAt: at(1),
  project: null,
});

const rows = (steps: StepNode[]) =>
  steps.map((step) => [step.name, step.participant, step.state.word, step.state.mark]);
const step = (built: RunModel, id: string): StepNode => {
  const found = built.steps.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no step ${id}`);
  return found;
};

describe("deriveRunModel: the design's repair loop", () => {
  it("orders stage visits and checks with names, participants, states and marks", () => {
    const run = modelOf(build(DESIGN_RUN));
    expect(run.steps.map((item) => item.id)).toEqual([
      "stage:build:1",
      "check:verify:1",
      "stage:review:1",
      "stage:repair:1",
      "check:verify:2",
      "stage:review:2",
    ]);
    expect(rows(run.steps)).toEqual([
      ["build", "builder", "accepted", "ok"],
      ["verify", "check", "passed", "ok"],
      ["review", "reviewer", "changes requested", "retry"],
      ["repair", "builder", "accepted", "ok"],
      ["verify 2", "check", "passed", "ok"],
      ["review 2", "reviewer", "approved", "ok"],
    ]);
    expect(run.steps.every((item) => item.kind !== "pending")).toBe(true);
  });

  it("explains the rejected review: input, attempt times, verdict, gate route and same-builder handoff", () => {
    const rejectedReview = step(modelOf(build(DESIGN_RUN)), "stage:review:1");
    expect(rejectedReview.details).toEqual([
      { label: "input", value: "checks passed on build / visit 1 (verify)" },
      { label: "attempt 1", value: "dispatched 10:00:12 → accepted 10:00:13" },
      { label: "verdict", value: "fail" },
      { label: "gate", value: "changes requested → repair", tone: "amber" },
      { label: "handoff", value: "accepted review → builder (same agent)" },
    ]);
    expect(rejectedReview.startedAt).toBe(at(13));
    expect(rejectedReview.endedAt).toBe(at(15));
    expect(rejectedReview.state).toEqual({
      word: "changes requested",
      mark: "retry",
      tone: "amber",
    });
  });

  it("keeps the earlier rejected review's artifact distinguishable from the final approval", () => {
    const run = modelOf(build(DESIGN_RUN));
    const artifacts = run.steps.flatMap((item) =>
      item.artifacts.map((ref) => [ref.id, ref.kind, ref.label, ref.relPath, ref.context]),
    );
    expect(artifacts).toEqual([
      [
        "accepted:build:1:1",
        "accepted",
        "out.md",
        "accepted/build/visit-1/attempt-1/out.md",
        "accepted build / visit 1 / attempt 1 · gate: passed → verify",
      ],
      [
        "evidence:verify:1",
        "evidence",
        "output.log",
        "checks/verify/build-v1-a1/output.log",
        "verification evidence · verify on build / visit 1 · checks passed → review",
      ],
      [
        "accepted:review:1:1",
        "accepted",
        "out.md",
        "accepted/review/visit-1/attempt-1/out.md",
        "accepted review / visit 1 / attempt 1 · verdict fail · gate: changes requested → repair",
      ],
      [
        "accepted:repair:1:1",
        "accepted",
        "out.md",
        "accepted/repair/visit-1/attempt-1/out.md",
        "accepted repair / visit 1 / attempt 1 · gate: passed → verify",
      ],
      [
        "evidence:verify:2",
        "evidence",
        "output.log",
        "checks/verify/repair-v1-a1/output.log",
        "verification evidence · verify on repair / visit 1 · checks passed → review",
      ],
      [
        "accepted:review:2:1",
        "accepted",
        "out.md",
        "accepted/review/visit-2/attempt-1/out.md",
        "accepted review / visit 2 / attempt 1 · verdict pass · gate: approved → completed",
      ],
    ]);
    const evidence = step(run, "check:verify:1").artifacts[0];
    expect(evidence).toMatchObject({
      path: `${RUN_DIR}/checks/verify/build-v1-a1/output.log`,
      stageId: "build",
      visit: 1,
      attempt: 1,
      bytes: 10,
    });
    expect(step(run, "stage:review:2").artifacts[0]?.path).toBe(
      `${RUN_DIR}/accepted/review/visit-2/attempt-1/out.md`,
    );
  });

  it("shows the repair's input, the check's command and result, and the final review's route", () => {
    const run = modelOf(build(DESIGN_RUN));
    expect(step(run, "stage:repair:1").details).toEqual([
      { label: "input", value: "accepted review / visit 1 · changes requested" },
      { label: "attempt 1", value: "dispatched 10:00:16 → accepted 10:00:17" },
      { label: "gate", value: "passed → verify", tone: "green" },
    ]);
    const verify = step(run, "check:verify:2");
    expect(verify.details).toEqual([
      { label: "command", value: "node --test" },
      { label: "result", value: "exit 0 → review", tone: "green" },
      { label: "checked", value: "repair / visit 1 / attempt 1" },
    ]);
    expect([verify.startedAt, verify.endedAt]).toEqual([at(20), at(22)]);
    expect(step(run, "stage:review:2").details).toEqual([
      { label: "input", value: "checks passed on repair / visit 1 (verify)" },
      { label: "attempt 1", value: "dispatched 10:00:23 → accepted 10:00:24" },
      { label: "verdict", value: "pass" },
      { label: "gate", value: "approved → completed", tone: "green" },
    ]);
  });

  it("reads the completed run in the header and notes, with no wait and no pending steps", () => {
    const run = modelOf(build(DESIGN_RUN));
    expect(run.header).toEqual({
      title: "Fix empty-state rendering",
      workflow: "build-review",
      state: { word: "completed", mark: "ok", tone: "green" },
      step: "review 2",
      openedAt: at(1),
      endedAt: at(27),
      attention: null,
    });
    expect(run.stepsNote).toEqual({
      word: "result: completed · approved",
      mark: "ok",
      tone: "green",
    });
    expect(run.activityNote).toEqual({
      word: "recorded outcome: completed · approved",
      mark: "ok",
      tone: "green",
    });
    expect(run.wait).toBeNull();
  });
});

describe("deriveRunModel: a running run", () => {
  it("mid-review: awaiting result, the wait, and a header that reads the run now", () => {
    const run = modelOf(build(DESIGN_RUN.slice(0, 13)));
    const current = step(run, "stage:review:1");
    expect(current.state).toEqual({ word: "awaiting result", mark: "active", tone: "cyan" });
    expect(current.details).toEqual([
      { label: "input", value: "checks passed on build / visit 1 (verify)" },
      { label: "attempt 1", value: "dispatched 10:00:12" },
      { label: "waiting", value: "no accepted result yet" },
    ]);
    expect([current.startedAt, current.endedAt]).toEqual([at(13), null]);
    expect(run.wait).toEqual({ text: "waiting for reviewer / review", since: at(13) });
    expect(run.header).toEqual({
      title: "Fix empty-state rendering",
      workflow: "build-review",
      state: { word: "running", mark: "active", tone: "cyan" },
      step: "review",
      openedAt: at(1),
      endedAt: null,
      attention: null,
    });
    expect(run.activityNote).toBeNull();
    // A passing review completes the run: repair is only its rejection route, so nothing is
    // listed as next while the review is in progress.
    expect(run.steps.filter((item) => item.kind === "pending")).toEqual([]);
    expect(run.stepsNote).toBeNull();
  });

  it("after a rejecting review the routed repair is next, then the conditional check", () => {
    const run = modelOf(build(DESIGN_RUN.slice(0, 15)));
    const pending = run.steps.filter((item) => item.kind === "pending");
    expect(
      pending.map((item) => [
        item.id,
        item.name,
        item.participant,
        item.state.word,
        item.state.tone,
      ]),
    ).toEqual([
      ["pending:repair", "repair", "builder", "next · changes requested", "dim"],
      ["pending:verify", "verify 2", "check", "pending repair", "dim"],
    ]);
    expect(pending[0]?.details).toEqual([
      { label: "", value: "routed by the review gate: changes requested → repair" },
      { label: "", value: "not started yet" },
    ]);
    expect(pending.every((item) => item.startedAt === null && item.artifacts.length === 0)).toBe(
      true,
    );
  });

  it("mid-build: pending steps follow the graph with explicit prerequisites", () => {
    const run = modelOf(build(DESIGN_RUN.slice(0, 5)));
    expect(rows(run.steps)).toEqual([
      ["build", "builder", "awaiting result", "active"],
      ["verify", "check", "pending build", "dot"],
      ["review", "reviewer", "pending verify", "dot"],
    ]);
    expect(run.steps.slice(1).map((item) => [item.id, item.kind, item.details])).toEqual([
      [
        "pending:verify",
        "pending",
        [
          { label: "", value: "conditional on the build gate passing" },
          { label: "", value: "no check has started" },
        ],
      ],
      [
        "pending:review",
        "pending",
        [
          { label: "", value: "conditional on the verify gate passing" },
          { label: "", value: "no attempt has started" },
        ],
      ],
    ]);
    expect(run.stepsNote).toEqual({
      word: "next: verify → review, if each gate passes",
      mark: "dot",
      tone: "dim",
    });
    expect(run.header.step).toBe("build");
    expect(run.wait).toEqual({ text: "waiting for builder / build", since: at(5) });
  });

  it("an open check run is its own active step and the current wait", () => {
    const run = modelOf(build(DESIGN_RUN.slice(0, 8)));
    const check = step(run, "check:verify:1");
    expect(check.state).toEqual({ word: "running", mark: "active", tone: "cyan" });
    expect(check.details).toEqual([
      { label: "command", value: "node --test" },
      { label: "checking", value: "build / visit 1" },
      { label: "waiting", value: "check running; no result recorded yet" },
    ]);
    expect(run.wait).toEqual({ text: "running checks", since: at(8) });
    expect(run.header.step).toBe("verify");
  });

  it("accepted but not yet gated reads as awaiting the gate, not approval", () => {
    const run = modelOf(build(DESIGN_RUN.slice(0, 14)));
    const current = step(run, "stage:review:1");
    expect(current.state).toEqual({
      word: "accepted · awaiting gate",
      mark: "active",
      tone: "cyan",
    });
    expect(current.details.slice(-2)).toEqual([
      { label: "verdict", value: "fail" },
      { label: "waiting", value: "gate decision on the accepted result" },
    ]);
    expect(current.artifacts.map((ref) => ref.context)).toEqual([
      "accepted review / visit 1 / attempt 1 · verdict fail · no gate decision",
    ]);
    expect(run.header.state.word).toBe("running");
    expect(run.stepsNote).toBeNull();
    expect(run.wait).toEqual({ text: "waiting for the review gate", since: at(14) });
  });
});

const BLOCKED_RUN: Json[] = [
  opened(PLAN),
  hostClaimed(),
  assigned("builder"),
  attempt("build", "builder"),
  dispatched("build", "builder"),
  blocked("builder", ["build", 1, 1]),
];

describe("deriveRunModel: attention", () => {
  it("a blocked attempt names the block and where to act; no pending steps", () => {
    const built = build(BLOCKED_RUN);
    const run = modelOf(built);
    const action = "answer the prompt in the pane of builder (builder's pane w1:builder)";
    expect(run.steps.map((item) => item.kind)).toEqual(["stage"]);
    const current = step(run, "stage:build:1");
    expect(current.state).toEqual({
      word: "blocked · blocked on input",
      mark: "alert",
      tone: "amber",
    });
    expect(current.details.slice(-2)).toEqual([
      { label: "blocked", value: "blocked on input", tone: "amber" },
      { label: "action", value: action, tone: "amber" },
    ]);
    expect(run.header.state).toEqual({ word: "blocked", mark: "alert", tone: "amber" });
    expect(run.header.attention).toEqual({
      word: `blocked: blocked on input · ${action}`,
      mark: "alert",
      tone: "amber",
    });
    expect(run.stepsNote).toEqual({ word: `action: ${action}`, mark: "alert", tone: "amber" });
    expect(run.activityNote).toEqual({
      word: `run blocked; ${action}`,
      mark: "alert",
      tone: "amber",
    });
    expect(run.wait).toBeNull();
    const row = model.runRowOf(entry(), { snapshot: built.snapshot, status: built.status }, INPUT);
    expect(row).toMatchObject({ attention: true, step: "build", state: run.header.state });
  });

  it("a lost host is an unknown outcome, not a failure", () => {
    const built = build(DESIGN_RUN.slice(0, 13), (snapshot) => {
      snapshot.liveness.owner = "lost";
    });
    const run = modelOf(built);
    expect(run.header.state).toEqual({ word: "host lost", mark: "unknown", tone: "red" });
    expect(run.header.attention).toEqual({
      word: "outcome unknown · no terminal outcome recorded",
      mark: "unknown",
      tone: "red",
    });
    const current = step(run, "stage:review:1");
    expect(current.state).toEqual({ word: "outcome unknown", mark: "unknown", tone: "red" });
    expect(current.details.at(-1)).toEqual({
      label: "waiting",
      value: "host lost · no terminal outcome recorded",
    });
    expect(run.steps.some((item) => item.kind === "pending")).toBe(false);
    expect(run.stepsNote).toEqual({
      word: "host lost · outcome unknown",
      mark: "unknown",
      tone: "red",
    });
    expect(run.activityNote).toEqual({
      word: "host lost; outcome unknown",
      mark: "unknown",
      tone: "red",
    });
    expect(run.wait).toBeNull();
    const words = [run.header.state.word, current.state.word, run.stepsNote?.word].join(" ");
    expect(words).not.toContain("failed");
    const row = model.runRowOf(entry(), { snapshot: built.snapshot, status: built.status }, INPUT);
    expect(row).toMatchObject({ attention: true, state: run.header.state });
  });
});

describe("deriveRunModel: recorded outcomes", () => {
  const running = DESIGN_RUN.slice(0, 13);
  it.each([
    [
      "exhausted",
      { type: "run.terminated", outcome: "exhausted", reason: "round_limit", limit: "maxRounds" },
      { word: "exhausted", mark: "alert", tone: "red" },
      "result: exhausted · round limit (maxRounds)",
    ],
    [
      "failed",
      { type: "run.terminated", outcome: "failed", reason: "check_failed" },
      { word: "failed", mark: "alert", tone: "red" },
      "result: failed · check failed",
    ],
    [
      "cancelled",
      terminated("cancelled"),
      { word: "cancelled", mark: "dot", tone: "dim" },
      "result: cancelled · test",
    ],
  ])("%s has its own header word and result note", (_name, end, state, note) => {
    const run = modelOf(build([...running, end]));
    expect(run.header.state).toEqual(state);
    expect(run.header.attention).toBeNull();
    expect(run.header.endedAt).toBe(at(14));
    expect(run.stepsNote?.word).toBe(note);
    expect(run.activityNote?.word).toBe(note.replace("result:", "recorded outcome:"));
    expect(run.wait).toBeNull();
    expect(run.steps.some((item) => item.kind === "pending")).toBe(false);
  });
});

describe("deriveRunModel: attempts", () => {
  it("a format repair shows its cause and the rejection that led to it", () => {
    const run = modelOf(
      build([
        opened(PLAN),
        hostClaimed(),
        assigned("builder"),
        attempt("build", "builder"),
        dispatched("build", "builder"),
        {
          ...rejected("artifact_missing", {
            runId: "run-1",
            agentId: "builder",
            stageId: "build",
            visit: 1,
            attempt: 1,
          }),
          message: "the completion artifact is missing",
        },
        attempt("build", "builder", 1, 2),
        dispatched("build", "builder", 1, 2),
      ]),
    );
    expect(step(run, "stage:build:1").details).toEqual([
      { label: "attempt 1", value: "dispatched 10:00:04 · superseded" },
      {
        label: "rejected",
        value: "artifact missing · the completion artifact is missing",
        tone: "amber",
      },
      { label: "attempt 2", value: "format repair · dispatched 10:00:07" },
      { label: "waiting", value: "no accepted result yet" },
    ]);
  });

  it("a work retry after an undelivered request shows its cause", () => {
    const run = modelOf(
      build([
        opened(PLAN),
        hostClaimed(),
        assigned("builder"),
        attempt("build", "builder"),
        dispatched("build", "builder", 1, 1, "not_delivered", "runtime_unavailable"),
        attempt("build", "builder", 1, 2),
        dispatched("build", "builder", 1, 2),
      ]),
    );
    expect(step(run, "stage:build:1").details).toEqual([
      { label: "attempt 1", value: "dispatched 10:00:04 · not delivered · superseded" },
      { label: "attempt 2", value: "work retry · dispatched 10:00:06" },
      { label: "waiting", value: "no accepted result yet" },
    ]);
  });
});

const CONFIG = {
  resolvedAt: "2026-09-14T09:59:59.000Z",
  roots: { project: { root: "/work/app" } },
  repository: "/work/app",
  workflow: { name: "build-review", source: "builtin" },
  agents: { builder: { kind: { value: "claude", source: "input" } } },
  settings: { limits: { maxRounds: { value: 3, source: "user" } } },
  files: [{ scope: "user", path: "/tmp/woof-home/.woof/config.json" }],
};

describe("deriveRunModel: config", () => {
  it("lists agents with their model, stages and recorded observation", () => {
    const run = modelOf(
      build([
        opened(MIN_PLAN),
        hostClaimed(),
        assigned("builder"),
        lifecycleChanged("builder", null, "working"),
      ]),
    );
    expect(run.config.agents).toEqual([
      {
        agentId: "builder",
        role: "builder",
        kind: "claude",
        model: null,
        stages: ["build"],
        observed: "assigned 10:00:02 · pane w1:builder · last recorded working at 10:00:03",
      },
      {
        agentId: "reviewer",
        role: "reviewer",
        kind: "claude",
        model: "opus",
        stages: ["review"],
        observed: null,
      },
    ]);
  });

  it("keeps a repairing builder's stages together", () => {
    const run = modelOf(build(DESIGN_RUN));
    expect(
      run.config.agents.map((agent) => [agent.agentId, agent.kind, agent.model, agent.stages]),
    ).toEqual([
      ["builder", "claude", "sonnet", ["build", "repair"]],
      ["reviewer", "codex", "gpt-5", ["review"]],
    ]);
  });

  it("reports a missing or unreadable saved input", () => {
    const none = modelOf(build([opened(PLAN)]));
    expect([none.config.inputProblem, none.config.inputPath]).toEqual([
      "no saved input recorded",
      null,
    ]);
    const withInput = build([
      { ...opened(PLAN), input: { path: "input.json", sha256: "a".repeat(64), bytes: 321 } },
    ]);
    const unreadable = modelOf(withInput, { input: undefined });
    expect([unreadable.config.inputProblem, unreadable.config.inputPath]).toEqual([
      "input.json could not be read",
      `${RUN_DIR}/input.json`,
    ]);
    const readable = modelOf(withInput);
    expect([readable.config.inputProblem, readable.config.input]).toEqual([null, INPUT]);
  });

  it("gives the run context: project, run, workflow, verify, limits and provenance", () => {
    const run = modelOf(build(DESIGN_RUN), { config: CONFIG });
    const context = Object.fromEntries(run.config.context.map((line) => [line.label, line.value]));
    expect(context).toMatchObject({
      project: "/work/app",
      repository: "/work/app",
      revision: `head ${"b".repeat(12)} · tree ${"c".repeat(12)} (last gate)`,
      run: "run-1",
      "run dir": RUN_DIR,
      workflow: "build-review v1 · builtin",
      verify: "verify: node --test",
      config: "resolved 2026-09-14T09:59:59.000Z · config.json",
      provenance: "workflow builtin · agents input · limits user",
      file: "user /tmp/woof-home/.woof/config.json",
    });
    expect(context["limits"]?.startsWith("3 rounds · 3 visits/stage · 2 attempts/visit · ")).toBe(
      true,
    );
    const unknown = modelOf(build(DESIGN_RUN));
    expect(unknown.config.context[0]).toEqual({ label: "project", value: "unknown" });
    expect(unknown.config.context.at(-1)).toEqual({
      label: "config",
      value: "no resolved configuration recorded",
    });
  });
});

describe("runRowOf and titleOf", () => {
  it("falls back to `<workflow> · <runId>` without a task title", () => {
    const built = build(DESIGN_RUN);
    const read = { snapshot: built.snapshot, status: built.status };
    expect(model.runRowOf(entry(), read, { anything: true })).toEqual({
      runId: "run-1",
      runDir: RUN_DIR,
      title: "build-review · run-1",
      titleIsFallback: true,
      workflow: "build-review",
      state: { word: "completed", mark: "ok", tone: "green" },
      step: "review 2",
      openedAt: at(1),
      endedAt: at(27),
      attention: false,
    });
    expect(model.runRowOf(entry(null), null, undefined)).toMatchObject({
      title: "run · run-1",
      titleIsFallback: true,
      step: null,
      attention: false,
    });
    expect(model.runRowOf(entry(), read, INPUT)).toMatchObject({
      title: "Fix empty-state rendering",
      titleIsFallback: false,
    });
  });

  it("reads task.title, else title, and replaces control characters", () => {
    expect(model.titleOf({ task: { title: "From task" }, title: "Top level" })).toBe("From task");
    expect(model.titleOf({ title: "Top level" })).toBe("Top level");
    expect(model.titleOf({ task: { title: "\u001B[31mRed\u0007 title" } })).toBe("[31mRed  title");
    expect(model.titleOf({ task: { title: "  \n " } })).toBeUndefined();
    expect(model.titleOf({ task: { title: 7 } })).toBeUndefined();
    expect(model.titleOf("a string")).toBeUndefined();
    expect(model.titleOf(undefined)).toBeUndefined();
  });
});

describe("deriveRunModel: workflow steps (composition)", () => {
  it("a step has no agent: its owner is the child run, its attempt names the child, a running step waits on its child", () => {
    const plan = {
      ...COMPOSITE_PLAN,
      workflows: [
        { stageId: "plan", workflow: "plan" },
        { stageId: "build", workflow: "build-review" },
      ],
    };
    const built = build([
      opened(plan),
      hostClaimed(),
      childOpened("plan"),
      childResult(4, "plan"),
      gate(4, "plan", 1, 1, {
        verdict: "completed",
        reason: "planned",
        next: { stageId: "build" },
      }),
      childOpened("build"),
    ]);
    const run = modelOf(built, {
      graph: graphOf(builtInWorkflow("auto-build"), plan, undefined),
    });
    const step = run.steps.find((item) => item.id === "stage:plan:1");
    expect(step?.participant).toBe("run run-1.plan.1");
    expect(step?.details.map((item) => item.value).join("\n")).toContain("child run run-1.plan.1");
    expect(step?.details.map((item) => item.value).join("\n")).not.toContain("not dispatched");
    const running = run.steps.find((item) => item.id === "stage:build:1");
    expect(running?.participant).toBe("run run-1.build.1");
    expect(running?.details).toContainEqual(
      expect.objectContaining({ label: "waiting", value: "child run run-1.build.1" }),
    );
  });
});
