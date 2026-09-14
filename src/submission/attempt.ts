import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  isId,
  isPositiveInteger,
  type AttemptIdentity,
  type RejectionDetail,
} from "../contracts/envelope.js";
import type { AttemptOpenReason } from "../contracts/reasons.js";
import {
  JOURNAL_FILE,
  appendRecord,
  compareAttempts,
  readJournal,
  replay,
} from "../journal/journal.js";
import { withJournalLock, type LockOptions } from "../journal/lock.js";
import type { JournalRecord } from "../journal/records.js";

export interface OpenAttemptInput extends AttemptIdentity {
  runDir: string;
  /** Verdicts the submission may carry; empty means the verdict must be null. */
  verdicts?: readonly string[];
  /** Herdr pane expected to submit, compared with the submitter's HERDR_PANE_ID. */
  paneId?: string;
  lock?: LockOptions;
}

export interface OpenedAttempt extends AttemptIdentity {
  seq: number;
  verdicts: string[];
  /** Absolute output directory the worker must write its artifact into. */
  artifactDir: string;
  paneId?: string;
}

export type OpenAttemptOutcome =
  | { outcome: "opened"; attempt: OpenedAttempt }
  | { outcome: "rejected"; reason: AttemptOpenReason; message: string; details: RejectionDetail[] };

/**
 * Declares an open attempt and its owner in the run journal, creating the run
 * directory, journal and `artifacts/<stage>/visit-<n>/attempt-<m>/` as needed.
 * The (visit, attempt) pair must be newer than every attempt already opened for
 * the stage; still-open older attempts become stale. This is dispatcher
 * tooling, not a scheduler. Invalid identity input throws a TypeError.
 */
export async function openAttempt(input: OpenAttemptInput): Promise<OpenAttemptOutcome> {
  validateInput(input);
  const runDir = resolve(input.runDir);
  const verdicts = [...(input.verdicts ?? [])];
  const artifactDir = join(
    "artifacts",
    input.stageId,
    `visit-${input.visit}`,
    `attempt-${input.attempt}`,
  );

  try {
    mkdirSync(runDir, { recursive: true });
  } catch (error) {
    return reject(
      "journal_write_failed",
      `cannot create run directory: ${(error as Error).message}`,
    );
  }

  let locked;
  try {
    locked = await withJournalLock(
      runDir,
      (): OpenAttemptOutcome => {
        let records: JournalRecord[] = [];
        if (existsSync(join(runDir, JOURNAL_FILE))) {
          const read = readJournal(runDir);
          if (!read.ok) {
            return reject(
              read.reason === "journal_corrupt" ? "journal_corrupt" : "journal_write_failed",
              read.message,
            );
          }
          records = read.records;
        }

        const state = replay(records);
        if (state.runId !== undefined && state.runId !== input.runId) {
          return reject("run_mismatch", `run directory belongs to run ${state.runId}`, [
            { field: "runId", message: `expected ${state.runId}` },
          ]);
        }
        const latest = state.latestByStage.get(input.stageId);
        if (latest !== undefined && compareAttempts(input, latest) <= 0) {
          return reject(
            "attempt_open_conflict",
            `stage ${input.stageId} already opened visit ${latest.visit} attempt ${latest.attempt}; a new attempt must be newer`,
            [{ field: "attempt", message: "must be newer than the latest opened attempt" }],
          );
        }

        try {
          mkdirSync(join(runDir, artifactDir), { recursive: true });
          if (records.length === 0) {
            records.push(appendRecord(runDir, records, { type: "run.opened", runId: input.runId }));
          }
          const opened = appendRecord(runDir, records, {
            type: "attempt.opened",
            runId: input.runId,
            agentId: input.agentId,
            stageId: input.stageId,
            visit: input.visit,
            attempt: input.attempt,
            verdicts,
            artifactDir,
            ...(input.paneId !== undefined ? { paneId: input.paneId } : {}),
          });
          return {
            outcome: "opened",
            attempt: {
              runId: input.runId,
              agentId: input.agentId,
              stageId: input.stageId,
              visit: input.visit,
              attempt: input.attempt,
              seq: opened.seq,
              verdicts,
              artifactDir: join(runDir, artifactDir),
              ...(input.paneId !== undefined ? { paneId: input.paneId } : {}),
            },
          };
        } catch (error) {
          return reject("journal_write_failed", (error as Error).message);
        }
      },
      input.lock,
    );
  } catch (error) {
    return reject("journal_write_failed", `cannot lock the journal: ${(error as Error).message}`);
  }
  return locked.ok ? locked.value : reject(locked.reason, locked.message);
}

function validateInput(input: OpenAttemptInput): void {
  const problems: string[] = [];
  for (const field of ["runId", "agentId", "stageId"] as const) {
    if (!isId(input[field])) problems.push(`${field} must be a valid id`);
  }
  for (const field of ["visit", "attempt"] as const) {
    if (!isPositiveInteger(input[field])) problems.push(`${field} must be an integer >= 1`);
  }
  if (typeof input.runDir !== "string" || input.runDir === "") {
    problems.push("runDir must be a non-empty path");
  }
  if (input.verdicts?.some((verdict) => typeof verdict !== "string" || verdict === "")) {
    problems.push("verdicts must be non-empty strings");
  }
  if (input.paneId !== undefined && (typeof input.paneId !== "string" || input.paneId === "")) {
    problems.push("paneId must be a non-empty string");
  }
  if (problems.length > 0) throw new TypeError(problems.join("; "));
}

function reject(
  reason: AttemptOpenReason,
  message: string,
  details: RejectionDetail[] = [],
): OpenAttemptOutcome {
  return { outcome: "rejected", reason, message, details };
}
