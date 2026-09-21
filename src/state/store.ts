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
import { registerRunLocator } from "../inspect/locator.js";
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
import { probeHostEvidence } from "../host/probe.js";
import {
  JOURNAL_FILE,
  JournalFileError,
  appendRecord,
  createJournal,
  inspectJournalPath,
  readJournal,
} from "../journal/journal.js";
import type {
  CancelSource,
  HostClaimedRecord,
  HostExitedRecord,
  HostLostRecord,
  ObservationLostRecord,
  ObservationRecoveredRecord,
  RunCancelRequestedRecord,
} from "../journal/lifecycle-records.js";
import { withJournalLock, type LockOptions } from "../journal/lock.js";
import {
  CONFIG_FILE,
  INPUT_FILE,
  type AgentAssignedRecord,
  type JournalRecord,
  type NewJournalRecord,
  type RequestDispatchedRecord,
  type RunOpenedRecord,
  type RunTerminatedRecord,
} from "../journal/records.js";
import { writeAll } from "../journal/write-all.js";
import { candidateRecord, refuseAppend, replay, type RunState } from "./reducer.js";

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
  /**
   * Resolved configuration to persist as `<runDir>/config.json` (mode 0444, p4)
   * with its sha256 and size on run.opened. Nothing reads it back to run the
   * workflow; it records what the run was admitted with.
   */
  configuration?: unknown;
  /**
   * The run host's claim. `host.claimed` is then appended right after
   * `run.opened` under the same journal lock, so no other writer (a cancel) can
   * come between the two and leave a hosted run without its host records.
   */
  host?: Omit<HostClaimedInput, keyof StoreInput>;
  lock?: LockOptions;
}

/** `openRun`'s outcome: `run.opened` as `record`, plus the `host.claimed` written with it. */
export type OpenRunOutcome =
  | (Extract<StoreOutcome<RunOpenedRecord>, { outcome: "recorded" }> & {
      hostClaimed: HostClaimedRecord | null;
    })
  | Extract<StoreOutcome<RunOpenedRecord>, { outcome: "rejected" }>;

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

export interface CancelRunInput extends StoreInput {
  /** Who asked: recorded on run.cancel_requested. */
  source: CancelSource;
  reason: string;
  /**
   * Probe the run host before cancelling and journal `host.lost` when it is
   * lost (default true). The scheduler cancelling its own run passes false: it
   * is the host, and it is alive.
   */
  probeHost?: boolean;
}

export type CancelRunOutcome =
  | (Extract<StoreOutcome<RunTerminatedRecord>, { outcome: "recorded" }> & {
      cancelRequest: RunCancelRequestedRecord;
      hostLost: HostLostRecord | null;
    })
  | Extract<StoreOutcome<RunTerminatedRecord>, { outcome: "rejected" }>;

export interface HostClaimedInput extends StoreInput {
  pid: number;
  hostname: string;
  startedAt: string;
  heartbeatMs: number;
  paneId: string | null;
  workspaceId: string | null;
}

export interface HostExitedInput extends StoreInput {
  pid: number;
  exitCode: number;
  reason: string;
}

export interface ObservationLostInput extends StoreInput {
  agentId: string;
  code: string;
  message: string;
  terminalId: string | null;
}

export interface ObservationRecoveredInput extends StoreInput {
  agentId: string;
  lostSeq: number;
  terminalId: string | null;
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
 * content is `run_exists`. With `host`, `host.claimed` follows `run.opened`
 * under the same lock and is returned as `hostClaimed`.
 */
export async function openRun(input: OpenRunInput): Promise<OpenRunOutcome> {
  if (typeof input.runDir !== "string" || input.runDir === "") {
    throw new TypeError("runDir must be a non-empty path");
  }
  if (!isId(input.runId)) throw new TypeError("runId must be a valid id");
  const validated = validateRunPlan(input.plan);
  if (!validated.ok) {
    return rejected("plan_invalid", "run plan is invalid", validated.details);
  }
  const claim: NewJournalRecord | undefined =
    input.host === undefined
      ? undefined
      : {
          type: "host.claimed",
          pid: input.host.pid,
          hostname: input.host.hostname,
          startedAt: input.host.startedAt,
          heartbeatMs: input.host.heartbeatMs,
          paneId: input.host.paneId,
          workspaceId: input.host.workspaceId,
        };
  // Field contract first, outside the lock: a malformed fact is an engine bug.
  if (claim !== undefined) candidateRecord([], claim);
  const runDir = resolve(input.runDir);
  try {
    mkdirSync(runDir, { recursive: true });
  } catch (error) {
    return rejected(
      "journal_write_failed",
      `cannot create run directory: ${(error as Error).message}`,
    );
  }

  const result = await locked<[RunOpenedRecord, HostClaimedRecord | null]>(
    runDir,
    () => {
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
        const written = writeRunFile(runDir, INPUT_FILE, bytes);
        if (written !== undefined) return rejected("run_exists", written);
        inputRef = { path: INPUT_FILE, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
      }
      let configRef: RunOpenedRecord["config"];
      if (input.configuration !== undefined) {
        const bytes = Buffer.from(`${JSON.stringify(input.configuration, null, 2)}\n`, "utf8");
        const written = writeRunFile(runDir, CONFIG_FILE, bytes);
        if (written !== undefined) return rejected("run_exists", written);
        configRef = { path: CONFIG_FILE, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
      }
      const record = appendRecord(runDir, records, {
        type: "run.opened",
        runId: input.runId,
        plan: validated.plan,
        ...(inputRef !== undefined ? { input: inputRef } : {}),
        ...(configRef !== undefined ? { config: configRef } : {}),
      }) as RunOpenedRecord;
      // Same lock as run.opened: a cancel cannot close the run before its host is on record.
      // A host record is never required for the run: a failed write leaves `hostClaimed` null.
      let claimed: HostClaimedRecord | null = null;
      if (claim !== undefined) {
        try {
          claimed = appendRecord(runDir, [record], claim) as HostClaimedRecord;
        } catch {
          claimed = null;
        }
      }
      return { outcome: "recorded", record: [record, claimed], revision: (claimed ?? record).seq };
    },
    input.lock,
  );
  if (result.outcome === "rejected") return result;
  const [opened, hostClaimed] = result.record;
  // The locator index only helps inspectors find the run; it never fails the open.
  registerRunLocator({
    runDir,
    runId: input.runId,
    openedAt: opened.ts,
    workflow: validated.plan.workflow,
    configuration: input.configuration,
  });
  return { outcome: "recorded", record: opened, revision: result.revision, hostClaimed };
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
 * Creates a run file (`input.json`, `config.json`) exclusively without
 * following symlinks. An existing file with identical bytes is kept (a retried
 * open); anything else is refused. Returns a refusal message, or undefined
 * when the file holds `bytes`.
 */
function writeRunFile(runDir: string, name: string, bytes: Buffer): string | undefined {
  const path = join(runDir, name);
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

/**
 * Cancels a run: under one lock it records who asked (`run.cancel_requested`)
 * and then the termination that request leads to (`run.terminated` with outcome
 * `cancelled`), so no other writer can come between the two. When the host
 * probe says the run's host is lost and the journal does not say so yet, the
 * evidence is recorded first as `host.lost`: this is the first locked writer to
 * act on that run. A run that already terminated is `run_closed` and records
 * nothing.
 */
export async function cancelRun(input: CancelRunInput): Promise<CancelRunOutcome> {
  const request: NewJournalRecord = {
    type: "run.cancel_requested",
    source: input.source,
    reason: input.reason,
  };
  const termination: NewJournalRecord = {
    type: "run.terminated",
    outcome: "cancelled",
    reason: input.reason,
  };
  candidateRecord([], request);
  candidateRecord([], termination);
  const outcome = await appendFacts(input, (state, runDir) => {
    if (state.termination !== undefined || input.probeHost === false) return [request, termination];
    if (state.host.exited !== undefined || state.host.lost !== undefined) {
      return [request, termination];
    }
    const probed = probeHostEvidence(runDir);
    if (probed.owner !== "lost") return [request, termination];
    const lost: NewJournalRecord = {
      type: "host.lost",
      pid: probed.host?.pid ?? null,
      heartbeatAt: probed.host?.heartbeatAt ?? null,
      reason: (probed.lostReason ?? "heartbeat_stale").slice(0, 500),
      detectedBy: input.source,
    };
    return [lost, request, termination];
  });
  if (outcome.outcome === "rejected") return outcome;
  const written = outcome.records;
  const terminated = written.at(-1) as RunTerminatedRecord;
  return {
    outcome: "recorded",
    record: terminated,
    revision: terminated.seq,
    cancelRequest: written.at(-2) as RunCancelRequestedRecord,
    hostLost: written.length === 3 ? (written[0] as HostLostRecord) : null,
  };
}

/** Records that this process hosts the run (the host writes it once the run is open). */
export async function recordHostClaimed(
  input: HostClaimedInput,
): Promise<StoreOutcome<HostClaimedRecord>> {
  return appendFact<HostClaimedRecord>(input, {
    type: "host.claimed",
    pid: input.pid,
    hostname: input.hostname,
    startedAt: input.startedAt,
    heartbeatMs: input.heartbeatMs,
    paneId: input.paneId,
    workspaceId: input.workspaceId,
  });
}

/** Records the host's own exit; the one fact allowed after run.terminated. */
export async function recordHostExited(
  input: HostExitedInput,
): Promise<StoreOutcome<HostExitedRecord>> {
  return appendFact<HostExitedRecord>(input, {
    type: "host.exited",
    pid: input.pid,
    exitCode: input.exitCode,
    reason: input.reason,
  });
}

/** Records that the scheduler stopped seeing an agent's runtime state (a transition, not a sample). */
export async function recordObservationLost(
  input: ObservationLostInput,
): Promise<StoreOutcome<ObservationLostRecord>> {
  return appendFact<ObservationLostRecord>(input, {
    type: "observation.lost",
    agentId: input.agentId,
    code: input.code,
    message: input.message,
    terminalId: input.terminalId,
  });
}

/** Records the first successful observation after an observation.lost. */
export async function recordObservationRecovered(
  input: ObservationRecoveredInput,
): Promise<StoreOutcome<ObservationRecoveredRecord>> {
  return appendFact<ObservationRecoveredRecord>(input, {
    type: "observation.recovered",
    agentId: input.agentId,
    lostSeq: input.lostSeq,
    terminalId: input.terminalId,
  });
}

async function appendFact<R extends JournalRecord>(
  input: StoreInput,
  record: NewJournalRecord,
): Promise<StoreOutcome<R>> {
  // Field contract first, outside the lock: a malformed fact is an engine bug.
  candidateRecord([], record);
  const outcome = await appendFacts(input, () => [record]);
  if (outcome.outcome === "rejected") return outcome;
  return recorded(outcome.records[0] as R);
}

/**
 * Appends the records `plan` returns, in order, under one lock. Each is checked
 * by the reducer against the journal including the ones before it; the first
 * refusal ends the call, and nothing after it is written.
 */
async function appendFacts(
  input: StoreInput,
  plan: (state: RunState, runDir: string) => NewJournalRecord[],
): Promise<
  | { outcome: "recorded"; records: JournalRecord[] }
  | Extract<StoreOutcome<never>, { outcome: "rejected" }>
> {
  if (typeof input.runDir !== "string" || input.runDir === "") {
    throw new TypeError("runDir must be a non-empty path");
  }
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

  const result = await locked<JournalRecord[]>(
    runDir,
    () => {
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
      const written: JournalRecord[] = [];
      for (const record of plan(replayed.state, runDir)) {
        const refusal = refuseAppend(records, record);
        if (refusal !== undefined) {
          const reason = refusal.reason;
          if (reason === "invalid_transition" || reason === "attempt_open_conflict") {
            // Only attempt and submission records produce these; the store writes neither.
            throw new Error(`unexpected reducer refusal ${reason}: ${refusal.message}`);
          }
          return rejected(reason, refusal.message);
        }
        const appended = appendRecord(runDir, records, record);
        records.push(appended);
        written.push(appended);
      }
      return { outcome: "recorded", record: written, revision: written.at(-1)?.seq ?? 0 };
    },
    input.lock,
  );
  return result.outcome === "rejected" ? result : { outcome: "recorded", records: result.record };
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
