import { join } from "node:path";

import type { AttemptCause, Limits, Revision } from "../domain/types.js";
import type { AgentHandle, LifecycleObservation } from "../runtime/adapter.js";
import type { AcceptedRef, EvidenceRef } from "../state/result.js";
import type {
  RunSnapshot,
  SnapshotAgent,
  SnapshotAttempt,
  SnapshotGate,
} from "../state/snapshot.js";
import type { GateNext, GateSubject } from "../journal/control-records.js";
import {
  agentStageOf,
  checkStageOf,
  transitionProblem,
  type AgentStage,
  type RunHistory,
  type StageRequest,
  type Transition,
  type WorkflowDefinition,
} from "./definition.js";

/**
 * Pure scheduler decision core (D1). `decide` looks only at the run snapshot,
 * the definition and its validated input, the scheduler's in-memory runtime
 * view and the clock, and returns exactly one action. It never reads the
 * journal, never writes, and never names a workflow stage: every stage-specific
 * choice comes from the definition. The driver executes the action, re-reads
 * the snapshot and asks again.
 */

/** In-memory runtime view of one agent, maintained by the driver. */
export interface AgentRuntimeView {
  handle: AgentHandle | null;
  /** Clock when the agent was started (readiness wait start). */
  startedAt: number | null;
  /** Clock when the scheduler first waited for this agent to be ready for a dispatch. */
  awaitingReadySince: number | null;
  /** Last observation that was not stale. */
  last: LifecycleObservation | null;
  /** Consecutive ready observations with an equal stateChangeSeq since the last dispatch. */
  readyStreak: number;
  /** The tracker reported another terminal in the agent's pane. */
  replaced: boolean;
  /** Working or blocked was observed on the same terminal after the latest dispatch. */
  activitySinceDispatch: boolean;
}

/** Engine-run evidence for the next gate, produced by the driver for one acceptance. */
export interface GateEvidence {
  gate: string;
  acceptedSeq: number;
  revision: Revision;
  check?: {
    argv: string[];
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    /** Evidence file relative to the run directory, with its digest. */
    evidence: { path: string; sha256: string; bytes: number };
  };
}

export interface SchedulerView<Input = unknown> {
  snapshot: RunSnapshot;
  definition: WorkflowDefinition<Input>;
  input: Input;
  /** Absolute run directory. */
  runDir: string;
  agents: Record<string, AgentRuntimeView>;
  evidence: GateEvidence | null;
  now: number;
  aborted: boolean;
}

export interface GateRecordAction {
  gate: string;
  kind: "stage" | "check";
  subject: GateSubject;
  decision: "pass" | "reject";
  reason: string;
  round: number;
  next: GateNext;
  revision: Revision;
  verdict?: string | null;
  reviewed?: Revision;
  check?: {
    command: string[];
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    evidence: { path: string; sha256: string; bytes: number };
  };
}

export type Action =
  /** The run is terminated (by this scheduler or anyone else): stop owned panes and return. */
  | { type: "settle" }
  | {
      type: "terminate";
      outcome: "completed" | "failed" | "cancelled" | "exhausted";
      reason: string;
      limit?: keyof Limits;
    }
  | { type: "wait"; reason: string; observe: string | null }
  | { type: "start_agent"; agentId: string }
  | {
      type: "dispatch";
      agentId: string;
      stageId: string;
      visit: number;
      attempt: number;
      cause: AttemptCause;
      round: number;
      /** Rendered-request content from the definition (initial and work retry). */
      request: StageRequest | null;
      /** The previous attempt of the visit, for a format repair. */
      previous: { attempt: number; rejections: Array<{ reason: string; message: string }> } | null;
    }
  | { type: "compute_revision"; gate: string; acceptedSeq: number }
  | {
      type: "run_check";
      gate: string;
      subject: GateSubject;
      argv: string[];
      timeoutMs: number;
    }
  | { type: "record_gate"; gate: GateRecordAction; exhausted: "maxRounds" | null }
  | {
      type: "block";
      agentId: string;
      reason: "blocked_on_input";
      requiredAction: string;
      observed: ObservedFields;
      attempt: { stageId: string; visit: number; attempt: number } | null;
    }
  | { type: "unblock"; agentId: string; observed: ObservedFields }
  | {
      type: "reconcile";
      agentId: string;
      stageId: string;
      visit: number;
      attempt: number;
      dispatchSeq: number;
      resolution: "delivered" | "abandoned";
      evidence: "submission_recorded" | "observed_activity" | "no_evidence_before_deadline";
    };

export interface ObservedFields {
  runtimeStatus: string | null;
  terminalId: string | null;
  stateChangeSeq: number | null;
}

const MAX_TERMINATION_REASON = 500;

export function emptyRuntimeView(): AgentRuntimeView {
  return {
    handle: null,
    startedAt: null,
    awaitingReadySince: null,
    last: null,
    readyStreak: 0,
    replaced: false,
    activitySinceDispatch: false,
  };
}

type Located = SnapshotAttempt & { stageId: string; visit: number };

export function decide<Input>(view: SchedulerView<Input>): Action {
  const snapshot = view.snapshot;
  if (snapshot.outcome !== null) return { type: "settle" };
  if (view.aborted) return terminate("cancelled", "cancel requested");
  const limits = snapshot.limits;
  if (limits === null) return terminate("failed", "engine_invariant: the run has no plan");
  if (view.now - Date.parse(snapshot.openedAt) >= limits.runTimeoutMs) {
    return exhausted("runTimeoutMs", `the run exceeded runTimeoutMs (${limits.runTimeoutMs} ms)`);
  }
  try {
    return decideRun(view, limits);
  } catch (error) {
    if (error instanceof DefinitionError) return terminate("failed", error.message);
    throw error;
  }
}

class DefinitionError extends Error {}

function decideRun<Input>(
  view: SchedulerView<Input>,
  limits: Limits & { maxFormatRepairs: number },
): Action {
  const { snapshot, definition } = view;

  // Agent loss is checked for every agent this scheduler holds a handle for.
  for (const agent of snapshot.agents) {
    const runtime = view.agents[agent.agentId];
    if (runtime === undefined || runtime.handle === null) continue;
    const loss = agentLoss(agent, runtime);
    if (loss !== undefined) return terminate("failed", loss);
  }

  const blocked = snapshot.attention.blocked;
  if (blocked !== null) {
    const runtime = view.agents[blocked.agentId];
    const last = runtime?.last ?? null;
    if (last !== null && (last.lifecycle === "ready" || last.lifecycle === "working")) {
      return { type: "unblock", agentId: blocked.agentId, observed: observedOf(last) };
    }
    if (view.now - Date.parse(blocked.since) >= limits.blockedWaitMs) {
      return exhausted(
        "blockedWaitMs",
        `agent ${blocked.agentId} stayed blocked past blockedWaitMs (${limits.blockedWaitMs} ms)`,
      );
    }
    return { type: "wait", reason: "blocked", observe: blocked.agentId };
  }

  // An observed block of any agent this scheduler watches is recorded before anything else.
  for (const agent of snapshot.agents) {
    const runtime = view.agents[agent.agentId];
    if (runtime?.last?.lifecycle !== "blocked" || agent.assignment === null) continue;
    const active = agent.activeAttempt;
    return {
      type: "block",
      agentId: agent.agentId,
      reason: "blocked_on_input",
      requiredAction: requiredActionFor(agent, view.runDir),
      observed: observedOf(runtime.last),
      attempt: active === null ? null : { ...active },
    };
  }

  const gates = snapshot.gates;
  const lastGate = gates.at(-1);
  const target: GateNext = lastGate === undefined ? { stageId: definition.start } : lastGate.next;
  if ("outcome" in target) return terminate(target.outcome, (lastGate as SnapshotGate).reason);
  const targetId = target.stageId;
  const history = historyOf(snapshot, view.runDir);

  const check = checkStageOf(definition, targetId);
  if (check !== undefined) {
    if (lastGate === undefined)
      return terminate("failed", "definition_contract_violated: a check cannot start a run");
    const subject = lastGate.subject;
    const evidence = view.evidence;
    if (
      evidence?.check !== undefined &&
      evidence.gate === targetId &&
      evidence.acceptedSeq === subject.acceptedSeq
    ) {
      const subjectRef = acceptedRefOf(snapshot, view.runDir, subject);
      if (subjectRef === null)
        return terminate("failed", "engine_invariant: check subject has no accepted artifact");
      const transition = callDefinition(targetId, () =>
        check.next({
          input: view.input,
          runId: snapshot.runId,
          history,
          subject: subjectRef,
          check: {
            exitCode: evidence.check?.exitCode ?? null,
            signal: evidence.check?.signal ?? null,
            timedOut: evidence.check?.timedOut ?? false,
            evidence: {
              path: join(view.runDir, evidence.check?.evidence.path ?? ""),
              sha256: evidence.check?.evidence.sha256 ?? "",
              bytes: evidence.check?.evidence.bytes ?? 0,
            },
          },
          revision: { current: evidence.revision },
        }),
      );
      return gateAction(view, limits, targetId, transition, {
        gate: targetId,
        kind: "check",
        subject: { ...subject },
        revision: evidence.revision,
        check: {
          command: [...evidence.check.argv],
          exitCode: evidence.check.exitCode,
          signal: evidence.check.signal,
          timedOut: evidence.check.timedOut,
          evidence: { ...evidence.check.evidence },
        },
      });
    }
    const command = callDefinition(targetId, () => check.command(view.input));
    if (
      command === null ||
      typeof command !== "object" ||
      !Array.isArray(command.argv) ||
      command.argv.length === 0 ||
      !command.argv.every((item) => typeof item === "string") ||
      !Number.isSafeInteger(command.timeoutMs) ||
      command.timeoutMs < 1
    ) {
      return terminate(
        "failed",
        `definition_contract_violated: check ${targetId} returned no argv and timeout`,
      );
    }
    return {
      type: "run_check",
      gate: targetId,
      subject: { ...subject },
      argv: [...command.argv],
      timeoutMs: command.timeoutMs,
    };
  }

  const stage = agentStageOf(definition, targetId);
  if (stage === undefined)
    return terminate("failed", `transition_undeclared: ${targetId} is not a stage or check`);
  const enteredSeq = lastGate?.seq ?? 0;
  const visits = snapshot.stages.find((item) => item.stageId === targetId)?.visits ?? [];
  const latestVisit = visits.at(-1);
  const current =
    latestVisit !== undefined && (latestVisit.attempts[0]?.seq ?? 0) > enteredSeq
      ? latestVisit
      : undefined;
  const roundsUsed =
    definition.roundStage === null
      ? 0
      : (snapshot.counters.visitsByStage[definition.roundStage] ?? 0);

  if (current === undefined) {
    const visit = (latestVisit?.visit ?? 0) + 1;
    if (visit > limits.maxVisitsPerStage) {
      return exhausted(
        "maxVisitsPerStage",
        `stage ${targetId} would need visit ${visit} beyond maxVisitsPerStage (${limits.maxVisitsPerStage})`,
      );
    }
    if (definition.roundStage === targetId && roundsUsed >= limits.maxRounds) {
      return exhausted("maxRounds", `a new round would exceed maxRounds (${limits.maxRounds})`);
    }
    const round = definition.roundStage === targetId ? roundsUsed + 1 : roundsUsed;
    return dispatchWhenReady(
      view,
      limits,
      stage,
      visit,
      1,
      "initial",
      round,
      lastGate ?? null,
      history,
      null,
    );
  }

  const attempt = current.attempts.at(-1) as SnapshotAttempt;
  const located: Located = { ...attempt, stageId: targetId, visit: current.visit };
  const agentId = stage.agentId;
  const runtime = view.agents[agentId];

  if (
    attempt.delivery === "ambiguous" &&
    attempt.reconciliation === null &&
    attempt.dispatch !== null
  ) {
    const base = {
      type: "reconcile" as const,
      agentId,
      stageId: targetId,
      visit: current.visit,
      attempt: attempt.attempt,
      dispatchSeq: attempt.dispatch.seq,
    };
    if (attempt.accepted !== null || attempt.rejectionLog.length > 0) {
      return { ...base, resolution: "delivered", evidence: "submission_recorded" };
    }
    if (runtime?.activitySinceDispatch === true)
      return { ...base, resolution: "delivered", evidence: "observed_activity" };
    if (view.now - Date.parse(attempt.dispatch.at) >= limits.deliveryTimeoutMs) {
      return { ...base, resolution: "abandoned", evidence: "no_evidence_before_deadline" };
    }
    return { type: "wait", reason: "delivery_unconfirmed", observe: agentId };
  }
  if (attempt.reconciliation?.resolution === "abandoned") {
    return exhausted(
      "deliveryTimeoutMs",
      `no evidence that ${attemptLabel(located)} was delivered within deliveryTimeoutMs (${limits.deliveryTimeoutMs} ms)`,
    );
  }

  const round = roundsUsed;
  if (attempt.accepted !== null) {
    if (attempt.accepted.status === "failed") {
      if (stage.onFailedStatus === "fail") {
        return terminate(
          "failed",
          `stage ${targetId} reported status failed (${attemptLabel(located)})`,
        );
      }
      return nextAttempt(
        view,
        limits,
        stage,
        located,
        "work_retry",
        round,
        lastGate ?? null,
        history,
        current.attempts,
      );
    }
    const evidence = view.evidence;
    if (
      evidence === null ||
      evidence.check !== undefined ||
      evidence.gate !== targetId ||
      evidence.acceptedSeq !== attempt.accepted.seq
    ) {
      return { type: "compute_revision", gate: targetId, acceptedSeq: attempt.accepted.seq };
    }
    const acceptedRef = acceptedRefOf(snapshot, view.runDir, located) as AcceptedRef;
    const reviewed = stage.bindsRevision ? attempt.revision : null;
    const transition = callDefinition(targetId, () =>
      stage.next({
        input: view.input,
        runId: snapshot.runId,
        history,
        accepted: {
          ...acceptedRef,
          status: "completed",
          verdict: attempt.accepted?.verdict ?? null,
        },
        revision: { reviewed, current: evidence.revision },
      }),
    );
    const base = {
      gate: targetId,
      kind: "stage" as const,
      subject: {
        stageId: targetId,
        visit: current.visit,
        attempt: attempt.attempt,
        acceptedSeq: attempt.accepted.seq,
        receiptId: attempt.accepted.receiptId,
      },
      revision: evidence.revision,
      verdict: attempt.accepted.verdict,
      ...(reviewed !== null ? { reviewed } : {}),
    };
    // Completion fence: a revision-bound stage completes the run only on the exact
    // tree it reviewed, which is also the tree of the latest work gate.
    if (stage.bindsRevision && "outcome" in transition && transition.outcome === "completed") {
      const tree = evidence.revision.tree;
      const work = snapshot.gates.findLast(
        (item) => item.kind === "stage" && item.gate !== targetId,
      );
      if (reviewed?.tree !== tree || (work !== undefined && work.revision.tree !== tree)) {
        return revisionMoved(view, limits, targetId, base);
      }
    }
    return gateAction(view, limits, targetId, transition, base);
  }

  if (attempt.dispatch === null) {
    return terminate(
      "failed",
      `engine_invariant: ${attemptLabel(located)} was opened without a dispatch`,
    );
  }
  if (attempt.delivery === "not_delivered") {
    if (attempt.dispatch.reason === "not_found")
      return terminate("failed", `agent_gone: agent ${agentId} was not found at dispatch`);
    if (attempt.dispatch.reason === "runtime_unavailable")
      return terminate("failed", "runtime_unavailable: the runtime was unavailable at dispatch");
    return nextAttempt(
      view,
      limits,
      stage,
      located,
      "work_retry",
      round,
      lastGate ?? null,
      history,
      current.attempts,
    );
  }
  // Started, or ambiguous and reconciled delivered: wait for the result.
  if (runtime !== undefined && runtime.last?.lifecycle === "ready" && runtime.readyStreak >= 2) {
    return nextAttempt(
      view,
      limits,
      stage,
      located,
      "format_repair",
      round,
      lastGate ?? null,
      history,
      current.attempts,
    );
  }
  return { type: "wait", reason: "awaiting_result", observe: agentId };
}

function nextAttempt<Input>(
  view: SchedulerView<Input>,
  limits: Limits & { maxFormatRepairs: number },
  stage: AgentStage<Input>,
  previous: Located,
  cause: "work_retry" | "format_repair",
  round: number,
  enteredBy: SnapshotGate | null,
  history: RunHistory,
  attempts: SnapshotAttempt[],
): Action {
  if (cause === "format_repair") {
    const used = attempts.filter((item) => item.cause === "format_repair").length;
    if (used >= limits.maxFormatRepairs) {
      return exhausted(
        "maxFormatRepairs",
        `${attemptLabel(previous)} ended without an accepted submission and maxFormatRepairs (${limits.maxFormatRepairs}) is used`,
      );
    }
  } else {
    const used = attempts.filter((item) => item.cause !== "format_repair").length;
    if (used >= limits.maxAttemptsPerVisit) {
      return exhausted(
        "maxAttemptsPerVisit",
        `${attemptLabel(previous)} needs a work retry beyond maxAttemptsPerVisit (${limits.maxAttemptsPerVisit})`,
      );
    }
  }
  return dispatchWhenReady(
    view,
    limits,
    stage,
    previous.visit,
    previous.attempt + 1,
    cause,
    round,
    enteredBy,
    history,
    cause === "format_repair"
      ? {
          attempt: previous.attempt,
          rejections: previous.rejectionLog.map(({ reason, message }) => ({ reason, message })),
        }
      : null,
  );
}

function dispatchWhenReady<Input>(
  view: SchedulerView<Input>,
  limits: Limits,
  stage: AgentStage<Input>,
  visit: number,
  attempt: number,
  cause: AttemptCause,
  round: number,
  enteredBy: SnapshotGate | null,
  history: RunHistory,
  previous: { attempt: number; rejections: Array<{ reason: string; message: string }> } | null,
): Action {
  const agentId = stage.agentId;
  const agent = view.snapshot.agents.find((item) => item.agentId === agentId);
  if (agent === undefined)
    return terminate("failed", `engine_invariant: agent ${agentId} is not in the plan`);
  const runtime = view.agents[agentId];
  if (agent.assignment === null) {
    return { type: "start_agent", agentId };
  }
  if (runtime === undefined || runtime.handle === null) {
    return terminate(
      "failed",
      `engine_invariant: agent ${agentId} was assigned outside this scheduler`,
    );
  }
  const ready = runtime.last?.lifecycle === "ready" && runtime.readyStreak >= 2;
  if (!ready) {
    const since = runtime.awaitingReadySince ?? runtime.startedAt ?? view.now;
    if (view.now - since >= limits.readinessWaitMs) {
      return exhausted(
        "readinessWaitMs",
        `agent ${agentId} was not ready within readinessWaitMs (${limits.readinessWaitMs} ms)`,
      );
    }
    return { type: "wait", reason: "awaiting_ready", observe: agentId };
  }
  const request =
    cause === "format_repair"
      ? null
      : callDefinition(stage.stageId, () =>
          stage.request({
            input: view.input,
            runId: view.snapshot.runId,
            history,
            stageId: stage.stageId,
            visit,
            attempt,
            round,
            enteredBy,
          }),
        );
  return {
    type: "dispatch",
    agentId,
    stageId: stage.stageId,
    visit,
    attempt,
    cause,
    round,
    request,
    previous,
  };
}

function gateAction<Input>(
  view: SchedulerView<Input>,
  limits: Limits,
  from: string,
  transition: Transition,
  base: Omit<GateRecordAction, "decision" | "reason" | "round" | "next">,
): Action {
  const problem = transitionProblem(
    view.definition as WorkflowDefinition<unknown>,
    from,
    transition,
  );
  if (problem !== undefined) return terminate("failed", `${problem.reason}: ${problem.message}`);
  const definition = view.definition;
  const roundsUsed =
    definition.roundStage === null
      ? 0
      : (view.snapshot.counters.visitsByStage[definition.roundStage] ?? 0);
  const next: GateNext =
    "outcome" in transition ? { outcome: transition.outcome } : { stageId: transition.to };
  const needsRound =
    "to" in transition && transition.requires === "round" && definition.roundStage !== null;
  return {
    type: "record_gate",
    gate: {
      ...base,
      decision: transition.decision,
      reason: transition.reason,
      round: roundsUsed,
      next,
    },
    exhausted: needsRound && roundsUsed >= limits.maxRounds ? "maxRounds" : null,
  };
}

/** Engine-imposed rejection of a completion whose revision no longer matches: the stage runs again. */
function revisionMoved<Input>(
  view: SchedulerView<Input>,
  limits: Limits,
  stageId: string,
  base: Omit<GateRecordAction, "decision" | "reason" | "round" | "next">,
): Action {
  const definition = view.definition;
  const roundsUsed =
    definition.roundStage === null
      ? 0
      : (view.snapshot.counters.visitsByStage[definition.roundStage] ?? 0);
  return {
    type: "record_gate",
    gate: {
      ...base,
      decision: "reject",
      reason: "revision_moved",
      round: roundsUsed,
      next: { stageId },
    },
    exhausted:
      definition.roundStage === stageId && roundsUsed >= limits.maxRounds ? "maxRounds" : null,
  };
}

function agentLoss(agent: SnapshotAgent, runtime: AgentRuntimeView): string | undefined {
  if (runtime.replaced)
    return `agent_replaced: another terminal occupies agent ${agent.agentId}'s pane`;
  const last = runtime.last;
  if (last === null) return undefined;
  if (last.lifecycle === "gone") return `agent_gone: agent ${agent.agentId} is gone`;
  const assigned = agent.assignment?.terminalId ?? null;
  if (assigned !== null && last.order.terminalId !== null && last.order.terminalId !== assigned) {
    return `agent_replaced: agent ${agent.agentId} runs in terminal ${last.order.terminalId}, not ${assigned}`;
  }
  return undefined;
}

/** Read-only history for definition functions: gates and the latest accepted artifact per stage. */
export function historyOf(snapshot: RunSnapshot, runDir: string): RunHistory {
  const latestAccepted = Object.create(null) as Record<string, AcceptedRef>;
  for (const [stageId, latest] of Object.entries(snapshot.outputs.latestAcceptedByStage)) {
    const ref = acceptedRefOf(snapshot, runDir, latest);
    if (ref !== null) latestAccepted[stageId] = ref;
  }
  return { gates: snapshot.gates, latestAccepted };
}

export function acceptedRefOf(
  snapshot: RunSnapshot,
  runDir: string,
  ref: { stageId: string; visit: number; attempt: number },
): AcceptedRef | null {
  const attempt = attemptOf(snapshot, ref);
  if (attempt?.accepted == null) return null;
  return {
    stageId: ref.stageId,
    visit: ref.visit,
    attempt: ref.attempt,
    receiptId: attempt.accepted.receiptId,
    acceptedPath: join(runDir, attempt.accepted.artifact.acceptedPath),
    sha256: attempt.accepted.artifact.sha256,
  };
}

/** Latest check evidence recorded by gate id, as an absolute evidence reference. */
export function latestCheckEvidence(
  snapshot: RunSnapshot,
  runDir: string,
  checkId: string,
): EvidenceRef | null {
  const gate = snapshot.gates.findLast((item) => item.kind === "check" && item.gate === checkId);
  if (gate?.check == null) return null;
  return {
    path: join(runDir, gate.check.evidence.path),
    sha256: gate.check.evidence.sha256,
    bytes: gate.check.evidence.bytes,
  };
}

export function attemptOf(
  snapshot: RunSnapshot,
  ref: { stageId: string; visit: number; attempt: number },
): SnapshotAttempt | undefined {
  return snapshot.stages
    .find((stage) => stage.stageId === ref.stageId)
    ?.visits.find((visit) => visit.visit === ref.visit)
    ?.attempts.find((attempt) => attempt.attempt === ref.attempt);
}

function callDefinition<T>(stageId: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DefinitionError(
      `definition_threw: ${stageId}: ${message}`.slice(0, MAX_TERMINATION_REASON),
    );
  }
}

function requiredActionFor(agent: SnapshotAgent, runDir: string): string {
  const assignment = agent.assignment;
  return `Agent ${agent.agentId} (runtime agent ${assignment?.runtimeName ?? "unknown"}) is blocked in pane ${assignment?.paneId ?? "unknown"}. Answer its prompt in that pane, or cancel the run with: woof run cancel ${runDir}`.slice(
    0,
    2000,
  );
}

function observedOf(observation: LifecycleObservation): ObservedFields {
  return {
    runtimeStatus: observation.runtimeStatus,
    terminalId: observation.order.terminalId,
    stateChangeSeq: observation.order.stateChangeSeq,
  };
}

function attemptLabel(attempt: Located): string {
  return `${attempt.stageId} visit ${attempt.visit} attempt ${attempt.attempt}`;
}

function terminate(outcome: "completed" | "failed" | "cancelled", reason: string): Action {
  return { type: "terminate", outcome, reason: reason.slice(0, MAX_TERMINATION_REASON) };
}

function exhausted(limit: keyof Limits, reason: string): Action {
  return {
    type: "terminate",
    outcome: "exhausted",
    reason: reason.slice(0, MAX_TERMINATION_REASON),
    limit,
  };
}
