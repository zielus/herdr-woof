import { join } from "node:path";

import { readJsonFile } from "../host/files.js";
import type { HostInfo, HostOwner } from "../host/probe.js";
import { deriveRunResult, type RunResult } from "../state/result.js";
import { readSnapshot, type ReadSnapshotResult, type RunSnapshot } from "../state/snapshot.js";

/**
 * Run status (p4 D8, §3.8): a compact, read-only view of one run for callers
 * that wait on it. Derived from the journal snapshot, the host probe the
 * snapshot reader already performs, and the recorded `config.json` (only for
 * the repository the run result names). Takes no lock and never contacts Herdr.
 */

export interface RunStatusView {
  schemaVersion: 1;
  kind: "woof.run.status";
  runId: string;
  runDir: string;
  workflow: RunSnapshot["workflow"];
  status: RunSnapshot["status"];
  openedAt: string;
  updatedAt: string;
  liveness: { owner: HostOwner; host: HostInfo | null };
  activeAttempts: Array<{
    agentId: string;
    stageId: string;
    visit: number;
    attempt: number;
    dispatchedAt: string | null;
  }>;
  lastGate: { gate: string; decision: string; reason: string; round: number; at: string } | null;
  attention: RunSnapshot["attention"];
  counters: RunSnapshot["counters"];
  config: { sha256: string } | null;
  cursor: string;
}

export type ReadRunStatusResult =
  | { ok: true; status: RunStatusView; result: RunResult | null; snapshot: RunSnapshot }
  | Extract<ReadSnapshotResult, { ok: false }>;

/** The status document of a snapshot (pure). */
export function runStatusOf(snapshot: RunSnapshot, runDir: string): RunStatusView {
  const activeAttempts: RunStatusView["activeAttempts"] = [];
  for (const agent of snapshot.agents) {
    const active = agent.activeAttempt;
    if (active === null) continue;
    const attempt = snapshot.stages
      .find((stage) => stage.stageId === active.stageId)
      ?.visits.find((visit) => visit.visit === active.visit)
      ?.attempts.find((item) => item.attempt === active.attempt);
    activeAttempts.push({
      agentId: agent.agentId,
      stageId: active.stageId,
      visit: active.visit,
      attempt: active.attempt,
      dispatchedAt: attempt?.dispatch?.at ?? null,
    });
  }
  const gate = snapshot.gates.at(-1);
  return {
    schemaVersion: 1,
    kind: "woof.run.status",
    runId: snapshot.runId,
    runDir,
    workflow: snapshot.workflow,
    status: snapshot.status,
    openedAt: snapshot.openedAt,
    updatedAt: snapshot.updatedAt,
    liveness: { owner: snapshot.liveness.owner, host: snapshot.liveness.host },
    activeAttempts,
    lastGate:
      gate === undefined
        ? null
        : {
            gate: gate.gate,
            decision: gate.decision,
            reason: gate.reason,
            round: gate.round,
            at: gate.at,
          },
    attention: snapshot.attention,
    counters: snapshot.counters,
    config: snapshot.config === null ? null : { sha256: snapshot.config.sha256 },
    cursor: snapshot.cursor,
  };
}

export function readRunStatus(
  runDir: string,
  options: { verifyArtifacts?: boolean } = {},
): ReadRunStatusResult {
  const read = readSnapshot(runDir, options);
  if (!read.ok) return read;
  const snapshot = read.snapshot;
  let repository: string | null = null;
  if (snapshot.outcome !== null && snapshot.config !== null) {
    const recorded = readJsonFile(join(runDir, "config.json"));
    if (isObject(recorded) && typeof recorded["repository"] === "string")
      repository = recorded["repository"];
  }
  return {
    ok: true,
    status: runStatusOf(snapshot, runDir),
    result: snapshot.outcome === null ? null : deriveRunResult(snapshot, { runDir, repository }),
    snapshot,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
