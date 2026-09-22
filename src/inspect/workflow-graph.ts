import type { RunPlan } from "../domain/types.js";
import type { GraphNode, WorkflowGraph } from "../observe/workflow-graph.js";
import type { WorkflowDefinition } from "../scheduler/definition.js";

/**
 * Deriving the stage graph the human run view draws from a workflow
 * definition. A run plan records stages, agents and checks but no routes; the
 * routes live in the definition's edge table. `graphOf` reads them from a
 * definition whose stages agree with the plan, and returns null otherwise, so
 * the view never draws a map the run did not follow. The graph itself is the
 * renderer's pure input type (`src/observe/workflow-graph.ts`); this module is
 * the only place that knows how a definition becomes one.
 */

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
