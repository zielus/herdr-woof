import { isAbsolute } from "node:path";

import type { RejectionDetail } from "../contracts/envelope.js";
import { validateRunPlan } from "../domain/plan.js";
import type { AgentSpec, Revision, RunPlan } from "../domain/types.js";
import type { WorkflowDefinition } from "./definition.js";
import { launchArgs } from "./launch.js";
import { revisionOf } from "./revision.js";

/**
 * Workflow admission (p3): everything checked before a run directory or pane
 * exists. Validates the caller input with the definition, requires the
 * repository to be a git work tree, resolves each agent's kind, model and launch
 * arguments through the kind table, and builds the run plan (agent stages,
 * planned checks, limits).
 */

export type AdmissionReason =
  "input_invalid" | "repo_invalid" | "agent_kind_unsupported" | "plan_invalid";

export type AdmissionResult<Input> =
  | { ok: true; input: Input; plan: RunPlan; repository: string; revision: Revision }
  | { ok: false; reason: AdmissionReason; message: string; details: RejectionDetail[] };

export async function admitWorkflow<Input>(options: {
  definition: WorkflowDefinition<Input>;
  input: unknown;
  /** Absolute run directory; agents get write access to it. */
  runDir: string;
}): Promise<AdmissionResult<Input>> {
  const { definition } = options;
  let validated: ReturnType<WorkflowDefinition<Input>["validateInput"]>;
  try {
    validated = definition.validateInput(options.input);
  } catch (error) {
    return reject("input_invalid", `input validation threw: ${(error as Error).message}`);
  }
  if (!validated.ok) {
    return reject("input_invalid", "workflow input is invalid", validated.details);
  }
  const input = validated.input;
  const repository = definition.repository(input);
  if (typeof repository !== "string" || !isAbsolute(repository)) {
    return reject("repo_invalid", "the repository must be an absolute path");
  }
  const revision = await revisionOf(repository);
  if (!revision.ok) return reject("repo_invalid", revision.message);

  const resolved = definition.resolveAgents(input);
  const agents: AgentSpec[] = [];
  for (const { agentId, role } of definition.agents) {
    const agent = resolved[agentId];
    if (agent === undefined) {
      return reject("plan_invalid", `no kind or model resolved for agent ${agentId}`, [
        { field: `agents.${agentId}`, message: "is not resolved" },
      ]);
    }
    const launch = launchArgs({ ...agent, runDir: options.runDir });
    if (!launch.ok) {
      return reject(launch.reason, launch.message, [
        { field: `agents.${agentId}.kind`, message: launch.message },
      ]);
    }
    agents.push({ agentId, role, kind: agent.kind, model: agent.model, args: launch.args });
  }
  const plan = {
    workflow: { name: definition.name, version: definition.version },
    agents,
    stages: definition.stages.flatMap((stage) =>
      stage.kind === "agent"
        ? [{ stageId: stage.stageId, agentId: stage.agentId, verdicts: [...stage.verdicts] }]
        : [],
    ),
    limits: definition.resolveLimits(input),
    checks: definition.stages.flatMap((stage) => (stage.kind === "check" ? [stage.checkId] : [])),
  };
  const checked = validateRunPlan(plan);
  if (!checked.ok)
    return reject("plan_invalid", "the resolved run plan is invalid", checked.details);
  return { ok: true, input, plan: checked.plan, repository, revision: revision.revision };
}

function reject<Input>(
  reason: AdmissionReason,
  message: string,
  details: RejectionDetail[] = [],
): AdmissionResult<Input> {
  return { ok: false, reason, message, details };
}
