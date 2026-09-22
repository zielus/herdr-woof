import { isId, isPositiveInteger } from "../contracts/envelope.js";
import type { Lifecycle } from "../runtime/adapter.js";
import { check, keysProblem } from "./record-fields.js";
import type { RecordBase } from "./records.js";

/**
 * Activity records: the scheduler's view of what an agent is doing and what the
 * engine itself is busy with. They are transitions, never poll samples: a
 * lifecycle change is written once, when the observed lifecycle differs from the
 * last journaled one, and an engine activity is written once when it starts and
 * once when it ends. Each has an exact key set; cross-record rules (a change
 * must start from the journaled lifecycle, an activity cannot start twice or
 * end unstarted) live in the reducer. All are additive at schemaVersion 1: a
 * journal without them replays unchanged.
 */

/** The runtime lifecycle enum, as a closed list for the field contract. */
export const LIFECYCLES = [
  "ready",
  "working",
  "blocked",
  "unknown",
  "gone",
] as const satisfies readonly Lifecycle[];

/**
 * Written by the scheduler when an agent's observed lifecycle differs from the
 * last journaled one for that agent (`from` is that lifecycle, null for the
 * first). A pane occupant replacement is a transition too, even to the same
 * lifecycle, and carries `replaced: true`.
 */
export interface AgentLifecycleChangedRecord extends RecordBase {
  type: "agent.lifecycle_changed";
  agentId: string;
  from: Lifecycle | null;
  to: Lifecycle;
  terminalId: string | null;
  /** The raw runtime status behind `to`, when the runtime reported one. */
  raw?: string;
  /** The tracker saw another terminal in the agent's pane. */
  replaced?: true;
}

/** Engine activities with noticeable duration, each written at start and at end. */
export const ACTIVITY_KINDS = [
  /** Waiting for an agent to become ready for a dispatch (`agentId`). */
  "readiness_wait",
  /** A repository fingerprint for a gate (`detail` is the gate id; subject is the gated attempt). */
  "revision_check",
  /** A verification command (`detail` is the argv; `result` its exit summary). */
  "check_run",
  /** An ambiguous delivery being reconciled (`agentId` and the attempt). */
  "delivery_check",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_PHASES = ["started", "ended"] as const;
export type ActivityPhase = (typeof ACTIVITY_PHASES)[number];

/**
 * One phase of an engine activity. `started` and `ended` pair up on the same
 * kind and subject (`agentId`, and `stageId`/`visit`/`attempt` together or not
 * at all); a failure end is still `ended`, with `result` saying how.
 */
export interface RunActivityRecord extends RecordBase {
  type: "run.activity";
  kind: ActivityKind;
  phase: ActivityPhase;
  agentId?: string;
  stageId?: string;
  visit?: number;
  attempt?: number;
  detail?: string;
  /** Present only on `ended`. */
  result?: string;
}

/**
 * The subject fields an activity's start and end share; the reducer keys open
 * activities on them (`activityKey` in `src/state/reducer.ts`).
 */
export interface ActivitySubject {
  kind: ActivityKind;
  agentId?: string;
  stageId?: string;
  visit?: number;
  attempt?: number;
}

const MAX_RAW = 200;
const MAX_DETAIL = 500;

function lifecycleProblem(value: unknown, field: string): string | undefined {
  return check(
    (LIFECYCLES as readonly unknown[]).includes(value),
    `${field} is not one of ${LIFECYCLES.join(", ")}`,
  );
}

function optionalBoundedStringProblem(
  value: Record<string, unknown>,
  field: string,
  max: number,
): string | undefined {
  const item = value[field];
  if (item === undefined) return undefined;
  return check(
    typeof item === "string" && item !== "" && item.length <= max,
    `${field} is not a non-empty string of at most ${max} characters`,
  );
}

export function agentLifecycleChangedProblem(value: Record<string, unknown>): string | undefined {
  const terminalId = value["terminalId"];
  return (
    keysProblem(value, ["agentId", "from", "to", "terminalId"], ["raw", "replaced"]) ??
    check(isId(value["agentId"]), "agentId is invalid") ??
    (value["from"] === null ? undefined : lifecycleProblem(value["from"], "from")) ??
    lifecycleProblem(value["to"], "to") ??
    check(
      terminalId === null || (typeof terminalId === "string" && terminalId !== ""),
      "terminalId is not a non-empty string or null",
    ) ??
    optionalBoundedStringProblem(value, "raw", MAX_RAW) ??
    check(value["replaced"] === undefined || value["replaced"] === true, "replaced is not true")
  );
}

export function runActivityProblem(value: Record<string, unknown>): string | undefined {
  const attemptFields = ["stageId", "visit", "attempt"].filter(
    (field) => value[field] !== undefined,
  );
  return (
    keysProblem(
      value,
      ["kind", "phase"],
      ["agentId", "stageId", "visit", "attempt", "detail", "result"],
    ) ??
    check(
      (ACTIVITY_KINDS as readonly unknown[]).includes(value["kind"]),
      `kind is not one of ${ACTIVITY_KINDS.join(", ")}`,
    ) ??
    check(
      (ACTIVITY_PHASES as readonly unknown[]).includes(value["phase"]),
      `phase is not one of ${ACTIVITY_PHASES.join(", ")}`,
    ) ??
    check(value["agentId"] === undefined || isId(value["agentId"]), "agentId is invalid") ??
    check(
      attemptFields.length === 0 || attemptFields.length === 3,
      "stageId, visit and attempt must be given together",
    ) ??
    check(value["stageId"] === undefined || isId(value["stageId"]), "stageId is invalid") ??
    check(value["visit"] === undefined || isPositiveInteger(value["visit"]), "visit is invalid") ??
    check(
      value["attempt"] === undefined || isPositiveInteger(value["attempt"]),
      "attempt is invalid",
    ) ??
    optionalBoundedStringProblem(value, "detail", MAX_DETAIL) ??
    optionalBoundedStringProblem(value, "result", MAX_DETAIL) ??
    check(
      value["result"] === undefined || value["phase"] === "ended",
      "result is only carried by an ended activity",
    )
  );
}
