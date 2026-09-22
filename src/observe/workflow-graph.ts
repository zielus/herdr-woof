import type { RunPlan } from "../domain/types.js";
import type { WorkflowDefinition } from "../scheduler/definition.js";

/**
 * The stage graph the human run view draws (pure value). A run plan records
 * stages, agents and checks but no routes; the routes live in the workflow
 * definition's edge table. `graphOf` reads them from a definition whose stages
 * agree with the plan, and returns null otherwise, so the view never draws a
 * map the run did not follow.
 */

export interface GraphNode {
  id: string;
  kind: "agent" | "check";
  /** The gate compares the reviewed revision with the current one (a review). */
  bindsRevision: boolean;
  /** The check command as one line; null for agent stages or when it cannot be resolved. */
  command: string | null;
}

export interface WorkflowGraph {
  start: string;
  /** Entering this stage starts a round; null when the workflow has no rounds. */
  roundStage: string | null;
  nodes: GraphNode[];
  /** Stage or check id → allowed next ids and terminal outcomes, in declaration order. */
  edges: Record<string, string[]>;
}

/**
 * The graph of `definition` for a run planned as `plan`, with check commands
 * resolved from `input` when it validates. Null when the definition's agent
 * stages and checks are not exactly the plan's.
 */
export function graphOf(
  definition: WorkflowDefinition<unknown>,
  plan: {
    stages: ReadonlyArray<Pick<RunPlan["stages"][number], "stageId">>;
    checks?: readonly string[] | null;
  },
  input: unknown,
): WorkflowGraph | null {
  const planStages = new Set(plan.stages.map((stage) => stage.stageId));
  const planChecks = new Set(plan.checks ?? []);
  const agentStages = definition.stages.filter((stage) => stage.kind === "agent");
  const checkStages = definition.stages.filter((stage) => stage.kind === "check");
  if (
    agentStages.length !== planStages.size ||
    checkStages.length !== planChecks.size ||
    !agentStages.every((stage) => planStages.has(stage.stageId)) ||
    !checkStages.every((stage) => planChecks.has(stage.checkId))
  ) {
    return null;
  }
  let validated: unknown;
  let inputOk = false;
  try {
    const result = definition.validateInput(input);
    if (result.ok) {
      validated = result.input;
      inputOk = true;
    }
  } catch {
    inputOk = false;
  }
  const nodes: GraphNode[] = definition.stages.map((stage) => {
    if (stage.kind === "agent") {
      return {
        id: stage.stageId,
        kind: "agent",
        bindsRevision: stage.bindsRevision,
        command: null,
      };
    }
    let command: string | null = null;
    if (inputOk) {
      try {
        const argv = stage.command(validated).argv;
        command = argv.length === 0 ? null : argv.join(" ");
      } catch {
        command = null;
      }
    }
    return { id: stage.checkId, kind: "check", bindsRevision: false, command };
  });
  const edges: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const [from, to] of Object.entries(definition.edges)) edges[from] = [...to];
  return { start: definition.start, roundStage: definition.roundStage, nodes, edges };
}
