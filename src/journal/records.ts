import { posix } from "node:path";

import {
  isId,
  isPlainObject,
  isPositiveInteger,
  relativePathProblem,
  type AttemptIdentity,
  type Receipt,
  type RejectionDetail,
  type SubmissionStatus,
} from "../contracts/envelope.js";
import { INFRA_REASONS, REJECTION_REASONS } from "../contracts/reasons.js";

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

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RECEIPT_ID_PATTERN = /^rcpt-[1-9][0-9]*-[0-9a-f]{12}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE_KEYS = ["schemaVersion", "seq", "ts", "type"];
const IDENTITY_KEYS = ["runId", "agentId", "stageId", "visit", "attempt"];
const JOURNALED_REASONS: ReadonlySet<string> = new Set(
  REJECTION_REASONS.filter((reason) => !(INFRA_REASONS as readonly string[]).includes(reason)),
);

/** Artifact directory for an attempt, relative to the run directory. */
export function attemptArtifactDir(stageId: string, visit: number, attempt: number): string {
  return `artifacts/${stageId}/visit-${visit}/attempt-${attempt}`;
}

/** Immutable accepted-copy path for an attempt's artifact, relative to the run directory. */
export function acceptedPathFor(
  stageId: string,
  visit: number,
  attempt: number,
  artifactPath: string,
): string {
  return `accepted/${stageId}/visit-${visit}/attempt-${attempt}/${posix.basename(artifactPath)}`;
}

export function receiptIdFor(seq: number, envelopeDigest: string): string {
  return `rcpt-${seq}-${envelopeDigest.slice(0, 12)}`;
}

/**
 * Parses one journal line. Each record type has an exact key set and a full
 * field contract (ids, hashes, timestamps, enums, paths derived from the attempt
 * identity). Returns the record, or a message describing why the line is not a
 * valid v1 record. Cross-record consistency is checked by `replay`.
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
  const seq = value["seq"];
  if (!isPositiveInteger(seq)) return "seq is not a positive integer";
  if (!isIsoTimestamp(value["ts"])) return "ts is not an ISO-8601 UTC timestamp";

  const problem = recordProblem(value, seq);
  return problem === undefined
    ? (value as unknown as JournalRecord)
    : `${String(value["type"])}: ${problem}`;
}

function recordProblem(value: Record<string, unknown>, seq: number): string | undefined {
  switch (value["type"]) {
    case "run.opened":
      return keysProblem(value, ["runId"]) ?? check(isId(value["runId"]), "runId is invalid");
    case "attempt.opened":
      return attemptOpenedProblem(value);
    case "submission.accepted":
      return submissionAcceptedProblem(value, seq);
    case "submission.duplicate":
      return submissionDuplicateProblem(value, seq);
    case "submission.rejected":
      return submissionRejectedProblem(value);
    default:
      return "unknown record type";
  }
}

function attemptOpenedProblem(value: Record<string, unknown>): string | undefined {
  const problem =
    keysProblem(value, [...IDENTITY_KEYS, "verdicts", "artifactDir"], ["paneId"]) ??
    identityProblem(value);
  if (problem !== undefined) return problem;
  const verdicts = value["verdicts"];
  return (
    check(
      Array.isArray(verdicts) &&
        verdicts.every((verdict) => typeof verdict === "string" && verdict !== ""),
      "verdicts is not an array of non-empty strings",
    ) ??
    check(
      value["artifactDir"] ===
        attemptArtifactDir(
          value["stageId"] as string,
          value["visit"] as number,
          value["attempt"] as number,
        ),
      "artifactDir does not match the attempt identity",
    ) ??
    paneProblem(value)
  );
}

function submissionAcceptedProblem(
  value: Record<string, unknown>,
  seq: number,
): string | undefined {
  const problem =
    keysProblem(
      value,
      [...IDENTITY_KEYS, "status", "verdict", "envelopeDigest", "artifact", "receiptId"],
      ["paneId"],
    ) ??
    identityProblem(value) ??
    check(
      value["status"] === "completed" || value["status"] === "failed",
      'status is not "completed" or "failed"',
    ) ??
    check(
      value["verdict"] === null || typeof value["verdict"] === "string",
      "verdict is not a string or null",
    ) ??
    hashProblem(value, "envelopeDigest");
  if (problem !== undefined) return problem;

  const stageId = value["stageId"] as string;
  const visit = value["visit"] as number;
  const attempt = value["attempt"] as number;
  const artifact = value["artifact"];
  if (!isPlainObject(artifact)) return "artifact is not an object";
  const artifactKeys = exactKeysProblem(
    artifact,
    ["path", "sha256", "bytes", "acceptedPath"],
    [],
    "artifact.",
  );
  if (artifactKeys !== undefined) return artifactKeys;
  const path = artifact["path"];
  if (typeof path !== "string" || relativePathProblem(path) !== undefined) {
    return `artifact.path ${relativePathProblem(path) ?? "is invalid"}`;
  }
  if (!posix.normalize(path).startsWith(`${attemptArtifactDir(stageId, visit, attempt)}/`)) {
    return "artifact.path is outside the attempt's artifact directory";
  }
  const bytes = artifact["bytes"];
  return (
    hashProblem(artifact, "sha256", "artifact.") ??
    check(
      typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0,
      "artifact.bytes is not a non-negative safe integer",
    ) ??
    check(
      artifact["acceptedPath"] === acceptedPathFor(stageId, visit, attempt, path),
      "artifact.acceptedPath does not match the attempt identity and artifact.path",
    ) ??
    check(
      value["receiptId"] === receiptIdFor(seq, value["envelopeDigest"] as string),
      "receiptId does not match seq and envelopeDigest",
    ) ??
    paneProblem(value)
  );
}

function submissionDuplicateProblem(
  value: Record<string, unknown>,
  seq: number,
): string | undefined {
  const receiptId = value["receiptId"];
  const acceptedSeq = value["acceptedSeq"];
  return (
    keysProblem(value, ["receiptId", "acceptedSeq", "envelopeDigest"], ["paneId"]) ??
    check(
      typeof receiptId === "string" && RECEIPT_ID_PATTERN.test(receiptId),
      "receiptId is invalid",
    ) ??
    check(
      isPositiveInteger(acceptedSeq) && acceptedSeq < seq,
      "acceptedSeq does not name an earlier record",
    ) ??
    hashProblem(value, "envelopeDigest") ??
    paneProblem(value)
  );
}

function submissionRejectedProblem(value: Record<string, unknown>): string | undefined {
  const reason = value["reason"];
  return (
    keysProblem(
      value,
      ["reason", "message", "details"],
      ["envelopeDigest", "identity", "paneId"],
    ) ??
    check(
      typeof reason === "string" && JOURNALED_REASONS.has(reason),
      "reason is not a journaled rejection reason",
    ) ??
    check(typeof value["message"] === "string", "message is not a string") ??
    detailsProblem(value["details"]) ??
    (value["envelopeDigest"] === undefined ? undefined : hashProblem(value, "envelopeDigest")) ??
    identityFieldProblem(value["identity"]) ??
    paneProblem(value)
  );
}

function keysProblem(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): string | undefined {
  return exactKeysProblem(value, [...BASE_KEYS, ...required], optional, "");
}

function exactKeysProblem(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  prefix: string,
): string | undefined {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return `unexpected field ${prefix}${key}`;
  }
  for (const key of required) {
    if (!(key in value)) return `missing field ${prefix}${key}`;
  }
  return undefined;
}

function identityProblem(value: Record<string, unknown>, prefix = ""): string | undefined {
  for (const field of ["runId", "agentId", "stageId"]) {
    if (!isId(value[field])) return `${prefix}${field} is invalid`;
  }
  for (const field of ["visit", "attempt"]) {
    if (!isPositiveInteger(value[field])) return `${prefix}${field} is invalid`;
  }
  return undefined;
}

function identityFieldProblem(identity: unknown): string | undefined {
  if (identity === undefined) return undefined;
  if (!isPlainObject(identity)) return "identity is not an object";
  return (
    exactKeysProblem(identity, IDENTITY_KEYS, [], "identity.") ??
    identityProblem(identity, "identity.")
  );
}

function detailsProblem(details: unknown): string | undefined {
  if (!Array.isArray(details)) return "details is not an array";
  for (const detail of details) {
    if (
      !isPlainObject(detail) ||
      exactKeysProblem(detail, ["field", "message"], [], "") !== undefined ||
      typeof detail["field"] !== "string" ||
      typeof detail["message"] !== "string"
    ) {
      return "details entries must be {field, message} strings";
    }
  }
  return undefined;
}

function hashProblem(
  value: Record<string, unknown>,
  field: string,
  prefix = "",
): string | undefined {
  const hash = value[field];
  return check(
    typeof hash === "string" && SHA256_PATTERN.test(hash),
    `${prefix}${field} is not 64 lowercase hex characters`,
  );
}

function paneProblem(value: Record<string, unknown>): string | undefined {
  const paneId = value["paneId"];
  return check(
    paneId === undefined || (typeof paneId === "string" && paneId !== ""),
    "paneId is not a non-empty string",
  );
}

function isIsoTimestamp(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ISO_TIMESTAMP_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function check(condition: boolean, message: string): string | undefined {
  return condition ? undefined : message;
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
