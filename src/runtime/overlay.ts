import { cloneData } from "../contracts/clone.js";
import type { RunSnapshot, SnapshotAgent } from "../state/snapshot.js";
import type { Lifecycle, ObservationOrder } from "./adapter.js";
import type { ObservationTracker } from "./tracker.js";

/** In-memory runtime state laid over a snapshot agent; never persisted. */
export interface RuntimeOverlay {
  lifecycle: Lifecycle;
  herdrStatus: string | null;
  observedAt: string;
  order: ObservationOrder;
}

/** An observation left out because it came from another terminal than the assignment's. */
export interface OverlaySkip {
  agentId: string;
  runtimeName: string;
  assignedTerminalId: string;
  observedTerminalId: string | null;
}

export type OverlaidSnapshot = Omit<RunSnapshot, "agents" | "liveness"> & {
  agents: Array<Omit<SnapshotAgent, "runtime"> & { runtime: RuntimeOverlay | null }>;
  liveness: { owner: "unhosted"; runtime: "observed" | "not_observed" };
  /** Assigned agents whose last observation names another terminal; their `runtime` stays null. */
  skipped: OverlaySkip[];
};

/**
 * Copies a snapshot and fills `agents[].runtime` from the tracker's last
 * accepted observation of each assigned agent's runtime name and pane. The
 * observation is used only when the assignment has no terminal id or names the
 * observation's terminal; otherwise the agent keeps `runtime: null` and is
 * listed in `skipped`. The copy keeps null-prototype dictionaries. The
 * snapshot's journal-derived fields are unchanged: an observed lifecycle never
 * completes, accepts or fails an attempt, and is never written to the journal.
 */
export function overlayRuntime(
  snapshot: RunSnapshot,
  tracker: ObservationTracker,
): OverlaidSnapshot {
  let observed = false;
  const skipped: OverlaySkip[] = [];
  const agents = snapshot.agents.map((agent) => {
    const copy = cloneData(agent);
    const assignment = agent.assignment;
    const last = assignment === null ? undefined : tracker.last(assignment.runtimeName);
    if (assignment === null || last === undefined || last.paneId !== assignment.paneId) {
      return { ...copy, runtime: null };
    }
    if (assignment.terminalId !== null && assignment.terminalId !== last.order.terminalId) {
      skipped.push({
        agentId: agent.agentId,
        runtimeName: assignment.runtimeName,
        assignedTerminalId: assignment.terminalId,
        observedTerminalId: last.order.terminalId,
      });
      return { ...copy, runtime: null };
    }
    observed = true;
    return {
      ...copy,
      runtime: {
        lifecycle: last.lifecycle,
        herdrStatus: last.runtimeStatus,
        observedAt: last.observedAt,
        order: { ...last.order },
      },
    };
  });
  return {
    ...cloneData(snapshot),
    agents,
    liveness: { owner: "unhosted", runtime: observed ? "observed" : "not_observed" },
    skipped,
  };
}
