import { isPositiveInteger } from "../contracts/envelope.js";
import type {
  AttemptCause,
  AttemptRef,
  AttemptStatus,
  BlockReason,
  DeliveryState,
  Limits,
  Outcome,
  Revision,
  RunStatus,
} from "../domain/types.js";
import { probeHost, type HostInfo, type HostOwner } from "../host/probe.js";
import { acceptedCopyProblem } from "../journal/accepted-copy.js";
import type {
  CheckResultRecord,
  GateNext,
  GateSubject,
  ObservedState,
} from "../journal/control-records.js";
import { journalAnchor, readJournalPrefixSettled } from "../journal/journal.js";
import type { JournalRecord } from "../journal/records.js";
import {
  attemptKey,
  compareAttempts,
  copyDict,
  currentBlock,
  dict,
  replay,
  type Counters,
  type RunState,
} from "./reducer.js";

/**
 * Run snapshot: an engine-owned document derived only from journal records (p2
 * contract, unstable until v1). It is readable without the journal lock,
 * without Herdr and after the run ended. It never embeds artifact bodies and
 * never reports runtime lifecycle state (`agents[].runtime` is null unless a
 * caller overlays an in-memory observation).
 */

export interface SnapshotAgent {
  agentId: string;
  role: string | null;
  kind: string | null;
  model: string | null;
  /** Resolved launch arguments from the plan; null when the plan has none. */
  args: string[] | null;
  assignment: {
    adapter: string;
    runtimeName: string;
    paneId: string;
    terminalId: string | null;
    sessionId: string | null;
    at: string;
  } | null;
  /** Latest open attempt owned by this agent; null once the run terminated. */
  activeAttempt: AttemptRef | null;
  /** Null in derived snapshots; see overlayRuntime. */
  runtime: null;
}

export interface SnapshotAttempt {
  attempt: number;
  /** Seq of the attempt.opened record. */
  seq: number;
  agentId: string;
  status: AttemptStatus;
  cause: AttemptCause;
  openedAt: string;
  paneId: string | null;
  delivery: DeliveryState;
  /** The dispatch record's seq, time and reason; null while undispatched. */
  dispatch: { seq: number; at: string; reason: string } | null;
  request: { path: string; sha256: string; bytes: number } | null;
  target: { terminalId: string | null; sessionId: string | null } | null;
  /** Repository revision recorded on the dispatch. */
  revision: Revision | null;
  reconciliation: {
    seq: number;
    resolution: "delivered" | "abandoned";
    evidence: string;
    at: string;
  } | null;
  rejections: Record<string, number>;
  /** Journaled rejections naming this attempt, in order. */
  rejectionLog: Array<{ seq: number; reason: string; message: string }>;
  accepted: {
    /** Seq of the submission.accepted record. */
    seq: number;
    receiptId: string;
    status: "completed" | "failed";
    verdict: string | null;
    artifact: { path: string; acceptedPath: string; sha256: string; bytes: number };
    at: string;
  } | null;
}

export interface SnapshotStage {
  stageId: string;
  agentId: string | null;
  verdicts: string[] | null;
  visits: Array<{ visit: number; attempts: SnapshotAttempt[] }>;
}

export interface SnapshotGate {
  seq: number;
  at: string;
  gate: string;
  kind: "stage" | "check";
  subject: GateSubject;
  decision: "pass" | "reject";
  reason: string;
  /** The accepted verdict for stage gates; null for check gates. */
  verdict: string | null;
  round: number;
  next: GateNext;
  revision: Revision;
  reviewed: Revision | null;
  check: CheckResultRecord | null;
}

export interface SnapshotBlocked {
  seq: number;
  agentId: string;
  reason: BlockReason;
  requiredAction: string;
  since: string;
  observed: ObservedState;
  /** The blocked agent's attempt named by the record, if any. */
  attempt: AttemptRef | null;
}

export interface ArtifactIntegrity {
  checked: number;
  altered: Array<{ receiptId: string; acceptedPath: string; problem: string }>;
}

export interface RunSnapshot {
  schemaVersion: 1;
  kind: "woof.run.snapshot";
  runId: string;
  /** Seq of the last complete journal record. */
  revision: number;
  /** Resume cursor positioned after `revision`: `v1.<seq>.<anchor>`. */
  cursor: string;
  journal: { records: number; tailPending: boolean };
  workflow: { name: string; version: string } | null;
  /** Digest of the persisted caller input, when run.opened carries one. */
  input: { path: string; sha256: string; bytes: number } | null;
  /** Digest of the recorded resolved configuration, when run.opened carries one (p4). */
  config: { path: string; sha256: string; bytes: number } | null;
  status: RunStatus;
  openedAt: string;
  updatedAt: string;
  /** `seq` is the run.terminated record's seq. */
  outcome: (Outcome & { at: string; seq: number }) | null;
  /** Plan limits; `maxFormatRepairs` is 0 when the plan omits it. */
  limits: (Limits & { maxFormatRepairs: number }) | null;
  /** Planned engine-run checks; null when the plan lists none. */
  checks: string[] | null;
  counters: Counters;
  agents: SnapshotAgent[];
  stages: SnapshotStage[];
  /** Gate decisions in journal order. */
  gates: SnapshotGate[];
  attention: {
    /** Ambiguous deliveries whose attempt is open and that were not reconciled. */
    ambiguousDeliveries: Array<AttemptRef & { agentId: string; reason: string }>;
    /** The unresolved block, if any. */
    blocked: SnapshotBlocked | null;
  };
  outputs: {
    /** Highest accepted (visit, attempt) per stage; a newer unaccepted attempt never hides or replaces it. */
    latestAcceptedByStage: Record<string, AttemptRef & { receiptId: string; acceptedPath: string }>;
  };
  /**
   * Run owner (p4): `unhosted` when no host claimed the run, `alive` while its
   * host heartbeats, `lost` when the heartbeat went stale or the host process is
   * gone, `exited` after a clean exit (or a stale claim on a terminated run).
   * Derived snapshots are always unhosted; `readSnapshot` probes `host.json`.
   */
  liveness: {
    owner: HostOwner;
    runtime: "not_observed";
    host: HostInfo | null;
    /** Present when `host.json` exists but holds no valid claim; the owner is then `lost` (p4). */
    claimProblem?: string;
  };
  integrity: { artifacts: "unchecked" | ArtifactIntegrity };
}

export interface DeriveSnapshotOptions {
  /**
   * Run anchor from the raw bytes of journal line 1. Defaults to the anchor of
   * the serialized first record, which equals the raw anchor for every journal
   * the engine wrote.
   */
  anchor?: string;
  tailPending?: boolean;
}

export type DeriveSnapshotResult =
  | { ok: true; snapshot: RunSnapshot }
  | { ok: false; reason: "run_dir_invalid" | "journal_corrupt"; message: string; line?: number };

/**
 * `run_dir_invalid`: the journal is missing or holds no records.
 * `journal_corrupt`: a complete line is invalid or impossible.
 * `journal_replaced`: the journal's line 1 changed during each of the bounded
 * consecutive reads (three), so there is no stable run to show.
 */
export type ReadSnapshotResult =
  | { ok: true; snapshot: RunSnapshot }
  | {
      ok: false;
      reason: "run_dir_invalid" | "journal_corrupt" | "journal_replaced";
      message: string;
      line?: number;
    };

const CURSOR_PATTERN = /^v1\.(0|[1-9][0-9]*)\.([0-9a-f]{12})$/;

/** Formats a resume cursor positioned after `seq`. */
export function formatCursor(seq: number, anchor: string): string {
  return `v1.${seq}.${anchor}`;
}

/** Parses a resume cursor; undefined when it is malformed. */
export function parseCursor(cursor: string): { seq: number; anchor: string } | undefined {
  const match = CURSOR_PATTERN.exec(cursor);
  if (match === null) return undefined;
  const seq = Number(match[1]);
  if (seq !== 0 && !isPositiveInteger(seq)) return undefined;
  return { seq, anchor: match[2] as string };
}

/**
 * Reads a snapshot of `<runDir>` without taking the journal lock. A final line
 * still being written is excluded (`journal.tailPending`); a journal with no
 * records (or no journal) is `run_dir_invalid`. A journal whose line 1 changes
 * while it is read is read again, so a replaced run is shown whole, never as a
 * mixed prefix; one whose line 1 changed during each of three consecutive reads
 * is `journal_replaced`. With `verifyArtifacts`, every accepted copy is
 * re-hashed against its journal record and reported in `integrity.artifacts`.
 */
export function readSnapshot(
  runDir: string,
  options: { verifyArtifacts?: boolean } = {},
): ReadSnapshotResult {
  const read = readJournalPrefixSettled(runDir);
  if (!read.ok) return read;
  if (read.records.length === 0 || read.anchor === null) {
    return { ok: false, reason: "run_dir_invalid", message: `${runDir} holds no run records` };
  }
  const derived = deriveSnapshot(read.records, {
    anchor: read.anchor,
    tailPending: read.tailPending,
  });
  if (!derived.ok) return derived;
  const probed = probeHost(runDir, { terminal: derived.snapshot.outcome !== null });
  derived.snapshot.liveness = {
    owner: probed.owner,
    runtime: "not_observed",
    host: probed.host,
    ...(probed.problem !== undefined ? { claimProblem: probed.problem } : {}),
  };
  if (options.verifyArtifacts !== true) return derived;
  const altered: ArtifactIntegrity["altered"] = [];
  let checked = 0;
  for (const stage of derived.snapshot.stages) {
    for (const visit of stage.visits) {
      for (const attempt of visit.attempts) {
        if (attempt.accepted === null) continue;
        checked += 1;
        const problem = acceptedCopyProblem(runDir, attempt.accepted.artifact);
        if (problem !== undefined) {
          altered.push({
            receiptId: attempt.accepted.receiptId,
            acceptedPath: attempt.accepted.artifact.acceptedPath,
            problem,
          });
        }
      }
    }
  }
  derived.snapshot.integrity = { artifacts: { checked, altered } };
  return derived;
}

/** Derives a snapshot from complete journal records (pure). */
export function deriveSnapshot(
  records: readonly JournalRecord[],
  options: DeriveSnapshotOptions = {},
): DeriveSnapshotResult {
  const first = records[0];
  if (first === undefined || first.type !== "run.opened") {
    return {
      ok: false,
      reason: "run_dir_invalid",
      message: "the journal holds no run.opened record",
    };
  }
  const replayed = replay(records);
  if (!replayed.ok) {
    return {
      ok: false,
      reason: "journal_corrupt",
      message: `line ${replayed.line}: ${replayed.message}`,
      line: replayed.line,
    };
  }
  const state = replayed.state;
  const anchor = options.anchor ?? journalAnchor(Buffer.from(JSON.stringify(first), "utf8"));
  return {
    ok: true,
    snapshot: {
      schemaVersion: 1,
      kind: "woof.run.snapshot",
      runId: first.runId,
      revision: state.revision,
      cursor: formatCursor(state.revision, anchor),
      journal: { records: records.length, tailPending: options.tailPending ?? false },
      workflow: state.plan === null ? null : { ...state.plan.workflow },
      input: first.input === undefined ? null : { ...first.input },
      config: first.config === undefined ? null : { ...first.config },
      status: state.status,
      openedAt: state.openedAt ?? first.ts,
      updatedAt: state.updatedAt ?? first.ts,
      outcome:
        state.termination === undefined
          ? null
          : {
              outcome: state.termination.outcome,
              reason: state.termination.reason,
              limit: state.termination.limit ?? null,
              at: state.termination.ts,
              seq: state.termination.seq,
            },
      limits:
        state.plan === null
          ? null
          : { ...state.plan.limits, maxFormatRepairs: state.plan.limits.maxFormatRepairs ?? 0 },
      // An explicit `checks: []` lists no checks either.
      checks:
        state.plan?.checks === undefined || state.plan.checks.length === 0
          ? null
          : [...state.plan.checks],
      counters: cloneCounters(state.counters),
      agents: deriveAgents(state, records),
      stages: deriveStages(state, records),
      gates: deriveGates(state),
      attention: {
        ambiguousDeliveries: ambiguousDeliveries(state),
        blocked: deriveBlocked(state),
      },
      outputs: { latestAcceptedByStage: latestAccepted(state) },
      liveness: { owner: "unhosted", runtime: "not_observed", host: null },
      integrity: { artifacts: "unchecked" },
    },
  };
}

/** Plan agents in plan order, then other agents in order of first appearance. */
function deriveAgents(state: RunState, records: readonly JournalRecord[]): SnapshotAgent[] {
  const order: string[] = state.plan?.agents.map((agent) => agent.agentId) ?? [];
  for (const record of records) {
    if (
      (record.type === "agent.assigned" || record.type === "attempt.opened") &&
      !order.includes(record.agentId)
    ) {
      order.push(record.agentId);
    }
  }
  const terminated = state.termination !== undefined;
  return order.map((agentId) => {
    const spec = state.plan?.agents.find((agent) => agent.agentId === agentId);
    const assignment = state.assignments.get(agentId)?.at(-1);
    let active: AttemptRef | null = null;
    let activeSeq = 0;
    if (!terminated) {
      for (const attempt of state.attempts.values()) {
        const opened = attempt.opened;
        if (attempt.status === "open" && opened.agentId === agentId && opened.seq > activeSeq) {
          active = { stageId: opened.stageId, visit: opened.visit, attempt: opened.attempt };
          activeSeq = opened.seq;
        }
      }
    }
    return {
      agentId,
      role: spec?.role ?? null,
      kind: spec?.kind ?? null,
      model: spec?.model ?? null,
      args: spec?.args === undefined ? null : [...spec.args],
      assignment:
        assignment === undefined
          ? null
          : {
              adapter: assignment.runtime.adapter,
              runtimeName: assignment.runtime.runtimeName,
              paneId: assignment.runtime.paneId,
              terminalId: assignment.terminalId ?? null,
              sessionId: assignment.sessionId ?? null,
              at: assignment.ts,
            },
      activeAttempt: active,
      runtime: null,
    };
  });
}

/** Plan stages in plan order, then other stages in order of first attempt. */
function deriveStages(state: RunState, records: readonly JournalRecord[]): SnapshotStage[] {
  const order: string[] = state.plan?.stages.map((stage) => stage.stageId) ?? [];
  for (const record of records) {
    if (record.type === "attempt.opened" && !order.includes(record.stageId)) {
      order.push(record.stageId);
    }
  }
  const terminated = state.termination !== undefined;
  return order.map((stageId) => {
    const spec = state.plan?.stages.find((stage) => stage.stageId === stageId);
    const visits = new Map<number, SnapshotAttempt[]>();
    const attempts = [...state.attempts.values()]
      .filter((attempt) => attempt.opened.stageId === stageId)
      .toSorted((a, b) => compareAttempts(a.opened, b.opened));
    for (const attempt of attempts) {
      const opened = attempt.opened;
      const dispatch = state.dispatches.get(attemptKey(stageId, opened.visit, opened.attempt));
      const accepted = attempt.accepted;
      const list = visits.get(opened.visit) ?? [];
      const reconciliation =
        dispatch === undefined ? undefined : state.reconciliations.get(dispatch.seq);
      list.push({
        attempt: opened.attempt,
        seq: opened.seq,
        agentId: opened.agentId,
        status: attempt.status === "open" && terminated ? "abandoned" : attempt.status,
        cause: attempt.cause,
        openedAt: opened.ts,
        paneId: opened.paneId ?? null,
        delivery: dispatch?.delivery ?? "undispatched",
        dispatch:
          dispatch === undefined
            ? null
            : { seq: dispatch.seq, at: dispatch.ts, reason: dispatch.reason },
        request: dispatch?.request === undefined ? null : { ...dispatch.request },
        target: dispatch?.target === undefined ? null : { ...dispatch.target },
        revision: dispatch?.revision === undefined ? null : { ...dispatch.revision },
        reconciliation:
          reconciliation === undefined
            ? null
            : {
                seq: reconciliation.seq,
                resolution: reconciliation.resolution,
                evidence: reconciliation.evidence,
                at: reconciliation.ts,
              },
        rejections: copyDict(attempt.rejections),
        rejectionLog: attempt.rejectionLog.map(({ seq, reason, message }) => ({
          seq,
          reason,
          message,
        })),
        accepted:
          accepted === undefined
            ? null
            : {
                seq: accepted.seq,
                receiptId: accepted.receiptId,
                status: accepted.status,
                verdict: accepted.verdict,
                artifact: {
                  path: accepted.artifact.path,
                  acceptedPath: accepted.artifact.acceptedPath,
                  sha256: accepted.artifact.sha256,
                  bytes: accepted.artifact.bytes,
                },
                at: accepted.ts,
              },
      });
      visits.set(opened.visit, list);
    }
    return {
      stageId,
      agentId: spec?.agentId ?? null,
      verdicts: spec === undefined ? null : [...spec.verdicts],
      visits: [...visits.entries()].map(([visit, list]) => ({ visit, attempts: list })),
    };
  });
}

function deriveGates(state: RunState): SnapshotGate[] {
  return state.gates.map((gate) => ({
    seq: gate.seq,
    at: gate.ts,
    gate: gate.gate,
    kind: gate.kind,
    subject: { ...gate.subject },
    decision: gate.decision,
    reason: gate.reason,
    verdict: gate.verdict ?? null,
    round: gate.round,
    next: { ...gate.next },
    revision: { ...gate.revision },
    reviewed: gate.reviewed === undefined ? null : { ...gate.reviewed },
    check:
      gate.check === undefined
        ? null
        : { ...gate.check, command: [...gate.check.command], evidence: { ...gate.check.evidence } },
  }));
}

function deriveBlocked(state: RunState): SnapshotBlocked | null {
  const current = currentBlock(state)?.blocked;
  if (current === undefined) return null;
  return {
    seq: current.seq,
    agentId: current.agentId,
    reason: current.reason,
    requiredAction: current.requiredAction,
    since: current.ts,
    observed: { ...current.observed },
    attempt:
      current.stageId === undefined || current.visit === undefined || current.attempt === undefined
        ? null
        : { stageId: current.stageId, visit: current.visit, attempt: current.attempt },
  };
}

function ambiguousDeliveries(state: RunState): RunSnapshot["attention"]["ambiguousDeliveries"] {
  return [...state.dispatches.values()]
    .filter((dispatch) => {
      if (dispatch.delivery !== "ambiguous") return false;
      if (state.reconciliations.has(dispatch.seq)) return false;
      const attempt = state.attempts.get(
        attemptKey(dispatch.stageId, dispatch.visit, dispatch.attempt),
      );
      return attempt?.status === "open";
    })
    .toSorted((a, b) => a.seq - b.seq)
    .map((dispatch) => ({
      stageId: dispatch.stageId,
      visit: dispatch.visit,
      attempt: dispatch.attempt,
      agentId: dispatch.agentId,
      reason: dispatch.reason,
    }));
}

/** Counters with every id-keyed dictionary copied as a null-prototype object. */
function cloneCounters(counters: Counters): Counters {
  return {
    attemptsOpened: counters.attemptsOpened,
    visitsByStage: copyDict(counters.visitsByStage),
    attemptsByVisit: copyDict(counters.attemptsByVisit),
    submissionsAccepted: counters.submissionsAccepted,
    submissionsDuplicate: counters.submissionsDuplicate,
    submissionsRejected: counters.submissionsRejected,
    rejectionsByReason: copyDict(counters.rejectionsByReason),
    dispatches: { ...counters.dispatches },
    replacementsByAgent: copyDict(counters.replacementsByAgent),
    rounds: counters.rounds,
    gatesByDecision: { ...counters.gatesByDecision },
    gatesByGate: copyDict(counters.gatesByGate),
    formatRepairsByVisit: copyDict(counters.formatRepairsByVisit),
    workRetriesByVisit: copyDict(counters.workRetriesByVisit),
    blocks: counters.blocks,
    reconciliations: { ...counters.reconciliations },
  };
}

function latestAccepted(state: RunState): RunSnapshot["outputs"]["latestAcceptedByStage"] {
  // Keyed by stage id: null prototype, so `constructor` is an ordinary stage id.
  const latest = dict<RunSnapshot["outputs"]["latestAcceptedByStage"][string]>();
  for (const attempt of state.attempts.values()) {
    const accepted = attempt.accepted;
    if (accepted === undefined) continue;
    const current = latest[accepted.stageId];
    if (current === undefined || compareAttempts(accepted, current) > 0) {
      latest[accepted.stageId] = {
        stageId: accepted.stageId,
        visit: accepted.visit,
        attempt: accepted.attempt,
        receiptId: accepted.receiptId,
        acceptedPath: accepted.artifact.acceptedPath,
      };
    }
  }
  return latest;
}
