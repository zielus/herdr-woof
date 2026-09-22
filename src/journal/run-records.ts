import { isId, isPlainObject, isPositiveInteger } from "../contracts/envelope.js";
import {
  DISPATCH_DELIVERIES,
  DISPATCH_REASONS,
  LIMIT_KEYS,
  TERMINAL_OUTCOMES,
  type DispatchDelivery,
  type Limits,
  type Revision,
  type TerminalOutcome,
} from "../domain/types.js";
import {
  check,
  exactKeysProblem,
  fileRefProblem,
  keysProblem,
  nonEmptyStringProblem,
  paneProblem,
  revisionProblem,
} from "./record-fields.js";
import type { RecordBase } from "./records.js";

/**
 * Run-fact records added in p2: agent assignment, request dispatch with its
 * delivery certainty, and termination. p3 adds optional request, target and
 * revision fields to request.dispatched; the p3 control records live in
 * control-records.ts.
 */

export interface AgentAssignedRecord extends RecordBase {
  type: "agent.assigned";
  agentId: string;
  runtime: { adapter: string; runtimeName: string; paneId: string };
  terminalId?: string;
  sessionId?: string;
  /** The Herdr tab created for the agent's pane, when the runtime reported one (additive; absent in older journals). */
  tabId?: string;
}

export interface RequestDispatchedRecord extends RecordBase {
  type: "request.dispatched";
  agentId: string;
  stageId: string;
  visit: number;
  attempt: number;
  delivery: DispatchDelivery;
  /** Closed per delivery value; see DISPATCH_REASONS. */
  reason: string;
  paneId?: string;
  /** Persisted request text (p3): `requests/<stage>/visit-<n>/attempt-<m>/request.md`. */
  request?: { path: string; sha256: string; bytes: number };
  /** Runtime identity observed at dispatch (p3). */
  target?: { terminalId: string | null; sessionId: string | null };
  /** Repository revision when the request was sent (p3). */
  revision?: Revision;
}

/** Persisted request file of an attempt, relative to the run directory. */
export function requestPathFor(stageId: string, visit: number, attempt: number): string {
  return `requests/${stageId}/visit-${visit}/attempt-${attempt}/request.md`;
}

export interface RunTerminatedRecord extends RecordBase {
  type: "run.terminated";
  outcome: TerminalOutcome;
  reason: string;
  /** Present exactly when outcome is "exhausted". */
  limit?: keyof Limits;
}

export function agentAssignedProblem(value: Record<string, unknown>): string | undefined {
  const problem =
    keysProblem(value, ["agentId", "runtime"], ["terminalId", "sessionId", "tabId"]) ??
    check(isId(value["agentId"]), "agentId is invalid");
  if (problem !== undefined) return problem;
  const runtime = value["runtime"];
  if (!isPlainObject(runtime)) return "runtime is not an object";
  return (
    exactKeysProblem(runtime, ["adapter", "runtimeName", "paneId"], [], "runtime.") ??
    check(isId(runtime["adapter"]), "runtime.adapter is invalid") ??
    nonEmptyStringProblem(runtime, "runtimeName", "runtime.") ??
    nonEmptyStringProblem(runtime, "paneId", "runtime.") ??
    (value["terminalId"] === undefined ? undefined : nonEmptyStringProblem(value, "terminalId")) ??
    (value["sessionId"] === undefined ? undefined : nonEmptyStringProblem(value, "sessionId")) ??
    (value["tabId"] === undefined ? undefined : nonEmptyStringProblem(value, "tabId"))
  );
}

export function requestDispatchedProblem(value: Record<string, unknown>): string | undefined {
  const problem =
    keysProblem(
      value,
      ["agentId", "stageId", "visit", "attempt", "delivery", "reason"],
      ["paneId", "request", "target", "revision"],
    ) ??
    check(isId(value["agentId"]), "agentId is invalid") ??
    check(isId(value["stageId"]), "stageId is invalid") ??
    check(isPositiveInteger(value["visit"]), "visit is invalid") ??
    check(isPositiveInteger(value["attempt"]), "attempt is invalid");
  if (problem !== undefined) return problem;
  const delivery = value["delivery"];
  if (!(DISPATCH_DELIVERIES as readonly unknown[]).includes(delivery)) {
    return `delivery is not one of ${DISPATCH_DELIVERIES.join(", ")}`;
  }
  const reasons: readonly string[] = DISPATCH_REASONS[delivery as DispatchDelivery];
  return (
    check(
      typeof value["reason"] === "string" && reasons.includes(value["reason"]),
      `reason is not one of ${reasons.join(", ")} for delivery ${String(delivery)}`,
    ) ??
    paneProblem(value) ??
    (value["request"] === undefined
      ? undefined
      : fileRefProblem(
          value["request"],
          "request",
          requestPathFor(
            value["stageId"] as string,
            value["visit"] as number,
            value["attempt"] as number,
          ),
        )) ??
    (value["target"] === undefined ? undefined : targetProblem(value["target"])) ??
    (value["revision"] === undefined ? undefined : revisionProblem(value["revision"], "revision"))
  );
}

function targetProblem(target: unknown): string | undefined {
  if (!isPlainObject(target)) return "target is not an object";
  return (
    exactKeysProblem(target, ["terminalId", "sessionId"], [], "target.") ??
    check(
      target["terminalId"] === null ||
        (typeof target["terminalId"] === "string" && target["terminalId"] !== ""),
      "target.terminalId is not a non-empty string or null",
    ) ??
    check(
      target["sessionId"] === null ||
        (typeof target["sessionId"] === "string" && target["sessionId"] !== ""),
      "target.sessionId is not a non-empty string or null",
    )
  );
}

/** Whether `value` is one of the run's terminal outcomes (the closed list `run.terminated` carries). */
export function isTerminalOutcome(value: unknown): value is TerminalOutcome {
  return (TERMINAL_OUTCOMES as readonly unknown[]).includes(value);
}

export function runTerminatedProblem(value: Record<string, unknown>): string | undefined {
  const problem =
    keysProblem(value, ["outcome", "reason"], ["limit"]) ??
    check(
      isTerminalOutcome(value["outcome"]),
      `outcome is not one of ${TERMINAL_OUTCOMES.join(", ")}`,
    ) ??
    nonEmptyStringProblem(value, "reason");
  if (problem !== undefined) return problem;
  if (value["outcome"] === "exhausted") {
    return check(
      (LIMIT_KEYS as readonly unknown[]).includes(value["limit"]),
      "limit must name a Limits field when outcome is exhausted",
    );
  }
  return check(value["limit"] === undefined, "limit is only allowed when outcome is exhausted");
}
