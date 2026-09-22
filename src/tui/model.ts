import { basename, join } from "node:path";

import type { RunListEntry } from "../inspect/runs.js";
import type { RunStatusView } from "../inspect/status.js";
import type { RunEvent } from "../observe/events.js";
import { timeOf } from "../observe/format.js";
import { duration, isObject, sanitize, text, words } from "../observe/render-text.js";
import type { WorkflowGraph } from "../observe/workflow-graph.js";
import type {
  RunSnapshot,
  SnapshotAttempt,
  SnapshotGate,
  SnapshotStage,
} from "../state/snapshot.js";
import type {
  AgentConfigRow,
  ArtifactRef,
  ConfigDoc,
  DetailLine,
  RunHeader,
  RunModel,
  RunRow,
  StateWord,
  StepNode,
} from "./types.js";

/**
 * The run as the terminal UI shows it (pure): header, ordered step rows with
 * their expansion and readable files, the steps and activity notes, and the
 * Config document. Everything is derived from engine facts — the snapshot, the
 * status view, the event list, the saved input and the recorded configuration —
 * never from terminal output or from time passing. Accepted submissions, gate
 * decisions and the recorded outcome stay separate facts; a lost host is an
 * unknown outcome, not a failure.
 */

export interface RunModelInput {
  snapshot: RunSnapshot;
  status: RunStatusView;
  runDir: string;
  /** The run's events in seq order (for check start times); may be empty. */
  events: readonly RunEvent[];
  /** Parsed `input.json`; undefined when absent or unreadable. */
  input: unknown;
  /** Parsed `config.json`; undefined when absent or unreadable. */
  config: unknown;
  graph: WorkflowGraph | null;
  /** IANA zone for clock times; local time when omitted. */
  timeZone?: string;
}

export function deriveRunModel(model: RunModelInput): RunModel {
  const { snapshot, runDir } = model;
  const clock = (ts: string) => timeOf(ts, model.timeZone);
  const steps = deriveSteps(model, clock);
  const header = headerOf(snapshot, model.input, steps);
  return {
    runId: snapshot.runId,
    runDir,
    header,
    steps,
    stepsNote: stepsNoteOf(snapshot, steps),
    wait: waitOf(snapshot, steps),
    activityNote: activityNoteOf(snapshot),
    config: configOf(model, clock),
  };
}

/** One runs-list row; `read` is null when the run's status could not be read again. */
export function runRowOf(
  entry: RunListEntry,
  read: { snapshot: RunSnapshot; status: RunStatusView } | null,
  input: unknown,
): RunRow {
  const title = titleOf(input);
  const workflow = entry.workflow?.name ?? null;
  const fallback = `${workflow ?? "run"} · ${entry.runId}`;
  if (read === null) {
    return {
      runId: entry.runId,
      runDir: entry.runDir,
      title: title ?? fallback,
      titleIsFallback: title === undefined,
      workflow,
      state: { word: entry.status, mark: "dot", tone: "dim" },
      step: null,
      openedAt: entry.openedAt,
      endedAt: null,
      attention: false,
    };
  }
  const { snapshot, status } = read;
  const steps = deriveSteps(
    { snapshot, status, runDir: entry.runDir, events: [], input, config: undefined, graph: null },
    (ts) => ts,
  );
  const header = headerOf(snapshot, input, steps);
  return {
    runId: entry.runId,
    runDir: entry.runDir,
    title: title ?? fallback,
    titleIsFallback: title === undefined,
    workflow,
    state: header.state,
    step: header.step,
    openedAt: snapshot.openedAt,
    endedAt: header.endedAt,
    attention: needsAttention(snapshot),
  };
}

/** The task title of a saved input: `task.title`, else `title`. */
export function titleOf(input: unknown): string | undefined {
  if (!isObject(input)) return undefined;
  const task = input["task"];
  const title = isObject(task) ? task["title"] : input["title"];
  if (typeof title !== "string") return undefined;
  const clean = sanitize(title).trim();
  return clean === "" ? undefined : clean;
}

// --- run state -----------------------------------------------------------------------------------

/** The host is gone (or exited) and no outcome was recorded: the outcome is unknown. */
function hostLost(snapshot: RunSnapshot): boolean {
  if (snapshot.outcome !== null) return false;
  return snapshot.liveness.owner === "lost" || snapshot.liveness.owner === "exited";
}

function needsAttention(snapshot: RunSnapshot): boolean {
  if (snapshot.outcome !== null) return false;
  return (
    hostLost(snapshot) ||
    snapshot.attention.blocked !== null ||
    snapshot.attention.ambiguousDeliveries.length > 0 ||
    snapshot.lifecycle.observationLost.length > 0
  );
}

function runState(snapshot: RunSnapshot): StateWord {
  const outcome = snapshot.outcome;
  if (outcome !== null) {
    switch (outcome.outcome) {
      case "completed":
        return { word: "completed", mark: "ok", tone: "green" };
      case "failed":
        return { word: "failed", mark: "alert", tone: "red" };
      case "exhausted":
        return { word: "exhausted", mark: "alert", tone: "red" };
      default:
        return { word: "cancelled", mark: "dot", tone: "dim" };
    }
  }
  if (snapshot.liveness.owner === "lost")
    return { word: "host lost", mark: "unknown", tone: "red" };
  if (snapshot.liveness.owner === "exited")
    return { word: "host exited", mark: "unknown", tone: "red" };
  switch (snapshot.status) {
    case "blocked":
      return { word: "blocked", mark: "alert", tone: "amber" };
    case "running":
      return { word: "running", mark: "active", tone: "cyan" };
    case "starting":
      return { word: "starting", mark: "active", tone: "cyan" };
    default:
      return { word: text(snapshot.status), mark: "dot", tone: "dim" };
  }
}

function headerOf(snapshot: RunSnapshot, input: unknown, steps: StepNode[]): RunHeader {
  const title = titleOf(input);
  const workflow = snapshot.workflow?.name ?? null;
  const current = steps.findLast((step) => step.kind !== "pending");
  return {
    title: title ?? `${workflow ?? "run"} · ${snapshot.runId}`,
    workflow,
    state: runState(snapshot),
    step: current?.name ?? null,
    openedAt: snapshot.openedAt,
    endedAt: snapshot.outcome?.at ?? null,
    attention: attentionOf(snapshot),
  };
}

function attentionOf(snapshot: RunSnapshot): StateWord | null {
  if (snapshot.outcome !== null) return null;
  if (snapshot.liveness.owner === "lost")
    return { word: "outcome unknown · no terminal outcome recorded", mark: "unknown", tone: "red" };
  if (snapshot.liveness.owner === "exited")
    return {
      word: "host exited without an outcome · outcome unknown",
      mark: "unknown",
      tone: "red",
    };
  const blocked = snapshot.attention.blocked;
  if (blocked !== null) {
    return {
      word: `blocked: ${words(blocked.reason)} · ${text(blocked.requiredAction)} (${where(snapshot, blocked.agentId)})`,
      mark: "alert",
      tone: "amber",
    };
  }
  const ambiguous = snapshot.attention.ambiguousDeliveries[0];
  if (ambiguous !== undefined) {
    return {
      word: `delivery unconfirmed · ${text(ambiguous.agentId)} ${text(ambiguous.stageId)}`,
      mark: "retry",
      tone: "amber",
    };
  }
  const lost = snapshot.lifecycle.observationLost[0];
  if (lost !== undefined) {
    return {
      word: `observation lost · ${text(lost.agentId)} (${words(lost.code)})`,
      mark: "alert",
      tone: "amber",
    };
  }
  if (snapshot.liveness.owner === "unhosted" && snapshot.status !== "created")
    return { word: "no run host claimed this run", mark: "dot", tone: "dim" };
  return null;
}

/** Where to act for an agent: its Herdr tab or pane, when recorded. */
function where(snapshot: RunSnapshot, agentId: string): string {
  const assignment = snapshot.agents.find((agent) => agent.agentId === agentId)?.assignment;
  if (assignment?.tabId != null) return `${text(agentId)}'s tab ${text(assignment.tabId)}`;
  if (assignment != null) return `${text(agentId)}'s pane ${text(assignment.paneId)}`;
  return text(agentId);
}

// --- steps ---------------------------------------------------------------------------------------

type Clock = (ts: string) => string;

interface Ordered {
  seq: number;
  node: StepNode;
}

function deriveSteps(model: RunModelInput, clock: Clock): StepNode[] {
  const { snapshot } = model;
  const ordered: Ordered[] = [];
  for (const stage of snapshot.stages) {
    for (const visit of stage.visits) {
      const first = visit.attempts[0];
      if (first === undefined) continue;
      ordered.push({
        seq: first.seq,
        node: stageVisitNode(model, stage, visit.visit, visit.attempts, clock),
      });
    }
  }
  const checkCounts = new Map<string, number>();
  for (const gate of snapshot.gates) {
    if (gate.kind !== "check") continue;
    const count = (checkCounts.get(gate.gate) ?? 0) + 1;
    checkCounts.set(gate.gate, count);
    const started = checkStart(model.events, gate);
    ordered.push({
      seq: started?.seq ?? gate.seq,
      node: checkNode(model, gate, count, started?.ts ?? null),
    });
  }
  if (snapshot.outcome === null) {
    for (const activity of snapshot.activity.open) {
      if (activity.kind !== "check_run") continue;
      const checks = snapshot.checks ?? [];
      const id = checks.length === 1 ? (checks[0] as string) : "checks";
      const count = (checkCounts.get(id) ?? 0) + 1;
      checkCounts.set(id, count);
      const subject = activity.attempt;
      ordered.push({
        seq: activity.seq,
        node: {
          id: `check:${id}:${count}`,
          kind: "check",
          name: numbered(id, count),
          participant: "check",
          state: { word: "running", mark: "active", tone: "cyan" },
          startedAt: activity.since,
          endedAt: null,
          details: [
            ...(activity.detail === null
              ? []
              : [{ label: "command", value: text(activity.detail) }]),
            ...(subject === null
              ? []
              : [
                  { label: "checking", value: `${text(subject.stageId)} / visit ${subject.visit}` },
                ]),
            { label: "waiting", value: "check running; no result recorded yet" },
          ],
          artifacts: [],
        },
      });
    }
  }
  const steps = ordered.toSorted((a, b) => a.seq - b.seq).map((item) => item.node);
  return [...steps, ...pendingSteps(model, steps, checkCounts)];
}

function numbered(name: string, count: number): string {
  return count > 1 ? `${name} ${count}` : name;
}

function stageVisitNode(
  model: RunModelInput,
  stage: SnapshotStage,
  visit: number,
  attempts: SnapshotAttempt[],
  clock: Clock,
): StepNode {
  const { snapshot, runDir } = model;
  const stageId = stage.stageId;
  const latest = attempts.at(-1) as SnapshotAttempt;
  const first = attempts[0] as SnapshotAttempt;
  const accepted = attempts.findLast((attempt) => attempt.accepted !== null);
  const gate =
    accepted === undefined
      ? undefined
      : snapshot.gates.find(
          (item) =>
            item.kind === "stage" &&
            item.subject.stageId === stageId &&
            item.subject.visit === visit &&
            item.subject.attempt === accepted.attempt,
        );
  const blocked = snapshot.attention.blocked;
  const blockedHere =
    blocked !== null &&
    blocked.attempt !== null &&
    blocked.attempt.stageId === stageId &&
    blocked.attempt.visit === visit &&
    blocked.attempt.attempt === latest.attempt;
  const details: DetailLine[] = [];
  const entered = enteringGate(snapshot, stageId, first.seq);
  if (entered !== undefined) details.push({ label: "input", value: enteredBy(entered) });
  for (const attempt of attempts) {
    details.push({ label: `attempt ${attempt.attempt}`, value: attemptLine(attempt, clock) });
    for (const rejection of attempt.rejectionLog) {
      details.push({
        label: "rejected",
        value: `${words(rejection.reason)}${rejection.message === "" ? "" : ` · ${text(rejection.message)}`}`,
        tone: "amber",
      });
    }
  }
  if (accepted?.accepted?.verdict != null)
    details.push({ label: "verdict", value: text(accepted.accepted.verdict) });
  if (gate !== undefined) {
    details.push({
      label: "gate",
      value: gatePhrase(gate),
      tone: gate.decision === "pass" ? "green" : "amber",
    });
    const handoff = handoffOf(snapshot, stage, gate);
    if (handoff !== undefined) details.push({ label: "handoff", value: handoff });
  }
  const terminated = snapshot.outcome !== null;
  if (blockedHere && blocked !== null) {
    details.push({ label: "blocked", value: words(blocked.reason), tone: "amber" });
    details.push({
      label: "action",
      value: `${text(blocked.requiredAction)} (${where(snapshot, blocked.agentId)})`,
      tone: "amber",
    });
  } else if (!terminated && latest.status === "open") {
    const checking = snapshot.activity.open.find(
      (activity) =>
        activity.attempt?.stageId === stageId &&
        activity.attempt.visit === visit &&
        activity.attempt.attempt === latest.attempt,
    );
    details.push({
      label: "waiting",
      value:
        checking !== undefined
          ? `${words(checking.kind)} since ${clock(checking.since)}`
          : hostLost(snapshot)
            ? "host lost · no terminal outcome recorded"
            : latest.dispatch === null
              ? "not dispatched yet"
              : "no accepted result yet",
    });
  } else if (!terminated && accepted !== undefined && gate === undefined) {
    details.push({ label: "waiting", value: "gate decision on the accepted result" });
  }

  const artifacts: ArtifactRef[] = [];
  for (const attempt of attempts) {
    const result = attempt.accepted;
    if (result === null) continue;
    const decided = attempt === accepted ? gate : undefined;
    artifacts.push({
      id: `accepted:${stageId}:${visit}:${attempt.attempt}`,
      kind: "accepted",
      label: basename(result.artifact.acceptedPath),
      path: join(runDir, result.artifact.acceptedPath),
      relPath: result.artifact.acceptedPath,
      stageId,
      visit,
      attempt: attempt.attempt,
      context: [
        `accepted ${text(stageId)} / visit ${visit} / attempt ${attempt.attempt}`,
        ...(result.status === "failed" ? ["reported failure"] : []),
        ...(result.verdict === null ? [] : [`verdict ${text(result.verdict)}`]),
        decided === undefined ? "no gate decision" : `gate: ${gatePhrase(decided)}`,
      ].join(" · "),
      bytes: result.artifact.bytes,
      sha256: result.artifact.sha256,
    });
  }
  for (const attempt of attempts) {
    if (attempt.request === null) continue;
    artifacts.push({
      id: `request:${stageId}:${visit}:${attempt.attempt}`,
      kind: "request",
      label: basename(attempt.request.path),
      path: join(runDir, attempt.request.path),
      relPath: attempt.request.path,
      stageId,
      visit,
      attempt: attempt.attempt,
      context: `request dispatched to ${text(attempt.agentId)} · ${text(stageId)} / visit ${visit} / attempt ${attempt.attempt}`,
      bytes: attempt.request.bytes,
      sha256: attempt.request.sha256,
    });
  }

  let endedAt: string | null = null;
  if (gate !== undefined) endedAt = gate.at;
  else if (accepted?.accepted != null) endedAt = accepted.accepted.at;
  else if (terminated) endedAt = snapshot.outcome?.at ?? null;
  return {
    id: `stage:${stageId}:${visit}`,
    kind: "stage",
    name: numbered(stageId, visit),
    participant: latest.agentId,
    state: visitState(snapshot, latest, accepted, gate, blockedHere),
    startedAt: first.dispatch?.at ?? first.openedAt,
    endedAt,
    details,
    artifacts,
  };
}

function visitState(
  snapshot: RunSnapshot,
  latest: SnapshotAttempt,
  accepted: SnapshotAttempt | undefined,
  gate: SnapshotGate | undefined,
  blockedHere: boolean,
): StateWord {
  if (gate !== undefined) {
    if (gate.decision === "pass") {
      return {
        word: gate.reason === "built" ? "accepted" : words(gate.reason),
        mark: "ok",
        tone: "green",
      };
    }
    const toFailure = "outcome" in gate.next && gate.next.outcome === "failed";
    return toFailure
      ? { word: words(gate.reason), mark: "alert", tone: "red" }
      : { word: words(gate.reason), mark: "retry", tone: "amber" };
  }
  // Once the run ended or its host is gone, no gate decision will follow.
  const terminated = snapshot.outcome !== null || hostLost(snapshot);
  if (accepted?.accepted != null && latest === accepted) {
    if (accepted.accepted.status === "failed")
      return { word: "reported failure", mark: "alert", tone: "red" };
    return terminated
      ? { word: "accepted · no gate", mark: "dot", tone: "dim" }
      : { word: "accepted · awaiting gate", mark: "active", tone: "cyan" };
  }
  if (blockedHere) {
    const reason = snapshot.attention.blocked?.reason;
    return { word: `blocked · ${words(reason)}`, mark: "alert", tone: "amber" };
  }
  if (latest.status === "abandoned") return { word: "abandoned", mark: "dot", tone: "dim" };
  if (latest.status !== "open") return { word: words(latest.status), mark: "dot", tone: "dim" };
  if (hostLost(snapshot)) return { word: "outcome unknown", mark: "unknown", tone: "red" };
  switch (latest.delivery) {
    case "undispatched":
      return { word: "preparing", mark: "active", tone: "cyan" };
    case "ambiguous":
      return latest.reconciliation?.resolution === "delivered"
        ? { word: "awaiting result", mark: "active", tone: "cyan" }
        : { word: "delivery unconfirmed", mark: "retry", tone: "amber" };
    case "not_delivered":
      return { word: "not delivered", mark: "alert", tone: "amber" };
    default:
      return { word: "awaiting result", mark: "active", tone: "cyan" };
  }
}

function attemptLine(attempt: SnapshotAttempt, clock: Clock): string {
  const parts: string[] = [];
  if (attempt.cause !== "initial") parts.push(words(attempt.cause));
  if (attempt.dispatch === null) parts.push("not dispatched");
  else {
    parts.push(`dispatched ${clock(attempt.dispatch.at)}`);
    if (attempt.delivery === "ambiguous") parts.push("delivery unconfirmed");
    if (attempt.delivery === "not_delivered") parts.push("not delivered");
  }
  if (attempt.reconciliation !== null)
    parts.push(`delivery ${text(attempt.reconciliation.resolution)}`);
  if (attempt.accepted !== null) {
    const accepted = `accepted ${clock(attempt.accepted.at)}`;
    return `${parts.join(" · ")} → ${accepted}${attempt.accepted.status === "failed" ? " · reported failure" : ""}`;
  }
  if (attempt.status === "superseded") parts.push("superseded");
  else if (attempt.status === "abandoned") parts.push("abandoned");
  return parts.join(" · ");
}

/** The gate that sent the run into this stage visit: the latest one naming it before the visit opened. */
function enteringGate(
  snapshot: RunSnapshot,
  stageId: string,
  openedSeq: number,
): SnapshotGate | undefined {
  return snapshot.gates.findLast(
    (gate) => gate.seq < openedSeq && "stageId" in gate.next && gate.next.stageId === stageId,
  );
}

function enteredBy(gate: SnapshotGate): string {
  const subject = `${text(gate.subject.stageId)} / visit ${gate.subject.visit}`;
  if (gate.kind === "check") return `${gateReason(gate)} on ${subject} (${text(gate.gate)})`;
  return `accepted ${subject} · ${gateReason(gate)}`;
}

/** `changes requested`, `checks passed`, `approved`, `passed`. */
function gateReason(gate: SnapshotGate): string {
  return gate.reason === "built" ? "passed" : words(gate.reason);
}

/** `changes requested → repair`, `approved → completed`, `passed → verify again`. */
function gatePhrase(gate: SnapshotGate): string {
  const target = "stageId" in gate.next ? gate.next.stageId : gate.next.outcome;
  return `${gateReason(gate)} → ${text(target)}${target === gate.gate ? " again" : ""}`;
}

/** Who receives this visit's accepted result when the gate routes to another stage. */
function handoffOf(
  snapshot: RunSnapshot,
  stage: SnapshotStage,
  gate: SnapshotGate,
): string | undefined {
  if (!("stageId" in gate.next) || gate.decision !== "reject") return undefined;
  const nextStage = gate.next.stageId;
  const receiver = snapshot.stages.find((item) => item.stageId === nextStage)?.agentId ?? null;
  if (receiver === null) return undefined;
  const sameAgent = snapshot.stages.some(
    (item) => item.agentId === receiver && item.stageId !== nextStage && item.visits.length > 0,
  );
  return `accepted ${text(stage.stageId)} → ${text(receiver)}${sameAgent ? " (same agent)" : ""}`;
}

/** The `run.activity` check_run start of a check gate: the last start on its subject before it. */
function checkStart(
  events: readonly RunEvent[],
  gate: SnapshotGate,
): { seq: number; ts: string } | undefined {
  const start = events.findLast(
    (event) =>
      event.seq < gate.seq &&
      event.type === "run.activity" &&
      event.data["kind"] === "check_run" &&
      event.data["phase"] === "started" &&
      event.subject.stageId === gate.subject.stageId &&
      event.subject.visit === gate.subject.visit &&
      event.subject.attempt === gate.subject.attempt,
  );
  return start === undefined ? undefined : { seq: start.seq, ts: start.ts };
}

function checkNode(
  model: RunModelInput,
  gate: SnapshotGate,
  count: number,
  startedAt: string | null,
): StepNode {
  const check = gate.check;
  const subject = `${text(gate.subject.stageId)} / visit ${gate.subject.visit}`;
  const target = "stageId" in gate.next ? gate.next.stageId : gate.next.outcome;
  const details: DetailLine[] = [];
  if (check !== null) {
    details.push({ label: "command", value: check.command.map((part) => text(part)).join(" ") });
    const exit = check.timedOut
      ? "timed out"
      : check.signal !== null
        ? `signal ${text(check.signal)}`
        : `exit ${text(check.exitCode)}`;
    details.push({
      label: "result",
      value: `${exit} → ${text(target)}`,
      tone: gate.decision === "pass" ? "green" : "amber",
    });
  }
  details.push({ label: "checked", value: `${subject} / attempt ${gate.subject.attempt}` });
  const toFailure = "outcome" in gate.next && gate.next.outcome === "failed";
  const state: StateWord =
    gate.decision === "pass"
      ? { word: "passed", mark: "ok", tone: "green" }
      : toFailure
        ? { word: words(gate.reason), mark: "alert", tone: "red" }
        : { word: words(gate.reason), mark: "retry", tone: "amber" };
  return {
    id: `check:${gate.gate}:${count}`,
    kind: "check",
    name: numbered(gate.gate, count),
    participant: "check",
    state,
    startedAt,
    endedAt: gate.at,
    details,
    artifacts:
      check === null
        ? []
        : [
            {
              id: `evidence:${gate.gate}:${count}`,
              kind: "evidence",
              label: basename(check.evidence.path),
              path: join(model.runDir, check.evidence.path),
              relPath: check.evidence.path,
              stageId: gate.subject.stageId,
              visit: gate.subject.visit,
              attempt: gate.subject.attempt,
              context: `verification evidence · ${text(gate.gate)} on ${subject} · ${gatePhrase(gate)}`,
              bytes: check.evidence.bytes,
              sha256: check.evidence.sha256,
            },
          ],
  };
}

/**
 * Possible next steps along the workflow graph's first route from the current
 * step, subdued and conditional. They are routes, not a checklist: none once
 * the run ended, while it is blocked or its host is lost, or without a graph.
 */
function pendingSteps(
  model: RunModelInput,
  steps: StepNode[],
  checkCounts: Map<string, number>,
): StepNode[] {
  const { snapshot, graph } = model;
  if (graph === null || snapshot.outcome !== null || hostLost(snapshot)) return [];
  if (snapshot.attention.blocked !== null) return [];
  const current = steps.at(-1);
  if (current === undefined) return [];
  const currentId = current.id.split(":")[1] as string;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const visits = new Map<string, number>();
  for (const stage of snapshot.stages) visits.set(stage.stageId, stage.visits.length);
  for (const [id, count] of checkCounts) visits.set(id, count);
  const pending: StepNode[] = [];
  let previous = { id: currentId, name: current.name };
  const seen = new Set([currentId]);
  const agentOf = (id: string) =>
    nodes.get(id)?.kind === "check"
      ? "check"
      : (snapshot.stages.find((stage) => stage.stageId === id)?.agentId ?? "—");
  // A finished step whose gate already chose the route: that stage is next, not conditional.
  const last = snapshot.gates.at(-1);
  const decidedHere =
    last !== undefined &&
    (last.kind === "stage"
      ? current.id === `stage:${last.subject.stageId}:${last.subject.visit}`
      : current.kind === "check" && current.endedAt === last.at);
  const routed = decidedHere ? last : undefined;
  if (routed !== undefined && "stageId" in routed.next) {
    const next = routed.next.stageId;
    const name = numbered(next, (visits.get(next) ?? 0) + 1);
    pending.push({
      id: `pending:${next}`,
      kind: "pending",
      name,
      participant: agentOf(next),
      state: { word: `next · ${gateReason(routed)}`, mark: "dot", tone: "dim" },
      startedAt: null,
      endedAt: null,
      details: [
        { label: "", value: `routed by the ${text(routed.gate)} gate: ${gatePhrase(routed)}` },
        { label: "", value: "not started yet" },
      ],
      artifacts: [],
    });
    seen.add(next);
    previous = { id: next, name };
  }
  // The route "if each gate passes" ends at a step that can complete the run; its other
  // edges are rejection routes, not the next step.
  const completes = (id: string) => (graph.edges[id] ?? []).includes("completed");
  for (let index = pending.length; index < 2 && !completes(previous.id); index += 1) {
    const next = (graph.edges[previous.id] ?? []).find((id) => nodes.has(id) && !seen.has(id));
    if (next === undefined) break;
    seen.add(next);
    const node = nodes.get(next);
    const count = (visits.get(next) ?? 0) + 1;
    const name = numbered(next, count);
    const agent =
      node?.kind === "check"
        ? "check"
        : (snapshot.stages.find((stage) => stage.stageId === next)?.agentId ?? "—");
    pending.push({
      id: `pending:${next}`,
      kind: "pending",
      name,
      participant: agent,
      state: { word: `pending ${previous.name}`, mark: "dot", tone: "dim" },
      startedAt: null,
      endedAt: null,
      details: [
        { label: "", value: `conditional on the ${previous.name} gate passing` },
        {
          label: "",
          value: node?.kind === "check" ? "no check has started" : "no attempt has started",
        },
      ],
      artifacts: [],
    });
    previous = { id: next, name };
  }
  return pending;
}

// --- notes ---------------------------------------------------------------------------------------

function outcomeWord(snapshot: RunSnapshot): StateWord | null {
  const outcome = snapshot.outcome;
  if (outcome === null) return null;
  const state = runState(snapshot);
  const limit =
    outcome.outcome === "exhausted" && outcome.limit !== null ? ` (${text(outcome.limit)})` : "";
  return { ...state, word: `${outcome.outcome} · ${words(outcome.reason)}${limit}` };
}

function stepsNoteOf(snapshot: RunSnapshot, steps: StepNode[]): StateWord | null {
  const outcome = outcomeWord(snapshot);
  if (outcome !== null) return { ...outcome, word: `result: ${outcome.word}` };
  if (hostLost(snapshot))
    return {
      word: `${snapshot.liveness.owner === "lost" ? "host lost" : "host exited"} · outcome unknown`,
      mark: "unknown",
      tone: "red",
    };
  const blocked = snapshot.attention.blocked;
  if (blocked !== null) {
    return {
      word: `action: ${text(blocked.requiredAction)} (${where(snapshot, blocked.agentId)})`,
      mark: "alert",
      tone: "amber",
    };
  }
  const pending = steps.filter((step) => step.kind === "pending");
  if (pending.length === 0) return null;
  return {
    word: `next: ${pending.map((step) => step.name).join(" → ")}, if each gate passes`,
    mark: "dot",
    tone: "dim",
  };
}

function waitOf(snapshot: RunSnapshot, steps: StepNode[]): RunModel["wait"] {
  if (snapshot.outcome !== null || hostLost(snapshot) || snapshot.attention.blocked !== null)
    return null;
  const activity = snapshot.activity.open.at(-1);
  if (activity !== undefined) {
    const who = activity.agentId === null ? "" : ` ${text(activity.agentId)}`;
    const phrase =
      activity.kind === "readiness_wait"
        ? `waiting for${who} to become ready`
        : activity.kind === "check_run"
          ? "running checks"
          : activity.kind === "delivery_check"
            ? `checking delivery to${who}`
            : "checking the repository revision";
    return { text: phrase, since: activity.since };
  }
  const current = steps.findLast((step) => step.kind !== "pending");
  if (current === undefined || current.endedAt !== null) return null;
  if (current.state.word === "accepted · awaiting gate")
    return { text: `waiting for the ${current.name} gate`, since: current.startedAt ?? "" };
  if (current.kind === "stage" && current.startedAt !== null)
    return {
      text: `waiting for ${current.participant} / ${current.name}`,
      since: current.startedAt,
    };
  return null;
}

function activityNoteOf(snapshot: RunSnapshot): StateWord | null {
  const outcome = outcomeWord(snapshot);
  if (outcome !== null) return { ...outcome, word: `recorded outcome: ${outcome.word}` };
  if (snapshot.liveness.owner === "lost")
    return { word: "host lost; outcome unknown", mark: "unknown", tone: "red" };
  if (snapshot.liveness.owner === "exited")
    return {
      word: "host exited without an outcome; outcome unknown",
      mark: "unknown",
      tone: "red",
    };
  const blocked = snapshot.attention.blocked;
  if (blocked !== null) {
    return {
      word: `run blocked; ${text(blocked.requiredAction)} (${where(snapshot, blocked.agentId)})`,
      mark: "alert",
      tone: "amber",
    };
  }
  return null;
}

// --- config --------------------------------------------------------------------------------------

function configOf(model: RunModelInput, clock: Clock): ConfigDoc {
  const { snapshot, runDir, config } = model;
  const agents: AgentConfigRow[] = snapshot.agents.map((agent) => {
    const observed: string[] = [];
    if (agent.assignment !== null) {
      const tab = agent.assignment.tabId === null ? "" : ` · tab ${text(agent.assignment.tabId)}`;
      observed.push(
        `assigned ${clock(agent.assignment.at)} · pane ${text(agent.assignment.paneId)}${tab}`,
      );
    }
    if (agent.lifecycle !== null)
      observed.push(
        `last recorded ${text(agent.lifecycle.state)} at ${clock(agent.lifecycle.since)}`,
      );
    return {
      agentId: agent.agentId,
      role: agent.role,
      kind: agent.kind,
      model: agent.model,
      stages: snapshot.stages
        .filter((stage) => stage.agentId === agent.agentId)
        .map((stage) => stage.stageId),
      observed: observed.length === 0 ? null : observed.join(" · "),
    };
  });

  const context: DetailLine[] = [];
  const recorded = isObject(config) ? config : undefined;
  const roots =
    recorded !== undefined && isObject(recorded["roots"]) ? recorded["roots"] : undefined;
  const project = roots !== undefined && isObject(roots["project"]) ? roots["project"] : undefined;
  context.push({
    label: "project",
    value: typeof project?.["root"] === "string" ? text(project["root"]) : "unknown",
  });
  if (typeof recorded?.["repository"] === "string")
    context.push({ label: "repository", value: text(recorded["repository"]) });
  const revision = snapshot.gates.at(-1)?.revision;
  if (revision !== undefined) {
    context.push({
      label: "revision",
      value: `${revision.head === null ? "no commits" : `head ${revision.head.slice(0, 12)}`} · tree ${revision.tree.slice(0, 12)} (last gate)`,
    });
  }
  context.push({ label: "run", value: text(snapshot.runId) });
  context.push({ label: "run dir", value: text(runDir) });
  const workflowSource =
    recorded !== undefined && isObject(recorded["workflow"]) ? recorded["workflow"] : undefined;
  context.push({
    label: "workflow",
    value:
      snapshot.workflow === null
        ? "unknown"
        : `${text(snapshot.workflow.name)} v${text(snapshot.workflow.version)}${
            typeof workflowSource?.["source"] === "string"
              ? ` · ${text(workflowSource["source"])}`
              : ""
          }`,
  });
  for (const command of verifyCommands(snapshot, model.graph, model.input))
    context.push({ label: "verify", value: command });
  if (snapshot.limits !== null)
    context.push({ label: "limits", value: limitsLine(snapshot.limits) });
  context.push({ label: "opened", value: `${text(snapshot.openedAt)}` });
  const host = snapshot.liveness.host;
  context.push({
    label: "host",
    value:
      host === null
        ? `${text(snapshot.liveness.owner)} · no host claim recorded`
        : `${text(snapshot.liveness.owner)} · pid ${text(host.pid)}${host.paneId == null ? "" : ` · pane ${text(host.paneId)}`}`,
  });
  if (recorded !== undefined) {
    if (typeof recorded["resolvedAt"] === "string")
      context.push({
        label: "config",
        value: `resolved ${text(recorded["resolvedAt"])} · config.json`,
      });
    const provenance = provenanceLine(recorded);
    if (provenance !== "") context.push({ label: "provenance", value: provenance });
    const files = Array.isArray(recorded["files"]) ? recorded["files"] : [];
    for (const file of files) {
      if (isObject(file) && typeof file["path"] === "string")
        context.push({ label: "file", value: `${text(file["scope"])} ${text(file["path"])}` });
    }
  } else {
    context.push({
      label: "config",
      value:
        snapshot.config === null ? "no resolved configuration recorded" : "config.json unreadable",
    });
  }

  let inputProblem: string | null = null;
  if (snapshot.input === null) inputProblem = "no saved input recorded";
  else if (model.input === undefined) inputProblem = `${snapshot.input.path} could not be read`;
  return {
    agents,
    input: model.input,
    inputPath: snapshot.input === null ? null : join(runDir, snapshot.input.path),
    inputProblem,
    context,
  };
}

function verifyCommands(
  snapshot: RunSnapshot,
  graph: WorkflowGraph | null,
  input: unknown,
): string[] {
  const commands: string[] = [];
  for (const id of snapshot.checks ?? []) {
    const gate = snapshot.gates.findLast((item) => item.kind === "check" && item.gate === id);
    const node = graph?.nodes.find((item) => item.id === id);
    const command =
      gate?.check != null
        ? gate.check.command.map((part) => text(part)).join(" ")
        : (node?.command ?? null);
    commands.push(`${text(id)}: ${command ?? "command not recorded"}`);
  }
  if (commands.length === 0 && isObject(input) && isObject(input["verify"])) {
    const command = input["verify"]["command"];
    if (Array.isArray(command)) commands.push(command.map((part) => text(part)).join(" "));
  }
  return commands;
}

function limitsLine(limits: NonNullable<RunSnapshot["limits"]>): string {
  return [
    `${limits.maxRounds} rounds`,
    `${limits.maxVisitsPerStage} visits/stage`,
    `${limits.maxAttemptsPerVisit} attempts/visit`,
    `${limits.maxFormatRepairs} format repairs`,
    `${duration(limits.runTimeoutMs)} timeout`,
  ].join(" · ");
}

/** The `source` of a recorded value, or of every value below a group. */
function sources(value: unknown): string[] {
  if (!isObject(value)) return [];
  if (typeof value["source"] === "string") return [value["source"]];
  return Object.values(value).flatMap(sources);
}

/** `workflow builtin · agents input · limits input, builtin` from the recorded sources. */
function provenanceLine(recorded: Record<string, unknown>): string {
  const parts: string[] = [];
  const add = (label: string, value: unknown) => {
    const found = [...new Set(sources(value))];
    if (found.length > 0) parts.push(`${label} ${found.map((item) => text(item)).join(", ")}`);
  };
  add("workflow", recorded["workflow"]);
  add("agents", recorded["agents"]);
  const settings = isObject(recorded["settings"]) ? recorded["settings"] : undefined;
  add("limits", settings?.["limits"]);
  return parts.join(" · ");
}
