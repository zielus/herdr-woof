import { isId, isPlainObject, type RejectionDetail } from "../contracts/envelope.js";
import {
  COUNT_LIMIT_KEYS,
  DURATION_LIMIT_KEYS,
  MAX_COUNT_LIMIT,
  MAX_DURATION_LIMIT_MS,
  type RunPlan,
} from "./types.js";

export type ValidateRunPlanResult =
  { ok: true; plan: RunPlan } | { ok: false; details: RejectionDetail[] };

const PLAN_KEYS = ["workflow", "agents", "stages", "limits"];
const WORKFLOW_KEYS = ["name", "version"];
const AGENT_KEYS = ["agentId", "role", "kind", "model"];
const STAGE_KEYS = ["stageId", "agentId", "verdicts"];

/**
 * Validates a resolved run plan. Every object has an exact key set; ids use
 * the envelope id rule; agent and stage ids are unique; every stage names a
 * planned agent; verdicts are non-empty unique strings; every limit is a safe
 * integer between 1 and its cap. Returns one detail per offending field path
 * and never throws. The returned plan is a copy of the validated fields.
 */
export function validateRunPlan(value: unknown): ValidateRunPlanResult {
  const details: RejectionDetail[] = [];
  const fail = (field: string, message: string) => details.push({ field, message });

  if (!isPlainObject(value)) {
    return { ok: false, details: [{ field: "plan", message: "must be an object" }] };
  }
  exactKeys(value, PLAN_KEYS, "", fail);

  const workflow = value["workflow"];
  if (!isPlainObject(workflow)) {
    fail("workflow", "must be an object with name and version");
  } else {
    exactKeys(workflow, WORKFLOW_KEYS, "workflow.", fail);
    for (const field of WORKFLOW_KEYS) {
      if (!isId(workflow[field])) fail(`workflow.${field}`, "must be a valid id");
    }
  }

  const agentIds = new Set<string>();
  const agents = value["agents"];
  if (!Array.isArray(agents) || agents.length === 0) {
    fail("agents", "must be a non-empty array");
  } else {
    for (const [index, agent] of agents.entries()) {
      const path = `agents[${index}]`;
      if (!isPlainObject(agent)) {
        fail(path, "must be an object");
        continue;
      }
      exactKeys(agent, AGENT_KEYS, `${path}.`, fail);
      const agentId = agent["agentId"];
      if (!isId(agentId)) {
        fail(`${path}.agentId`, "must be a valid id");
      } else if (agentIds.has(agentId)) {
        fail(`${path}.agentId`, `duplicates agent ${agentId}`);
      } else {
        agentIds.add(agentId);
      }
      if (!isId(agent["role"])) fail(`${path}.role`, "must be a valid id");
      if (typeof agent["kind"] !== "string" || agent["kind"] === "") {
        fail(`${path}.kind`, "must be a non-empty string");
      }
      const model = agent["model"];
      if (model !== null && (typeof model !== "string" || model === "")) {
        fail(`${path}.model`, "must be a non-empty string or null");
      }
    }
  }

  const stageIds = new Set<string>();
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
      exactKeys(stage, STAGE_KEYS, `${path}.`, fail);
      const stageId = stage["stageId"];
      if (!isId(stageId)) {
        fail(`${path}.stageId`, "must be a valid id");
      } else if (stageIds.has(stageId)) {
        fail(`${path}.stageId`, `duplicates stage ${stageId}`);
      } else {
        stageIds.add(stageId);
      }
      const agentId = stage["agentId"];
      if (!isId(agentId)) {
        fail(`${path}.agentId`, "must be a valid id");
      } else if (Array.isArray(agents) && !agentIds.has(agentId)) {
        fail(`${path}.agentId`, `names no planned agent (${agentId})`);
      }
      verdictsProblems(stage["verdicts"], `${path}.verdicts`, fail);
    }
  }

  const limits = value["limits"];
  if (!isPlainObject(limits)) {
    fail("limits", "must be an object");
  } else {
    exactKeys(limits, [...COUNT_LIMIT_KEYS, ...DURATION_LIMIT_KEYS], "limits.", fail);
    for (const key of COUNT_LIMIT_KEYS) {
      boundedInteger(limits[key], `limits.${key}`, MAX_COUNT_LIMIT, fail);
    }
    for (const key of DURATION_LIMIT_KEYS) {
      boundedInteger(limits[key], `limits.${key}`, MAX_DURATION_LIMIT_MS, fail);
    }
  }

  if (details.length > 0) return { ok: false, details };
  return { ok: true, plan: copyPlan(value as unknown as RunPlan) };
}

function copyPlan(plan: RunPlan): RunPlan {
  return {
    workflow: { name: plan.workflow.name, version: plan.workflow.version },
    agents: plan.agents.map(({ agentId, role, kind, model }) => ({ agentId, role, kind, model })),
    stages: plan.stages.map(({ stageId, agentId, verdicts }) => ({
      stageId,
      agentId,
      verdicts: [...verdicts],
    })),
    limits: { ...plan.limits },
  };
}

/** Reports unknown keys; each field check reports a missing field itself. */
function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  prefix: string,
  fail: (field: string, message: string) => void,
): void {
  for (const key of Object.keys(value)) {
    if (!required.includes(key)) fail(`${prefix}${key}`, "unknown field");
  }
}

function verdictsProblems(
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
    if (typeof verdict !== "string" || verdict === "") {
      fail(`${path}[${index}]`, "must be a non-empty string");
    } else if (seen.has(verdict)) {
      fail(`${path}[${index}]`, `duplicates verdict ${verdict}`);
    } else {
      seen.add(verdict);
    }
  }
}

function boundedInteger(
  value: unknown,
  path: string,
  max: number,
  fail: (field: string, message: string) => void,
): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    fail(path, `must be an integer between 1 and ${max}`);
  }
}
