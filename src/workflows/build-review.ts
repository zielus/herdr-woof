import { canonicalJson } from "../contracts/canonical-json.js";
import { isPlainObject, type RejectionDetail } from "../contracts/envelope.js";
import { jsonValueProblem } from "../contracts/json-value.js";
import { MAX_COUNT_LIMIT, MAX_DURATION_LIMIT_MS, type Limits } from "../domain/types.js";
import {
  agentStageOf,
  type InputRef,
  type RequestContext,
  type RunHistory,
  type StageGateContext,
  type Transition,
  type WorkflowDefinition,
} from "../scheduler/definition.js";
import {
  MAX_REQUEST_BYTES,
  MAX_RUN_DIR_BYTES,
  renderRequest,
  type ResolvedInput,
} from "../scheduler/request.js";

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
  agents: Record<"builder" | "reviewer", { kind: string; model: string | null; args: string[] }>;
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

function validateInput(
  value: unknown,
): { ok: true; input: BuildReviewInput } | { ok: false; details: RejectionDetail[] } {
  const details: RejectionDetail[] = [];
  const fail = (field: string, message: string) => details.push({ field, message });
  if (!isPlainObject(value))
    return { ok: false, details: [{ field: "input", message: "must be an object" }] };
  exact(
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
    exact(task, ["title", "description", "acceptanceCriteria", "context"], "task.", fail);
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
      exact(instructions, ["builder", "reviewer"], "instructions.", fail);
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
      exact(verify, ["command", "timeoutMs"], "verify.", fail);
      const command = verify["command"];
      if (!Array.isArray(command) || command.length === 0 || !command.every(nonEmpty)) {
        fail("verify.command", "must be a non-empty array of non-empty strings");
      }
      if (!integerIn(verify["timeoutMs"], 1, MAX_DURATION_LIMIT_MS))
        fail("verify.timeoutMs", `must be an integer between 1 and ${MAX_DURATION_LIMIT_MS}`);
    }
  }

  const agents = value["agents"];
  if (!isPlainObject(agents)) {
    fail("agents", "must be an object with builder and reviewer");
  } else {
    exact(agents, ["builder", "reviewer"], "agents.", fail);
    for (const role of ["builder", "reviewer"]) {
      const agent = agents[role];
      if (!isPlainObject(agent)) {
        fail(`agents.${role}`, "must be an object with kind, model and args");
        continue;
      }
      exact(agent, ["kind", "model", "args"], `agents.${role}.`, fail);
      if (!nonEmpty(agent["kind"])) fail(`agents.${role}.kind`, "must be a non-empty string");
      if (agent["model"] !== null && !nonEmpty(agent["model"]))
        fail(`agents.${role}.model`, "must be a non-empty string or null");
      const args = agent["args"];
      if (!Array.isArray(args) || !args.every((item) => typeof item === "string"))
        fail(`agents.${role}.args`, "must be an array of strings");
    }
  }

  const limits = value["limits"];
  if (limits !== undefined) {
    if (!isPlainObject(limits)) {
      fail("limits", "must be an object");
    } else {
      exact(limits, Object.keys(BUILD_REVIEW_DEFAULT_LIMITS), "limits.", fail);
      for (const [key, raw] of Object.entries(limits)) {
        if (!(key in BUILD_REVIEW_DEFAULT_LIMITS)) continue;
        const [min, max] =
          key === "maxFormatRepairs"
            ? [0, MAX_COUNT_LIMIT]
            : key.endsWith("Ms")
              ? [1, MAX_DURATION_LIMIT_MS]
              : [1, MAX_COUNT_LIMIT];
        if (!integerIn(raw, min, max))
          fail(`limits.${key}`, `must be an integer between ${min} and ${max}`);
      }
    }
  }

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
    const largest = largestRequestBytes(value as unknown as BuildReviewInput);
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
  resolveAgents: (input) => ({
    builder: {
      kind: input.agents.builder.kind,
      model: input.agents.builder.model,
      args: [...input.agents.builder.args],
    },
    reviewer: {
      kind: input.agents.reviewer.kind,
      model: input.agents.reviewer.model,
      args: [...input.agents.reviewer.args],
    },
  }),
  resolveLimits: (input) => ({ ...BUILD_REVIEW_DEFAULT_LIMITS, ...input.limits }),
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
      request: (ctx) => {
        const builder = latestBuilderGate(ctx.history);
        const inputs: InputRef[] =
          builder === undefined
            ? []
            : [{ label: "completion report", from: { stageId: builder.subject.stageId } }];
        return {
          goal: "Review the current change in the repository against the task below.",
          instructions:
            'Inspect the repository (your working directory) and the completion report. Decide whether every acceptance criterion and project instruction holds. Write your review as your artifact with concrete findings. Submit verdict "fail" when any blocking finding remains, "pass" otherwise. A "fail" review is a completed review: use status "completed". Do not change repository files.',
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
          instructions: `Read the inputs, fix every blocking finding in the repository, and keep the acceptance criteria satisfied. ${COMPLETION_REPORT}`,
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

function exact(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  fail: (field: string, message: string) => void,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${prefix}${key}`, "unknown field");
  }
}

/** An absolute path of the admitted maximum run directory length, plus room for symlink resolution. */
function longPath(char: string): string {
  return `/${char.repeat(MAX_RUN_DIR_BYTES + 127)}`;
}

/**
 * Admission-time bound on the exact rendered request: renders the largest
 * requests this input can produce — the review, and the repair entered by a
 * review or by the verify check, each with every input its request names — with
 * a run directory and submit command at the admitted maximum length (plus room
 * for symlink resolution) and maximal counters, ids and digests.
 */
function largestRequestBytes(input: BuildReviewInput): number {
  const runDir = longPath("r");
  const hex = "f".repeat(64);
  const counter = MAX_COUNT_LIMIT;
  const seq = Number.MAX_SAFE_INTEGER;
  const receiptId = `rcpt-${seq}-${hex.slice(0, 12)}`;
  type Entered = NonNullable<RequestContext<BuildReviewInput>["enteredBy"]>;
  const builderGate = {
    kind: "stage",
    gate: "repair",
    subject: { stageId: "repair", visit: counter, attempt: counter, acceptedSeq: seq, receiptId },
    revision: { head: hex, tree: hex },
  } as unknown as Entered;
  const cases: Array<{ stageId: string; enteredBy: Entered }> = [
    { stageId: "review", enteredBy: builderGate },
    { stageId: "repair", enteredBy: { ...builderGate, gate: "review" } },
    { stageId: "repair", enteredBy: { ...builderGate, kind: "check", gate: "verify" } as Entered },
  ];
  let largest = 0;
  for (const { stageId, enteredBy } of cases) {
    const stage = agentStageOf(buildReviewWorkflow, stageId);
    if (stage === undefined) continue;
    const request = stage.request({
      input,
      runId: "r".repeat(128),
      history: { gates: [builderGate], latestAccepted: {} },
      stageId,
      visit: counter,
      attempt: counter,
      round: counter,
      enteredBy,
    });
    const inputs: ResolvedInput[] = request.inputs.map((ref) => {
      if ("checkId" in ref.from) {
        return {
          label: ref.label,
          path: `${runDir}/checks/${ref.from.checkId}/repair-v${counter}-a${counter}/output.log`,
          sha256: hex,
          checkId: ref.from.checkId,
        };
      }
      const source = agentStageOf(buildReviewWorkflow, ref.from.stageId);
      return {
        label: ref.label,
        path: `${runDir}/accepted/${ref.from.stageId}/visit-${counter}/attempt-${counter}/${source?.artifactFile ?? "artifact"}`,
        sha256: hex,
        accepted: { stageId: ref.from.stageId, visit: counter, attempt: counter, receiptId },
      };
    });
    const rendered = renderRequest({
      runId: "r".repeat(128),
      workflow: { name: buildReviewWorkflow.name, version: buildReviewWorkflow.version },
      agentId: stage.agentId,
      role: stage.agentId,
      stageId,
      visit: counter,
      attempt: counter,
      cause: "work_retry",
      round: counter,
      repository: input.repo,
      revision: { head: hex, tree: hex },
      runDir,
      artifactFile: stage.artifactFile,
      verdicts: stage.verdicts,
      submitCommand: [longPath("n"), longPath("c")],
      goal: request.goal,
      instructions: request.instructions,
      inputs,
      ...(request.task !== undefined ? { task: request.task } : {}),
      ...(request.roleInstructions !== undefined
        ? { roleInstructions: request.roleInstructions }
        : {}),
    });
    largest = Math.max(largest, rendered.bytes);
  }
  return largest;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function integerIn(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
