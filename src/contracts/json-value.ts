/**
 * JSON value check shared by workflow input validation and the stage request
 * contract: null, boolean, finite number, string, arrays (holes are checked by
 * index) and plain objects of JSON values, without cycles or excessive nesting.
 */

export interface JsonValueProblem {
  /** Path of the offending value, starting at the given field name. */
  field: string;
  message: string;
}

export const MAX_JSON_DEPTH = 1000;

export function jsonValueProblem(value: unknown, field: string): JsonValueProblem | undefined {
  return walk(value, field, new Set(), 0);
}

function walk(
  value: unknown,
  field: string,
  ancestors: Set<object>,
  depth: number,
): JsonValueProblem | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? undefined : { field, message: "must be a finite number" };
  }
  if (typeof value !== "object") {
    return { field, message: `must be a JSON value, not ${typeof value}` };
  }
  if (depth >= MAX_JSON_DEPTH) {
    return { field, message: `nests deeper than ${MAX_JSON_DEPTH} levels` };
  }
  if (ancestors.has(value)) return { field, message: "must not contain a cycle" };
  const isArray = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    return { field, message: "must be a plain JSON object or array" };
  }
  ancestors.add(value);
  try {
    if (isArray) {
      for (let index = 0; index < value.length; index += 1) {
        const problem = walk(value[index], `${field}[${index}]`, ancestors, depth + 1);
        if (problem !== undefined) return problem;
      }
    } else {
      for (const [key, item] of Object.entries(value)) {
        const problem = walk(item, `${field}.${key}`, ancestors, depth + 1);
        if (problem !== undefined) return problem;
      }
    }
  } finally {
    ancestors.delete(value);
  }
  return undefined;
}
