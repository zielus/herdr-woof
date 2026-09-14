import {
  isId,
  isPlainObject,
  isPositiveInteger,
  type AttemptIdentity,
  type Receipt,
  type RejectionDetail,
  type SubmissionStatus,
} from "../contracts/envelope.js";

/** Fields every journal record carries. */
export interface RecordBase {
  schemaVersion: 1;
  seq: number;
  ts: string;
}

export interface RunOpenedRecord extends RecordBase {
  type: "run.opened";
  runId: string;
}

export interface AttemptOpenedRecord extends RecordBase, AttemptIdentity {
  type: "attempt.opened";
  verdicts: string[];
  /** Attempt output directory, relative to the run directory. */
  artifactDir: string;
  paneId?: string;
}

export interface SubmissionAcceptedRecord extends RecordBase, AttemptIdentity {
  type: "submission.accepted";
  status: SubmissionStatus;
  verdict: string | null;
  envelopeDigest: string;
  artifact: { path: string; sha256: string; bytes: number; acceptedPath: string };
  paneId?: string;
  receiptId: string;
}

export interface SubmissionDuplicateRecord extends RecordBase {
  type: "submission.duplicate";
  receiptId: string;
  acceptedSeq: number;
  envelopeDigest: string;
  paneId?: string;
}

export interface SubmissionRejectedRecord extends RecordBase {
  type: "submission.rejected";
  reason: string;
  message: string;
  details: RejectionDetail[];
  envelopeDigest?: string;
  identity?: AttemptIdentity;
  paneId?: string;
}

export type JournalRecord =
  | RunOpenedRecord
  | AttemptOpenedRecord
  | SubmissionAcceptedRecord
  | SubmissionDuplicateRecord
  | SubmissionRejectedRecord;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A record before the journal assigns `schemaVersion`, `seq` and `ts`. */
export type NewJournalRecord = DistributiveOmit<JournalRecord, keyof RecordBase>;

/**
 * Parses one journal line. Returns the record, or a message describing why the
 * line is not a valid v1 record.
 */
export function parseRecordLine(line: string): JournalRecord | string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return `not valid JSON: ${(error as Error).message}`;
  }
  if (!isPlainObject(value)) return "not a JSON object";
  if (value["schemaVersion"] !== 1) return "schemaVersion is not 1";
  if (!isPositiveInteger(value["seq"])) return "seq is not a positive integer";
  if (typeof value["ts"] !== "string") return "ts is not a string";

  const problem = recordProblem(value);
  return problem === undefined
    ? (value as unknown as JournalRecord)
    : `${String(value["type"])}: ${problem}`;
}

function recordProblem(value: Record<string, unknown>): string | undefined {
  switch (value["type"]) {
    case "run.opened":
      return isId(value["runId"]) ? undefined : "runId is invalid";
    case "attempt.opened":
      return (
        identityProblem(value) ??
        (Array.isArray(value["verdicts"]) && value["verdicts"].every((v) => typeof v === "string")
          ? undefined
          : "verdicts is not a string array") ??
        (typeof value["artifactDir"] === "string" ? undefined : "artifactDir is not a string") ??
        optionalStringProblem(value, "paneId")
      );
    case "submission.accepted": {
      const artifact = value["artifact"];
      return (
        identityProblem(value) ??
        (typeof value["envelopeDigest"] === "string"
          ? undefined
          : "envelopeDigest is not a string") ??
        (typeof value["receiptId"] === "string" ? undefined : "receiptId is not a string") ??
        (isPlainObject(artifact) &&
        typeof artifact["path"] === "string" &&
        typeof artifact["sha256"] === "string" &&
        typeof artifact["bytes"] === "number" &&
        typeof artifact["acceptedPath"] === "string"
          ? undefined
          : "artifact is incomplete") ??
        optionalStringProblem(value, "paneId")
      );
    }
    case "submission.duplicate":
      return (
        (typeof value["receiptId"] === "string" ? undefined : "receiptId is not a string") ??
        (isPositiveInteger(value["acceptedSeq"]) ? undefined : "acceptedSeq is invalid") ??
        optionalStringProblem(value, "paneId")
      );
    case "submission.rejected":
      return (
        (typeof value["reason"] === "string" ? undefined : "reason is not a string") ??
        (Array.isArray(value["details"]) ? undefined : "details is not an array") ??
        optionalStringProblem(value, "paneId")
      );
    default:
      return "unknown record type";
  }
}

function identityProblem(value: Record<string, unknown>): string | undefined {
  for (const field of ["runId", "agentId", "stageId"]) {
    if (!isId(value[field])) return `${field} is invalid`;
  }
  for (const field of ["visit", "attempt"]) {
    if (!isPositiveInteger(value[field])) return `${field} is invalid`;
  }
  return undefined;
}

function optionalStringProblem(value: Record<string, unknown>, field: string): string | undefined {
  return value[field] === undefined || typeof value[field] === "string"
    ? undefined
    : `${field} is not a string`;
}

/** Receipt for an accepted submission, derived only from its journal record. */
export function receiptFromAccepted(record: SubmissionAcceptedRecord): Receipt {
  return {
    receiptId: record.receiptId,
    seq: record.seq,
    runId: record.runId,
    agentId: record.agentId,
    stageId: record.stageId,
    visit: record.visit,
    attempt: record.attempt,
    acceptedAt: record.ts,
    envelopeDigest: record.envelopeDigest,
    artifact: {
      path: record.artifact.path,
      sha256: record.artifact.sha256,
      bytes: record.artifact.bytes,
      acceptedPath: record.artifact.acceptedPath,
    },
  };
}
