import { createHash } from "node:crypto";

/**
 * Serializes a JSON value with object keys sorted recursively and no
 * whitespace, so equal values produce equal bytes regardless of formatting or
 * key order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.keys(value)
    .toSorted()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    );
  return `{${entries.join(",")}}`;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
