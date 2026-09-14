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

export type OverlaidSnapshot = Omit<RunSnapshot, "agents" | "liveness"> & {
  agents: Array<Omit<SnapshotAgent, "runtime"> & { runtime: RuntimeOverlay | null }>;
  liveness: { owner: "unhosted"; runtime: "observed" | "not_observed" };
};

/**
 * Copies a snapshot and fills `agents[].runtime` from the tracker's last
 * accepted observation of each assigned agent's runtime name and pane. The
 * snapshot's journal-derived fields are unchanged: an observed lifecycle never
 * completes, accepts or fails an attempt, and is never written to the journal.
 */
export function overlayRuntime(
  snapshot: RunSnapshot,
  tracker: ObservationTracker,
): OverlaidSnapshot {
  let observed = false;
  const agents = snapshot.agents.map((agent) => {
    const assignment = agent.assignment;
    const last = assignment === null ? undefined : tracker.last(assignment.runtimeName);
    if (assignment === null || last === undefined || last.paneId !== assignment.paneId) {
      return { ...agent, runtime: null };
    }
    observed = true;
    return {
      ...agent,
      runtime: {
        lifecycle: last.lifecycle,
        herdrStatus: last.runtimeStatus,
        observedAt: last.observedAt,
        order: { ...last.order },
      },
    };
  });
  return {
    ...structuredClone(snapshot),
    agents,
    liveness: { owner: "unhosted", runtime: observed ? "observed" : "not_observed" },
  };
}
