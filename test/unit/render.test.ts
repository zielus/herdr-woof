import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";
import {
  accepted,
  assigned,
  attempt,
  blocked,
  checkGate,
  dispatched,
  gate,
  journalOf,
  opened,
  rejected,
  REV,
} from "../helpers/records.js";

// The human run view behind woof watch (pure): opening block, history rows, summary.
type Json = Record<string, unknown>;
interface Event {
  seq: number;
  ts: string;
  type: string;
  subject: Json;
  data: unknown;
}
interface Renderer {
  opening(): string[];
  row(event: Event): string[];
  summary(end: { status: Json; result: Json | null; snapshot: Json }): string[];
  blocked(status: Json): string[];
  observerStopped(reason: string): string;
}
interface Graph {
  start: string;
  roundStage: string | null;
  nodes: Array<{ id: string; kind: string; bindsRevision: boolean; command: string | null }>;
  edges: Record<string, string[]>;
}
interface RenderModule {
  createRunRenderer(input: {
    snapshot: Json;
    status: Json;
    input: unknown;
    repository?: { path: string; branch: string | null } | null;
    graph?: Graph | null;
    options: Json;
  }): Renderer;
}

let render: RenderModule;
let parse: (line: string) => Json | string;
let projectEvents: (records: Json[], anchor: string) => Event[];
let deriveSnapshot: (records: Json[]) => { ok: boolean; snapshot: Json & { outcome: Json | null } };
let runStatusOf: (snapshot: Json, runDir: string) => Json;
let deriveRunResult: (snapshot: Json, options: { runDir: string }) => Json;
let graphOf: (definition: unknown, plan: Json, input: unknown) => Graph | null;
let builtInWorkflow: (name: string) => unknown;

const ANCHOR = "0123456789ab";
const RUN_DIR = "/tmp/woof-home/runs/run-1";
// oxlint-disable-next-line no-control-regex
const SGR = /\u001B\[[0-9;]*m/g;

const PLAN = {
  workflow: { name: "build-review", version: "1" },
  agents: [
    { agentId: "builder", role: "builder", kind: "claude", model: "sonnet" },
    { agentId: "reviewer", role: "reviewer", kind: "claude", model: "sonnet" },
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

const GRAPH: Graph = {
  start: "build",
  roundStage: "review",
  nodes: [
    { id: "build", kind: "agent", bindsRevision: false, command: null },
    { id: "verify", kind: "check", bindsRevision: false, command: "bun test" },
    { id: "review", kind: "agent", bindsRevision: true, command: null },
    { id: "repair", kind: "agent", bindsRevision: false, command: null },
  ],
  edges: {
    build: ["verify", "review"],
    verify: ["review", "repair"],
    review: ["completed", "review", "repair"],
    repair: ["verify", "review"],
  },
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

/** The design's example: build → verify → review (changes) → repair → verify → review (approved). */
const DESIGN_RUN: Json[] = [
  opened(PLAN),
  assigned("builder"),
  attempt("build", "builder"),
  dispatched("build", "builder"),
  accepted(5, "build", "builder", null),
  gate(5, "build", 1, 1, { next: { stageId: "verify" } }),
  checkGate(5, "verify", "build"),
  assigned("reviewer"),
  review(1),
  dispatched("review", "reviewer"),
  accepted(11, "review", "reviewer", "fail"),
  reviewGate(11, 1, {
    decision: "reject",
    reason: "changes_requested",
    round: 1,
    next: { stageId: "repair" },
    verdict: "fail",
  }),
  attempt("repair", "builder"),
  dispatched("repair", "builder"),
  accepted(15, "repair", "builder", null),
  gate(15, "repair", 1, 1, { round: 1, next: { stageId: "verify" } }),
  checkGate(15, "verify", "repair", 1, 1, { round: 1 }),
  review(2),
  dispatched("review", "reviewer", 2),
  accepted(20, "review", "reviewer", "pass", 2),
  reviewGate(20, 2, {
    decision: "pass",
    reason: "approved",
    round: 2,
    next: { outcome: "completed" },
    verdict: "pass",
  }),
  { type: "run.terminated", outcome: "completed", reason: "approved" },
];

const DESIGN_ROWS = [
  "10:00:00 · run              Started",
  "10:00:00 + builder          Agent started · claude / sonnet",
  "10:00:00 → builder  build   Task dispatched",
  "10:00:00 ✓ builder  build   Completion report accepted",
  "10:00:00 ✓ gate     build   Passed → verify",
  "10:00:00 ✓ gate     verify  Checks passed → review",
  "",
  "10:00:00 + reviewer         Agent started · claude / sonnet",
  "10:00:00 → reviewer review  Task dispatched",
  "10:00:00 ↓ reviewer review  Review received · changes requested",
  "10:00:00 ↻ gate     review  Changes requested → repair",
  "",
  "10:00:00 → builder  repair  Task dispatched · same agent",
  "10:00:00 ✓ builder  repair  Completion report accepted",
  "10:00:00 ✓ gate     repair  Passed → verify",
  "10:00:00 ✓ gate     verify  Checks passed → review",
  "",
  "10:00:00 → reviewer review  Task dispatched · visit 2",
  "10:00:00 ↓ reviewer review  Review received · approval recommended",
  "10:00:00 ✓ gate     review  Approved → completed",
];

beforeAll(async () => {
  render = await loadDist<RenderModule>("observe/render.js");
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
  ({ deriveRunResult } = await loadDist<{ deriveRunResult: typeof deriveRunResult }>(
    "state/result.js",
  ));
  ({ graphOf } = await loadDist<{ graphOf: typeof graphOf }>("inspect/workflow-graph.js"));
  ({ builtInWorkflow } = await loadDist<{ builtInWorkflow: typeof builtInWorkflow }>(
    "workflows/catalog.js",
  ));
});

interface Built {
  records: Json[];
  events: Event[];
  snapshot: Json & { outcome: Json | null };
  status: Json;
  result: Json | null;
}

/** A journal from `bodies`, its events and the snapshot/status/result derived from all of it. */
function build(bodies: Json[], upTo = bodies.length): Built {
  const records = journalOf(parse, ...bodies);
  const derived = deriveSnapshot(records.slice(0, upTo));
  expect(derived.ok).toBe(true);
  const { snapshot } = derived;
  return {
    records,
    events: projectEvents(records, ANCHOR),
    snapshot,
    status: runStatusOf(snapshot, RUN_DIR),
    result: snapshot.outcome === null ? null : deriveRunResult(snapshot, { runDir: RUN_DIR }),
  };
}

function rendererFor(built: Built, options: Json = {}, extra: Json = {}): Renderer {
  return render.createRunRenderer({
    snapshot: built.snapshot,
    status: built.status,
    input: INPUT,
    repository: { path: "/tmp/woof-home/fixture-repo", branch: "master" },
    graph: GRAPH,
    ...extra,
    options: {
      color: false,
      ascii: false,
      timeZone: "UTC",
      width: 80,
      home: "/tmp/woof-home",
      ...options,
    },
  });
}

function rowsOf(renderer: Renderer, events: Event[]): string[] {
  return events.flatMap((event) => renderer.row(event));
}

describe("createRunRenderer: opening block", () => {
  it("prints context, roster, the stage map with gates and repair routes, limits and the input summary", () => {
    const built = build(DESIGN_RUN, 1);
    expect(rendererFor(built).opening()).toEqual([
      "woof / build-review  fixture-repo · master",
      "run run-1 · workflow v1",
      "dir ~/runs/run-1",
      "",
      "AGENTS",
      "builder    claude   sonnet   build, repair",
      "reviewer   claude   sonnet   review",
      "",
      "STEPS & GATES",
      "build → verify → review → completed",
      "        reject ↘ repair → verify",
      "                 reject ↘ repair → verify → review",
      "verify: bun test · review: verdict + matching revision",
      "limits: 3 review rounds · 2 attempts/visit · 3 visits/stage · 2h run",
      "",
      "INPUT",
      "Fix empty-state rendering",
      "1 acceptance criterion · full input: input.json",
      "",
      "─".repeat(80),
    ]);
  });

  it("omits the branch when unknown, says `provider default` for a null model and shows a role that differs from the name", () => {
    const plan = {
      ...PLAN,
      agents: [
        { agentId: "worker", role: "writer", kind: "codex", model: null },
        { agentId: "reviewer", role: "reviewer", kind: "claude", model: "opus" },
      ],
      stages: [
        { stageId: "build", agentId: "worker", verdicts: [] },
        { stageId: "review", agentId: "reviewer", verdicts: ["pass", "fail"] },
        { stageId: "repair", agentId: "worker", verdicts: [] },
      ],
    };
    const lines = rendererFor(
      build([opened(plan)]),
      {},
      {
        repository: { path: "/srv/repo/", branch: null },
      },
    ).opening();
    expect(lines[0]).toBe("woof / build-review  repo");
    expect(lines.slice(4, 7)).toEqual([
      "AGENTS",
      "worker     codex    provider default   build, repair   role writer",
      "reviewer   claude   opus               review",
    ]);
  });

  it("without a graph lists the plan's stages and checks instead of drawing routes it cannot know", () => {
    const lines = rendererFor(build([opened(PLAN)]), {}, { graph: null }).opening();
    expect(lines.slice(8, 11)).toEqual([
      "STEPS & GATES",
      "stages build, review, repair · checks verify",
      "limits: 3 rounds · 2 attempts/visit · 3 visits/stage · 2h run",
    ]);
    // A plan-less run has no roster, map or limits to show and says so.
    const bare = rendererFor(
      build([opened(null)]),
      {},
      { graph: null, repository: null },
    ).opening();
    expect(bare.slice(0, 2)).toEqual(["woof / plan-less run", "run run-1"]);
    expect(bare).toContain("no planned agents");
    expect(bare).toContain("no planned stages");
  });

  it("graphOf reads the built-in workflow's routes and check command for a matching plan, and refuses another plan", () => {
    const definition = builtInWorkflow("build-review");
    expect(graphOf(definition, PLAN, INPUT)).toEqual(GRAPH);
    // Without a verify command the check has none to show; the routes stay.
    const { verify: _verify, ...withoutVerify } = INPUT;
    expect(graphOf(definition, PLAN, withoutVerify)?.nodes[1]).toEqual({
      id: "verify",
      kind: "check",
      bindsRevision: false,
      command: null,
    });
    expect(
      graphOf(definition, { stages: PLAN.stages.slice(0, 2), checks: ["verify"] }, INPUT),
    ).toBeNull();
    expect(graphOf(definition, { stages: PLAN.stages }, INPUT)).toBeNull();
  });
});

describe("createRunRenderer: input preview", () => {
  it("summary mode counts criteria from the task and falls back to the byte count honestly", () => {
    const built = build([
      { ...opened(PLAN), input: { path: "input.json", sha256: "a".repeat(64), bytes: 321 } },
    ]);
    const titled = rendererFor(
      built,
      {},
      { input: { title: "Ship it", acceptanceCriteria: [1, 2, 3] } },
    ).opening();
    expect(titled.slice(-4, -2)).toEqual([
      "Ship it",
      "3 acceptance criteria · full input: input.json",
    ]);
    const untitled = rendererFor(built, {}, { input: { anything: true } }).opening();
    expect(untitled.slice(-3, -2)).toEqual(["input: 321 bytes · full input: input.json"]);
    const unreadable = rendererFor(built, {}, { input: undefined }).opening();
    expect(unreadable.slice(-3, -2)).toEqual([
      "input: 321 bytes · full input: input.json (not readable here)",
    ]);
    const none = rendererFor(build([opened(PLAN)]), {}, { input: undefined }).opening();
    expect(none.slice(-3, -2)).toEqual(["no input recorded"]);
  });

  it("json mode prints indented JSON and cuts it with an explicit marker, never looking complete", () => {
    const built = build([opened(PLAN)]);
    const full = rendererFor(built, { input: "json" }).opening();
    const start = full.indexOf("INPUT") + 1;
    const preview = full.slice(start, -2);
    expect(preview[0]).toBe("{");
    expect(preview.at(-1)).toBe("full input: input.json");
    expect(preview.slice(0, -1).join("\n")).toBe(JSON.stringify(INPUT, null, 2));

    const cut = rendererFor(built, { input: "json", jsonPreviewLines: 5 }).opening();
    const shown = cut.slice(cut.indexOf("INPUT") + 1, -2);
    expect(shown).toHaveLength(6);
    expect(shown.slice(0, 5)).toEqual(JSON.stringify(INPUT, null, 2).split("\n").slice(0, 5));
    expect(shown.at(-1)).toBe(
      `… (${JSON.stringify(INPUT, null, 2).split("\n").length - 5} more lines, full input: input.json)`,
    );

    // A line wider than the terminal is clipped with an ellipsis, so it never reads as complete.
    const wide = rendererFor(
      built,
      { input: "json", width: 40 },
      { input: { description: "x".repeat(100) } },
    ).opening();
    const line = wide.find((item) => item.includes('"description"'));
    expect(line).toHaveLength(40);
    expect(line?.endsWith("…")).toBe(true);

    // Restrained coloring: keys cyan, string values green, structure uncolored.
    const colored = rendererFor(built, { input: "json", color: true }).opening();
    const title = colored.find((item) => item.includes("Fix empty-state"));
    expect(title).toBe(
      '    \u001B[36m"title"\u001B[0m: \u001B[32m"Fix empty-state rendering",\u001B[0m',
    );
  });
});

describe("createRunRenderer: history rows", () => {
  it("renders the design's build → verify → review → repair → verify → review example row for row", () => {
    const built = build(DESIGN_RUN, 1);
    expect(rowsOf(rendererFor(built), built.events)).toEqual(DESIGN_ROWS);
  });

  it("attaching to a run with history replays exactly the live rows, and a repeated event adds nothing", () => {
    const built = build(DESIGN_RUN);
    const attached = rendererFor(built);
    expect(rowsOf(attached, built.events)).toEqual(DESIGN_ROWS);
    expect(rowsOf(attached, built.events.slice(3, 6))).toEqual([]);
    expect(attached.opening()).toEqual(rendererFor(build(DESIGN_RUN, 1)).opening());
  });

  it("colors only the mark and the message: stripping SGR codes gives the plain rows", () => {
    const built = build(DESIGN_RUN, 1);
    const colored = rowsOf(rendererFor(built, { color: true }), built.events);
    expect(colored.map((line) => line.replaceAll(SGR, ""))).toEqual(DESIGN_ROWS);
    expect(colored[3]).toBe(
      "\u001B[2m10:00:00\u001B[0m \u001B[32m✓\u001B[0m builder  \u001B[2mbuild \u001B[0m  \u001B[32mCompletion report accepted\u001B[0m",
    );
    expect(colored[10]).toContain("\u001B[33m↻\u001B[0m");
    expect(colored[10]).toContain("\u001B[33mChanges requested → repair\u001B[0m");
    expect(colored[1]).toContain("\u001B[36m+\u001B[0m");
    // A received review awaits the gate: no foreground color on that row at all.
    expect(colored[9]?.replaceAll(SGR, "")).toBe(DESIGN_ROWS[9]);
    expect(colored[9]).not.toContain("[3");
  });

  it("ascii mode uses + -> v ~ ! . and spells every arrow ->", () => {
    const built = build(DESIGN_RUN, 1);
    const rows = rowsOf(rendererFor(built, { ascii: true }), built.events);
    expect(rows.slice(0, 6)).toEqual([
      "10:00:00 .  run              Started",
      "10:00:00 +  builder          Agent started - claude / sonnet",
      "10:00:00 -> builder  build   Task dispatched",
      "10:00:00 v  builder  build   Completion report accepted",
      "10:00:00 v  gate     build   Passed -> verify",
      "10:00:00 v  gate     verify  Checks passed -> review",
    ]);
    expect(rows[10]).toBe("10:00:00 ~  gate     review  Changes requested -> repair");
    const opening = rendererFor(built, { ascii: true }).opening();
    expect(opening[9]).toBe("build -> verify -> review -> completed");
    expect(opening[10]).toBe("        reject -> repair -> verify");
    expect(opening.at(-1)).toBe("-".repeat(80));
    for (const line of [...rows, ...opening]) expect(line).toMatch(/^[\x20-\x7E]*$/u);
  });

  it("wraps a long message under the message column at 80 columns and keeps the participant on the first line", () => {
    const action =
      "approve the permission prompt for the shell command that the builder is waiting on in its terminal";
    const built = build([
      opened(PLAN),
      assigned("builder"),
      attempt("build", "builder"),
      dispatched("build", "builder"),
      { ...blocked("builder", ["build", 1, 1]), requiredAction: action },
    ]);
    const rows = rowsOf(rendererFor(built), built.events);
    const indent = " ".repeat(28);
    expect(rows.slice(-4)).toEqual([
      "10:00:00 ! builder  build   Blocked: blocked on input",
      `${indent}approve the permission prompt for the shell command`,
      `${indent}that the builder is waiting on in its terminal ·`,
      `${indent}builder, pane w1:builder`,
    ]);
    for (const line of rows) expect(line.length).toBeLessThanOrEqual(80);
    // The block is what the observer shows when it leaves, with the one supported action.
    expect(rendererFor(built).blocked(built.status)).toEqual([
      "! Blocked: blocked on input · builder (pane w1:builder)",
      "  approve the permission prompt for the shell command that the builder is",
      "  waiting on in its terminal",
      `  supported action: woof run cancel ${RUN_DIR}`,
    ]);
  });

  it("keeps format repair, work retry and uncertain delivery distinct, and explains a rejected result", () => {
    const built = build([
      opened(PLAN),
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
        details: [{ field: "artifact.path", message: "does not exist" }],
      },
      attempt("build", "builder", 1, 2),
      dispatched("build", "builder", 1, 2, "ambiguous", "timeout"),
      {
        type: "delivery.reconciled",
        agentId: "builder",
        stageId: "build",
        visit: 1,
        attempt: 2,
        dispatchSeq: 7,
        resolution: "abandoned",
        evidence: "no_evidence_before_deadline",
      },
      attempt("build", "builder", 1, 3),
      dispatched("build", "builder", 1, 3),
    ]);
    const rows = rowsOf(rendererFor(built), built.events);
    expect(rows.slice(3)).toEqual([
      "10:00:00 ! builder  build   Result rejected: artifact missing · artifact.path",
      "                            does not exist",
      "10:00:00 ↻ builder  build   Fixing result format · attempt 2",
      "10:00:00 ↻ builder  build   Delivery unconfirmed · checking (timeout)",
      "10:00:00 ! builder  build   Delivery abandoned · no evidence before deadline",
      "10:00:00 ↻ builder  build   Retrying work · attempt 3",
      "10:00:00 → builder  build   Task dispatched · attempt 3",
    ]);
  });

  it("renders lifecycle and activity records by their type string and falls back to a subdued row for an unknown type", () => {
    const built = build([opened(PLAN), assigned("builder")]);
    const renderer = rendererFor(built);
    rowsOf(renderer, built.events);
    const at = (seq: number, type: string, data: Json, subject: Json = {}): Event => ({
      seq,
      ts: "2026-09-14T10:00:01.000Z",
      type,
      subject,
      data,
    });
    const lifecycle = (seq: number, to: string, extra: Json = {}) =>
      at(seq, "agent.lifecycle_changed", {
        agentId: "builder",
        from: "x",
        to,
        terminalId: "t",
        ...extra,
      });
    const activity = (seq: number, kind: string, phase: string, extra: Json = {}) =>
      at(seq, "run.activity", { kind, phase, agentId: "builder", stageId: "build", ...extra });
    expect(
      [
        lifecycle(3, "starting"),
        lifecycle(4, "ready"),
        lifecycle(5, "working"),
        lifecycle(6, "blocked"),
        lifecycle(7, "gone", { replaced: true }),
        activity(8, "readiness_wait", "started"),
        activity(9, "readiness_wait", "ended"),
        activity(10, "revision_check", "started"),
        activity(11, "revision_check", "ended"),
        activity(12, "check_run", "started", { detail: "bun test" }),
        activity(13, "delivery_check", "started"),
        activity(14, "cache_warmup", "started", { detail: "3 files" }),
        at(15, "future.thing", { a: 1 }, { agentId: "reviewer" }),
        at(16, "future.other", {}),
      ].flatMap((event) => renderer.row(event)),
    ).toEqual([
      "10:00:01 · builder          Waiting for agent to become ready",
      "10:00:01 · builder          Agent ready",
      "10:00:01 · builder          Agent working",
      "10:00:01 ! builder          Blocked · agent waits",
      "10:00:01 ! builder          Agent gone · replaced",
      "10:00:01 · builder  build   Waiting for agent to become ready",
      "10:00:01 · builder  build   Agent ready",
      "10:00:01 · builder  build   Checking repository revision",
      "10:00:01 · gate     build   Running checks · bun test",
      "10:00:01 ↻ builder  build   Delivery unconfirmed · checking",
      "10:00:01 · builder  build   · cache warmup started · 3 files",
      "10:00:01 · reviewer         · future.thing",
      "10:00:01 · run              · future.other",
    ]);
  });

  it("host loss, cancellation and a late rejection stay visible; the termination itself is left to the summary", () => {
    const built = build([
      opened(PLAN),
      {
        type: "host.claimed",
        pid: 7,
        hostname: "h",
        startedAt: "2026-09-14T10:00:00.000Z",
        heartbeatMs: 2000,
        paneId: null,
        workspaceId: null,
      },
      { type: "run.cancel_requested", source: "cli", reason: "cancelled via woof run cancel" },
      {
        type: "host.lost",
        pid: 7,
        heartbeatAt: null,
        reason: "host_process_gone",
        detectedBy: "cli",
      },
      { type: "run.terminated", outcome: "cancelled", reason: "cancelled via woof run cancel" },
    ]);
    expect(rowsOf(rendererFor(built), built.events)).toEqual([
      "10:00:00 · run              Started",
      "10:00:00 · run              Cancel requested · cli: cancelled via woof run",
      "                            cancel",
      "10:00:00 ! run              Host lost · outcome unknown (host process gone)",
    ]);
  });
});

describe("createRunRenderer: summary and observer stop", () => {
  it("a completed run: outcome, duration, review and repair counts, and the accepted artifacts of the completing revision", () => {
    const built = build(DESIGN_RUN);
    const renderer = rendererFor(built);
    rowsOf(renderer, built.events);
    expect(
      renderer.summary({ status: built.status, result: built.result, snapshot: built.snapshot }),
    ).toEqual([
      "",
      "─".repeat(80),
      "✓ Completed · approved",
      "0s · 2 reviews · 1 repair",
      "",
      "ARTIFACTS · relative to run directory",
      "changes  accepted/repair/visit-1/attempt-1/out.md",
      "review   accepted/review/visit-2/attempt-1/out.md",
      "checks   checks/verify/repair-v1-a1/output.log",
    ]);
  });

  it("failed, exhausted and cancelled runs are each visibly distinct from completion", () => {
    const base = DESIGN_RUN.slice(0, 12);
    const ending = (terminal: Json) => {
      const built = build([...base, terminal]);
      return rendererFor(built).summary({
        status: built.status,
        result: built.result,
        snapshot: built.snapshot,
      });
    };
    expect(
      ending({
        type: "run.terminated",
        outcome: "failed",
        reason: "builder reported failure",
      }).slice(2, 4),
    ).toEqual(["! Failed · builder reported failure", "0s · 1 review · 1 repair · last at review"]);
    expect(
      ending({
        type: "run.terminated",
        outcome: "exhausted",
        reason: "gate review requires another round beyond maxRounds (3)",
        limit: "maxRounds",
      }).slice(2, 5),
    ).toEqual([
      "! Exhausted · maxRounds (3)",
      "gate review requires another round beyond maxRounds (3)",
      "0s · 1 review · 1 repair · last at review",
    ]);
    const cancelled = ending({
      type: "run.terminated",
      outcome: "cancelled",
      reason: "cancelled via woof run cancel",
    });
    expect(cancelled.slice(2, 4)).toEqual([
      "· Cancelled · cancelled via woof run cancel",
      "0s · 1 review · 1 repair · last at review",
    ]);
    // No review is named unless the run completed on the reviewed revision.
    expect(cancelled.slice(5)).toEqual([
      "ARTIFACTS · relative to run directory",
      "changes  accepted/build/visit-1/attempt-1/out.md",
      "checks   checks/verify/build-v1-a1/output.log",
    ]);
    // In color the four outcomes carry four different treatments.
    const paint = (terminal: Json) => {
      const built = build([...base, terminal]);
      return rendererFor(built, { color: true }).summary({
        status: built.status,
        result: built.result,
        snapshot: built.snapshot,
      })[2];
    };
    expect(
      paint({ type: "run.terminated", outcome: "failed", reason: "x" })?.startsWith("\u001B[31m!"),
    ).toBe(true);
    expect(
      paint({ type: "run.terminated", outcome: "cancelled", reason: "x" })?.startsWith(
        "\u001B[2m·",
      ),
    ).toBe(true);
    const done = build(DESIGN_RUN);
    expect(
      rendererFor(done, { color: true })
        .summary({ status: done.status, result: done.result, snapshot: done.snapshot })[2]
        ?.startsWith("\u001B[32m✓"),
    ).toBe(true);
  });

  it("stopping the observer is not the end of the run", () => {
    const built = build(DESIGN_RUN, 1);
    const renderer = rendererFor(built);
    expect(renderer.observerStopped("timeout")).toBe(
      "-- observer stopped (timeout); the run continues",
    );
    expect(renderer.blocked(built.status)).toEqual([]);
    expect(rendererFor(built, { color: true }).observerStopped("end")).toBe(
      "\u001B[2m-- observer stopped (end); the run continues\u001B[0m",
    );
  });
});
