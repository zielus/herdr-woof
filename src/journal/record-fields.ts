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
