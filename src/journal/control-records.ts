import { isId, isPlainObject, isPositiveInteger } from "../contracts/envelope.js";
import {
  BLOCK_REASONS,
  RECONCILE_EVIDENCE,
  type BlockReason,
  type GateDecision,
  type Revision,
} from "../domain/types.js";
import {
  check,
  exactKeysProblem,
  isSha256,
  keysProblem,
  nonNegativeInteger,
  revisionProblem,
} from "./record-fields.js";
import type { RecordBase } from "./records.js";

/**
 * Control records added in p3 and written by the scheduler through the store:
 * gate decisions, blocking and unblocking, and ambiguous-delivery
 * reconciliation. Each has an exact key set; cross-record rules live in the
 * reducer.
 */

export interface GateSubject {
  stageId: string;
  visit: number;
  attempt: number;
  /** Seq of the submission.accepted record the gate decided on. */
  acceptedSeq: number;
  receiptId: string;
}

export interface CheckResultRecord {
  command: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  evidence: { path: string; sha256: string; bytes: number };
}

export type GateNext = { stageId: string } | { outcome: "completed" | "failed" };

export interface GateRecordedRecord extends RecordBase {
  type: "gate.recorded";
  /** Stage id for stage gates; check id for check gates. */
  gate: string;
  kind: "stage" | "check";
  subject: GateSubject;
  decision: GateDecision;
  reason: string;
  round: number;
  next: GateNext;
  /** Repository revision when the gate was recorded. */
  revision: Revision;
  /** The accepted verdict; present exactly for stage gates. */
  verdict?: string | null;
  /** Revision the gated attempt was dispatched against (revision-binding stages). */
  reviewed?: Revision;
  /** Present exactly for check gates. */
  check?: CheckResultRecord;
}

export interface ObservedState {
  runtimeStatus: string | null;
  terminalId: string | null;
  stateChangeSeq: number | null;
}

export interface RunBlockedRecord extends RecordBase {
  type: "run.blocked";
  agentId: string;
  reason: BlockReason;
  requiredAction: string;
  observed: ObservedState;
  stageId?: string;
  visit?: number;
  attempt?: number;
}

export interface RunUnblockedRecord extends RecordBase {
  type: "run.unblocked";
  agentId: string;
  resolution: "observed_unblocked";
  observed: ObservedState;
}

export interface DeliveryReconciledRecord extends RecordBase {
  type: "delivery.reconciled";
  agentId: string;
  stageId: string;
  visit: number;
  attempt: number;
  dispatchSeq: number;
  resolution: "delivered" | "abandoned";
  evidence: "submission_recorded" | "observed_activity" | "no_evidence_before_deadline";
}

const RECEIPT_ID_PATTERN = /^rcpt-[1-9][0-9]*-[0-9a-f]{12}$/;
const MAX_GATE_REASON = 200;
const MAX_REQUIRED_ACTION = 2000;

/** Evidence file of a check gate, relative to the run directory. */
export function checkEvidencePath(
  gate: string,
  stageId: string,
  visit: number,
  attempt: number,
): string {
  return `checks/${gate}/${stageId}-v${visit}-a${attempt}/output.log`;
}

export function gateRecordedProblem(
  value: Record<string, unknown>,
  seq: number,
): string | undefined {
  const problem =
    keysProblem(
      value,
      ["gate", "kind", "subject", "decision", "reason", "round", "next", "revision"],
      ["verdict", "reviewed", "check"],
    ) ??
    check(isId(value["gate"]), "gate is invalid") ??
    check(
      value["kind"] === "stage" || value["kind"] === "check",
      'kind is not "stage" or "check"',
    ) ??
    check(
      value["decision"] === "pass" || value["decision"] === "reject",
      'decision is not "pass" or "reject"',
    ) ??
    check(
      typeof value["reason"] === "string" &&
        value["reason"] !== "" &&
        value["reason"].length <= MAX_GATE_REASON,
      `reason is not a non-empty string of at most ${MAX_GATE_REASON} characters`,
    ) ??
    check(nonNegativeInteger(value["round"]), "round is not a non-negative safe integer") ??
    subjectProblem(value["subject"], seq) ??
    nextProblem(value["next"]) ??
    revisionProblem(value["revision"], "revision");
  if (problem !== undefined) return problem;

  const subject = value["subject"] as unknown as GateSubject;
  if (value["kind"] === "stage") {
    return (
      check(Object.hasOwn(value, "verdict"), "verdict is required for a stage gate") ??
      check(
        value["verdict"] === null || typeof value["verdict"] === "string",
        "verdict is not a string or null",
      ) ??
      check(value["check"] === undefined, "check is only allowed on a check gate") ??
      (value["reviewed"] === undefined ? undefined : revisionProblem(value["reviewed"], "reviewed"))
    );
  }
  return (
    check(value["verdict"] === undefined, "verdict is only allowed on a stage gate") ??
    check(value["reviewed"] === undefined, "reviewed is only allowed on a stage gate") ??
    checkResultProblem(
      value["check"],
      checkEvidencePath(value["gate"] as string, subject.stageId, subject.visit, subject.attempt),
    )
  );
}

function subjectProblem(value: unknown, seq: number): string | undefined {
  if (!isPlainObject(value)) return "subject is not an object";
  return (
    exactKeysProblem(
      value,
      ["stageId", "visit", "attempt", "acceptedSeq", "receiptId"],
      [],
      "subject.",
    ) ??
    check(isId(value["stageId"]), "subject.stageId is invalid") ??
    check(isPositiveInteger(value["visit"]), "subject.visit is invalid") ??
    check(isPositiveInteger(value["attempt"]), "subject.attempt is invalid") ??
    check(
      isPositiveInteger(value["acceptedSeq"]) && value["acceptedSeq"] < seq,
      "subject.acceptedSeq does not name an earlier record",
    ) ??
    check(
      typeof value["receiptId"] === "string" && RECEIPT_ID_PATTERN.test(value["receiptId"]),
      "subject.receiptId is invalid",
    )
  );
}

function nextProblem(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "next is not an object";
  if (Object.hasOwn(value, "stageId")) {
    return (
      exactKeysProblem(value, ["stageId"], [], "next.") ??
      check(isId(value["stageId"]), "next.stageId is invalid")
    );
  }
  return (
    exactKeysProblem(value, ["outcome"], [], "next.") ??
    check(
      value["outcome"] === "completed" || value["outcome"] === "failed",
      'next.outcome is not "completed" or "failed"',
    )
  );
}

function checkResultProblem(value: unknown, evidencePath: string): string | undefined {
  if (!isPlainObject(value)) return "check is required for a check gate";
  const command = value["command"];
  const exitCode = value["exitCode"];
  const signal = value["signal"];
  const problem =
    exactKeysProblem(
      value,
      ["command", "exitCode", "signal", "timedOut", "evidence"],
      [],
      "check.",
    ) ??
    check(
      Array.isArray(command) &&
        command.length > 0 &&
        command.every((item) => typeof item === "string"),
      "check.command is not a non-empty array of strings",
    ) ??
    check(
      exitCode === null || (typeof exitCode === "number" && Number.isSafeInteger(exitCode)),
      "check.exitCode is not an integer or null",
    ) ??
    check(
      signal === null || (typeof signal === "string" && signal !== ""),
      "check.signal is not a non-empty string or null",
    ) ??
    check(typeof value["timedOut"] === "boolean", "check.timedOut is not a boolean");
  if (problem !== undefined) return problem;
  const evidence = value["evidence"];
  if (!isPlainObject(evidence)) return "check.evidence is not an object";
  return (
    exactKeysProblem(evidence, ["path", "sha256", "bytes"], [], "check.evidence.") ??
    check(evidence["path"] === evidencePath, `check.evidence.path is not ${evidencePath}`) ??
    check(
      isSha256(evidence["sha256"]),
      "check.evidence.sha256 is not 64 lowercase hex characters",
    ) ??
    check(
      nonNegativeInteger(evidence["bytes"]),
      "check.evidence.bytes is not a non-negative safe integer",
    )
  );
}

export function runBlockedProblem(value: Record<string, unknown>): string | undefined {
  const attemptFields = ["stageId", "visit", "attempt"].filter((field) =>
    Object.hasOwn(value, field),
  );
  const requiredAction = value["requiredAction"];
  return (
    keysProblem(
      value,
      ["agentId", "reason", "requiredAction", "observed"],
      ["stageId", "visit", "attempt"],
    ) ??
    check(isId(value["agentId"]), "agentId is invalid") ??
    check(
      (BLOCK_REASONS as readonly unknown[]).includes(value["reason"]),
      `reason is not one of ${BLOCK_REASONS.join(", ")}`,
    ) ??
    check(
      typeof requiredAction === "string" &&
        requiredAction !== "" &&
        requiredAction.length <= MAX_REQUIRED_ACTION,
      `requiredAction is not a non-empty string of at most ${MAX_REQUIRED_ACTION} characters`,
    ) ??
    observedProblem(value["observed"]) ??
    check(
      attemptFields.length === 0 || attemptFields.length === 3,
      "stageId, visit and attempt must be given together or not at all",
    ) ??
    (attemptFields.length === 0
      ? undefined
      : (check(isId(value["stageId"]), "stageId is invalid") ??
        check(isPositiveInteger(value["visit"]), "visit is invalid") ??
        check(isPositiveInteger(value["attempt"]), "attempt is invalid")))
  );
}

export function runUnblockedProblem(value: Record<string, unknown>): string | undefined {
  return (
    keysProblem(value, ["agentId", "resolution", "observed"]) ??
    check(isId(value["agentId"]), "agentId is invalid") ??
    check(value["resolution"] === "observed_unblocked", 'resolution is not "observed_unblocked"') ??
    observedProblem(value["observed"])
  );
}

export function deliveryReconciledProblem(
  value: Record<string, unknown>,
  seq: number,
): string | undefined {
  const resolution = value["resolution"];
  const problem =
    keysProblem(value, [
      "agentId",
      "stageId",
      "visit",
      "attempt",
      "dispatchSeq",
      "resolution",
      "evidence",
    ]) ??
    check(isId(value["agentId"]), "agentId is invalid") ??
    check(isId(value["stageId"]), "stageId is invalid") ??
    check(isPositiveInteger(value["visit"]), "visit is invalid") ??
    check(isPositiveInteger(value["attempt"]), "attempt is invalid") ??
    check(
      isPositiveInteger(value["dispatchSeq"]) && value["dispatchSeq"] < seq,
      "dispatchSeq does not name an earlier record",
    ) ??
    check(
      resolution === "delivered" || resolution === "abandoned",
      'resolution is not "delivered" or "abandoned"',
    );
  if (problem !== undefined) return problem;
  const allowed: readonly string[] = RECONCILE_EVIDENCE[resolution as "delivered" | "abandoned"];
  return check(
    typeof value["evidence"] === "string" && allowed.includes(value["evidence"]),
    `evidence is not one of ${allowed.join(", ")} for resolution ${String(resolution)}`,
  );
}

function observedProblem(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "observed is not an object";
  const seq = value["stateChangeSeq"];
  return (
    exactKeysProblem(value, ["runtimeStatus", "terminalId", "stateChangeSeq"], [], "observed.") ??
    check(
      value["runtimeStatus"] === null ||
        (typeof value["runtimeStatus"] === "string" && value["runtimeStatus"] !== ""),
      "observed.runtimeStatus is not a non-empty string or null",
    ) ??
    check(
      value["terminalId"] === null ||
        (typeof value["terminalId"] === "string" && value["terminalId"] !== ""),
      "observed.terminalId is not a non-empty string or null",
    ) ??
    check(
      seq === null || nonNegativeInteger(seq),
      "observed.stateChangeSeq is not an integer or null",
    )
  );
}
