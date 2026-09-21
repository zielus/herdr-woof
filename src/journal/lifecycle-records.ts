import { isId, isPositiveInteger } from "../contracts/envelope.js";
import { check, keysProblem, nonEmptyStringProblem } from "./record-fields.js";
import type { RecordBase } from "./records.js";

/**
 * Lifecycle records: facts about the run host, a cancellation request and the
 * driver's view of runtime observation. They are transitions, never poll
 * samples: a host claims, exits or is found lost once; observation is lost once
 * per outage and recovered once. Each has an exact key set; cross-record rules
 * live in the reducer. All are additive at schemaVersion 1: a journal without
 * them replays unchanged.
 */

/** Who asked for the cancellation that a `run.terminated{cancelled}` follows. */
export const CANCEL_SOURCES = ["cli", "web", "herdr_action", "signal", "abort_signal"] as const;
export type CancelSource = (typeof CANCEL_SOURCES)[number];

/** Written by the run host once it holds the claim and the run is open. */
export interface HostClaimedRecord extends RecordBase {
  type: "host.claimed";
  pid: number;
  hostname: string;
  startedAt: string;
  heartbeatMs: number;
  paneId: string | null;
  workspaceId: string | null;
}

/** Written by the run host on its way out, before it releases the claim. */
export interface HostExitedRecord extends RecordBase {
  type: "host.exited";
  pid: number;
  exitCode: number;
  /** The host's own result: a run outcome, or `rejected:<reason>`. */
  reason: string;
}

/**
 * A dead host cannot write this: the first locked writer that acts on a run
 * whose probe says `lost` records the evidence it saw. Inspectors never do.
 */
export interface HostLostRecord extends RecordBase {
  type: "host.lost";
  /** The claim's pid; null when the claim itself is invalid. */
  pid: number | null;
  /** The claim file's last heartbeat (its mtime); null when unknown. */
  heartbeatAt: string | null;
  /** Probe evidence: `host_process_gone`, `heartbeat_stale` or `claim_invalid: …`. */
  reason: string;
  detectedBy: CancelSource;
}

export interface RunCancelRequestedRecord extends RecordBase {
  type: "run.cancel_requested";
  source: CancelSource;
  reason: string;
}

export interface ObservationLostRecord extends RecordBase {
  type: "observation.lost";
  agentId: string;
  /** The runtime error code of the failed observation that started the outage. */
  code: string;
  message: string;
  terminalId: string | null;
}

export interface ObservationRecoveredRecord extends RecordBase {
  type: "observation.recovered";
  agentId: string;
  /** Seq of the observation.lost record this resolves. */
  lostSeq: number;
  terminalId: string | null;
}

const MAX_REASON = 500;
const MAX_MESSAGE = 2000;

function boundedStringProblem(
  value: Record<string, unknown>,
  field: string,
  max: number,
): string | undefined {
  const item = value[field];
  return check(
    typeof item === "string" && item !== "" && item.length <= max,
    `${field} is not a non-empty string of at most ${max} characters`,
  );
}

function nullableStringProblem(value: Record<string, unknown>, field: string): string | undefined {
  const item = value[field];
  return check(
    item === null || (typeof item === "string" && item !== ""),
    `${field} is not a non-empty string or null`,
  );
}

function sourceProblem(value: unknown, field: string): string | undefined {
  return check(
    (CANCEL_SOURCES as readonly unknown[]).includes(value),
    `${field} is not one of ${CANCEL_SOURCES.join(", ")}`,
  );
}

export function hostClaimedProblem(value: Record<string, unknown>): string | undefined {
  return (
    keysProblem(value, ["pid", "hostname", "startedAt", "heartbeatMs", "paneId", "workspaceId"]) ??
    check(isPositiveInteger(value["pid"]), "pid is not a positive integer") ??
    nonEmptyStringProblem(value, "hostname") ??
    nonEmptyStringProblem(value, "startedAt") ??
    check(isPositiveInteger(value["heartbeatMs"]), "heartbeatMs is not a positive integer") ??
    nullableStringProblem(value, "paneId") ??
    nullableStringProblem(value, "workspaceId")
  );
}

export function hostExitedProblem(value: Record<string, unknown>): string | undefined {
  const exitCode = value["exitCode"];
  return (
    keysProblem(value, ["pid", "exitCode", "reason"]) ??
    check(isPositiveInteger(value["pid"]), "pid is not a positive integer") ??
    check(
      typeof exitCode === "number" && Number.isSafeInteger(exitCode) && exitCode >= 0,
      "exitCode is not a non-negative integer",
    ) ??
    boundedStringProblem(value, "reason", MAX_REASON)
  );
}

export function hostLostProblem(value: Record<string, unknown>): string | undefined {
  return (
    keysProblem(value, ["pid", "heartbeatAt", "reason", "detectedBy"]) ??
    check(
      value["pid"] === null || isPositiveInteger(value["pid"]),
      "pid is not a positive integer or null",
    ) ??
    nullableStringProblem(value, "heartbeatAt") ??
    boundedStringProblem(value, "reason", MAX_REASON) ??
    sourceProblem(value["detectedBy"], "detectedBy")
  );
}

export function runCancelRequestedProblem(value: Record<string, unknown>): string | undefined {
  return (
    keysProblem(value, ["source", "reason"]) ??
    sourceProblem(value["source"], "source") ??
    nonEmptyStringProblem(value, "reason")
  );
}

export function observationLostProblem(value: Record<string, unknown>): string | undefined {
  return (
    keysProblem(value, ["agentId", "code", "message", "terminalId"]) ??
    check(isId(value["agentId"]), "agentId is invalid") ??
    nonEmptyStringProblem(value, "code") ??
    check(
      typeof value["message"] === "string" && value["message"].length <= MAX_MESSAGE,
      `message is not a string of at most ${MAX_MESSAGE} characters`,
    ) ??
    nullableStringProblem(value, "terminalId")
  );
}

export function observationRecoveredProblem(value: Record<string, unknown>): string | undefined {
  return (
    keysProblem(value, ["agentId", "lostSeq", "terminalId"]) ??
    check(isId(value["agentId"]), "agentId is invalid") ??
    check(isPositiveInteger(value["lostSeq"]), "lostSeq is invalid") ??
    nullableStringProblem(value, "terminalId")
  );
}
