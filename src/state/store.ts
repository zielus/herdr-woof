import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { isId, type RejectionDetail } from "../contracts/envelope.js";
import type { StoreReason } from "../contracts/reasons.js";
import { validateRunPlan } from "../domain/plan.js";
import type { DispatchDelivery, Limits, RunPlan, TerminalOutcome } from "../domain/types.js";
import {
  JOURNAL_FILE,
  JournalFileError,
  appendRecord,
  createJournal,
  inspectJournalPath,
  readJournal,
} from "../journal/journal.js";
import { withJournalLock, type LockOptions } from "../journal/lock.js";
import type {
  AgentAssignedRecord,
  JournalRecord,
  NewJournalRecord,
  RequestDispatchedRecord,
  RunOpenedRecord,
  RunTerminatedRecord,
} from "../journal/records.js";
import { candidateRecord, refuseAppend, replay } from "./reducer.js";

/**
 * State store: SDK functions that record run facts in the journal (p2 contract,
 * unstable until v1). Each takes the journal lock, replays the journal, checks
 * the candidate record with the reducer and appends it only when the journal
 * stays valid.
 *
 * The store records facts and refuses impossible states; it never decides what
 * happens next. It does not open attempts, choose stages, evaluate verdicts,
 * resend requests, enforce limits or turn runtime observations into records.
 * Refusals are returned, not journaled. Input that breaks a record's field
 * contract is an engine bug and throws a TypeError before the lock is taken.
 */

export type StoreOutcome<R> =
  | { outcome: "recorded"; record: R; revision: number }
  | { outcome: "rejected"; reason: StoreReason; message: string; details: RejectionDetail[] };

interface StoreInput {
  runDir: string;
  /** When given, the journal must belong to this run (`run_mismatch`). */
  runId?: string;
  lock?: LockOptions;
}

export interface OpenRunInput {
  runDir: string;
  runId: string;
  plan: RunPlan;
  lock?: LockOptions;
}

export interface AssignAgentInput extends StoreInput {
  agentId: string;
  runtime: { adapter: string; runtimeName: string; paneId: string };
  terminalId?: string | null;
  sessionId?: string | null;
}

export interface RecordDispatchInput extends StoreInput {
  agentId: string;
  stageId: string;
  visit: number;
  attempt: number;
  delivery: DispatchDelivery;
  /** Closed per delivery; see DISPATCH_REASONS. */
  reason: string;
  paneId?: string;
}

export interface TerminateRunInput extends StoreInput {
  outcome: TerminalOutcome;
  reason: string;
  /** Required exactly when outcome is "exhausted". */
  limit?: keyof Limits;
}

/**
 * Creates `<runDir>/journal.jsonl` with a `run.opened` record carrying the
 * validated plan. Refuses `plan_invalid` (one detail per field) and
 * `run_exists` when the journal already holds records. An existing empty
 * journal is opened.
 */
export async function openRun(input: OpenRunInput): Promise<StoreOutcome<RunOpenedRecord>> {
  if (typeof input.runDir !== "string" || input.runDir === "") {
    throw new TypeError("runDir must be a non-empty path");
  }
  if (!isId(input.runId)) throw new TypeError("runId must be a valid id");
  const validated = validateRunPlan(input.plan);
  if (!validated.ok) {
    return rejected("plan_invalid", "run plan is invalid", validated.details);
  }
  const runDir = resolve(input.runDir);
  try {
    mkdirSync(runDir, { recursive: true });
  } catch (error) {
    return rejected(
      "journal_write_failed",
      `cannot create run directory: ${(error as Error).message}`,
    );
  }

  return locked(
    runDir,
    (): StoreOutcome<RunOpenedRecord> => {
      const entry = inspectJournalPath(join(runDir, JOURNAL_FILE));
      if (entry instanceof JournalFileError) return rejected("journal_corrupt", entry.message);
      let records: JournalRecord[] = [];
      if (entry === "regular") {
        const read = readJournal(runDir);
        if (!read.ok) return readFailure(read.reason, read.message);
        records = read.records;
        if (records.length > 0) {
          const existing = records[0]?.type === "run.opened" ? records[0].runId : "unknown";
          return rejected("run_exists", `${runDir} already holds run ${existing}`);
        }
      } else {
        createJournal(runDir);
      }
      const record = appendRecord(runDir, records, {
        type: "run.opened",
        runId: input.runId,
        plan: validated.plan,
      });
      return recorded(record as RunOpenedRecord);
    },
    input.lock,
  );
}

/** Records that an agent runs in a runtime pane. A later assignment on another pane is a replacement. */
export async function assignAgent(
  input: AssignAgentInput,
): Promise<StoreOutcome<AgentAssignedRecord>> {
  return appendFact<AgentAssignedRecord>(input, {
    type: "agent.assigned",
    agentId: input.agentId,
    runtime: {
      adapter: input.runtime.adapter,
      runtimeName: input.runtime.runtimeName,
      paneId: input.runtime.paneId,
    },
    ...(typeof input.terminalId === "string" ? { terminalId: input.terminalId } : {}),
    ...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
  });
}

/**
 * Records the delivery certainty of the one request sent for an attempt. A
 * second dispatch for the same attempt is refused (`dispatch_exists`): trying
 * again is only expressible as a new, explicitly opened attempt.
 */
export async function recordDispatch(
  input: RecordDispatchInput,
): Promise<StoreOutcome<RequestDispatchedRecord>> {
  return appendFact<RequestDispatchedRecord>(input, {
    type: "request.dispatched",
    agentId: input.agentId,
    stageId: input.stageId,
    visit: input.visit,
    attempt: input.attempt,
    delivery: input.delivery,
    reason: input.reason,
    ...(input.paneId !== undefined ? { paneId: input.paneId } : {}),
  });
}

/** Records the run's terminal outcome, once. The caller decides the outcome. */
export async function terminateRun(
  input: TerminateRunInput,
): Promise<StoreOutcome<RunTerminatedRecord>> {
  return appendFact<RunTerminatedRecord>(input, {
    type: "run.terminated",
    outcome: input.outcome,
    reason: input.reason,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
}

async function appendFact<R extends JournalRecord>(
  input: StoreInput,
  record: NewJournalRecord,
): Promise<StoreOutcome<R>> {
  if (typeof input.runDir !== "string" || input.runDir === "") {
    throw new TypeError("runDir must be a non-empty path");
  }
  // Field contract first, outside the lock: a malformed fact is an engine bug.
  candidateRecord([], record);
  const runDir = resolve(input.runDir);
  const journalPath = join(runDir, JOURNAL_FILE);
  let entry: ReturnType<typeof inspectJournalPath>;
  try {
    entry = inspectJournalPath(journalPath);
  } catch (error) {
    return rejected(
      "run_dir_invalid",
      `cannot inspect ${journalPath}: ${(error as Error).message}`,
    );
  }
  if (entry === "missing")
    return rejected("run_dir_invalid", `${runDir} does not contain ${JOURNAL_FILE}`);
  if (entry instanceof JournalFileError) return rejected("journal_corrupt", entry.message);

  return locked(
    runDir,
    (): StoreOutcome<R> => {
      const read = readJournal(runDir);
      if (!read.ok) return readFailure(read.reason, read.message);
      const records = read.records;
      if (records.length === 0) {
        return rejected("run_dir_invalid", `${journalPath} has no run.opened record`);
      }
      const replayed = replay(records);
      if (!replayed.ok) return rejected("journal_corrupt", replayed.message);
      if (input.runId !== undefined && input.runId !== replayed.state.runId) {
        return rejected(
          "run_mismatch",
          `run directory belongs to run ${String(replayed.state.runId)}`,
          [{ field: "runId", message: `expected ${String(replayed.state.runId)}` }],
        );
      }
      const refusal = refuseAppend(records, record);
      if (refusal !== undefined) {
        const reason = refusal.reason;
        if (reason === "invalid_transition" || reason === "attempt_open_conflict") {
          // Only attempt and submission records produce these; the store writes neither.
          throw new Error(`unexpected reducer refusal ${reason}: ${refusal.message}`);
        }
        return rejected(reason, refusal.message);
      }
      return recorded(appendRecord(runDir, records, record) as R);
    },
    input.lock,
  );
}

async function locked<R>(
  runDir: string,
  fn: () => StoreOutcome<R>,
  lock: LockOptions | undefined,
): Promise<StoreOutcome<R>> {
  let result;
  try {
    result = await withJournalLock(
      runDir,
      (): StoreOutcome<R> => {
        try {
          return fn();
        } catch (error) {
          if (error instanceof JournalFileError) return rejected("journal_corrupt", error.message);
          if (error instanceof TypeError || !isFsError(error)) throw error;
          return rejected("journal_write_failed", (error as Error).message);
        }
      },
      lock,
    );
  } catch (error) {
    if (isFsError(error)) {
      return rejected(
        "journal_write_failed",
        `cannot lock the journal: ${(error as Error).message}`,
      );
    }
    throw error;
  }
  return result.ok ? result.value : rejected(result.reason, result.message);
}

function isFsError(error: unknown): boolean {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

function readFailure(reason: "run_dir_invalid" | "journal_corrupt", message: string) {
  return rejected(
    reason === "journal_corrupt" ? "journal_corrupt" : "journal_write_failed",
    message,
  );
}

function recorded<R extends JournalRecord>(record: R): StoreOutcome<R> {
  return { outcome: "recorded", record, revision: record.seq };
}

function rejected(
  reason: StoreReason,
  message: string,
  details: RejectionDetail[] = [],
): { outcome: "rejected"; reason: StoreReason; message: string; details: RejectionDetail[] } {
  return { outcome: "rejected", reason, message, details };
}
