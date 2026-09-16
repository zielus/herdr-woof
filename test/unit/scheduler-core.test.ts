import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";
import {
  HEX,
  REV,
  accepted,
  assigned,
  attempt,
  blocked,
  checkGate,
  dispatched,
  gate,
  journalOf,
  opened,
  reconciled,
  rejected,
  terminated,
} from "../helpers/records.js";

type Json = Record<string, unknown>;
type Parse = (line: string) => Json | string;
type Derive = (
  records: readonly Json[],
) => { ok: true; snapshot: Json } | { ok: false; message: string };
type Decide = (view: Json) => Json;

let parse: Parse;
let deriveSnapshot: Derive;
let decide: Decide;
let emptyRuntimeView: () => Json;

beforeAll(async () => {
  ({ parseRecordLine: parse } = await loadDist<{ parseRecordLine: Parse }>("journal/records.js"));
  ({ deriveSnapshot } = await loadDist<{ deriveSnapshot: Derive }>("state/snapshot.js"));
  ({ decide, emptyRuntimeView } = await loadDist<{ decide: Decide; emptyRuntimeView: () => Json }>(
    "scheduler/core.js",
  ));
});

// Journal timestamps from journalOf: record n is at T0 + (n - 1) ms.
const T0 = Date.UTC(2026, 8, 14, 10, 0, 0, 0);
const RUN_DIR = "/runs/core";
const LIMITS = {
  maxAttemptsPerVisit: 2,
  maxVisitsPerStage: 3,
  maxRounds: 2,
  runTimeoutMs: 1_000_000,
  readinessWaitMs: 1000,
  blockedWaitMs: 5000,
  deliveryTimeoutMs: 2000,
  maxFormatRepairs: 1,
};
const CORE_PLAN = {
  workflow: { name: "draft-critique", version: "1" },
  agents: [
    { agentId: "writer", role: "writer", kind: "claude", model: null },
    { agentId: "critic", role: "critic", kind: "claude", model: null },
  ],
  stages: [
    { stageId: "draft", agentId: "writer", verdicts: [] },
    { stageId: "critique", agentId: "critic", verdicts: ["accept", "revise"] },
    { stageId: "revise", agentId: "writer", verdicts: [] },
  ],
  limits: LIMITS,
  checks: ["lint"],
};

/** Transitions the synthetic definition returns; tests override them. */
const behaviour: {
  draft: () => Json;
  lint: () => Json;
  critique: () => Json;
  request: () => Json;
} = {
  draft: () => ({ decision: "pass", reason: "drafted", to: "lint" }),
  lint: () => ({ decision: "pass", reason: "lint_passed", to: "critique" }),
  critique: () => ({
    decision: "reject",
    reason: "revise_requested",
    to: "revise",
    requires: "round",
  }),
  request: () => ({ goal: "goal", instructions: "do it", inputs: [] }),
};
const seen: Json[] = [];

function agentStage(
  stageId: string,
  agentId: string,
  verdicts: string[],
  next: () => Json,
  bindsRevision = false,
): Json {
  return {
    kind: "agent",
    stageId,
    agentId,
    verdicts,
    artifactFile: `${stageId}.md`,
    onFailedStatus: "fail",
    bindsRevision,
    request: (ctx: Json) => {
      seen.push({ request: ctx });
      return behaviour.request();
    },
    next: (ctx: Json) => {
      seen.push({ next: ctx });
      return next();
    },
  };
}

const DEFINITION = {
  schemaVersion: 1,
  name: "draft-critique",
  version: "1",
  validateInput: (value: unknown) => ({ ok: true, input: value }),
  resolveAgents: () => ({}),
  resolveLimits: () => LIMITS,
  repository: () => "/repo",
  agents: [
    { agentId: "writer", role: "writer" },
    { agentId: "critic", role: "critic" },
  ],
  start: "draft",
  roundStage: "critique",
  stages: [
    agentStage("draft", "writer", [], () => behaviour.draft()),
    {
      kind: "check",
      checkId: "lint",
      command: () => ({ argv: ["node", "--check", "x.mjs"], timeoutMs: 1000 }),
      next: (ctx: Json) => {
        seen.push({ check: ctx });
        return behaviour.lint();
      },
    },
    agentStage("critique", "critic", ["accept", "revise"], () => behaviour.critique(), true),
    agentStage("revise", "writer", [], () => behaviour.draft()),
  ],
  edges: {
    draft: ["lint", "failed"],
    lint: ["critique", "revise"],
    critique: ["completed", "critique", "revise"],
    revise: ["lint"],
  },
};

function snapshotOf(bodies: Json[]): Json {
  const result = deriveSnapshot(journalOf(parse, ...bodies));
  if (!result.ok) throw new Error(result.message);
  return result.snapshot;
}

const handle = (agentId: string) => ({
  adapter: "scripted",
  runtimeName: `w-${agentId}`,
  kind: "claude",
  paneId: `w1:${agentId}`,
  paneOwned: true,
  terminalId: `term-${agentId}`,
  sessionId: null,
});

function observed(
  agentId: string,
  lifecycle: string,
  seq: number | null = 1,
  terminalId = `term-${agentId}`,
): Json {
  const status = {
    ready: "idle",
    working: "working",
    blocked: "blocked",
    gone: null,
    unknown: "unknown",
  }[lifecycle];
  return {
    runtimeName: `w-${agentId}`,
    paneId: `w1:${agentId}`,
    lifecycle,
    runtimeStatus: status,
    sessionId: null,
    order: {
      terminalId: lifecycle === "gone" ? null : terminalId,
      stateChangeSeq: seq,
      revision: null,
    },
    observedAt: new Date(T0).toISOString(),
  };
}

function runtime(agentId: string, overrides: Json = {}): Json {
  return { ...emptyRuntimeView(), handle: handle(agentId), startedAt: T0, ...overrides };
}

const readyView = (agentId: string, overrides: Json = {}) =>
  runtime(agentId, { last: observed(agentId, "ready"), readyStreak: 2, ...overrides });

function act(bodies: Json[], options: Json = {}): Json {
  return decide({
    snapshot: snapshotOf(bodies),
    definition: DEFINITION,
    input: { topic: "x" },
    runDir: RUN_DIR,
    agents: {},
    evidence: null,
    now: T0 + 100,
    aborted: false,
    ...options,
  });
}

const writerAssigned = { ...assigned("writer", "w1:writer"), terminalId: "term-writer" };
const criticAssigned = { ...assigned("critic", "w1:critic"), terminalId: "term-critic" };
const draftAttempt = (attemptNo = 1, visit = 1) => attempt("draft", "writer", visit, attemptNo, []);
/** Records through an accepted draft (acceptance at seq 5). */
const drafted = () => [
  opened(CORE_PLAN),
  writerAssigned,
  draftAttempt(),
  { ...dispatched("draft", "writer"), revision: REV },
  accepted(5, "draft", "writer", null),
];
/** …then draft gate (6) and lint gate (7) into critique, critic assigned (8), critique attempt (9), dispatch (10). */
const critiquing = () => [
  ...drafted(),
  gate(5, "draft", 1, 1, { next: { stageId: "lint" } }),
  checkGate(5, "lint", "draft", 1, 1, { next: { stageId: "critique" } }),
  criticAssigned,
  attempt("critique", "critic", 1, 1, ["accept", "revise"]),
  { ...dispatched("critique", "critic"), revision: REV },
];

describe("decide: starting, readiness and dispatch", () => {
  it("starts the start stage's agent, then waits for a settled ready before dispatching", () => {
    expect(act([opened(CORE_PLAN)])).toEqual({ type: "start_agent", agentId: "writer" });
    const base = [opened(CORE_PLAN), writerAssigned];
    expect(act(base, { agents: { writer: runtime("writer") } })).toEqual({
      type: "wait",
      reason: "awaiting_ready",
      observe: "writer",
    });
    // One ready tick is not settled.
    expect(
      act(base, {
        agents: {
          writer: runtime("writer", { last: observed("writer", "ready"), readyStreak: 1 }),
        },
      }),
    ).toMatchObject({ type: "wait", reason: "awaiting_ready" });
    seen.length = 0;
    expect(act(base, { agents: { writer: readyView("writer") } })).toEqual({
      type: "dispatch",
      agentId: "writer",
      stageId: "draft",
      visit: 1,
      attempt: 1,
      cause: "initial",
      round: 0,
      request: { goal: "goal", instructions: "do it", inputs: [] },
      previous: null,
    });
    expect(seen[0]).toMatchObject({
      request: { stageId: "draft", visit: 1, attempt: 1, round: 0, enteredBy: null },
    });
  });

  it("fails the run on a malformed request() return; null is only a format repair", () => {
    const base = [opened(CORE_PLAN), writerAssigned];
    const agents = { writer: readyView("writer") };
    const original = behaviour.request;
    try {
      for (const bad of [
        null,
        undefined,
        {},
        { goal: "g", instructions: 1, inputs: [] },
        { goal: "g", instructions: "i", inputs: [null] },
        {
          goal: "g",
          instructions: "i",
          inputs: [{ label: "x", from: { stageId: "a", checkId: "b" } }],
        },
        { goal: "g", instructions: "i", inputs: [], task: { title: "t" } },
      ]) {
        behaviour.request = () => bad as unknown as Json;
        expect(act(base, { agents }), JSON.stringify(bad)).toMatchObject({
          type: "terminate",
          outcome: "failed",
          reason: expect.stringMatching(/^definition_contract_violated: draft: request\(\) /),
        });
      }
    } finally {
      // Restored even when an assertion fails, so later tests keep the valid request.
      behaviour.request = original;
    }
  });

  it("fails the run as a contract violation when request() returns a task context that is not JSON", () => {
    const base = [opened(CORE_PLAN), writerAssigned];
    const agents = { writer: readyView("writer") };
    const original = behaviour.request;
    const cyclic: Json = {};
    cyclic["self"] = cyclic;
    try {
      for (const context of [{ big: 10n }, { run: () => 1 }, cyclic]) {
        behaviour.request = () => ({
          goal: "g",
          instructions: "i",
          inputs: [],
          task: { title: "t", description: "d", acceptanceCriteria: [], context },
        });
        expect(act(base, { agents })).toMatchObject({
          type: "terminate",
          outcome: "failed",
          reason: expect.stringMatching(
            /^definition_contract_violated: draft: request\(\) task\.context/,
          ),
        });
      }
    } finally {
      behaviour.request = original;
    }
  });

  it("exhausts readinessWaitMs at its boundary", () => {
    const base = [opened(CORE_PLAN), writerAssigned];
    const agents = { writer: runtime("writer", { startedAt: T0 }) };
    expect(act(base, { agents, now: T0 + 999 })).toMatchObject({ type: "wait" });
    expect(act(base, { agents, now: T0 + 1000 })).toMatchObject({
      type: "terminate",
      outcome: "exhausted",
      limit: "readinessWaitMs",
    });
    // A later wait for readiness counts from when that wait began.
    const later = { writer: runtime("writer", { startedAt: T0, awaitingReadySince: T0 + 5000 }) };
    expect(act(base, { agents: later, now: T0 + 5999 })).toMatchObject({ type: "wait" });
    expect(act(base, { agents: later, now: T0 + 6000 })).toMatchObject({
      limit: "readinessWaitMs",
    });
  });

  it("fails on an agent that is gone or replaced", () => {
    const base = [opened(CORE_PLAN), writerAssigned];
    expect(
      act(base, { agents: { writer: runtime("writer", { last: observed("writer", "gone") }) } }),
    ).toMatchObject({
      type: "terminate",
      outcome: "failed",
      reason: expect.stringMatching(/^agent_gone/),
    });
    expect(act(base, { agents: { writer: runtime("writer", { replaced: true }) } })).toMatchObject({
      outcome: "failed",
      reason: expect.stringMatching(/^agent_replaced/),
    });
    expect(
      act(base, {
        agents: {
          writer: runtime("writer", {
            last: observed("writer", "ready", 1, "term-other"),
            readyStreak: 2,
          }),
        },
      }),
    ).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/^agent_replaced/) });
  });
});

describe("decide: waiting for results, format repair and work retry", () => {
  const started = () => [
    opened(CORE_PLAN),
    writerAssigned,
    draftAttempt(),
    dispatched("draft", "writer"),
  ];

  it("waits while working and repairs the format only after a settled ready without acceptance", () => {
    expect(
      act(started(), {
        agents: { writer: runtime("writer", { last: observed("writer", "working") }) },
      }),
    ).toEqual({
      type: "wait",
      reason: "awaiting_result",
      observe: "writer",
    });
    expect(
      act(started(), {
        agents: {
          writer: runtime("writer", { last: observed("writer", "ready"), readyStreak: 1 }),
        },
      }),
    ).toMatchObject({ type: "wait", reason: "awaiting_result" });
    const withRejection = [
      ...started(),
      {
        ...rejected("artifact_hash_mismatch", {
          runId: "run-1",
          agentId: "writer",
          stageId: "draft",
          visit: 1,
          attempt: 1,
        }),
        message: "sha differs",
      },
    ];
    expect(act(withRejection, { agents: { writer: readyView("writer") } })).toEqual({
      type: "dispatch",
      agentId: "writer",
      stageId: "draft",
      visit: 1,
      attempt: 2,
      cause: "format_repair",
      round: 0,
      request: null,
      previous: {
        attempt: 1,
        rejections: [{ reason: "artifact_hash_mismatch", message: "sha differs" }],
      },
    });
  });

  it("bounds format repairs by maxFormatRepairs", () => {
    const second = [...started(), draftAttempt(2), dispatched("draft", "writer", 1, 2)];
    expect(act(second, { agents: { writer: readyView("writer") } })).toMatchObject({
      type: "terminate",
      outcome: "exhausted",
      limit: "maxFormatRepairs",
    });
    const snapshotLimits = { ...CORE_PLAN, limits: { ...LIMITS, maxFormatRepairs: 2 } };
    expect(
      act([opened(snapshotLimits), ...second.slice(1)], {
        agents: { writer: readyView("writer") },
      }),
    ).toMatchObject({ type: "dispatch", attempt: 3, cause: "format_repair" });
    const none = { ...CORE_PLAN, limits: { ...LIMITS, maxFormatRepairs: 0 } };
    expect(
      act([opened(none), ...started().slice(1)], { agents: { writer: readyView("writer") } }),
    ).toMatchObject({
      limit: "maxFormatRepairs",
    });
  });

  it("retries undelivered work in a new attempt up to maxAttemptsPerVisit", () => {
    const busy = [
      opened(CORE_PLAN),
      writerAssigned,
      draftAttempt(),
      dispatched("draft", "writer", 1, 1, "not_delivered", "agent_busy"),
    ];
    expect(act(busy, { agents: { writer: readyView("writer") } })).toMatchObject({
      type: "dispatch",
      attempt: 2,
      cause: "work_retry",
      request: { goal: "goal" },
      previous: null,
    });
    expect(
      act(busy, { agents: { writer: runtime("writer", { last: observed("writer", "working") }) } }),
    ).toMatchObject({
      type: "wait",
      reason: "awaiting_ready",
    });
    const twice = [
      ...busy,
      draftAttempt(2),
      dispatched("draft", "writer", 1, 2, "not_delivered", "agent_busy"),
    ];
    expect(act(twice, { agents: { writer: readyView("writer") } })).toMatchObject({
      outcome: "exhausted",
      limit: "maxAttemptsPerVisit",
    });
    // Format repairs do not use the work-retry budget.
    const repaired = [
      ...started(),
      draftAttempt(2),
      dispatched("draft", "writer", 1, 2, "not_delivered", "agent_busy"),
    ];
    expect(act(repaired, { agents: { writer: readyView("writer") } })).toMatchObject({
      type: "dispatch",
      attempt: 3,
      cause: "work_retry",
    });
  });

  it("retries a failed precondition read as work, bounded by maxAttemptsPerVisit (F-003)", () => {
    const precondition = [
      opened(CORE_PLAN),
      writerAssigned,
      draftAttempt(),
      dispatched("draft", "writer", 1, 1, "not_delivered", "precondition_failed"),
    ];
    expect(act(precondition, { agents: { writer: readyView("writer") } })).toMatchObject({
      type: "dispatch",
      attempt: 2,
      cause: "work_retry",
    });
    const twice = [
      ...precondition,
      draftAttempt(2),
      dispatched("draft", "writer", 1, 2, "not_delivered", "precondition_failed"),
    ];
    expect(act(twice, { agents: { writer: readyView("writer") } })).toMatchObject({
      outcome: "exhausted",
      limit: "maxAttemptsPerVisit",
    });
  });

  it("fails when the agent was not found or the runtime was unavailable at dispatch", () => {
    const gone = [
      opened(CORE_PLAN),
      writerAssigned,
      draftAttempt(),
      dispatched("draft", "writer", 1, 1, "not_delivered", "not_found"),
    ];
    expect(act(gone, { agents: { writer: readyView("writer") } })).toMatchObject({
      outcome: "failed",
      reason: expect.stringMatching(/^agent_gone/),
    });
    const down = [
      opened(CORE_PLAN),
      writerAssigned,
      draftAttempt(),
      dispatched("draft", "writer", 1, 1, "not_delivered", "runtime_unavailable"),
    ];
    expect(act(down, { agents: { writer: readyView("writer") } })).toMatchObject({
      outcome: "failed",
      reason: expect.stringMatching(/^runtime_unavailable/),
    });
  });

  it("ends the run when a stage reports status failed", () => {
    const failed = [
      opened(CORE_PLAN),
      writerAssigned,
      draftAttempt(),
      dispatched("draft", "writer"),
      { ...accepted(5, "draft", "writer", null), status: "failed" },
    ];
    expect(act(failed, { agents: { writer: readyView("writer") } })).toEqual({
      type: "terminate",
      outcome: "failed",
      reason: "stage draft reported status failed (draft visit 1 attempt 1)",
    });
  });
});

describe("decide: gates", () => {
  it("computes the revision for an acceptance, then records the definition's transition", () => {
    const agents = { writer: readyView("writer") };
    expect(act(drafted(), { agents })).toEqual({
      type: "compute_revision",
      gate: "draft",
      acceptedSeq: 5,
      subject: { stageId: "draft", visit: 1, attempt: 1 },
    });
    seen.length = 0;
    const evidence = { gate: "draft", acceptedSeq: 5, revision: REV };
    expect(act(drafted(), { agents, evidence })).toEqual({
      type: "record_gate",
      gate: {
        gate: "draft",
        kind: "stage",
        subject: {
          stageId: "draft",
          visit: 1,
          attempt: 1,
          acceptedSeq: 5,
          receiptId: `rcpt-5-${HEX.slice(0, 12)}`,
        },
        revision: REV,
        verdict: null,
        decision: "pass",
        reason: "drafted",
        round: 0,
        next: { stageId: "lint" },
      },
      exhausted: null,
    });
    expect(seen[0]).toMatchObject({
      next: {
        accepted: {
          stageId: "draft",
          acceptedPath: `${RUN_DIR}/accepted/draft/visit-1/attempt-1/out.md`,
          status: "completed",
          verdict: null,
        },
        revision: { reviewed: null, current: REV },
      },
    });
    // Evidence for another acceptance is ignored.
    expect(act(drafted(), { agents, evidence: { ...evidence, acceptedSeq: 4 } })).toMatchObject({
      type: "compute_revision",
    });
  });

  it("runs a check on the gate's subject and records its result as a check gate", () => {
    const afterDraftGate = [...drafted(), gate(5, "draft", 1, 1, { next: { stageId: "lint" } })];
    expect(act(afterDraftGate)).toEqual({
      type: "run_check",
      gate: "lint",
      subject: {
        stageId: "draft",
        visit: 1,
        attempt: 1,
        acceptedSeq: 5,
        receiptId: `rcpt-5-${HEX.slice(0, 12)}`,
      },
      argv: ["node", "--check", "x.mjs"],
      timeoutMs: 1000,
    });
    seen.length = 0;
    const evidence = {
      gate: "lint",
      acceptedSeq: 5,
      revision: REV,
      check: {
        argv: ["node", "--check", "x.mjs"],
        exitCode: 1,
        signal: null,
        timedOut: false,
        evidence: { path: "checks/lint/draft-v1-a1/output.log", sha256: HEX, bytes: 3 },
      },
    };
    behaviour.lint = () => ({ decision: "reject", reason: "lint_failed", to: "revise" });
    expect(act(afterDraftGate, { evidence })).toMatchObject({
      type: "record_gate",
      gate: {
        gate: "lint",
        kind: "check",
        decision: "reject",
        reason: "lint_failed",
        next: { stageId: "revise" },
        check: {
          command: ["node", "--check", "x.mjs"],
          exitCode: 1,
          evidence: { path: "checks/lint/draft-v1-a1/output.log" },
        },
      },
      exhausted: null,
    });
    expect(seen[0]).toMatchObject({
      check: {
        check: { exitCode: 1, evidence: { path: `${RUN_DIR}/checks/lint/draft-v1-a1/output.log` } },
      },
    });
    behaviour.lint = () => ({ decision: "pass", reason: "lint_passed", to: "critique" });
  });

  it("gives a revision-binding stage the dispatched revision and pre-checks maxRounds on requires round", () => {
    const reviewed = [...critiquing(), accepted(11, "critique", "critic", "revise")];
    const evidence = {
      gate: "critique",
      acceptedSeq: 11,
      revision: { head: null, tree: "d".repeat(40) },
    };
    seen.length = 0;
    // One round used of two: the repair may start.
    expect(act(reviewed, { evidence })).toMatchObject({
      type: "record_gate",
      gate: {
        kind: "stage",
        verdict: "revise",
        reviewed: REV,
        round: 1,
        next: { stageId: "revise" },
      },
      exhausted: null,
    });
    expect(seen[0]).toMatchObject({
      next: { revision: { reviewed: REV, current: { tree: "d".repeat(40) } } },
    });
    const oneRound = { ...CORE_PLAN, limits: { ...LIMITS, maxRounds: 1 } };
    expect(act([opened(oneRound), ...reviewed.slice(1)], { evidence })).toMatchObject({
      type: "record_gate",
      gate: { next: { stageId: "revise" } },
      exhausted: "maxRounds",
    });
  });

  it("records a revision-bound completion only on the reviewed tree of the latest work gate", () => {
    const original = behaviour.critique;
    behaviour.critique = () => ({
      decision: "pass",
      reason: "accepted_by_critic",
      outcome: "completed",
    });
    const reviewed = [...critiquing(), accepted(11, "critique", "critic", "accept")];
    // The current tree differs from the reviewed one: the engine rejects instead of completing.
    const moved = {
      gate: "critique",
      acceptedSeq: 11,
      revision: { head: null, tree: "d".repeat(40) },
    };
    expect(act(reviewed, { evidence: moved })).toMatchObject({
      type: "record_gate",
      gate: {
        decision: "reject",
        reason: "revision_moved",
        next: { stageId: "critique" },
        reviewed: REV,
        revision: { tree: "d".repeat(40) },
      },
    });
    // Reviewed, current and work-gate trees agree: the definition's completion is recorded.
    expect(
      act(reviewed, { evidence: { gate: "critique", acceptedSeq: 11, revision: REV } }),
    ).toMatchObject({
      type: "record_gate",
      gate: { decision: "pass", next: { outcome: "completed" } },
    });
    behaviour.critique = original;
  });

  it("terminates with the outcome of a gate that ends the run", () => {
    const done = [
      ...critiquing(),
      accepted(11, "critique", "critic", "accept"),
      gate(11, "critique", 1, 1, {
        verdict: "accept",
        reason: "accepted_by_critic",
        round: 1,
        reviewed: REV,
        next: { outcome: "completed" },
      }),
    ];
    expect(act(done)).toEqual({
      type: "terminate",
      outcome: "completed",
      reason: "accepted_by_critic",
    });
  });

  it("fails on a transition outside the edges, a contract violation or a throwing definition", () => {
    const evidence = { gate: "draft", acceptedSeq: 5, revision: REV };
    behaviour.draft = () => ({ decision: "pass", reason: "x", to: "critique" });
    expect(act(drafted(), { evidence })).toMatchObject({
      outcome: "failed",
      reason: expect.stringMatching(/^transition_undeclared/),
    });
    behaviour.draft = () => ({ decision: "reject", reason: "x", outcome: "completed" });
    expect(act(drafted(), { evidence })).toMatchObject({
      outcome: "failed",
      reason: expect.stringMatching(/^definition_contract_violated/),
    });
    behaviour.draft = () => {
      throw new Error("boom");
    };
    expect(act(drafted(), { evidence })).toMatchObject({
      outcome: "failed",
      reason: "definition_threw: draft: boom",
    });
    behaviour.draft = () => ({ decision: "pass", reason: "drafted", to: "lint" });
  });
});

describe("decide: visits and rounds", () => {
  it("opens a round-stage visit with the next round number and bounds rounds and visits", () => {
    const toCritique = [
      ...drafted(),
      gate(5, "draft", 1, 1, { next: { stageId: "lint" } }),
      checkGate(5, "lint", "draft", 1, 1, { next: { stageId: "critique" } }),
    ];
    expect(act(toCritique)).toEqual({ type: "start_agent", agentId: "critic" });
    expect(
      act([...toCritique, criticAssigned], { agents: { critic: readyView("critic") } }),
    ).toMatchObject({
      type: "dispatch",
      stageId: "critique",
      visit: 1,
      round: 1,
    });
    // Critique moved on to itself after two visits: a third round is refused before opening it.
    const twoRounds = [
      ...critiquing(),
      accepted(11, "critique", "critic", "accept"),
      gate(11, "critique", 1, 1, {
        verdict: "accept",
        round: 1,
        reviewed: REV,
        next: { stageId: "critique" },
      }),
      attempt("critique", "critic", 2, 1, ["accept", "revise"]),
      dispatched("critique", "critic", 2, 1),
      accepted(15, "critique", "critic", "accept", 2, 1),
      gate(15, "critique", 2, 1, {
        verdict: "accept",
        round: 2,
        reviewed: REV,
        next: { stageId: "critique" },
      }),
    ];
    expect(act(twoRounds, { agents: { critic: readyView("critic") } })).toMatchObject({
      outcome: "exhausted",
      limit: "maxRounds",
    });
    const oneVisit = { ...CORE_PLAN, limits: { ...LIMITS, maxVisitsPerStage: 1, maxRounds: 5 } };
    expect(
      act([opened(oneVisit), ...twoRounds.slice(1, 12)], {
        agents: { critic: readyView("critic") },
      }),
    ).toMatchObject({
      outcome: "exhausted",
      limit: "maxVisitsPerStage",
    });
  });
});

describe("decide: blocking", () => {
  const base = () => [
    opened(CORE_PLAN),
    writerAssigned,
    draftAttempt(),
    dispatched("draft", "writer"),
  ];

  it("records an observed block with the pane and cancel command", () => {
    const action = act(base(), {
      agents: { writer: runtime("writer", { last: observed("writer", "blocked", 4) }) },
    });
    expect(action).toMatchObject({
      type: "block",
      agentId: "writer",
      reason: "blocked_on_input",
      observed: { runtimeStatus: "blocked", terminalId: "term-writer", stateChangeSeq: 4 },
      attempt: { stageId: "draft", visit: 1, attempt: 1 },
    });
    expect(action["requiredAction"]).toContain("pane w1:writer");
    expect(action["requiredAction"]).toContain(`woof run cancel ${RUN_DIR}`);
  });

  it("unblocks on an observed change and exhausts blockedWaitMs at its boundary", () => {
    const records = [...base(), blocked("writer", ["draft", 1, 1])]; // blocked at T0 + 4 ms
    const stillBlocked = { writer: runtime("writer", { last: observed("writer", "blocked") }) };
    expect(act(records, { agents: stillBlocked, now: T0 + 4 + 4999 })).toEqual({
      type: "wait",
      reason: "blocked",
      observe: "writer",
    });
    expect(act(records, { agents: stillBlocked, now: T0 + 4 + 5000 })).toMatchObject({
      outcome: "exhausted",
      limit: "blockedWaitMs",
    });
    expect(
      act(records, {
        agents: { writer: runtime("writer", { last: observed("writer", "working", 5) }) },
      }),
    ).toEqual({
      type: "unblock",
      agentId: "writer",
      observed: { runtimeStatus: "working", terminalId: "term-writer", stateChangeSeq: 5 },
    });
  });
});

describe("decide: ambiguous delivery", () => {
  // Ambiguous dispatch at seq 4, T0 + 3 ms.
  const ambiguous = () => [
    opened(CORE_PLAN),
    writerAssigned,
    draftAttempt(),
    dispatched("draft", "writer", 1, 1, "ambiguous", "stalled"),
  ];
  const reconcile = {
    type: "reconcile",
    agentId: "writer",
    stageId: "draft",
    visit: 1,
    attempt: 1,
    dispatchSeq: 4,
  };

  it("reconciles on a recorded submission or observed activity, never by resending", () => {
    const idle = {
      writer: runtime("writer", { last: observed("writer", "ready"), readyStreak: 5 }),
    };
    expect(act([...ambiguous(), accepted(5, "draft", "writer", null)], { agents: idle })).toEqual({
      ...reconcile,
      resolution: "delivered",
      evidence: "submission_recorded",
    });
    expect(
      act(
        [
          ...ambiguous(),
          rejected("artifact_missing", {
            runId: "run-1",
            agentId: "writer",
            stageId: "draft",
            visit: 1,
            attempt: 1,
          }),
        ],
        { agents: idle },
      ),
    ).toMatchObject({ evidence: "submission_recorded" });
    expect(
      act(ambiguous(), { agents: { writer: runtime("writer", { activitySinceDispatch: true }) } }),
    ).toEqual({
      ...reconcile,
      resolution: "delivered",
      evidence: "observed_activity",
    });
    // Only ready, before the deadline: wait (no dispatch, no format repair).
    expect(act(ambiguous(), { agents: idle, now: T0 + 3 + 1999 })).toEqual({
      type: "wait",
      reason: "delivery_unconfirmed",
      observe: "writer",
    });
    expect(act(ambiguous(), { agents: idle, now: T0 + 3 + 2000 })).toEqual({
      ...reconcile,
      resolution: "abandoned",
      evidence: "no_evidence_before_deadline",
    });
  });

  it("exhausts deliveryTimeoutMs after an abandoned reconciliation and continues after a delivered one", () => {
    const idle = { writer: readyView("writer") };
    expect(
      act(
        [
          ...ambiguous(),
          reconciled(4, "draft", "writer", 1, 1, "abandoned", "no_evidence_before_deadline"),
        ],
        { agents: idle },
      ),
    ).toMatchObject({ outcome: "exhausted", limit: "deliveryTimeoutMs" });
    expect(act([...ambiguous(), reconciled(4, "draft", "writer")], { agents: idle })).toMatchObject(
      {
        type: "dispatch",
        attempt: 2,
        cause: "format_repair",
      },
    );
  });
});

describe("decide: precedence", () => {
  it("settles a terminated run, then honours abort, then the run timeout", () => {
    expect(act([opened(CORE_PLAN), terminated("cancelled")], { aborted: true })).toEqual({
      type: "settle",
    });
    expect(act([opened(CORE_PLAN)], { aborted: true, now: T0 + 10_000_000 })).toEqual({
      type: "terminate",
      outcome: "cancelled",
      reason: "cancel requested",
    });
    expect(act([opened(CORE_PLAN)], { now: T0 + 999_999 })).toMatchObject({ type: "start_agent" });
    expect(act([opened(CORE_PLAN)], { now: T0 + 1_000_000 })).toMatchObject({
      outcome: "exhausted",
      limit: "runTimeoutMs",
    });
    expect(act([opened(null)])).toMatchObject({
      outcome: "failed",
      reason: expect.stringMatching(/^engine_invariant/),
    });
  });
});
