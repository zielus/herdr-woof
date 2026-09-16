/**
 * Private strings that must never ship in a tracked file (preflight
 * `private-strings`). Extended regular expressions for `git grep -E`. This
 * module and its test are the only files excluded from the scan.
 */
export const PRIVATE_STRING_PATTERNS: readonly string[] = [
  "/Users/",
  "/home/[a-z]",
  "MacBook-(Pro|Air)",
  "\\.lan\\b",
  "chatgpt\\.com/(c|share)/",
  "claude\\.ai/(chat|code|share)/",
  "docs\\.google\\.com/",
  "@gmail\\.com",
];

/** Paths `git grep` skips for this check: the patterns themselves and the test that plants them. */
export const PRIVATE_STRING_EXCLUDES: readonly string[] = [
  "scripts/release/lib/patterns.ts",
  "test/release-preflight.process.test.ts",
];
