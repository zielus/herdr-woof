import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { sha256Hex } from "../contracts/canonical-json.js";
import { isId, type RejectionDetail } from "../contracts/envelope.js";
import type { StoreReason } from "../contracts/reasons.js";
import { validateRunPlan } from "../domain/plan.js";
import type {
  BlockReason,
  DispatchDelivery,
  GateDecision,
  Limits,
  Revision,
  RunPlan,
  TerminalOutcome,
} from "../domain/types.js";
import type {
  CheckResultRecord,
  DeliveryReconciledRecord,
  GateNext,
  GateRecordedRecord,
  GateSubject,
  ObservedState,
  RunBlockedRecord,
  RunUnblockedRecord,
} from "../journal/control-records.js";
import {
  JOURNAL_FILE,
  JournalFileError,
  appendRecord,
  createJournal,
  inspectJournalPath,
  readJournal,
} from "../journal/journal.js";
import { withJournalLock, type LockOptions } from "../journal/lock.js";
import {
  INPUT_FILE,
  type AgentAssignedRecord,
  type JournalRecord,
  type NewJournalRecord,
  type RequestDispatchedRecord,
  type RunOpenedRecord,
  type RunTerminatedRecord,
} from "../journal/records.js";
import { writeAll } from "../journal/write-all.js";
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
  /**
   * Caller input to persist as `<runDir>/input.json` (mode 0444, p3). Its
   * sha256 and size are recorded on run.opened. Must be JSON-serializable.
   */
  input?: unknown;
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
  /** Persisted request file (p3); path is `requests/<stage>/visit-<n>/attempt-<m>/request.md`. */
  request?: { path: string; sha256: string; bytes: number };
  /** Runtime identity observed at dispatch (p3). */
  target?: { terminalId: string | null; sessionId: string | null };
  /** Repository revision when the request was sent (p3). */
  revision?: Revision;
}

export interface RecordGateInput extends StoreInput {
  gate: string;
  kind: "stage" | "check";
  subject: GateSubject;
  decision: GateDecision;
  reason: string;
  round: number;
  next: GateNext;
  revision: Revision;
  /** Required for stage gates: the accepted verdict. */
  verdict?: string | null;
  reviewed?: Revision;
  /** Required for check gates. */
  check?: CheckResultRecord;
}

export interface BlockRunInput extends StoreInput {
  agentId: string;
  reason: BlockReason;
  requiredAction: string;
  observed: ObservedState;
  /** The blocked agent's open attempt, when there is one. */
  attempt?: { stageId: string; visit: number; attempt: number };
}

export interface UnblockRunInput extends StoreInput {
  agentId: string;
  observed: ObservedState;
}

export interface ReconcileDeliveryInput extends StoreInput {
  agentId: string;
  stageId: string;
  visit: number;
  attempt: number;
  dispatchSeq: number;
  resolution: "delivered" | "abandoned";
  evidence: DeliveryReconciledRecord["evidence"];
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
 * journal is opened. With `input`, `<runDir>/input.json` is created exclusively
 * (never through a symlink, mode 0444) before the record is appended, and the
 * record carries its sha256 and size; an existing `input.json` with other
 * content is `run_exists`.
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
      let inputRef: RunOpenedRecord["input"];
      if (input.input !== undefined) {
        const bytes = Buffer.from(`${JSON.stringify(input.input, null, 2)}\n`, "utf8");
        const written = writeInputFile(runDir, bytes);
        if (written !== undefined) return rejected("run_exists", written);
        inputRef = { path: INPUT_FILE, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
      }
      const record = appendRecord(runDir, records, {
        type: "run.opened",
        runId: input.runId,
        plan: validated.plan,
        ...(inputRef !== undefined ? { input: inputRef } : {}),
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
    // Any given value goes to record validation, so a malformed id throws instead of vanishing.
    ...(input.terminalId !== undefined && input.terminalId !== null
      ? { terminalId: input.terminalId }
      : {}),
    ...(input.sessionId !== undefined && input.sessionId !== null
      ? { sessionId: input.sessionId }
      : {}),
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
    ...(input.request !== undefined
      ? {
          request: {
            path: input.request.path,
            sha256: input.request.sha256,
            bytes: input.request.bytes,
          },
        }
      : {}),
    ...(input.target !== undefined
      ? { target: { terminalId: input.target.terminalId, sessionId: input.target.sessionId } }
      : {}),
    ...(input.revision !== undefined ? { revision: copyRevision(input.revision) } : {}),
  });
}

/**
 * Records a gate decision on a journaled acceptance (p3). The store checks
 * only that the record is possible (subject is the latest accepted attempt,
 * gate and verdict agree, no second gate, round order, planned checks); the
 * caller decides the decision and the next step.
 */
export async function recordGate(
  input: RecordGateInput,
): Promise<StoreOutcome<GateRecordedRecord>> {
  return appendFact<GateRecordedRecord>(input, {
    type: "gate.recorded",
    gate: input.gate,
    kind: input.kind,
    subject: {
      stageId: input.subject.stageId,
      visit: input.subject.visit,
      attempt: input.subject.attempt,
      acceptedSeq: input.subject.acceptedSeq,
      receiptId: input.subject.receiptId,
    },
    decision: input.decision,
    reason: input.reason,
    round: input.round,
    next:
      "stageId" in input.next ? { stageId: input.next.stageId } : { outcome: input.next.outcome },
    revision: copyRevision(input.revision),
    ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
    ...(input.reviewed !== undefined ? { reviewed: copyRevision(input.reviewed) } : {}),
    ...(input.check !== undefined
      ? {
          check: {
            command: [...input.check.command],
            exitCode: input.check.exitCode,
            signal: input.check.signal,
            timedOut: input.check.timedOut,
            evidence: {
              path: input.check.evidence.path,
              sha256: input.check.evidence.sha256,
              bytes: input.check.evidence.bytes,
            },
          },
        }
      : {}),
  });
}

/** Records that the run is blocked on an agent, with the observation that showed it (p3). */
export async function blockRun(input: BlockRunInput): Promise<StoreOutcome<RunBlockedRecord>> {
  return appendFact<RunBlockedRecord>(input, {
    type: "run.blocked",
    agentId: input.agentId,
    reason: input.reason,
    requiredAction: input.requiredAction,
    observed: copyObserved(input.observed),
    ...(input.attempt !== undefined
      ? {
          stageId: input.attempt.stageId,
          visit: input.attempt.visit,
          attempt: input.attempt.attempt,
        }
      : {}),
  });
}

/** Records that the blocking agent was observed no longer blocked (p3). */
export async function unblockRun(
  input: UnblockRunInput,
): Promise<StoreOutcome<RunUnblockedRecord>> {
  return appendFact<RunUnblockedRecord>(input, {
    type: "run.unblocked",
    agentId: input.agentId,
    resolution: "observed_unblocked",
    observed: copyObserved(input.observed),
  });
}

/** Resolves one ambiguous dispatch on evidence: delivered, or abandoned at its deadline (p3). */
export async function reconcileDelivery(
  input: ReconcileDeliveryInput,
): Promise<StoreOutcome<DeliveryReconciledRecord>> {
  return appendFact<DeliveryReconciledRecord>(input, {
    type: "delivery.reconciled",
    agentId: input.agentId,
    stageId: input.stageId,
    visit: input.visit,
    attempt: input.attempt,
    dispatchSeq: input.dispatchSeq,
    resolution: input.resolution,
    evidence: input.evidence,
  });
}

function copyRevision(revision: Revision): Revision {
  return { head: revision.head, tree: revision.tree };
}

function copyObserved(observed: ObservedState): ObservedState {
  return {
    runtimeStatus: observed.runtimeStatus,
    terminalId: observed.terminalId,
    stateChangeSeq: observed.stateChangeSeq,
  };
}

/**
 * Creates `input.json` exclusively without following symlinks. An existing file
 * with identical bytes is kept (a retried open); anything else is refused.
 * Returns a refusal message, or undefined when the file holds `bytes`.
 */
function writeInputFile(runDir: string, bytes: Buffer): string | undefined {
  const path = join(runDir, INPUT_FILE);
  const { O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY } = constants;
  let fd: number;
  try {
    fd = openSync(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o444);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let existing: Buffer | undefined;
    try {
      const readFd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
      try {
        existing = readFileSync(readFd);
      } finally {
        closeSync(readFd);
      }
    } catch {
      existing = undefined;
    }
    return existing !== undefined && existing.equals(bytes)
      ? undefined
      : `${path} already exists with other content`;
  }
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
    // The create mode is masked by the umask; the descriptor's mode is set exactly.
    fchmodSync(fd, 0o444);
  } finally {
    closeSync(fd);
  }
  return undefined;
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
