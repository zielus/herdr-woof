import { isPlainObject } from "../contracts/envelope.js";

/** Fields every journal record carries. */
export const BASE_KEYS = ["schemaVersion", "seq", "ts", "type"];

/** Exact key set for a record: base keys plus `required`, and `optional` may appear. */
export function keysProblem(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): string | undefined {
  return exactKeysProblem(value, [...BASE_KEYS, ...required], optional, "");
}

export function exactKeysProblem(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  prefix: string,
): string | undefined {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return `unexpected field ${prefix}${key}`;
  }
  // Own properties only: a field inherited from a prototype is missing.
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return `missing field ${prefix}${key}`;
  }
  return undefined;
}

export function paneProblem(value: Record<string, unknown>): string | undefined {
  const paneId = value["paneId"];
  return check(
    paneId === undefined || (typeof paneId === "string" && paneId !== ""),
    "paneId is not a non-empty string",
  );
}

export function nonEmptyStringProblem(
  value: Record<string, unknown>,
  field: string,
  prefix = "",
): string | undefined {
  const item = value[field];
  return check(
    typeof item === "string" && item !== "",
    `${prefix}${field} is not a non-empty string`,
  );
}

export function objectProblem(value: unknown, field: string): string | undefined {
  return check(isPlainObject(value), `${field} is not an object`);
}

export function check(condition: boolean, message: string): string | undefined {
  return condition ? undefined : message;
}

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

/** A git object id: 40 (SHA-1) or 64 (SHA-256) lowercase hex characters. */
export function isObjectId(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID_PATTERN.test(value);
}

export function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** `{head: object id | null, tree: object id}` with an exact key set. */
export function revisionProblem(value: unknown, field: string): string | undefined {
  if (!isPlainObject(value)) return `${field} is not an object`;
  return (
    exactKeysProblem(value, ["head", "tree"], [], `${field}.`) ??
    check(
      value["head"] === null || isObjectId(value["head"]),
      `${field}.head is not a git object id or null`,
    ) ??
    check(isObjectId(value["tree"]), `${field}.tree is not a git object id`)
  );
}

/** `{path, sha256, bytes}` where path must equal `expectedPath`. */
export function fileRefProblem(
  value: unknown,
  field: string,
  expectedPath: string,
): string | undefined {
  if (!isPlainObject(value)) return `${field} is not an object`;
  return (
    exactKeysProblem(value, ["path", "sha256", "bytes"], [], `${field}.`) ??
    check(value["path"] === expectedPath, `${field}.path is not ${expectedPath}`) ??
    check(isSha256(value["sha256"]), `${field}.sha256 is not 64 lowercase hex characters`) ??
    check(nonNegativeInteger(value["bytes"]), `${field}.bytes is not a non-negative safe integer`)
  );
}
