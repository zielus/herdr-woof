import type {
  AttemptOpenedRecord,
  JournalRecord,
  SubmissionAcceptedRecord,
} from "../journal/records.js";

/**
 * The single journal reducer. Every reader that derives run state from journal
 * records (readJournal, submitResult, openAttempt, the store and snapshots)
 * replays through this module; there is no second reducer.
 */

export type AttemptStatus = "open" | "superseded" | "accepted";

export interface AttemptState {
  opened: AttemptOpenedRecord;
  status: AttemptStatus;
  accepted?: SubmissionAcceptedRecord;
}

export interface RunState {
  runId: string | undefined;
  attempts: Map<string, AttemptState>;
  /** Highest opened (visit, attempt) per stage. */
  latestByStage: Map<string, { visit: number; attempt: number }>;
}

export type ReplayResult =
  { ok: true; state: RunState } | { ok: false; line: number; message: string };

export function attemptKey(stageId: string, visit: number, attempt: number): string {
  return `${stageId}/${visit}/${attempt}`;
}

/** Orders (visit, attempt) pairs lexicographically. */
export function compareAttempts(
  a: { visit: number; attempt: number },
  b: { visit: number; attempt: number },
): number {
  return a.visit === b.visit ? a.attempt - b.attempt : a.visit - b.visit;
}

/** An empty verdict list requires null; otherwise the verdict must be listed. */
export function verdictAllowed(allowed: readonly string[], verdict: string | null): boolean {
  return allowed.length === 0 ? verdict === null : verdict !== null && allowed.includes(verdict);
}

/**
 * Derives attempt state from the journal and rejects impossible transitions:
 * attempts for another run or not newer than the stage's latest, acceptance of
 * an attempt that was never opened, is not open, disagrees with the opened
 * identity or pane, or carries a disallowed verdict, and duplicates that do not
 * match the accepted record they name. Opening a newer attempt supersedes the
 * stage's still-open attempts; accepted attempts stay accepted.
 */
export function replay(records: readonly JournalRecord[]): ReplayResult {
  const state: RunState = { runId: undefined, attempts: new Map(), latestByStage: new Map() };
  const acceptedBySeq = new Map<number, SubmissionAcceptedRecord>();
  for (const record of records) {
    const problem = applyRecord(state, acceptedBySeq, record);
    if (problem !== undefined) return { ok: false, line: record.seq, message: problem };
  }
  return { ok: true, state };
}

function applyRecord(
  state: RunState,
  acceptedBySeq: Map<number, SubmissionAcceptedRecord>,
  record: JournalRecord,
): string | undefined {
  switch (record.type) {
    case "run.opened":
      state.runId = record.runId;
      return undefined;
    case "attempt.opened": {
      if (record.runId !== state.runId) {
        return `attempt.opened belongs to run ${record.runId}, not ${String(state.runId)}`;
      }
      const latest = state.latestByStage.get(record.stageId);
      if (latest !== undefined && compareAttempts(record, latest) <= 0) {
        return `attempt.opened visit ${record.visit} attempt ${record.attempt} is not newer than visit ${latest.visit} attempt ${latest.attempt}`;
      }
      for (const existing of state.attempts.values()) {
        if (existing.opened.stageId === record.stageId && existing.status === "open") {
          existing.status = "superseded";
        }
      }
      state.attempts.set(attemptKey(record.stageId, record.visit, record.attempt), {
        opened: record,
        status: "open",
      });
      state.latestByStage.set(record.stageId, { visit: record.visit, attempt: record.attempt });
      return undefined;
    }
    case "submission.accepted": {
      const attempt = state.attempts.get(attemptKey(record.stageId, record.visit, record.attempt));
      if (attempt === undefined) {
        return "submission.accepted for an attempt that was never opened";
      }
      const opened = attempt.opened;
      if (record.runId !== opened.runId || record.agentId !== opened.agentId) {
        return "submission.accepted identity disagrees with the opened attempt";
      }
      if (
        opened.paneId !== undefined &&
        record.paneId !== undefined &&
        record.paneId !== opened.paneId
      ) {
        return "submission.accepted pane disagrees with the opened attempt";
      }
      if (attempt.status !== "open") {
        return `submission.accepted for an attempt that is already ${attempt.status}`;
      }
      if (!verdictAllowed(opened.verdicts, record.verdict)) {
        return "submission.accepted verdict is not allowed by the opened attempt";
      }
      attempt.status = "accepted";
      attempt.accepted = record;
      acceptedBySeq.set(record.seq, record);
      return undefined;
    }
    case "submission.duplicate": {
      const accepted = acceptedBySeq.get(record.acceptedSeq);
      if (
        accepted === undefined ||
        accepted.receiptId !== record.receiptId ||
        accepted.envelopeDigest !== record.envelopeDigest
      ) {
        return "submission.duplicate does not match the accepted record it names";
      }
      return undefined;
    }
    case "submission.rejected":
      return undefined;
  }
}
