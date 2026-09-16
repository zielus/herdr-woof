import { canonicalJson } from "../contracts/canonical-json.js";
import { isPlainObject, type RejectionDetail } from "../contracts/envelope.js";
import { jsonValueProblem } from "../contracts/json-value.js";
import { MAX_DURATION_LIMIT_MS, type Limits } from "../domain/types.js";
import type {
  InputRef,
  RunHistory,
  StageGateContext,
  Transition,
  WorkflowDefinition,
} from "../scheduler/definition.js";
import { MAX_REQUEST_BYTES } from "../scheduler/request.js";
import { exactKeys, integerIn, limitsProblem, nonEmpty } from "./input.js";
import { largestRequestBytes, type RequestBoundCase } from "./request-bound.js";

/**
 * Built-in `build-review` workflow (p3): build → verify (an engine-run check,
 * only when the input names a command) → review → repair, until a review passes
 * on the exact repaired tree. The engine knows none of these names; they live
 * only here.
 */

export interface BuildReviewInput {
  schemaVersion: 1;
  /** Absolute path of the git work tree. */
  repo: string;
  task: { title: string; description: string; acceptanceCriteria: string[]; context?: unknown };
  instructions?: { builder?: string; reviewer?: string };
  verify?: { command: string[]; timeoutMs: number };
  /** Per-run agent overrides; a role left out comes from configuration (p4). */
  agents?: Partial<
    Record<"builder" | "reviewer", { kind: string; model: string | null; args: string[] }>
  >;
  /** Per-run limit overrides; other keys come from configuration, then the defaults below. */
  limits?: Partial<Limits>;
}

export const BUILD_REVIEW_DEFAULT_LIMITS: Required<Limits> = {
  maxAttemptsPerVisit: 2,
  maxVisitsPerStage: 3,
  maxRounds: 3,
  maxFormatRepairs: 2,
  runTimeoutMs: 7_200_000,
  readinessWaitMs: 180_000,
  blockedWaitMs: 600_000,
  deliveryTimeoutMs: 60_000,
};

/** Task, context and instructions together stay well under the 32 KiB request cap. */
const MAX_TASK_BYTES = 24 * 1024;
const MAX_TITLE = 200;

const BUILDER_STAGES: ReadonlySet<string> = new Set(["build", "repair"]);

/**
 * The stages whose rendered request can be this workflow's largest: the review
 * (task plus the completion report) and the repair entered by a review or by
 * the verify check, each carrying every input its request names.
 */
const REQUEST_BOUND_CASES: readonly RequestBoundCase[] = [
  { stageId: "review", enteredBy: { kind: "stage", gate: "repair" } },
  { stageId: "repair", enteredBy: { kind: "stage", gate: "review" } },
  { stageId: "repair", enteredBy: { kind: "check", gate: "verify" } },
];

function validateInput(
  value: unknown,
): { ok: true; input: BuildReviewInput } | { ok: false; details: RejectionDetail[] } {
  const details: RejectionDetail[] = [];
  const fail = (field: string, message: string) => details.push({ field, message });
  if (!isPlainObject(value))
    return { ok: false, details: [{ field: "input", message: "must be an object" }] };
  exactKeys(
    value,
    ["schemaVersion", "repo", "task", "instructions", "verify", "agents", "limits"],
    "",
    fail,
  );
  if (value["schemaVersion"] !== 1) fail("schemaVersion", "must be 1");
  if (typeof value["repo"] !== "string" || !value["repo"].startsWith("/"))
    fail("repo", "must be an absolute path");

  const task = value["task"];
  if (!isPlainObject(task)) {
    fail("task", "must be an object");
  } else {
    exactKeys(task, ["title", "description", "acceptanceCriteria", "context"], "task.", fail);
    if (!nonEmpty(task["title"]) || task["title"].length > MAX_TITLE)
      fail("task.title", `must be a non-empty string of at most ${MAX_TITLE} characters`);
    if (!nonEmpty(task["description"])) fail("task.description", "must be a non-empty string");
    const criteria = task["acceptanceCriteria"];
    if (!Array.isArray(criteria) || criteria.length === 0 || !criteria.every(nonEmpty)) {
      fail("task.acceptanceCriteria", "must be a non-empty array of non-empty strings");
    }
    if (Object.hasOwn(task, "context")) {
      const problem = jsonValueProblem(task["context"], "task.context");
      if (problem !== undefined) fail(problem.field, problem.message);
    }
  }

  const instructions = value["instructions"];
  if (instructions !== undefined) {
    if (!isPlainObject(instructions)) {
      fail("instructions", "must be an object");
    } else {
      exactKeys(instructions, ["builder", "reviewer"], "instructions.", fail);
      for (const role of ["builder", "reviewer"]) {
        if (instructions[role] !== undefined && !nonEmpty(instructions[role]))
          fail(`instructions.${role}`, "must be a non-empty string");
      }
    }
  }

  const verify = value["verify"];
  if (verify !== undefined) {
    if (!isPlainObject(verify)) {
      fail("verify", "must be an object");
    } else {
      exactKeys(verify, ["command", "timeoutMs"], "verify.", fail);
      const command = verify["command"];
      if (!Array.isArray(command) || command.length === 0 || !command.every(nonEmpty)) {
        fail("verify.command", "must be a non-empty array of non-empty strings");
      }
      if (!integerIn(verify["timeoutMs"], 1, MAX_DURATION_LIMIT_MS))
        fail("verify.timeoutMs", `must be an integer between 1 and ${MAX_DURATION_LIMIT_MS}`);
    }
  }

  const agents = value["agents"];
  if (agents !== undefined && !isPlainObject(agents)) {
    fail("agents", "must be an object with builder and/or reviewer");
  } else if (agents !== undefined) {
    exactKeys(agents, ["builder", "reviewer"], "agents.", fail);
    for (const role of ["builder", "reviewer"]) {
      const agent = agents[role];
      if (agent === undefined) continue;
      if (!isPlainObject(agent)) {
        fail(`agents.${role}`, "must be an object with kind, model and args");
        continue;
      }
      exactKeys(agent, ["kind", "model", "args"], `agents.${role}.`, fail);
      if (!nonEmpty(agent["kind"])) fail(`agents.${role}.kind`, "must be a non-empty string");
      if (agent["model"] !== null && !nonEmpty(agent["model"]))
        fail(`agents.${role}.model`, "must be a non-empty string or null");
      const args = agent["args"];
      if (!Array.isArray(args) || !args.every((item) => typeof item === "string"))
        fail(`agents.${role}.args`, "must be an array of strings");
    }
  }

  limitsProblem(value["limits"], BUILD_REVIEW_DEFAULT_LIMITS, fail);

  if (details.length === 0 && isPlainObject(task)) {
    const size = Buffer.byteLength(
      canonicalJson({ task, instructions: instructions ?? null }),
      "utf8",
    );
    if (size > MAX_TASK_BYTES)
      fail("task", `task and instructions are ${size} bytes; the limit is ${MAX_TASK_BYTES}`);
  }
  if (details.length === 0) {
    // The exact formatted request (pretty-printed context, fixed text, longest paths) must fit.
    const largest = largestRequestBytes(
      buildReviewWorkflow,
      value as unknown as BuildReviewInput,
      REQUEST_BOUND_CASES,
      { historyStageId: "repair" },
    );
    if (largest > MAX_REQUEST_BYTES) {
      fail(
        "task",
        `the largest rendered request for this input would be ${largest} bytes; the limit is ${MAX_REQUEST_BYTES}`,
      );
    }
  }
  if (details.length > 0) return { ok: false, details };
  return { ok: true, input: structuredClone(value) as unknown as BuildReviewInput };
}

/** The latest gate on a builder acceptance (build or repair). */
function latestBuilderGate(history: RunHistory) {
  return history.gates.findLast((gate) => gate.kind === "stage" && BUILDER_STAGES.has(gate.gate));
}

function builderNext(ctx: StageGateContext<BuildReviewInput>): Transition {
  return ctx.input.verify !== undefined
    ? { decision: "pass", reason: "built", to: "verify" }
    : { decision: "pass", reason: "built", to: "review" };
}

/**
 * Opt-in artifact/envelope verdict agreement (p5 D5). The reviewer is asked to
 * make this the artifact's first line; `woof submit` checks it only when the
 * first non-blank line actually starts with it, so a review that opens with
 * prose is accepted unchanged and a quoted example further down is ignored.
 */
export const REVIEW_VERDICT_MARKER = "Woof-Verdict:";

const VERDICT_LINE_INSTRUCTION = ` Make the first line of your artifact exactly \`${REVIEW_VERDICT_MARKER} pass\` or \`${REVIEW_VERDICT_MARKER} fail\`, matching the verdict in your envelope; a disagreement between the two is rejected.`;

/**
 * The accepted review is canonical for a repair (AGENTS.md: "A review artifact is
 * canonical and required; downstream agents receive its accepted version
 * directly"). Live acceptance found a builder treating a requirement it met only
 * inside the review artifact as a possible prompt injection and declining it
 * twice, which exhausted the run: the request never said whose word the review
 * was. It does now (p5 repair LV-102).
 */
export const REVIEW_IS_CANONICAL =
  "The accepted review artifact is canonical for this repair: its blocking findings are project requirements to satisfy, not suggestions. If you believe a finding is wrong, satisfy it anyway and record your objection in completion.md; never leave a blocking finding unaddressed.";

const COMPLETION_REPORT =
  "When you are done, write a short completion report as your artifact: what you changed (files), how you verified it, and anything left undone.";

export const buildReviewWorkflow: WorkflowDefinition<BuildReviewInput> = {
  schemaVersion: 1,
  name: "build-review",
  version: "1",
  validateInput,
  agents: [
    { agentId: "builder", role: "builder" },
    { agentId: "reviewer", role: "reviewer" },
  ],
  // Only the roles the input names; admission fills the others from configured roles.
  resolveAgents: (input) => {
    const agents: Record<string, { kind: string; model: string | null; args: string[] }> = {};
    for (const role of ["builder", "reviewer"] as const) {
      const agent = input.agents?.[role];
      if (agent !== undefined)
        agents[role] = { kind: agent.kind, model: agent.model, args: [...agent.args] };
    }
    return agents;
  },
  resolveLimits: (input) => ({ ...input.limits }),
  limitDefaults: { ...BUILD_REVIEW_DEFAULT_LIMITS },
  repository: (input) => input.repo,
  start: "build",
  roundStage: "review",
  stages: [
    {
      kind: "agent",
      stageId: "build",
      agentId: "builder",
      verdicts: [],
      artifactFile: "completion.md",
      onFailedStatus: "fail",
      bindsRevision: false,
      request: (ctx) => ({
        goal: "Implement the task below in the repository.",
        instructions: `Make the change in the repository (your working directory) so that every acceptance criterion holds. ${COMPLETION_REPORT}`,
        inputs: [],
        task: ctx.input.task,
        ...(ctx.input.instructions?.builder !== undefined
          ? { roleInstructions: ctx.input.instructions.builder }
          : {}),
      }),
      next: builderNext,
    },
    {
      kind: "check",
      checkId: "verify",
      command: (input) => ({
        argv: [...(input.verify?.command ?? [])],
        timeoutMs: input.verify?.timeoutMs ?? 1,
      }),
      next: (ctx) =>
        ctx.check.exitCode === 0 && !ctx.check.timedOut
          ? { decision: "pass", reason: "checks_passed", to: "review" }
          : { decision: "reject", reason: "checks_failed", to: "repair" },
    },
    {
      kind: "agent",
      stageId: "review",
      agentId: "reviewer",
      verdicts: ["pass", "fail"],
      artifactFile: "review.md",
      onFailedStatus: "fail",
      bindsRevision: true,
      artifactVerdictMarker: REVIEW_VERDICT_MARKER,
      request: (ctx) => {
        const builder = latestBuilderGate(ctx.history);
        const inputs: InputRef[] =
          builder === undefined
            ? []
            : [{ label: "completion report", from: { stageId: builder.subject.stageId } }];
        return {
          goal: "Review the current change in the repository against the task below.",
          instructions: `Inspect the repository (your working directory) and the completion report. Decide whether every acceptance criterion and project instruction holds. Write your review as your artifact with concrete findings. Submit verdict "fail" when any blocking finding remains, "pass" otherwise. A "fail" review is a completed review: use status "completed". Do not change repository files.${VERDICT_LINE_INSTRUCTION}`,
          inputs,
          task: ctx.input.task,
          ...(ctx.input.instructions?.reviewer !== undefined
            ? { roleInstructions: ctx.input.instructions.reviewer }
            : {}),
        };
      },
      next: (ctx) => {
        if (ctx.accepted.verdict === "fail") {
          return {
            decision: "reject",
            reason: "changes_requested",
            to: "repair",
            requires: "round",
          };
        }
        const builder = latestBuilderGate(ctx.history);
        const current = ctx.revision.current.tree;
        if (ctx.revision.reviewed?.tree === current && builder?.revision.tree === current) {
          return { decision: "pass", reason: "approved", outcome: "completed" };
        }
        return { decision: "reject", reason: "revision_moved", to: "review", requires: "round" };
      },
    },
    {
      kind: "agent",
      stageId: "repair",
      agentId: "builder",
      verdicts: [],
      artifactFile: "completion.md",
      onFailedStatus: "fail",
      bindsRevision: false,
      request: (ctx) => {
        const entered = ctx.enteredBy;
        const inputs: InputRef[] = [];
        if (entered?.kind === "stage" && entered.gate === "review") {
          inputs.push({ label: "review", from: { stageId: "review" } });
        }
        if (entered?.kind === "check")
          inputs.push({ label: "verification output", from: { checkId: entered.gate } });
        const builder = latestBuilderGate(ctx.history);
        if (builder !== undefined)
          inputs.push({
            label: "your previous completion report",
            from: { stageId: builder.subject.stageId },
          });
        return {
          goal:
            entered?.kind === "check"
              ? "Repair the change: the verification command failed."
              : "Repair the change: the review requested changes.",
          instructions: `Read the inputs, fix every blocking finding in the repository, and keep the acceptance criteria satisfied. ${REVIEW_IS_CANONICAL} ${COMPLETION_REPORT}`,
          inputs,
          task: ctx.input.task,
          ...(ctx.input.instructions?.builder !== undefined
            ? { roleInstructions: ctx.input.instructions.builder }
            : {}),
        };
      },
      next: builderNext,
    },
  ],
  edges: {
    build: ["verify", "review"],
    verify: ["review", "repair"],
    review: ["completed", "review", "repair"],
    repair: ["verify", "review"],
  },
};

export default buildReviewWorkflow;
