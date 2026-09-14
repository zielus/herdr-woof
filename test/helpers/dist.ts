// In-process access to compiled modules for pure-logic unit tests. Tests load
// the built dist/ output (bun run test builds it first) and never import src/.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Imports `dist/<rel>` in the test process. `rel` is relative to dist/, e.g. "domain/plan.js". */
export async function loadDist<T>(rel: string): Promise<T> {
  const path = join(repoRoot, "dist", rel);
  if (!existsSync(path)) throw new Error(`${path} is missing; run bun run build first`);
  return (await import(pathToFileURL(path).href)) as T;
}
