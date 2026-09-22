import { TERMINAL_OUTCOMES } from "../domain/types.js";
import type { FormattableEvent } from "./format.js";
import { capitalized, isObject, text, words, type Style } from "./render-text.js";

/**
 * The run history vocabulary (pure): one journal event becomes zero, one or two
 * rows in plain English, keyed on the event type string, so a record type this
 * module does not know still shows up as a subdued `· <type>` row. The state a
 * row needs (which agent did what before, which attempt was retried) is folded
 * from the events themselves, in order, so replayed and live rows are the same.
 */

export type MarkName = "start" | "dispatch" | "ok" | "retry" | "alert" | "dot" | "received";

export interface Row {
  ts: string;
  mark: MarkName;
  style: Style | undefined;
  /** An agent id, `gate` or `run`. */
  participant: string;
  stage: string;
  message: string;
  /** Lines shown under the message, in the message column. */
  detail: string[];
  /**
   * A row about an agent's runtime (started, ready, gone) rather than its work;
   * it belongs to the phase that follows it and never ends the current one.
   */
  lifecycle: boolean;
  /** Starts a new phase of the run: a blank line goes before it. */
  phase: boolean;
}

export interface RosterEntry {
  kind: string | null;
  model: string | null;
  tabId: string | null;
  paneId: string | null;
}

export interface RowContext {
  /** Planned participants; updated when an assignment names a tab. */
  roster: Map<string, RosterEntry>;
  /** Stages whose submissions carry a verdict (reviews). */
  verdictStages: ReadonlySet<string>;
}

interface AttemptFacts {
  delivery: string | null;
  delivered: boolean;
  accepted: boolean;
}

export interface RowState {
  lastSeq: number;
  /** Agents assigned at least once, for `restarted`. */
  assigned: Set<string>;
  /** Stage ids each agent was dispatched to, for `same agent`. */
  dispatchedStages: Map<string, Set<string>>;
  attempts: Map<string, AttemptFacts>;
  latestByStage: Map<string, { visit: number; attempt: number }>;
}

export function emptyRowState(): RowState {
  return {
    lastSeq: 0,
    assigned: new Set(),
    dispatchedStages: new Map(),
    attempts: new Map(),
    latestByStage: new Map(),
  };
}

const APPROVING = new Set(["pass", "approve", "approved", "accept", "accepted", "ok", "lgtm"]);
const REQUESTING = new Set([
  "fail",
  "failed",
  "reject",
  "rejected",
  "changes",
  "changes_requested",
  "request_changes",
]);

/** The rows of one event; empty for a repeat (seq at or below the last one) or an internal fact. */
export function rowsOf(event: FormattableEvent, state: RowState, ctx: RowContext): Row[] {
  if (event.seq <= state.lastSeq) return [];
  state.lastSeq = event.seq;
  const data = isObject(event.data) ? event.data : {};
  const subject = isObject(event.subject) ? event.subject : {};
  const agentId = typeof subject["agentId"] === "string" ? subject["agentId"] : undefined;
  const stageId = typeof subject["stageId"] === "string" ? subject["stageId"] : undefined;
  const visit = typeof subject["visit"] === "number" ? subject["visit"] : undefined;
  const attempt = typeof subject["attempt"] === "number" ? subject["attempt"] : undefined;
  const base = (over: Partial<Row>): Row => ({
    ts: event.ts,
    mark: "dot",
    style: undefined,
    participant: agentId ?? "run",
    stage: stageId ?? "",
    message: "",
    detail: [],
    lifecycle: false,
    phase: false,
    ...over,
  });
  try {
    switch (event.type) {
      case "run.opened":
        return [base({ participant: "run", stage: "", message: "Started", lifecycle: true })];

      case "host.claimed":
        return [];

      case "host.exited": {
        const reason = text(data["reason"]);
        if ((TERMINAL_OUTCOMES as readonly string[]).includes(reason)) return [];
        return [
          base({
            participant: "run",
            mark: "alert",
            style: "red",
            message: `Host exited · ${words(reason)}`,
          }),
        ];
      }

      case "host.lost":
        return [
          base({
            participant: "run",
            mark: "alert",
            style: "red",
            message: `Host lost · outcome unknown (${words(data["reason"])})`,
          }),
        ];

      case "agent.assigned": {
        const id = agentId ?? text(data["agentId"]);
        const entry = ctx.roster.get(id) ?? { kind: null, model: null, tabId: null, paneId: null };
        const runtime = isObject(data["runtime"]) ? data["runtime"] : {};
        ctx.roster.set(id, {
          ...entry,
          tabId: typeof data["tabId"] === "string" ? data["tabId"] : entry.tabId,
          paneId: typeof runtime["paneId"] === "string" ? runtime["paneId"] : entry.paneId,
        });
        const again = state.assigned.has(id);
        state.assigned.add(id);
        return [
          base({
            participant: id,
            mark: "start",
            style: "cyan",
            message: `${again ? "Agent restarted" : "Agent started"} · ${agentLabel(entry)}`,
            lifecycle: true,
            phase: true,
          }),
        ];
      }

      case "attempt.opened": {
        if (stageId === undefined || visit === undefined || attempt === undefined) return [];
        const cause = causeOf(state, stageId, visit, attempt);
        state.attempts.set(attemptKey(stageId, visit, attempt), {
          delivery: null,
          delivered: false,
          accepted: false,
        });
        state.latestByStage.set(stageId, { visit, attempt });
        if (cause === "initial") {
          // The dispatch row that follows tells the story; a visit start only opens a phase.
          return [base({ message: "", phase: attempt === 1 })];
        }
        return [
          base({
            mark: "retry",
            style: "yellow",
            message:
              cause === "format_repair"
                ? `Fixing result format · attempt ${attempt}`
                : `Retrying work · attempt ${attempt}`,
          }),
        ];
      }

      case "request.dispatched": {
        const id = agentId ?? "run";
        const delivery = text(data["delivery"]);
        if (stageId !== undefined && visit !== undefined && attempt !== undefined) {
          const facts = state.attempts.get(attemptKey(stageId, visit, attempt));
          if (facts !== undefined) facts.delivery = delivery;
        }
        const before = state.dispatchedStages.get(id) ?? new Set<string>();
        const sameAgent = [...before].some((other) => other !== stageId);
        if (stageId !== undefined) before.add(stageId);
        state.dispatchedStages.set(id, before);
        if (delivery === "not_delivered") {
          return [
            base({
              mark: "alert",
              style: "yellow",
              message: `Task not delivered · ${words(data["reason"])}`,
            }),
          ];
        }
        if (delivery === "ambiguous") {
          return [
            base({
              mark: "retry",
              style: "yellow",
              message: `Delivery unconfirmed · checking (${words(data["reason"])})`,
            }),
          ];
        }
        const qualifiers = [
          ...(sameAgent ? ["same agent"] : []),
          ...(visit !== undefined && visit > 1 ? [`visit ${visit}`] : []),
          ...(attempt !== undefined && attempt > 1 ? [`attempt ${attempt}`] : []),
        ];
        return [
          base({
            mark: "dispatch",
            style: "cyan",
            message: ["Task dispatched", ...qualifiers].join(" · "),
          }),
        ];
      }

      case "delivery.reconciled": {
        if (stageId !== undefined && visit !== undefined && attempt !== undefined) {
          const facts = state.attempts.get(attemptKey(stageId, visit, attempt));
          if (facts !== undefined && data["resolution"] === "delivered") facts.delivered = true;
        }
        return data["resolution"] === "delivered"
          ? [base({ mark: "dispatch", style: "cyan", message: "Delivery confirmed" })]
          : [
              base({
                mark: "alert",
                style: "yellow",
                message: `Delivery abandoned · ${words(data["evidence"])}`,
              }),
            ];
      }

      case "submission.accepted": {
        if (stageId !== undefined && visit !== undefined && attempt !== undefined) {
          const facts = state.attempts.get(attemptKey(stageId, visit, attempt));
          if (facts !== undefined) facts.accepted = true;
        }
        const status = text(data["status"]);
        if (stageId !== undefined && ctx.verdictStages.has(stageId)) {
          if (status === "failed") {
            return [base({ mark: "alert", style: "red", message: "Review reported failure" })];
          }
          return [
            base({
              mark: "received",
              message: `Review received · ${verdictPhrase(data["verdict"])}`,
            }),
          ];
        }
        if (status === "failed") {
          return [base({ mark: "alert", style: "red", message: "Failure reported" })];
        }
        return [base({ mark: "ok", style: "green", message: "Completion report accepted" })];
      }

      case "submission.rejected":
        return [
          base({
            participant: agentId ?? "run",
            mark: "alert",
            style: "yellow",
            message: `Result rejected: ${rejectionPhrase(data)}`,
          }),
        ];

      case "submission.duplicate":
        return [base({ message: "Duplicate result ignored" })];

      case "gate.recorded":
        return [gateRow(base, data)];

      case "run.blocked": {
        const id = agentId ?? text(data["agentId"]);
        const entry = ctx.roster.get(id);
        const where =
          entry?.tabId !== null && entry?.tabId !== undefined
            ? `, tab ${entry.tabId}`
            : entry?.paneId !== null && entry?.paneId !== undefined
              ? `, pane ${entry.paneId}`
              : "";
        return [
          base({
            participant: id,
            mark: "alert",
            style: "red",
            message: `Blocked: ${words(data["reason"])}`,
            detail: [`${text(data["requiredAction"])} · ${id}${where}`],
          }),
        ];
      }

      case "run.unblocked":
        return [base({ mark: "dispatch", style: "cyan", message: "Unblocked · agent continues" })];

      case "run.cancel_requested":
        return [
          base({
            participant: "run",
            message: `Cancel requested · ${words(data["source"])}: ${text(data["reason"])}`,
          }),
        ];

      case "run.terminated":
        // The summary states the outcome; a row would say it twice.
        return [];

      case "observation.lost":
        return [
          base({
            mark: "alert",
            style: "yellow",
            message: `Observation lost · ${words(data["code"])}`,
            lifecycle: true,
          }),
        ];

      case "observation.recovered":
        return [base({ message: "Observation recovered", lifecycle: true })];

      case "agent.lifecycle_changed":
        return [lifecycleRow(base, data)];

      case "run.activity":
        return activityRows(base, data);

      default:
        return [base({ style: "dim", message: `· ${text(event.type)}` })];
    }
  } catch {
    return [base({ style: "dim", message: `· ${text(event.type)}` })];
  }
}

function gateRow(base: (over: Partial<Row>) => Row, data: Record<string, unknown>): Row {
  const gate = text(data["gate"]);
  const decision = text(data["decision"]);
  const reason = text(data["reason"]);
  const next = isObject(data["next"]) ? data["next"] : {};
  const target =
    typeof next["stageId"] === "string"
      ? next["stageId"]
      : typeof next["outcome"] === "string"
        ? next["outcome"]
        : "?";
  const toFailure = next["outcome"] === "failed";
  let phrase: string;
  switch (reason) {
    case "built":
      phrase = "Passed";
      break;
    case "approved":
      phrase = "Approved";
      break;
    case "checks_passed":
      phrase = "Checks passed";
      break;
    case "checks_failed":
      phrase = "Checks failed";
      break;
    case "changes_requested":
      phrase = "Changes requested";
      break;
    case "revision_moved":
      phrase = "Revision changed";
      break;
    default:
      phrase = capitalized(words(reason));
  }
  const arrow = target === gate ? `→ ${target} again` : `→ ${target}`;
  if (decision === "pass") {
    return base({
      participant: "gate",
      stage: gate,
      mark: "ok",
      style: "green",
      message: `${phrase} ${arrow}`,
    });
  }
  return base({
    participant: "gate",
    stage: gate,
    mark: toFailure ? "alert" : "retry",
    style: toFailure ? "red" : "yellow",
    message: `${phrase} ${arrow}`,
  });
}

function lifecycleRow(base: (over: Partial<Row>) => Row, data: Record<string, unknown>): Row {
  const id = typeof data["agentId"] === "string" ? data["agentId"] : undefined;
  const to = text(data["to"]);
  const replaced = data["replaced"] === true ? " · replaced" : "";
  const common: Partial<Row> = {
    lifecycle: true,
    ...(id === undefined ? {} : { participant: id }),
  };
  switch (to) {
    case "starting":
      return base({ ...common, message: "Waiting for agent to become ready" });
    case "ready":
      return base({ ...common, message: "Agent ready" });
    case "working":
      return base({ ...common, message: "Agent working" });
    case "blocked":
      return base({ ...common, mark: "alert", style: "yellow", message: "Blocked · agent waits" });
    case "gone":
      return base({ ...common, mark: "alert", style: "red", message: `Agent gone${replaced}` });
    default:
      return base({ ...common, message: `Agent ${words(to)}${replaced}` });
  }
}

function activityRows(base: (over: Partial<Row>) => Row, data: Record<string, unknown>): Row[] {
  const kind = text(data["kind"]);
  const phase = text(data["phase"]);
  const id = typeof data["agentId"] === "string" ? data["agentId"] : undefined;
  const stage = typeof data["stageId"] === "string" ? data["stageId"] : undefined;
  const detail = typeof data["detail"] === "string" ? data["detail"] : undefined;
  const result = typeof data["result"] === "string" ? data["result"] : undefined;
  const common: Partial<Row> = {
    ...(id === undefined ? {} : { participant: id }),
    ...(stage === undefined ? {} : { stage }),
  };
  const started = phase === "started";
  switch (kind) {
    case "readiness_wait":
      if (started) {
        return [base({ ...common, lifecycle: true, message: "Waiting for agent to become ready" })];
      }
      return result === undefined || result === "ready"
        ? [base({ ...common, lifecycle: true, message: "Agent ready" })]
        : [
            base({
              ...common,
              lifecycle: true,
              mark: "alert",
              style: "yellow",
              message: `Agent not ready · ${words(result)}`,
            }),
          ];
    case "revision_check":
      return started ? [base({ ...common, message: "Checking repository revision" })] : [];
    case "check_run":
      return started
        ? [
            base({
              ...common,
              participant: "gate",
              message: `Running checks${detail === undefined ? "" : ` · ${detail}`}`,
            }),
          ]
        : [];
    case "delivery_check":
      return started
        ? [
            base({
              ...common,
              mark: "retry",
              style: "yellow",
              message: "Delivery unconfirmed · checking",
            }),
          ]
        : [];
    default:
      return [
        base({
          ...common,
          style: "dim",
          message: `· ${words(kind)} ${words(phase)}${detail === undefined ? "" : ` · ${detail}`}`,
        }),
      ];
  }
}

function verdictPhrase(verdict: unknown): string {
  if (typeof verdict !== "string") return "no verdict";
  const key = verdict.toLowerCase();
  if (APPROVING.has(key)) return "approval recommended";
  if (REQUESTING.has(key)) return "changes requested";
  return `verdict ${text(verdict)}`;
}

/** `missing completion artifact`-style reason with the first offending field, when the record names one. */
function rejectionPhrase(data: Record<string, unknown>): string {
  const reason = words(data["reason"]);
  const details = Array.isArray(data["details"]) ? data["details"] : [];
  const first = details.find(isObject);
  if (first !== undefined && typeof first["field"] === "string") {
    return `${reason} · ${text(first["field"])}${
      typeof first["message"] === "string" && first["message"] !== ""
        ? ` ${text(first["message"])}`
        : ""
    }`;
  }
  const message = typeof data["message"] === "string" ? text(data["message"]) : "";
  return message === "" || message === text(data["reason"]) ? reason : `${reason} · ${message}`;
}

function agentLabel(entry: RosterEntry): string {
  const kind = entry.kind === null ? "unknown kind" : text(entry.kind);
  const model = entry.model === null ? "provider default" : text(entry.model);
  return `${kind} / ${model}`;
}

/** The reducer's rule for why an attempt opened, folded from the rows' own view of the visit. */
function causeOf(
  state: RowState,
  stageId: string,
  visit: number,
  attempt: number,
): "initial" | "format_repair" | "work_retry" {
  const latest = state.latestByStage.get(stageId);
  if (latest === undefined || latest.visit !== visit || attempt === 1) return "initial";
  const previous = state.attempts.get(attemptKey(stageId, latest.visit, latest.attempt));
  if (previous === undefined) return "initial";
  if (previous.accepted) return "work_retry";
  if (previous.delivery === null || previous.delivery === "not_delivered") return "work_retry";
  if (previous.delivery === "started") return "format_repair";
  return previous.delivered ? "format_repair" : "work_retry";
}

function attemptKey(stageId: string, visit: number, attempt: number): string {
  return `${stageId}/${visit}/${attempt}`;
}
