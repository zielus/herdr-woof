import type { AttemptCause, DispatchDelivery, RunPlan, RunStatus } from "../domain/types.js";
import {
  parseRecordLine,
  type AgentAssignedRecord,
  type AttemptOpenedRecord,
  type DeliveryReconciledRecord,
  type GateRecordedRecord,
  type JournalRecord,
  type NewJournalRecord,
  type RequestDispatchedRecord,
  type RunBlockedRecord,
  type RunTerminatedRecord,
  type RunUnblockedRecord,
  type SubmissionAcceptedRecord,
} from "../journal/records.js";

/**
 * The single journal reducer. Every reader that derives run state from journal
 * records (readJournal, submitResult, openAttempt, the store, snapshots and
 * events) replays through this module; there is no second reducer.
 *
 * The reducer records facts and refuses impossible states. It never decides
 * what happens next: it does not route stages, evaluate verdicts, enforce
 * limits or resend work.
 */

/** Reducer-level attempt status; `abandoned` is derived only in snapshots. */
export type AttemptStatus = "open" | "superseded" | "accepted";

export interface AttemptState {
  opened: AttemptOpenedRecord;
  status: AttemptStatus;
  accepted?: SubmissionAcceptedRecord;
  /** Journaled submission rejections that named this attempt, by reason. */
  rejections: Record<string, number>;
  /** The same rejections in journal order, with their messages. */
  rejectionLog: Array<{ seq: number; reason: string; message: string }>;
  /** Derived when the attempt opens, from the previous attempt of its visit. */
  cause: AttemptCause;
}

/** A run.blocked record and, once resolved, its run.unblocked record. */
export interface BlockState {
  blocked: RunBlockedRecord;
  unblocked?: RunUnblockedRecord;
}

export interface Counters {
  attemptsOpened: number;
  visitsByStage: Record<string, number>;
  /** Keyed "stageId/visit". */
  attemptsByVisit: Record<string, number>;
  submissionsAccepted: number;
  submissionsDuplicate: number;
  submissionsRejected: number;
  rejectionsByReason: Record<string, number>;
  dispatches: Record<DispatchDelivery, number>;
  replacementsByAgent: Record<string, number>;
  /** Highest gate round recorded. */
  rounds: number;
  gatesByDecision: { pass: number; reject: number };
  gatesByGate: Record<string, number>;
  /** Keyed "stageId/visit". */
  formatRepairsByVisit: Record<string, number>;
  /** Keyed "stageId/visit". */
  workRetriesByVisit: Record<string, number>;
  blocks: number;
  reconciliations: { delivered: number; abandoned: number };
}

export interface RunState {
  runId: string | undefined;
  plan: RunPlan | null;
  openedAt: string | undefined;
  updatedAt: string | undefined;
  /** Seq of the last replayed record; 0 before any record. */
  revision: number;
  attempts: Map<string, AttemptState>;
  /** Highest opened (visit, attempt) per stage. */
  latestByStage: Map<string, { visit: number; attempt: number }>;
  /** Assignment history per agent, oldest first. */
  assignments: Map<string, AgentAssignedRecord[]>;
  /** Dispatch per attempt key; at most one. */
  dispatches: Map<string, RequestDispatchedRecord>;
  acceptedBySeq: Map<number, SubmissionAcceptedRecord>;
  termination: RunTerminatedRecord | undefined;
  /** Gate decisions in journal order. */
  gates: GateRecordedRecord[];
  /** Block history in journal order; the current block is the last one without an unblock. */
  blocks: BlockState[];
  /** Reconciliations by the seq of the ambiguous dispatch they resolve. */
  reconciliations: Map<number, DeliveryReconciledRecord>;
  status: RunStatus;
  counters: Counters;
}

/**
 * Why a record cannot follow the records before it. Store and attempt callers
 * return these names; during a journal read every refusal is `journal_corrupt`.
 * `invalid_transition` covers p1 consistency rules that no engine write can
 * trigger (for example an acceptance that disagrees with its attempt).
 */
export type ReducerReason =
  | "run_exists"
  | "run_mismatch"
  | "run_closed"
  | "agent_unknown"
  | "agent_unassigned"
  | "agent_busy"
  | "assignment_unchanged"
  | "stage_unknown"
  | "attempt_unknown"
  | "owner_mismatch"
  | "verdicts_mismatch"
  | "dispatch_exists"
  | "attempt_open_conflict"
  | "invalid_transition"
  | "gate_subject_unknown"
  | "gate_subject_stale"
  | "gate_mismatch"
  | "gate_exists"
  | "round_invalid"
  | "run_blocked"
  | "not_blocked"
  | "dispatch_not_ambiguous"
  | "reconcile_exists"
  | "assignment_mismatch";

export interface ReplayFailure {
  ok: false;
  line: number;
  message: string;
  reason: ReducerReason;
}

export type ReplayResult = { ok: true; state: RunState } | ReplayFailure;

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

export function emptyRunState(): RunState {
  return {
    runId: undefined,
    plan: null,
    openedAt: undefined,
    updatedAt: undefined,
    revision: 0,
    attempts: new Map(),
    latestByStage: new Map(),
    assignments: new Map(),
    dispatches: new Map(),
    acceptedBySeq: new Map(),
    termination: undefined,
    gates: [],
    blocks: [],
    reconciliations: new Map(),
    status: "created",
    counters: {
      attemptsOpened: 0,
      visitsByStage: dict(),
      attemptsByVisit: dict(),
      submissionsAccepted: 0,
      submissionsDuplicate: 0,
      submissionsRejected: 0,
      rejectionsByReason: dict(),
      dispatches: { started: 0, not_delivered: 0, ambiguous: 0 },
      replacementsByAgent: dict(),
      rounds: 0,
      gatesByDecision: { pass: 0, reject: 0 },
      gatesByGate: dict(),
      formatRepairsByVisit: dict(),
      workRetriesByVisit: dict(),
      blocks: 0,
      reconciliations: { delivered: 0, abandoned: 0 },
    },
  };
}

/**
 * Derives run state from the journal and refuses impossible transitions.
 *
 * p1 rules: attempts for another run or not newer than the stage's latest,
 * acceptance of an attempt that was never opened, is not open, disagrees with
 * the opened identity or pane, or carries a disallowed verdict, and duplicates
 * that do not match the accepted record they name. Opening a newer attempt
 * supersedes the stage's still-open attempts; accepted attempts stay accepted.
 *
 * p2 rules, in check order per record:
 * - run.opened is the first and only run record: a second one is run_exists,
 *   and any other record before it is invalid_transition. `readJournal` checks
 *   line positions too; this keeps `replay`, `deriveSnapshot` and `foldEvents`
 *   from mixing two runs when they are given records that did not come from a
 *   journal read.
 * - attempt.opened: run_mismatch, run_closed, then with a plan stage_unknown,
 *   owner_mismatch (agent is not the stage's agent), verdicts_mismatch (not
 *   the stage's verdict set), then attempt_open_conflict. Limits are never
 *   enforced.
 * - agent.assigned: run_closed, agent_unknown (plan only), agent_busy (the agent
 *   owns an open attempt that was dispatched), assignment_unchanged (same pane
 *   as the current assignment). A later assignment counts as a replacement.
 * - request.dispatched: run_closed, attempt_unknown (never opened),
 *   owner_mismatch, dispatch_exists, attempt_unknown (no longer open),
 *   agent_unassigned.
 * - run.terminated: run_closed when already terminated.
 * - submission.accepted and submission.duplicate: run_closed after termination.
 *
 * p3 rules, in check order per record:
 * - attempt.opened derives `cause` from the previous attempt of the same visit:
 *   none → initial; previous accepted, undispatched, not delivered, or ambiguous
 *   without a `delivered` reconciliation → work_retry; previous started (or
 *   reconciled delivered) and not accepted → format_repair.
 * - request.dispatched: after agent_unassigned, assignment_mismatch when
 *   `target.terminalId` and the current assignment's terminal id are both known
 *   and differ.
 * - gate.recorded: run_closed, gate_subject_unknown (acceptedSeq is not an
 *   acceptance of exactly the subject and receipt), gate_subject_stale (the
 *   subject is not the latest opened attempt of its stage), gate_mismatch (a
 *   stage gate names another stage or verdict; a check gate names a plan stage),
 *   gate_exists (same gate and acceptedSeq), stage_unknown (a plan listing
 *   `checks`: the check gate or `next.stageId` is neither a plan stage nor a
 *   listed check), round_invalid (below the highest round or more than one
 *   above it).
 * - run.blocked: run_closed, agent_unknown (plan), agent_unassigned,
 *   run_blocked (an unresolved block exists), then with attempt fields
 *   attempt_unknown (not open) and owner_mismatch.
 * - run.unblocked: run_closed, not_blocked (no unresolved block by this agent).
 * - delivery.reconciled: run_closed, dispatch_not_ambiguous (dispatchSeq is not
 *   an ambiguous dispatch of exactly this agent and attempt), reconcile_exists.
 * - run.terminated is allowed while blocked; the block stays in history.
 *
 * A plan-less run skips every plan check. Limits are never enforced here.
 */
export function replay(records: readonly JournalRecord[]): ReplayResult {
  const state = emptyRunState();
  for (const record of records) {
    const refusal = applyRecord(state, record);
    if (refusal !== undefined) {
      return { ok: false, line: record.seq, message: refusal[1], reason: refusal[0] };
    }
    state.revision = record.seq;
    state.updatedAt = record.ts;
  }
  state.status = deriveStatus(state);
  return { ok: true, state };
}

/**
 * Checks whether `record` may be appended after `records` (already replayed
 * cleanly). The record is first checked against its field contract; a record
 * that fails it is an engine bug and makes this throw a TypeError. Returns the
 * refusal, or undefined when the append would keep the journal valid.
 */
export function refuseAppend(
  records: readonly JournalRecord[],
  record: NewJournalRecord,
): ReplayFailure | undefined {
  const full = candidateRecord(records, record);
  const replayed = replay([...records, full]);
  return replayed.ok ? undefined : replayed;
}

/**
 * The record `appendRecord` would write next, with a provisional timestamp.
 * Throws a TypeError when it does not satisfy its record field contract.
 */
export function candidateRecord(
  records: readonly JournalRecord[],
  record: NewJournalRecord,
): JournalRecord {
  const full = {
    schemaVersion: 1,
    seq: (records.at(-1)?.seq ?? 0) + 1,
    ts: new Date().toISOString(),
    ...record,
  };
  const parsed = parseRecordLine(JSON.stringify(full));
  if (typeof parsed === "string") throw new TypeError(`invalid ${record.type} record: ${parsed}`);
  return parsed;
}

type Refusal = [ReducerReason, string];

function applyRecord(state: RunState, record: JournalRecord): Refusal | undefined {
  if (record.type !== "run.opened" && state.runId === undefined) {
    return ["invalid_transition", `${record.type} before run.opened`];
  }
  switch (record.type) {
    case "run.opened":
      if (state.runId !== undefined) {
        return [
          "run_exists",
          `run.opened for run ${record.runId} after run ${state.runId} was opened; run.opened must be the first and only run record`,
        ];
      }
      state.runId = record.runId;
      state.plan = record.plan ?? null;
      state.openedAt = record.ts;
      return undefined;
    case "attempt.opened":
      return applyAttemptOpened(state, record);
    case "submission.accepted":
      return applyAccepted(state, record);
    case "submission.duplicate": {
      if (state.termination !== undefined) {
        return ["run_closed", "submission.duplicate after run.terminated"];
      }
      const accepted = state.acceptedBySeq.get(record.acceptedSeq);
      if (
        accepted === undefined ||
        accepted.receiptId !== record.receiptId ||
        accepted.envelopeDigest !== record.envelopeDigest
      ) {
        return [
          "invalid_transition",
          "submission.duplicate does not match the accepted record it names",
        ];
      }
      state.counters.submissionsDuplicate += 1;
      return undefined;
    }
    case "submission.rejected": {
      state.counters.submissionsRejected += 1;
      increment(state.counters.rejectionsByReason, record.reason);
      const identity = record.identity;
      if (identity !== undefined && identity.runId === state.runId) {
        const attempt = state.attempts.get(
          attemptKey(identity.stageId, identity.visit, identity.attempt),
        );
        if (attempt !== undefined) {
          increment(attempt.rejections, record.reason);
          attempt.rejectionLog.push({
            seq: record.seq,
            reason: record.reason,
            message: record.message,
          });
        }
      }
      return undefined;
    }
    case "agent.assigned":
      return applyAssigned(state, record);
    case "request.dispatched":
      return applyDispatched(state, record);
    case "run.terminated":
      if (state.termination !== undefined) {
        return ["run_closed", "run.terminated after run.terminated"];
      }
      state.termination = record;
      return undefined;
    case "gate.recorded":
      return applyGate(state, record);
    case "run.blocked":
      return applyBlocked(state, record);
    case "run.unblocked":
      return applyUnblocked(state, record);
    case "delivery.reconciled":
      return applyReconciled(state, record);
  }
}

function applyAttemptOpened(state: RunState, record: AttemptOpenedRecord): Refusal | undefined {
  if (record.runId !== state.runId) {
    return [
      "run_mismatch",
      `attempt.opened belongs to run ${record.runId}, not ${String(state.runId)}`,
    ];
  }
  if (state.termination !== undefined) {
    return ["run_closed", "attempt.opened after run.terminated"];
  }
  if (state.plan !== null) {
    const stage = state.plan.stages.find((item) => item.stageId === record.stageId);
    if (stage === undefined) {
      return ["stage_unknown", `stage ${record.stageId} is not in the run plan`];
    }
    if (record.agentId !== stage.agentId) {
      return [
        "owner_mismatch",
        `stage ${record.stageId} is planned for agent ${stage.agentId}, not ${record.agentId}`,
      ];
    }
    if (!sameVerdicts(record.verdicts, stage.verdicts)) {
      return [
        "verdicts_mismatch",
        `attempt verdicts [${record.verdicts.join(", ")}] differ from stage ${record.stageId} verdicts [${stage.verdicts.join(", ")}]`,
      ];
    }
  }
  const latest = state.latestByStage.get(record.stageId);
  if (latest !== undefined && compareAttempts(record, latest) <= 0) {
    return [
      "attempt_open_conflict",
      `attempt.opened visit ${record.visit} attempt ${record.attempt} is not newer than visit ${latest.visit} attempt ${latest.attempt}`,
    ];
  }
  const cause = deriveCause(state, record);
  for (const existing of state.attempts.values()) {
    if (existing.opened.stageId === record.stageId && existing.status === "open") {
      existing.status = "superseded";
    }
  }
  state.attempts.set(attemptKey(record.stageId, record.visit, record.attempt), {
    opened: record,
    status: "open",
    rejections: dict(),
    rejectionLog: [],
    cause,
  });
  const counters = state.counters;
  counters.attemptsOpened += 1;
  if (latest === undefined || latest.visit !== record.visit) {
    increment(counters.visitsByStage, record.stageId);
  }
  const visitKey = `${record.stageId}/${record.visit}`;
  increment(counters.attemptsByVisit, visitKey);
  if (cause === "format_repair") increment(counters.formatRepairsByVisit, visitKey);
  if (cause === "work_retry") increment(counters.workRetriesByVisit, visitKey);
  state.latestByStage.set(record.stageId, { visit: record.visit, attempt: record.attempt });
  return undefined;
}

function applyAccepted(state: RunState, record: SubmissionAcceptedRecord): Refusal | undefined {
  if (state.termination !== undefined) {
    return ["run_closed", "submission.accepted after run.terminated"];
  }
  const attempt = state.attempts.get(attemptKey(record.stageId, record.visit, record.attempt));
  if (attempt === undefined) {
    return ["invalid_transition", "submission.accepted for an attempt that was never opened"];
  }
  const opened = attempt.opened;
  if (record.runId !== opened.runId || record.agentId !== opened.agentId) {
    return ["invalid_transition", "submission.accepted identity disagrees with the opened attempt"];
  }
  if (
    opened.paneId !== undefined &&
    record.paneId !== undefined &&
    record.paneId !== opened.paneId
  ) {
    return ["invalid_transition", "submission.accepted pane disagrees with the opened attempt"];
  }
  if (attempt.status !== "open") {
    return [
      "invalid_transition",
      `submission.accepted for an attempt that is already ${attempt.status}`,
    ];
  }
  if (!verdictAllowed(opened.verdicts, record.verdict)) {
    return [
      "invalid_transition",
      "submission.accepted verdict is not allowed by the opened attempt",
    ];
  }
  attempt.status = "accepted";
  attempt.accepted = record;
  state.acceptedBySeq.set(record.seq, record);
  state.counters.submissionsAccepted += 1;
  return undefined;
}

function applyAssigned(state: RunState, record: AgentAssignedRecord): Refusal | undefined {
  if (state.termination !== undefined) {
    return ["run_closed", "agent.assigned after run.terminated"];
  }
  if (state.plan !== null && !state.plan.agents.some((agent) => agent.agentId === record.agentId)) {
    return ["agent_unknown", `agent ${record.agentId} is not in the run plan`];
  }
  const busy = openDispatchedAttempt(state, record.agentId);
  if (busy !== undefined) {
    return [
      "agent_busy",
      `agent ${record.agentId} owns dispatched open attempt ${busy}; it cannot be reassigned`,
    ];
  }
  const history = state.assignments.get(record.agentId);
  const current = history?.at(-1);
  if (current !== undefined && current.runtime.paneId === record.runtime.paneId) {
    return [
      "assignment_unchanged",
      `agent ${record.agentId} is already assigned to pane ${record.runtime.paneId}`,
    ];
  }
  if (history === undefined) {
    state.assignments.set(record.agentId, [record]);
  } else {
    history.push(record);
    increment(state.counters.replacementsByAgent, record.agentId);
  }
  return undefined;
}

function applyDispatched(state: RunState, record: RequestDispatchedRecord): Refusal | undefined {
  if (state.termination !== undefined) {
    return ["run_closed", "request.dispatched after run.terminated"];
  }
  const key = attemptKey(record.stageId, record.visit, record.attempt);
  const attempt = state.attempts.get(key);
  if (attempt === undefined) {
    return ["attempt_unknown", `request.dispatched for attempt ${key}, which was never opened`];
  }
  if (attempt.opened.agentId !== record.agentId) {
    return [
      "owner_mismatch",
      `attempt ${key} is owned by ${attempt.opened.agentId}, not ${record.agentId}`,
    ];
  }
  if (state.dispatches.has(key)) {
    return [
      "dispatch_exists",
      `attempt ${key} was already dispatched; trying again requires a new attempt`,
    ];
  }
  if (attempt.status !== "open") {
    return ["attempt_unknown", `attempt ${key} is ${attempt.status}, not open`];
  }
  const assignment = state.assignments.get(record.agentId)?.at(-1);
  if (assignment === undefined) {
    return ["agent_unassigned", `agent ${record.agentId} has no runtime assignment`];
  }
  const targetTerminal = record.target?.terminalId ?? null;
  if (
    targetTerminal !== null &&
    assignment.terminalId !== undefined &&
    assignment.terminalId !== targetTerminal
  ) {
    return [
      "assignment_mismatch",
      `dispatch target terminal ${targetTerminal} differs from agent ${record.agentId}'s assigned terminal ${assignment.terminalId}`,
    ];
  }
  state.dispatches.set(key, record);
  state.counters.dispatches[record.delivery] += 1;
  return undefined;
}

/** Key of an open attempt owned by the agent that has a dispatch, if any. */
function openDispatchedAttempt(state: RunState, agentId: string): string | undefined {
  for (const [key, attempt] of state.attempts) {
    if (
      attempt.status === "open" &&
      attempt.opened.agentId === agentId &&
      state.dispatches.has(key)
    ) {
      return key;
    }
  }
  return undefined;
}

/** The previous attempt of the same visit decides why a new attempt opens (D5). */
function deriveCause(state: RunState, record: AttemptOpenedRecord): AttemptCause {
  const latest = state.latestByStage.get(record.stageId);
  if (latest === undefined || latest.visit !== record.visit) return "initial";
  const key = attemptKey(record.stageId, latest.visit, latest.attempt);
  if (state.attempts.get(key)?.accepted !== undefined) return "work_retry";
  const dispatch = state.dispatches.get(key);
  if (dispatch === undefined || dispatch.delivery === "not_delivered") return "work_retry";
  if (dispatch.delivery === "started") return "format_repair";
  return state.reconciliations.get(dispatch.seq)?.resolution === "delivered"
    ? "format_repair"
    : "work_retry";
}

function applyGate(state: RunState, record: GateRecordedRecord): Refusal | undefined {
  if (state.termination !== undefined) {
    return ["run_closed", "gate.recorded after run.terminated"];
  }
  const subject = record.subject;
  const accepted = state.acceptedBySeq.get(subject.acceptedSeq);
  if (
    accepted === undefined ||
    accepted.stageId !== subject.stageId ||
    accepted.visit !== subject.visit ||
    accepted.attempt !== subject.attempt ||
    accepted.receiptId !== subject.receiptId
  ) {
    return [
      "gate_subject_unknown",
      `gate ${record.gate} subject seq ${subject.acceptedSeq} is not the acceptance of ${attemptKey(subject.stageId, subject.visit, subject.attempt)} with receipt ${subject.receiptId}`,
    ];
  }
  const latest = state.latestByStage.get(subject.stageId);
  if (latest === undefined || compareAttempts(latest, subject) !== 0) {
    return [
      "gate_subject_stale",
      `gate ${record.gate} subject ${attemptKey(subject.stageId, subject.visit, subject.attempt)} is not the latest opened attempt of its stage`,
    ];
  }
  const plan = state.plan;
  if (record.kind === "stage") {
    if (record.gate !== subject.stageId || record.verdict !== accepted.verdict) {
      return [
        "gate_mismatch",
        `stage gate ${record.gate} must name stage ${subject.stageId} and its accepted verdict`,
      ];
    }
  } else if (plan !== null && plan.stages.some((stage) => stage.stageId === record.gate)) {
    return ["gate_mismatch", `check gate ${record.gate} names a plan stage`];
  }
  if (
    state.gates.some(
      (gate) => gate.gate === record.gate && gate.subject.acceptedSeq === subject.acceptedSeq,
    )
  ) {
    return [
      "gate_exists",
      `gate ${record.gate} was already recorded for acceptance seq ${subject.acceptedSeq}`,
    ];
  }
  const checks = plan?.checks;
  if (plan !== null && checks !== undefined) {
    if (record.kind === "check" && !checks.includes(record.gate)) {
      return ["stage_unknown", `check ${record.gate} is not in the run plan`];
    }
    if (
      "stageId" in record.next &&
      !checks.includes(record.next.stageId) &&
      !plan.stages.some((stage) => stage.stageId === (record.next as { stageId: string }).stageId)
    ) {
      return [
        "stage_unknown",
        `gate next ${record.next.stageId} is neither a plan stage nor a planned check`,
      ];
    }
  }
  const highest = state.counters.rounds;
  if (record.round < highest || record.round > highest + 1) {
    return ["round_invalid", `gate round ${record.round} must be ${highest} or ${highest + 1}`];
  }
  state.gates.push(record);
  const counters = state.counters;
  counters.rounds = record.round;
  counters.gatesByDecision[record.decision] += 1;
  increment(counters.gatesByGate, record.gate);
  return undefined;
}

function applyBlocked(state: RunState, record: RunBlockedRecord): Refusal | undefined {
  if (state.termination !== undefined) {
    return ["run_closed", "run.blocked after run.terminated"];
  }
  if (state.plan !== null && !state.plan.agents.some((agent) => agent.agentId === record.agentId)) {
    return ["agent_unknown", `agent ${record.agentId} is not in the run plan`];
  }
  if (!state.assignments.has(record.agentId)) {
    return ["agent_unassigned", `agent ${record.agentId} has no runtime assignment`];
  }
  const current = currentBlock(state);
  if (current !== undefined) {
    return [
      "run_blocked",
      `the run is already blocked on agent ${current.blocked.agentId} since seq ${current.blocked.seq}`,
    ];
  }
  if (record.stageId !== undefined && record.visit !== undefined && record.attempt !== undefined) {
    const key = attemptKey(record.stageId, record.visit, record.attempt);
    const attempt = state.attempts.get(key);
    if (attempt === undefined || attempt.status !== "open") {
      return ["attempt_unknown", `run.blocked names attempt ${key}, which is not open`];
    }
    if (attempt.opened.agentId !== record.agentId) {
      return [
        "owner_mismatch",
        `attempt ${key} is owned by ${attempt.opened.agentId}, not ${record.agentId}`,
      ];
    }
  }
  state.blocks.push({ blocked: record });
  state.counters.blocks += 1;
  return undefined;
}

function applyUnblocked(state: RunState, record: RunUnblockedRecord): Refusal | undefined {
  if (state.termination !== undefined) {
    return ["run_closed", "run.unblocked after run.terminated"];
  }
  const current = currentBlock(state);
  if (current === undefined || current.blocked.agentId !== record.agentId) {
    return ["not_blocked", `the run is not blocked on agent ${record.agentId}`];
  }
  current.unblocked = record;
  return undefined;
}

function applyReconciled(state: RunState, record: DeliveryReconciledRecord): Refusal | undefined {
  if (state.termination !== undefined) {
    return ["run_closed", "delivery.reconciled after run.terminated"];
  }
  const dispatch = state.dispatches.get(attemptKey(record.stageId, record.visit, record.attempt));
  if (
    dispatch === undefined ||
    dispatch.seq !== record.dispatchSeq ||
    dispatch.delivery !== "ambiguous" ||
    dispatch.agentId !== record.agentId
  ) {
    return [
      "dispatch_not_ambiguous",
      `seq ${record.dispatchSeq} is not an ambiguous dispatch of ${attemptKey(record.stageId, record.visit, record.attempt)} by agent ${record.agentId}`,
    ];
  }
  if (state.reconciliations.has(record.dispatchSeq)) {
    return ["reconcile_exists", `dispatch seq ${record.dispatchSeq} was already reconciled`];
  }
  state.reconciliations.set(record.dispatchSeq, record);
  state.counters.reconciliations[record.resolution] += 1;
  return undefined;
}

/** The unresolved block, if any. */
export function currentBlock(state: RunState): BlockState | undefined {
  const last = state.blocks.at(-1);
  return last !== undefined && last.unblocked === undefined ? last : undefined;
}

function deriveStatus(state: RunState): RunStatus {
  if (state.termination !== undefined) return state.termination.outcome;
  if (currentBlock(state) !== undefined) return "blocked";
  if (state.dispatches.size > 0) return "running";
  if (state.assignments.size > 0) return "starting";
  return "created";
}

/** Same verdict set: equal size and membership, order-insensitive. */
function sameVerdicts(actual: readonly string[], planned: readonly string[]): boolean {
  return (
    actual.length === planned.length &&
    new Set(actual).size === actual.length &&
    actual.every((verdict) => planned.includes(verdict))
  );
}

/**
 * An id-keyed dictionary with no prototype, so ids such as `constructor` or
 * `hasOwnProperty` are ordinary keys. Every id-keyed record in reducer state
 * and snapshots is built with this.
 */
export function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** A null-prototype copy of an id-keyed dictionary. */
export function copyDict<T>(source: Readonly<Record<string, T>>): Record<string, T> {
  const copy = dict<T>();
  for (const key of Object.keys(source)) copy[key] = source[key] as T;
  return copy;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}
