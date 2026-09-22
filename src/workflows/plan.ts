import { canonicalJson } from "../contracts/canonical-json.js";
import { isPlainObject, type RejectionDetail } from "../contracts/envelope.js";
import { jsonValueProblem } from "../contracts/json-value.js";
import type { Limits } from "../domain/types.js";
import type { InputRef, WorkflowDefinition } from "../scheduler/definition.js";
import { MAX_REQUEST_BYTES } from "../scheduler/request.js";
import { exactKeys, limitsProblem, nonEmpty } from "./input.js";
import { largestRequestBytes, type RequestBoundCase } from "./request-bound.js";

/**
 * Built-in `plan` workflow (composition): one planner writes `plan.md`, the implementation plan
 * for a task. It is the first step of `auto-build` and a workflow of its own (scenario (a) of
 * docs/design/composition.md): with `publish.path` the planner also writes the plan into the
 * repository at that path and commits it (and pushes, with `publish.push`), and an engine-run
 * check confirms the file is in the checkout's HEAD commit before the run completes. A plan that
 * is not committed sends the planner back once more, bounded by `maxVisitsPerStage`.
 *
 * Its checkout access is "writable": with `publish` it commits to the tree, so it never starts
 * on the operator's uncommitted work.
 */

export interface PlanInput {
  schemaVersion: 1;
  /** Absolute path of the git work tree. */
  repo: string;
  task: { title: string; description: string; acceptanceCriteria: string[]; context?: unknown };
  /** Constraints the plan must respect. */
  constraints?: string[];
  instructions?: { planner?: string };
  /** Commit the plan into the repository at `path` (relative to the top level). */
  publish?: { path: string; push?: boolean };
  agents?: { planner?: { kind: string; model: string | null; args: string[] } };
  limits?: Partial<Limits>;
}

export const PLAN_DEFAULT_LIMITS: Required<Limits> = {
  maxAttemptsPerVisit: 2,
  maxVisitsPerStage: 2,
  maxRounds: 1,
  maxFormatRepairs: 2,
  runTimeoutMs: 3_600_000,
  readinessWaitMs: 180_000,
  blockedWaitMs: 600_000,
  deliveryTimeoutMs: 60_000,
};

const MAX_TASK_BYTES = 24 * 1024;
const MAX_TITLE = 200;
const MAX_PUBLISH_PATH = 200;
/** A relative repository path of plain segments: no `..`, no leading `/` or `-`, no `.git`. */
const PUBLISH_PATH = /^(?!-)(?!.*(^|\/)\.\.?(\/|$))(?!\.git(\/|$))[A-Za-z0-9._/-]+(?<!\/)$/;
const VERIFY_TIMEOUT_MS = 30_000;

const REQUEST_BOUND_CASES: readonly RequestBoundCase[] = [
  { stageId: "plan", enteredBy: null },
  { stageId: "plan", enteredBy: { kind: "check", gate: "published" } },
];

function validateInput(
  value: unknown,
): { ok: true; input: PlanInput } | { ok: false; details: RejectionDetail[] } {
  const details: RejectionDetail[] = [];
  const fail = (field: string, message: string) => details.push({ field, message });
  if (!isPlainObject(value))
    return { ok: false, details: [{ field: "input", message: "must be an object" }] };
  exactKeys(
    value,
    ["schemaVersion", "repo", "task", "constraints", "instructions", "publish", "agents", "limits"],
    "",
    fail,
  );
  if (value["schemaVersion"] !== 1) fail("schemaVersion", "must be 1");
  if (typeof value["repo"] !== "string" || !value["repo"].startsWith("/"))
    fail("repo", "must be an absolute path");
  taskProblem(value["task"], fail);
  const constraints = value["constraints"];
  if (
    constraints !== undefined &&
    (!Array.isArray(constraints) || constraints.length === 0 || !constraints.every(nonEmpty))
  )
    fail("constraints", "must be a non-empty array of non-empty strings");
  const instructions = value["instructions"];
  if (instructions !== undefined) {
    if (!isPlainObject(instructions)) fail("instructions", "must be an object");
    else {
      exactKeys(instructions, ["planner"], "instructions.", fail);
      if (instructions["planner"] !== undefined && !nonEmpty(instructions["planner"]))
        fail("instructions.planner", "must be a non-empty string");
    }
  }
  const publish = value["publish"];
  if (publish !== undefined) {
    if (!isPlainObject(publish)) fail("publish", "must be an object with path");
    else {
      exactKeys(publish, ["path", "push"], "publish.", fail);
      const path = publish["path"];
      if (typeof path !== "string" || path.length > MAX_PUBLISH_PATH || !PUBLISH_PATH.test(path))
        fail(
          "publish.path",
          `must be a relative repository path of at most ${MAX_PUBLISH_PATH} characters, without .. or .git`,
        );
      if (publish["push"] !== undefined && typeof publish["push"] !== "boolean")
        fail("publish.push", "must be a boolean");
    }
  }
  agentsProblem(value["agents"], ["planner"], fail);
  limitsProblem(value["limits"], PLAN_DEFAULT_LIMITS, fail);
  if (details.length === 0) {
    const size = Buffer.byteLength(
      canonicalJson({
        task: value["task"],
        constraints: constraints ?? null,
        instructions: instructions ?? null,
      }),
      "utf8",
    );
    if (size > MAX_TASK_BYTES)
      fail(
        "task",
        `task, constraints and instructions are ${size} bytes; the limit is ${MAX_TASK_BYTES}`,
      );
  }
  if (details.length === 0) {
    const largest = largestRequestBytes(
      planWorkflow,
      value as unknown as PlanInput,
      REQUEST_BOUND_CASES,
    );
    if (largest > MAX_REQUEST_BYTES)
      fail(
        "task",
        `the largest rendered request for this input would be ${largest} bytes; the limit is ${MAX_REQUEST_BYTES}`,
      );
  }
  if (details.length > 0) return { ok: false, details };
  return { ok: true, input: structuredClone(value) as unknown as PlanInput };
}

/** The shared task shape of the built-in workflows. */
export function taskProblem(task: unknown, fail: (field: string, message: string) => void): void {
  if (!isPlainObject(task)) {
    fail("task", "must be an object");
    return;
  }
  exactKeys(task, ["title", "description", "acceptanceCriteria", "context"], "task.", fail);
  if (!nonEmpty(task["title"]) || task["title"].length > MAX_TITLE)
    fail("task.title", `must be a non-empty string of at most ${MAX_TITLE} characters`);
  if (!nonEmpty(task["description"])) fail("task.description", "must be a non-empty string");
  const criteria = task["acceptanceCriteria"];
  if (!Array.isArray(criteria) || criteria.length === 0 || !criteria.every(nonEmpty))
    fail("task.acceptanceCriteria", "must be a non-empty array of non-empty strings");
  if (Object.hasOwn(task, "context")) {
    const problem = jsonValueProblem(task["context"], "task.context");
    if (problem !== undefined) fail(problem.field, problem.message);
  }
}

/** Per-role agent overrides `{kind, model, args}` for the listed roles. */
export function agentsProblem(
  agents: unknown,
  roles: readonly string[],
  fail: (field: string, message: string) => void,
): void {
  if (agents === undefined) return;
  if (!isPlainObject(agents)) {
    fail("agents", `must be an object with ${roles.join(", ")}`);
    return;
  }
  exactKeys(agents, roles, "agents.", fail);
  for (const role of roles) {
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

function publishInstruction(input: PlanInput): string {
  const publish = input.publish;
  if (publish === undefined)
    return " Do not change repository files: the planner reads, the builder writes.";
  return ` Then publish it: write the same plan to \`${publish.path}\` in the repository (create its directory if needed), and commit only that file with the message \`plan: ${input.task.title.replaceAll("`", "'")}\`${publish.push === true ? ", then push the branch to its upstream (set one with `git push -u origin HEAD` if it has none)" : ""}. Change nothing else in the repository.`;
}

export const planWorkflow: WorkflowDefinition<PlanInput> = {
  schemaVersion: 1,
  name: "plan",
  version: "1",
  validateInput,
  checkout: "writable",
  agents: [{ agentId: "planner", role: "planner" }],
  resolveAgents: (input) => {
    const planner = input.agents?.planner;
    return planner === undefined
      ? {}
      : { planner: { kind: planner.kind, model: planner.model, args: [...planner.args] } };
  },
  resolveLimits: (input) => ({ ...input.limits }),
  limitDefaults: { ...PLAN_DEFAULT_LIMITS },
  repository: (input) => input.repo,
  start: "plan",
  roundStage: null,
  stages: [
    {
      kind: "agent",
      stageId: "plan",
      agentId: "planner",
      verdicts: [],
      artifactFile: "plan.md",
      onFailedStatus: "fail",
      bindsRevision: false,
      request: (ctx) => {
        const constraints = ctx.input.constraints ?? [];
        const constraintLines =
          constraints.length === 0
            ? ""
            : `\nRespect these constraints:\n${constraints.map((item) => `- ${item}`).join("\n")}`;
        const unpublished = ctx.enteredBy?.kind === "check";
        const inputs: InputRef[] = unpublished
          ? [{ label: "publish check output", from: { checkId: "published" } }]
          : [];
        return {
          goal: unpublished
            ? `Publish the plan: ${ctx.input.publish?.path ?? "the plan"} is not in the checkout's HEAD commit.`
            : "Write the implementation plan for the task below.",
          instructions: `Read the repository (your working directory) and write the plan as your artifact: concrete file-level steps another engineer can follow, and an explicit statement of what "done" means against every acceptance criterion.${publishInstruction(ctx.input)}${constraintLines}`,
          inputs,
          task: ctx.input.task,
          ...(ctx.input.instructions?.planner !== undefined
            ? { roleInstructions: ctx.input.instructions.planner }
            : {}),
        };
      },
      next: (ctx) =>
        ctx.input.publish === undefined
          ? { decision: "pass", reason: "planned", outcome: "completed" }
          : { decision: "pass", reason: "planned", to: "published" },
    },
    {
      kind: "check",
      checkId: "published",
      // The plan file must be in the commit the checkout's HEAD names.
      command: (input) => ({
        argv: ["git", "cat-file", "-e", `HEAD:${input.publish?.path ?? "plan.md"}`],
        timeoutMs: VERIFY_TIMEOUT_MS,
      }),
      next: (ctx) =>
        ctx.check.exitCode === 0 && !ctx.check.timedOut
          ? { decision: "pass", reason: "published", outcome: "completed" }
          : { decision: "reject", reason: "not_published", to: "plan" },
    },
  ],
  edges: { plan: ["published", "completed"], published: ["completed", "plan"] },
};

export default planWorkflow;
