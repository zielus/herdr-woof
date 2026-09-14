import { isId, isPlainObject, isPositiveInteger } from "../contracts/envelope.js";
import {
  DISPATCH_DELIVERIES,
  DISPATCH_REASONS,
  LIMIT_KEYS,
  TERMINAL_OUTCOMES,
  type DispatchDelivery,
  type Limits,
  type TerminalOutcome,
} from "../domain/types.js";
import {
  check,
  exactKeysProblem,
  keysProblem,
  nonEmptyStringProblem,
  paneProblem,
} from "./record-fields.js";
import type { RecordBase } from "./records.js";

/**
 * Run-fact records added in p2: agent assignment, request dispatch with its
 * delivery certainty, and termination. Gate, block and delivery-reconciliation
 * records arrive with the scheduler (phase 3).
 */

export interface AgentAssignedRecord extends RecordBase {
  type: "agent.assigned";
  agentId: string;
  runtime: { adapter: string; runtimeName: string; paneId: string };
  terminalId?: string;
  sessionId?: string;
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
    keysProblem(value, ["agentId", "runtime"], ["terminalId", "sessionId"]) ??
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
    (value["sessionId"] === undefined ? undefined : nonEmptyStringProblem(value, "sessionId"))
  );
}

export function requestDispatchedProblem(value: Record<string, unknown>): string | undefined {
  const problem =
    keysProblem(
      value,
      ["agentId", "stageId", "visit", "attempt", "delivery", "reason"],
      ["paneId"],
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
    ) ?? paneProblem(value)
  );
}

export function runTerminatedProblem(value: Record<string, unknown>): string | undefined {
  const problem =
    keysProblem(value, ["outcome", "reason"], ["limit"]) ??
    check(
      (TERMINAL_OUTCOMES as readonly unknown[]).includes(value["outcome"]),
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
