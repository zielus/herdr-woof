/**
 * Deep copy of JSON-shaped data (plain objects, arrays and primitives) that
 * keeps null-prototype objects null-prototype, so id-keyed dictionaries such as
 * snapshot counters stay safe for ids like `constructor`. Keys are defined as
 * own data properties, never assigned, so a `__proto__` key stays a key.
 */
export function cloneData<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item: unknown) => cloneData(item)) as T;
  if (typeof value !== "object" || value === null) return value;
  const copy: object = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      value: cloneData(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy as T;
}
