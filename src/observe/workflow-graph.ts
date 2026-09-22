/**
 * The stage graph the human run view draws (a pure value, no imports). A run
 * plan records stages, agents and checks but no routes; the routes come from
 * the workflow definition, which the renderer never sees: `graphOf` in
 * `src/inspect/workflow-graph.ts` derives a graph from a definition whose
 * stages agree with the plan, and the caller passes it in. Null draws the
 * plan's stage list instead.
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
