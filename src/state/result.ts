import { join } from "node:path";

import type { Limits, Revision, TerminalOutcome } from "../domain/types.js";
import type { Counters } from "./reducer.js";
import {
  formatCursor,
  parseCursor,
  type RunSnapshot,
  type SnapshotAttempt,
  type SnapshotBlocked,
} from "./snapshot.js";

/**
 * Terminal outcome of a run (p3 contract, unstable until v1), derived only from
 * a terminated snapshot. It names no workflow stage: the approving review is
 * the subject of the last stage gate that bound a revision, and the completion
 * it approved is the subject of the latest other gate that led into that stage.
 */

export interface AcceptedRef {
  stageId: string;
  visit: number;
  attempt: number;
  receiptId: string;
  /** Absolute path of the immutable accepted copy. */
  acceptedPath: string;
  sha256: string;
}

export interface EvidenceRef {
  /** Absolute path of the engine-owned evidence file. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface RunResult {
  schemaVersion: 1;
  kind: "woof.run.result";
  runId: string;
  /** Absolute run directory. */
  runDir: string;
  workflow: { name: string; version: string } | null;
  outcome: TerminalOutcome;
  reason: string;
  limit: keyof Limits | null;
  at: string;
  /** Seq of the run.terminated record. */
  revision: number;
  /** Cursor positioned after run.terminated. */
  cursor: string;
  /** The most recently opened attempt. */
  location: { stageId: string; visit: number; attempt: number } | null;
  repository: { path: string | null; revision: Revision | null };
  counters: Counters;
  blocked: SnapshotBlocked | null;
  artifacts: {
    completion: AcceptedRef | null;
    /** Non-null only when the run completed. */
    review: AcceptedRef | null;
    verification: EvidenceRef | null;
    lastAcceptedByStage: Record<string, AcceptedRef>;
  };
}

export interface DeriveRunResultOptions {
  /** Run directory the snapshot was read from; accepted paths are made absolute against it. */
  runDir: string;
  /** Repository the run worked in, when the caller knows it. */
  repository?: string | null;
}

/** Builds the run result from a terminated snapshot; throws a TypeError for a running one. */
export function deriveRunResult(snapshot: RunSnapshot, options: DeriveRunResultOptions): RunResult {
  const outcome = snapshot.outcome;
  if (outcome === null) throw new TypeError(`run ${snapshot.runId} has not terminated`);
  const anchor = parseCursor(snapshot.cursor)?.anchor;
  if (anchor === undefined) throw new TypeError(`snapshot cursor ${snapshot.cursor} is malformed`);
  const runDir = options.runDir;

  const attempts = new Map<string, SnapshotAttempt & { stageId: string; visit: number }>();
  let location: RunResult["location"] = null;
  let locationSeq = 0;
  for (const stage of snapshot.stages) {
    for (const visit of stage.visits) {
      for (const attempt of visit.attempts) {
        attempts.set(`${stage.stageId}/${visit.visit}/${attempt.attempt}`, {
          ...attempt,
          stageId: stage.stageId,
          visit: visit.visit,
        });
        if (attempt.seq > locationSeq) {
          locationSeq = attempt.seq;
          location = { stageId: stage.stageId, visit: visit.visit, attempt: attempt.attempt };
        }
      }
    }
  }
  const acceptedRef = (subject: {
    stageId: string;
    visit: number;
    attempt: number;
  }): AcceptedRef | null => {
    const attempt = attempts.get(`${subject.stageId}/${subject.visit}/${subject.attempt}`);
    if (attempt?.accepted === null || attempt === undefined) return null;
    return {
      stageId: subject.stageId,
      visit: subject.visit,
      attempt: subject.attempt,
      receiptId: attempt.accepted.receiptId,
      acceptedPath: join(runDir, attempt.accepted.artifact.acceptedPath),
      sha256: attempt.accepted.artifact.sha256,
    };
  };

  const gates = snapshot.gates;
  const reviewGate = gates.findLast((gate) => gate.kind === "stage" && gate.reviewed !== null);
  const entering =
    reviewGate === undefined
      ? undefined
      : gates.findLast(
          (gate) =>
            gate.seq < reviewGate.seq &&
            gate.gate !== reviewGate.gate &&
            "stageId" in gate.next &&
            gate.next.stageId === reviewGate.gate,
        );
  const checkGate = gates.findLast((gate) => gate.kind === "check");

  const lastAcceptedByStage = Object.create(null) as Record<string, AcceptedRef>;
  for (const [stageId, latest] of Object.entries(snapshot.outputs.latestAcceptedByStage)) {
    const ref = acceptedRef(latest);
    if (ref !== null) lastAcceptedByStage[stageId] = ref;
  }

  return {
    schemaVersion: 1,
    kind: "woof.run.result",
    runId: snapshot.runId,
    runDir,
    workflow: snapshot.workflow === null ? null : { ...snapshot.workflow },
    outcome: outcome.outcome,
    reason: outcome.reason,
    limit: outcome.limit,
    at: outcome.at,
    revision: outcome.seq,
    cursor: formatCursor(outcome.seq, anchor),
    location,
    repository: {
      path: options.repository ?? null,
      revision: gates.at(-1)?.revision ?? null,
    },
    counters: snapshot.counters,
    blocked: snapshot.attention.blocked,
    artifacts: {
      completion: entering === undefined ? null : acceptedRef(entering.subject),
      review:
        outcome.outcome === "completed" && reviewGate !== undefined
          ? acceptedRef(reviewGate.subject)
          : null,
      verification:
        checkGate?.check === null || checkGate === undefined
          ? null
          : {
              path: join(runDir, checkGate.check.evidence.path),
              sha256: checkGate.check.evidence.sha256,
              bytes: checkGate.check.evidence.bytes,
            },
      lastAcceptedByStage,
    },
  };
}
