import { MAX_COUNT_LIMIT, MAX_DURATION_LIMIT_MS, type Limits } from "../domain/types.js";

/**
 * Input-validation predicates shared by the built-in workflow definitions
 * (p5 T3). A definition owns its own key set and messages; what is shared here
 * is only what would otherwise be copied verbatim — in particular the per-key
 * limit bounds, which are a correctness-bearing table, not a convenience.
 * `config/schema.ts` has the same table for configuration files; a workflow
 * cannot import it (the engine's import rules keep `workflows/` out of
 * `config/`), so this is where a definition reads it.
 */

export type Fail = (field: string, message: string) => void;

/** Reports every key of `value` that is not in `allowed`, prefixed for nesting. */
export function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  fail: Fail,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${prefix}${key}`, "unknown field");
  }
}

export function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function integerIn(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Inclusive bounds for one limit key: counts 1–1000, `maxFormatRepairs` from 0, durations in ms. */
export function limitBounds(key: string): [number, number] {
  if (key === "maxFormatRepairs") return [0, MAX_COUNT_LIMIT];
  return key.endsWith("Ms") ? [1, MAX_DURATION_LIMIT_MS] : [1, MAX_COUNT_LIMIT];
}

/**
 * Validates an optional per-run `limits` override against a definition's own
 * default set: an object, no unknown key, and every value an integer in its
 * key's bounds.
 */
export function limitsProblem(limits: unknown, defaults: Required<Limits>, fail: Fail): void {
  if (limits === undefined) return;
  if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
    fail("limits", "must be an object");
    return;
  }
  const record = limits as Record<string, unknown>;
  exactKeys(record, Object.keys(defaults), "limits.", fail);
  for (const [key, raw] of Object.entries(record)) {
    if (!(key in defaults)) continue;
    const [min, max] = limitBounds(key);
    if (!integerIn(raw, min, max))
      fail(`limits.${key}`, `must be an integer between ${min} and ${max}`);
  }
}
