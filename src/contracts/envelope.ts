import { canonicalJson, sha256Hex } from "./canonical-json.js";
import type { RejectionReason } from "./reasons.js";

/** Largest envelope `submitResult` reads, in bytes. */
export const MAX_ENVELOPE_BYTES = 64 * 1024;

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type SubmissionStatus = "completed" | "failed";

/** Result envelope, schema version 1. */
export interface Envelope {
  schemaVersion: 1;
  runId: string;
  agentId: string;
  stageId: string;
  visit: number;
  attempt: number;
  status: SubmissionStatus;
  verdict: string | null;
  artifact: { path: string; sha256: string };
}

/** Correlation identity shared by attempts, envelopes and receipts. */
export interface AttemptIdentity {
  runId: string;
  agentId: string;
  stageId: string;
  visit: number;
  attempt: number;
}

export interface RejectionDetail {
  field: string;
  message: string;
}

export interface Receipt extends AttemptIdentity {
  receiptId: string;
  seq: number;
  acceptedAt: string;
  envelopeDigest: string;
  artifact: { path: string; sha256: string; bytes: number; acceptedPath: string };
}

export type SubmitOutcome =
  | { outcome: "accepted"; receipt: Receipt }
  | { outcome: "duplicate"; receipt: Receipt }
  | {
      outcome: "rejected";
      reason: RejectionReason;
      message: string;
      details: RejectionDetail[];
    };

export type ParseEnvelopeResult =
  | { ok: true; envelope: Envelope; digest: string }
  | {
      ok: false;
      reason: "envelope_malformed" | "envelope_invalid";
      message: string;
      details: RejectionDetail[];
    };

const ENVELOPE_KEYS = new Set([
  "schemaVersion",
  "runId",
  "agentId",
  "stageId",
  "visit",
  "attempt",
  "status",
  "verdict",
  "artifact",
]);
const ARTIFACT_KEYS = new Set(["path", "sha256"]);

/**
 * Parses and validates a v1 envelope. `envelope_malformed` covers unreadable
 * input (oversized, not UTF-8, not JSON, not an object); `envelope_invalid`
 * covers schema violations, with one detail per offending field. `digest` is
 * the sha256 of the envelope's canonical JSON.
 */
export function parseEnvelope(raw: string | Uint8Array): ParseEnvelopeResult {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
  if (bytes > MAX_ENVELOPE_BYTES) {
    return malformed(`envelope is ${bytes} bytes; the limit is ${MAX_ENVELOPE_BYTES}`);
  }

  let text: string;
  try {
    text = typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return malformed("envelope is not valid UTF-8");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return malformed(`envelope is not valid JSON: ${(error as Error).message}`);
  }
  if (!isPlainObject(value)) {
    return malformed("envelope must be a JSON object");
  }

  const details = validateEnvelope(value);
  if (details.length > 0) {
    return {
      ok: false,
      reason: "envelope_invalid",
      message: `envelope does not match schema v1: ${details.map((d) => d.field).join(", ")}`,
      details,
    };
  }
  return {
    ok: true,
    envelope: value as unknown as Envelope,
    digest: sha256Hex(canonicalJson(value)),
  };
}

function validateEnvelope(value: Record<string, unknown>): RejectionDetail[] {
  const details: RejectionDetail[] = [];
  const fail = (field: string, message: string) => details.push({ field, message });

  for (const key of Object.keys(value)) {
    if (!ENVELOPE_KEYS.has(key)) fail(key, "unknown field");
  }
  if (value["schemaVersion"] !== 1) fail("schemaVersion", "must be 1");
  for (const field of ["runId", "agentId", "stageId"]) {
    if (!isId(value[field])) fail(field, `must match ${ID_PATTERN.source}`);
  }
  for (const field of ["visit", "attempt"]) {
    if (!isPositiveInteger(value[field])) fail(field, "must be a safe integer >= 1");
  }
  if (value["status"] !== "completed" && value["status"] !== "failed") {
    fail("status", 'must be "completed" or "failed"');
  }
  if (!Object.hasOwn(value, "verdict")) {
    fail("verdict", "is required (use null when the stage has no verdict)");
  } else if (value["verdict"] !== null && typeof value["verdict"] !== "string") {
    fail("verdict", "must be a string or null");
  }

  const artifact = value["artifact"];
  if (!isPlainObject(artifact)) {
    fail("artifact", "must be an object with path and sha256");
    return details;
  }
  for (const key of Object.keys(artifact)) {
    if (!ARTIFACT_KEYS.has(key)) fail(`artifact.${key}`, "unknown field");
  }
  const pathProblem = relativePathProblem(artifact["path"]);
  if (pathProblem !== undefined) fail("artifact.path", pathProblem);
  if (typeof artifact["sha256"] !== "string" || !SHA256_PATTERN.test(artifact["sha256"])) {
    fail("artifact.sha256", "must be 64 lowercase hex characters");
  }
  return details;
}

export function relativePathProblem(path: unknown): string | undefined {
  if (typeof path !== "string" || path === "") return "must be a non-empty string";
  if (path.startsWith("/")) return "must be relative to the run directory";
  if (path.includes("\\") || path.includes("\0")) return "must be a POSIX path";
  if (path.split("/").some((segment) => segment === "..")) return "must not contain .. segments";
  return undefined;
}

/**
 * Ids are used as path components (stage directories), so `.` and `..` are
 * refused explicitly in addition to the pattern.
 */
export function isId(value: unknown): value is string {
  return typeof value === "string" && value !== "." && value !== ".." && ID_PATTERN.test(value);
}

/**
 * A safe integer >= 1. Values beyond Number.MAX_SAFE_INTEGER are refused because
 * distinct JSON inputs (for example 9007199254740992 and 9007199254740993) parse
 * to the same number and would collide as attempt identities.
 */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(message: string): ParseEnvelopeResult {
  return { ok: false, reason: "envelope_malformed", message, details: [] };
}
