import { isPlainObject, type RejectionDetail } from "../contracts/envelope.js";
import type { Limits } from "../domain/types.js";
import type { AcceptedRef, Transition, WorkflowDefinition } from "../scheduler/definition.js";
import { buildReviewWorkflow, type BuildReviewInput } from "./build-review.js";
import { exactKeys, limitsProblem, type InputAgent } from "./input.js";
import { planWorkflow, type PlanInput } from "./plan.js";

/**
 * Built-in `auto-build` workflow (composition): two workflow steps and no agents of its own.
 * `plan` runs the `plan` workflow; `build` runs `build-review` with the accepted `plan.md` as an
 * input artifact, on the same branch in the same checkout (scenario (c) of
 * docs/design/composition.md). The composition is declarative: each step's `input` maps this
 * workflow's input — and, for `build`, the plan step's copied artifact — to the child's input,
 * which the child's own definition validates. The builder commits each turn's change, so the
 * branch carries the plan commit and the reviewed change when the run completes. A step whose
 * child does not complete fails the run; there is no retry here, each child bounds its own work.
 */

type Agent = InputAgent;

export interface AutoBuildInput {
  schemaVersion: 1;
  /** Absolute path of the git work tree. */
  repo: string;
  task: { title: string; description: string; acceptanceCriteria: string[]; context?: unknown };
  /** Constraints the plan must respect (the plan step only). */
  constraints?: string[];
  instructions?: { planner?: string; builder?: string; reviewer?: string };
  verify?: { command: string[]; timeoutMs: number };
  /** Commit the plan into the repository before the build (the plan step's `publish`). */
  publish?: { path: string; push?: boolean };
  agents?: { planner?: Agent; builder?: Agent; reviewer?: Agent };
  /** This run's own limits; each child's limits come from its own defaults and configuration. */
  limits?: Partial<Limits>;
}

export const AUTO_BUILD_DEFAULT_LIMITS: Required<Limits> = {
  maxAttemptsPerVisit: 1,
  maxVisitsPerStage: 1,
  maxRounds: 1,
  maxFormatRepairs: 0,
  runTimeoutMs: 14_400_000,
  readinessWaitMs: 180_000,
  blockedWaitMs: 600_000,
  deliveryTimeoutMs: 60_000,
};

const FOLLOW_THE_PLAN =
  "Follow the plan: it is the input labelled `plan`. Read the file itself; nothing restates it for you. Where the plan is wrong or incomplete, do the right thing and say so in your completion report. When your change is complete, commit it on the current branch (all of it, one commit per turn, a message naming the task); never push, and never rewrite earlier commits.";
const REVIEW_AGAINST_THE_PLAN =
  "The input labelled `plan` is the plan the builder followed: check the change against it as well as against the task.";

/** The plan step's input: the task, constraints, planner and publish settings. */
function planInputOf(input: AutoBuildInput): PlanInput {
  return {
    schemaVersion: 1,
    repo: input.repo,
    task: input.task,
    ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
    ...(input.instructions?.planner !== undefined
      ? { instructions: { planner: input.instructions.planner } }
      : {}),
    ...(input.publish !== undefined ? { publish: input.publish } : {}),
    ...(input.agents?.planner !== undefined ? { agents: { planner: input.agents.planner } } : {}),
  };
}

/** The caller's own role instructions, then the fixed guidance for this composition. */
function joined(own: string | undefined, fixed: string): string {
  return own === undefined ? fixed : `${own}\n\n${fixed}`;
}

/** The build step's input: the task, builder and reviewer settings, and the accepted plan. */
function buildInputOf(
  input: AutoBuildInput,
  plan: { path: string; sha256: string },
): BuildReviewInput {
  const agents = {
    ...(input.agents?.builder !== undefined ? { builder: input.agents.builder } : {}),
    ...(input.agents?.reviewer !== undefined ? { reviewer: input.agents.reviewer } : {}),
  };
  return {
    schemaVersion: 1,
    repo: input.repo,
    task: input.task,
    instructions: {
      builder: joined(input.instructions?.builder, FOLLOW_THE_PLAN),
      reviewer: joined(input.instructions?.reviewer, REVIEW_AGAINST_THE_PLAN),
    },
    ...(input.verify !== undefined ? { verify: input.verify } : {}),
    ...(Object.keys(agents).length > 0 ? { agents } : {}),
    inputs: [{ label: "plan", path: plan.path, sha256: plan.sha256 }],
  };
}

/** The plan step's accepted `plan.md`, copied into this run. */
function acceptedPlan(plan: AcceptedRef | undefined): { path: string; sha256: string } {
  if (plan === undefined) throw new Error("the plan step accepted no plan.md");
  return { path: plan.acceptedPath, sha256: plan.sha256 };
}

/** A placeholder plan reference: the children's validators see a well-formed build input up front. */
const PLACEHOLDER_PLAN = { path: "/auto-build/plan/plan.md", sha256: "0".repeat(64) };

function validateInput(
  value: unknown,
): { ok: true; input: AutoBuildInput } | { ok: false; details: RejectionDetail[] } {
  if (!isPlainObject(value))
    return { ok: false, details: [{ field: "input", message: "must be an object" }] };
  const details: RejectionDetail[] = [];
  const fail = (field: string, message: string) => details.push({ field, message });
  exactKeys(
    value,
    [
      "schemaVersion",
      "repo",
      "task",
      "constraints",
      "instructions",
      "verify",
      "publish",
      "agents",
      "limits",
    ],
    "",
    fail,
  );
  const instructions = value["instructions"];
  if (isPlainObject(instructions))
    exactKeys(instructions, ["planner", "builder", "reviewer"], "instructions.", fail);
  const agents = value["agents"];
  if (isPlainObject(agents)) exactKeys(agents, ["planner", "builder", "reviewer"], "agents.", fail);
  limitsProblem(value["limits"], AUTO_BUILD_DEFAULT_LIMITS, fail);
  if (details.length > 0) return { ok: false, details };
  // Each child validates the input it will be given, now: a mistake is refused before any step runs.
  const candidate = value as unknown as AutoBuildInput;
  const seen = new Set<string>();
  for (const verdict of [
    planWorkflow.validateInput(planInputOf(candidate)),
    buildReviewWorkflow.validateInput(buildInputOf(candidate, PLACEHOLDER_PLAN)),
  ]) {
    if (verdict.ok) continue;
    for (const detail of verdict.details) {
      const key = `${detail.field}\u0000${detail.message}`;
      if (!seen.has(key)) details.push(detail);
      seen.add(key);
    }
  }
  if (details.length > 0) return { ok: false, details };
  return { ok: true, input: structuredClone(value) as unknown as AutoBuildInput };
}

const failedStep =
  (step: string) =>
  (verdict: string | null): Transition => ({
    decision: "reject",
    reason: `${step}_${verdict ?? "unknown"}`,
    outcome: "failed",
  });

export const autoBuildWorkflow: WorkflowDefinition<AutoBuildInput> = {
  schemaVersion: 1,
  name: "auto-build",
  version: "1",
  validateInput,
  checkout: "writable",
  agents: [],
  resolveAgents: () => ({}),
  resolveLimits: (input) => ({ ...input.limits }),
  limitDefaults: { ...AUTO_BUILD_DEFAULT_LIMITS },
  repository: (input) => input.repo,
  start: "plan",
  roundStage: null,
  stages: [
    {
      kind: "workflow",
      stageId: "plan",
      workflow: { name: "plan" },
      input: (ctx) => planInputOf(ctx.input),
      next: (ctx) =>
        ctx.accepted.verdict === "completed"
          ? { decision: "pass", reason: "planned", to: "build" }
          : failedStep("plan")(ctx.accepted.verdict),
    },
    {
      kind: "workflow",
      stageId: "build",
      workflow: { name: "build-review" },
      input: (ctx) =>
        buildInputOf(ctx.input, acceptedPlan(ctx.history.children["plan"]?.artifacts["plan"])),
      next: (ctx) =>
        ctx.accepted.verdict === "completed"
          ? { decision: "pass", reason: "built", outcome: "completed" }
          : failedStep("build")(ctx.accepted.verdict),
    },
  ],
  edges: { plan: ["build", "failed"], build: ["completed", "failed"] },
};

export default autoBuildWorkflow;
