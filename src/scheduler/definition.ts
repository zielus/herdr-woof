import {
  MAX_VERDICT_MARKER,
  isId,
  isPlainObject,
  isVerdictMarker,
  type RejectionDetail,
} from "../contracts/envelope.js";
import type { CheckoutAccess } from "../contracts/checkout.js";
import { jsonValueProblem } from "../contracts/json-value.js";
import {
  LIMIT_KEYS,
  MAX_COUNT_LIMIT,
  MAX_DURATION_LIMIT_MS,
  type Limits,
  type Revision,
} from "../domain/types.js";
import type { AcceptedRef, EvidenceRef } from "../state/result.js";
import type { SnapshotGate } from "../state/snapshot.js";

export type { AcceptedRef } from "../state/result.js";

/**
 * Workflow definition contract (p3, unstable until v1). A definition is an ES
 * module whose default export satisfies `WorkflowDefinition`: static agents,
 * agent stages, engine-run check stages and an edge table, plus synchronous,
 * side-effect-free functions the scheduler calls with snapshot-derived context.
 * The engine names no stage; everything stage-specific lives here.
 */

export type EdgeTarget = string;

export interface WorkflowDefinition<Input = unknown> {
  schemaVersion: 1;
  name: string;
  version: string;
  /** Validates caller input; runs before any journal write or pane. */
  validateInput(
    value: unknown,
  ): { ok: true; input: Input } | { ok: false; details: RejectionDetail[] };
  agents: Array<{ agentId: string; role: string }>;
  /**
   * Kind, model and caller launch arguments per agent id, from input. An agent
   * the map omits is filled at admission from the configured role (p4), or
   * refused as `role_unresolved`.
   */
  resolveAgents(
    input: Input,
  ): Record<string, { kind: string; model: string | null; args: string[] }>;
  /**
   * Limits from input. Without `limitDefaults` this is the complete set (p3);
   * with it, only the per-run overrides (p4). Configuration fills every key
   * the result lacks.
   */
  resolveLimits(input: Input): Partial<Limits>;
  /** Built-in value per limit key, below input and configuration (p4, optional). */
  limitDefaults?: Partial<Limits>;
  /**
   * Absolute path of the git work tree the input names: the source of the run's checkout. The
   * run works there (`current`), in a worktree created from it, or in a caller-named `path`;
   * admission resolves which, from the reserved input key `checkout` (composition.md).
   */
  repository(input: Input): string;
  /**
   * What the workflow's agents do to the tree (default "writable"): a writable workflow refuses
   * a `current` or `path` checkout with uncommitted or untracked changes (`checkout_dirty`).
   */
  checkout?: CheckoutAccess;
  /**
   * Artifacts from outside the run that its stages may name as inputs (`{from: {input: label}}`),
   * by path and sha256 (composition, optional). Admission checks each digest; the run open copies
   * each file into the run directory, where every agent of the run can read it.
   */
  inputArtifacts?(input: Input): InputArtifact[];
  /** An agent or workflow stage id. */
  start: string;
  /** Entering this agent or workflow stage starts a round; null when the workflow has no rounds. */
  roundStage: string | null;
  stages: Array<AgentStage<Input> | CheckStage<Input> | WorkflowStage<Input>>;
  /** Every stage and check id → allowed next ids and terminal outcomes ("completed", "failed"). */
  edges: Record<string, EdgeTarget[]>;
}

export interface AgentStage<Input = unknown> {
  kind: "agent";
  stageId: string;
  agentId: string;
  verdicts: string[];
  /** Basename of the artifact inside the attempt directory. */
  artifactFile: string;
  /** An accepted status "failed" ends the run ("fail") or opens a work retry ("retry"). */
  onFailedStatus: "fail" | "retry";
  /** The gate receives the revision the attempt was dispatched against. */
  bindsRevision: boolean;
  /**
   * Opt-in artifact/envelope verdict agreement (p5 D5). A literal line prefix,
   * e.g. `"Woof-Verdict:"`. When a stage declares one, `woof submit` reads the
   * artifact's **first non-blank line only**: if that line starts with the
   * prefix, the rest of it must equal the envelope's verdict, otherwise the
   * submission is `verdict_artifact_mismatch`. An artifact whose first non-blank
   * line does not start with the prefix is accepted unchanged, and a
   * marker-looking line further down is ignored — a reviewer quoting the
   * required line inside an example must not be rejected for it.
   */
  artifactVerdictMarker?: string;
  request(ctx: RequestContext<Input>): StageRequest;
  next(ctx: StageGateContext<Input>): Transition;
}

/**
 * A workflow as a step (composition): the stage runs the named workflow as a child run in the
 * parent's checkout. `input` maps the parent's validated input and history to the child's raw
 * input, which the child's own definition validates. The step's verdict is the child's terminal
 * outcome (`completed`, `failed`, `exhausted` or `cancelled`) and `next` routes on it; its
 * accepted artifact is the child's `RunResult` (`result.json`), and the child's latest accepted
 * artifact per child stage is copied with it (`history.children[stageId].artifacts`).
 */
export interface WorkflowStage<Input = unknown> {
  kind: "workflow";
  stageId: string;
  workflow: { name: string };
  input(ctx: RequestContext<Input>): unknown;
  next(ctx: StageGateContext<Input>): Transition;
}

export interface InputArtifact {
  label: string;
  /** Absolute path of the file to copy into the run. */
  path: string;
  sha256: string;
}

export interface CheckStage<Input = unknown> {
  kind: "check";
  checkId: string;
  /**
   * The command to run. `ctx.subject` is the accepted artifact the check is about (composition,
   * optional to read); it is absent when a presentation layer asks for the command to show it.
   */
  command(input: Input, ctx?: { subject: AcceptedRef }): { argv: string[]; timeoutMs: number };
  next(ctx: CheckGateContext<Input>): Transition;
}

export interface StageRequest {
  goal: string;
  instructions: string;
  inputs: InputRef[];
  /** Task section of the request, when the workflow has one. */
  task?: { title: string; description: string; acceptanceCriteria: string[]; context?: unknown };
  /** Project instructions for the agent's role, when given. */
  roleInstructions?: string;
}

export type Transition = { decision: "pass" | "reject"; reason: string } & (
  { to: string; requires?: "round" } | { outcome: "completed" | "failed" }
);

export interface InputRef {
  label: string;
  /**
   * Latest accepted artifact of a stage, or latest evidence of a check. For a workflow stage,
   * `artifact` names a child stage whose copied artifact is wanted instead of `result.json`.
   * `input` names one of the run's input artifacts (`inputArtifacts`) by label.
   */
  from: { stageId: string; artifact?: string } | { checkId: string } | { input: string };
}

/** The latest child result of a workflow stage, as definitions see it. */
export interface ChildRef {
  runId: string;
  /** Absolute run directory of the child run. */
  runDir: string;
  workflow: { name: string; version: string };
  outcome: "completed" | "failed" | "exhausted" | "cancelled";
  reason: string;
  /** The parent's own immutable copy of the child's latest accepted artifact per child stage. */
  artifacts: Record<string, AcceptedRef>;
}

export interface RunHistory {
  gates: SnapshotGate[];
  /** Latest accepted artifact per stage id. */
  latestAccepted: Record<string, AcceptedRef>;
  /** Latest child result per workflow stage id (composition). */
  children: Record<string, ChildRef>;
}

interface BaseContext<Input> {
  input: Input;
  runId: string;
  history: RunHistory;
}

export interface RequestContext<Input> extends BaseContext<Input> {
  stageId: string;
  visit: number;
  attempt: number;
  round: number;
  /** The gate whose transition opened this visit; null for the start stage's first visit. */
  enteredBy: SnapshotGate | null;
}

export interface StageGateContext<Input> extends BaseContext<Input> {
  accepted: AcceptedRef & { status: "completed" | "failed"; verdict: string | null };
  revision: { reviewed: Revision | null; current: Revision };
}

export interface CheckGateContext<Input> extends BaseContext<Input> {
  subject: AcceptedRef;
  check: {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    evidence: EvidenceRef;
  };
  revision: { current: Revision };
}

export type ValidateDefinitionResult<Input> =
  { ok: true; definition: WorkflowDefinition<Input> } | { ok: false; details: RejectionDetail[] };

const OUTCOME_TARGETS: ReadonlySet<string> = new Set(["completed", "failed"]);
const ARTIFACT_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFINITION_FUNCTIONS = ["validateInput", "resolveAgents", "resolveLimits", "repository"];
/** The verdicts a workflow stage routes on: its child run's terminal outcome. */
export const WORKFLOW_VERDICTS = ["completed", "failed", "exhausted", "cancelled"] as const;

/**
 * Validates a definition's static shape before any input is read: schema
 * version, ids, unique stage and check ids across both kinds, declared agents,
 * start and round stages, function members, a safe artifact basename, an edge
 * entry for every stage and check naming only known ids or outcomes, and no
 * cycle made only of checks (a check has no visit bound). Returns one detail
 * per problem and never throws.
 */
export function validateWorkflowDefinition<Input = unknown>(
  value: unknown,
): ValidateDefinitionResult<Input> {
  const details: RejectionDetail[] = [];
  const fail = (field: string, message: string) => details.push({ field, message });
  if (!isPlainObject(value)) {
    return { ok: false, details: [{ field: "definition", message: "must be an object" }] };
  }
  if (value["schemaVersion"] !== 1) fail("schemaVersion", "must be 1");
  for (const field of ["name", "version"]) {
    if (!isId(value[field])) fail(field, "must be a valid id");
  }
  for (const field of DEFINITION_FUNCTIONS) {
    if (typeof value[field] !== "function") fail(field, "must be a function");
  }
  const access = value["checkout"];
  if (access !== undefined && access !== "any" && access !== "writable")
    fail("checkout", 'must be "any" or "writable"');
  if (value["inputArtifacts"] !== undefined && typeof value["inputArtifacts"] !== "function")
    fail("inputArtifacts", "must be a function");
  const limitDefaults = value["limitDefaults"];
  if (limitDefaults !== undefined) {
    if (!isPlainObject(limitDefaults)) {
      fail("limitDefaults", "must be an object of limit values");
    } else {
      for (const [key, raw] of Object.entries(limitDefaults)) {
        if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
          fail(`limitDefaults.${key}`, "is not a limit");
          continue;
        }
        const [min, max] =
          key === "maxFormatRepairs"
            ? [0, MAX_COUNT_LIMIT]
            : key.endsWith("Ms")
              ? [1, MAX_DURATION_LIMIT_MS]
              : [1, MAX_COUNT_LIMIT];
        if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min || raw > max)
          fail(`limitDefaults.${key}`, `must be an integer between ${min} and ${max}`);
      }
    }
  }

  const agentIds = new Set<string>();
  const agents = value["agents"];
  // A definition whose steps are all workflows has no agents of its own (composition).
  const composite =
    Array.isArray(value["stages"]) &&
    value["stages"].some((stage) => isPlainObject(stage) && stage["kind"] === "workflow");
  if (!Array.isArray(agents) || (agents.length === 0 && !composite)) {
    fail("agents", "must be a non-empty array");
  } else {
    for (const [index, agent] of agents.entries()) {
      const path = `agents[${index}]`;
      if (!isPlainObject(agent)) {
        fail(path, "must be an object");
        continue;
      }
      if (!isId(agent["agentId"])) fail(`${path}.agentId`, "must be a valid id");
      else if (agentIds.has(agent["agentId"]))
        fail(`${path}.agentId`, `duplicates agent ${agent["agentId"]}`);
      else agentIds.add(agent["agentId"]);
      if (!isId(agent["role"])) fail(`${path}.role`, "must be a valid id");
    }
  }

  const agentStages = new Set<string>();
  const workflowStages = new Set<string>();
  const checks = new Set<string>();
  const taken = (id: string) => agentStages.has(id) || checks.has(id) || workflowStages.has(id);
  const stages = value["stages"];
  if (!Array.isArray(stages) || stages.length === 0) {
    fail("stages", "must be a non-empty array");
  } else {
    for (const [index, stage] of stages.entries()) {
      const path = `stages[${index}]`;
      if (!isPlainObject(stage)) {
        fail(path, "must be an object");
        continue;
      }
      if (stage["kind"] === "agent") {
        const id = stage["stageId"];
        if (!isId(id)) fail(`${path}.stageId`, "must be a valid id");
        else if (taken(id)) fail(`${path}.stageId`, `duplicates stage or check ${id}`);
        else agentStages.add(id);
        if (!isId(stage["agentId"]) || !agentIds.has(stage["agentId"])) {
          fail(`${path}.agentId`, "must name a declared agent");
        }
        verdictsProblem(stage["verdicts"], `${path}.verdicts`, fail);
        const file = stage["artifactFile"];
        if (
          typeof file !== "string" ||
          !ARTIFACT_FILE_PATTERN.test(file) ||
          file === "." ||
          file === ".."
        ) {
          fail(`${path}.artifactFile`, "must be a single safe file name");
        }
        if (stage["onFailedStatus"] !== "fail" && stage["onFailedStatus"] !== "retry") {
          fail(`${path}.onFailedStatus`, 'must be "fail" or "retry"');
        }
        if (typeof stage["bindsRevision"] !== "boolean")
          fail(`${path}.bindsRevision`, "must be a boolean");
        const marker = stage["artifactVerdictMarker"];
        if (marker !== undefined && !isVerdictMarker(marker)) {
          fail(
            `${path}.artifactVerdictMarker`,
            `must be a non-empty single-line string of at most ${MAX_VERDICT_MARKER} characters`,
          );
        }
        for (const field of ["request", "next"]) {
          if (typeof stage[field] !== "function") fail(`${path}.${field}`, "must be a function");
        }
      } else if (stage["kind"] === "check") {
        const id = stage["checkId"];
        if (!isId(id)) fail(`${path}.checkId`, "must be a valid id");
        else if (taken(id)) fail(`${path}.checkId`, `duplicates stage or check ${id}`);
        else checks.add(id);
        for (const field of ["command", "next"]) {
          if (typeof stage[field] !== "function") fail(`${path}.${field}`, "must be a function");
        }
      } else if (stage["kind"] === "workflow") {
        const id = stage["stageId"];
        if (!isId(id)) fail(`${path}.stageId`, "must be a valid id");
        else if (taken(id)) fail(`${path}.stageId`, `duplicates stage or check ${id}`);
        else workflowStages.add(id);
        const workflow = stage["workflow"];
        if (!isPlainObject(workflow) || !isId(workflow["name"]))
          fail(`${path}.workflow`, "must be { name: a workflow name }");
        for (const field of ["input", "next"]) {
          if (typeof stage[field] !== "function") fail(`${path}.${field}`, "must be a function");
        }
      } else {
        fail(`${path}.kind`, 'must be "agent", "check" or "workflow"');
      }
    }
  }

  const steps = (id: unknown) =>
    typeof id === "string" && (agentStages.has(id) || workflowStages.has(id));
  if (!steps(value["start"])) fail("start", "must name an agent or workflow stage");
  const roundStage = value["roundStage"];
  if (roundStage !== null && !steps(roundStage)) {
    fail("roundStage", "must be null or name an agent or workflow stage");
  }

  const edges = value["edges"];
  if (!isPlainObject(edges)) {
    fail("edges", "must be an object");
  } else {
    const known = new Set([...agentStages, ...checks, ...workflowStages]);
    for (const key of Object.keys(edges)) {
      if (!known.has(key)) fail(`edges.${key}`, "names no stage or check");
    }
    for (const id of known) {
      const targets = Object.hasOwn(edges, id) ? edges[id] : undefined;
      if (!Array.isArray(targets) || targets.length === 0) {
        fail(`edges.${id}`, "must list at least one next stage, check or outcome");
        continue;
      }
      for (const [index, target] of targets.entries()) {
        if (typeof target !== "string" || (!known.has(target) && !OUTCOME_TARGETS.has(target))) {
          fail(`edges.${id}[${index}]`, `names no stage, check or outcome (${String(target)})`);
        }
      }
    }
    const cycle = checkOnlyCycle(checks, edges);
    if (cycle !== undefined) {
      fail("edges", `checks ${cycle.join(" → ")} form a cycle without an agent stage`);
    }
  }

  if (details.length > 0) return { ok: false, details };
  return { ok: true, definition: value as unknown as WorkflowDefinition<Input> };
}

function verdictsProblem(
  verdicts: unknown,
  path: string,
  fail: (field: string, message: string) => void,
): void {
  if (!Array.isArray(verdicts)) {
    fail(path, "must be an array of strings");
    return;
  }
  const seen = new Set<string>();
  for (const [index, verdict] of verdicts.entries()) {
    if (typeof verdict !== "string" || verdict === "" || seen.has(verdict)) {
      fail(`${path}[${index}]`, "must be a unique non-empty string");
    } else {
      seen.add(verdict);
    }
  }
}

/** A cycle through check ids only, following edges between checks; undefined when none. */
function checkOnlyCycle(checks: Set<string>, edges: Record<string, unknown>): string[] | undefined {
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    state.set(id, "visiting");
    path.push(id);
    const targets = edges[id];
    for (const target of Array.isArray(targets) ? targets : []) {
      if (typeof target !== "string" || !checks.has(target)) continue;
      if (state.get(target) === "visiting") return [...path.slice(path.indexOf(target)), target];
      if (state.get(target) === undefined) {
        const found = visit(target);
        if (found !== undefined) return found;
      }
    }
    path.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const id of checks) {
    if (state.get(id) === undefined) {
      const found = visit(id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export type TransitionProblem =
  | { reason: "transition_undeclared"; message: string }
  | { reason: "definition_contract_violated"; message: string };

const MAX_TRANSITION_REASON = 200;

/**
 * Checks a transition returned by a definition's `next` against its contract
 * and the static edges of `from`: a pass/reject decision with a short reason,
 * exactly one of `to` and `outcome`, `completed` only from pass and `failed`
 * only from reject (definition_contract_violated), and a target listed in
 * `edges[from]` (transition_undeclared).
 */
export function transitionProblem(
  definition: WorkflowDefinition<unknown>,
  from: string,
  transition: unknown,
): TransitionProblem | undefined {
  const contract = (message: string): TransitionProblem => ({
    reason: "definition_contract_violated",
    message: `${from}: ${message}`,
  });
  if (!isPlainObject(transition)) return contract("next returned no transition object");
  const decision = transition["decision"];
  const reason = transition["reason"];
  if (decision !== "pass" && decision !== "reject")
    return contract('decision must be "pass" or "reject"');
  if (typeof reason !== "string" || reason === "" || reason.length > MAX_TRANSITION_REASON) {
    return contract(
      `reason must be a non-empty string of at most ${MAX_TRANSITION_REASON} characters`,
    );
  }
  const hasTo = Object.hasOwn(transition, "to");
  const hasOutcome = Object.hasOwn(transition, "outcome");
  if (hasTo === hasOutcome) return contract("a transition names exactly one of to and outcome");
  const allowed = definition.edges[from] ?? [];
  if (hasOutcome) {
    const outcome = transition["outcome"];
    if (outcome !== "completed" && outcome !== "failed")
      return contract('outcome must be "completed" or "failed"');
    if ((outcome === "completed") !== (decision === "pass")) {
      return contract(`outcome ${outcome} cannot follow decision ${decision}`);
    }
    if (!allowed.includes(outcome)) {
      return { reason: "transition_undeclared", message: `${from} → ${outcome} is not in edges` };
    }
    return undefined;
  }
  const to = transition["to"];
  const requires = transition["requires"];
  if (typeof to !== "string") return contract("to must be a stage or check id");
  if (requires !== undefined && requires !== "round")
    return contract('requires must be "round" when given');
  if (requires === "round" && definition.roundStage === null)
    return contract('requires "round" needs a roundStage, and this definition declares none');
  if (!allowed.includes(to) || OUTCOME_TARGETS.has(to)) {
    return { reason: "transition_undeclared", message: `${from} → ${to} is not in edges` };
  }
  return undefined;
}

/**
 * Checks a value an agent stage's `request()` returned against `StageRequest`:
 * `{goal: string, instructions: string, inputs: InputRef[]}` plus the optional
 * `task` and `roleInstructions`. Returns the first problem, or undefined.
 */
export function stageRequestProblem(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "returned no request object";
  if (typeof value["goal"] !== "string") return "goal must be a string";
  if (typeof value["instructions"] !== "string") return "instructions must be a string";
  const inputs = value["inputs"];
  if (!Array.isArray(inputs)) return "inputs must be an array";
  for (const [index, ref] of inputs.entries()) {
    if (!isPlainObject(ref) || typeof ref["label"] !== "string" || ref["label"] === "")
      return `inputs[${index}] must be { label: non-empty string, from }`;
    const from = ref["from"];
    const keys = isPlainObject(from) ? Object.keys(from).toSorted() : [];
    const valid =
      isPlainObject(from) &&
      ((keys.length === 1 && keys[0] === "stageId" && typeof from["stageId"] === "string") ||
        (keys.length === 2 &&
          keys[0] === "artifact" &&
          keys[1] === "stageId" &&
          typeof from["stageId"] === "string" &&
          typeof from["artifact"] === "string") ||
        (keys.length === 1 && keys[0] === "checkId" && typeof from["checkId"] === "string") ||
        (keys.length === 1 && keys[0] === "input" && typeof from["input"] === "string"));
    if (!valid)
      return `inputs[${index}].from must be { stageId: string, artifact?: string }, { checkId: string } or { input: string }`;
  }
  const task = value["task"];
  if (
    task !== undefined &&
    (!isPlainObject(task) ||
      typeof task["title"] !== "string" ||
      typeof task["description"] !== "string" ||
      !Array.isArray(task["acceptanceCriteria"]) ||
      !task["acceptanceCriteria"].every((item) => typeof item === "string"))
  ) {
    return "task must be { title: string, description: string, acceptanceCriteria: string[], context? }";
  }
  if (isPlainObject(task) && task["context"] !== undefined) {
    // The context is rendered as JSON: a non-JSON value is the definition's fault, not the engine's.
    const problem = jsonValueProblem(task["context"], "task.context");
    if (problem !== undefined) return `${problem.field} ${problem.message}`;
  }
  if (value["roleInstructions"] !== undefined && typeof value["roleInstructions"] !== "string")
    return "roleInstructions must be a string";
  return undefined;
}

export function agentStageOf<Input>(
  definition: WorkflowDefinition<Input>,
  id: string,
): AgentStage<Input> | undefined {
  const stage = definition.stages.find((item) => item.kind === "agent" && item.stageId === id);
  return stage?.kind === "agent" ? stage : undefined;
}

export function workflowStageOf<Input>(
  definition: WorkflowDefinition<Input>,
  id: string,
): WorkflowStage<Input> | undefined {
  const stage = definition.stages.find((item) => item.kind === "workflow" && item.stageId === id);
  return stage?.kind === "workflow" ? stage : undefined;
}

export function checkStageOf<Input>(
  definition: WorkflowDefinition<Input>,
  id: string,
): CheckStage<Input> | undefined {
  const stage = definition.stages.find((item) => item.kind === "check" && item.checkId === id);
  return stage?.kind === "check" ? stage : undefined;
}
