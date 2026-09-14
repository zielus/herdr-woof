import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { symlinkComponentProblem } from "../journal/accepted-copy.js";

export { symlinkComponentProblem } from "../journal/accepted-copy.js";

/**
 * Ensures `<runReal>/<relDir>` exists as real directories inside the run: no
 * symlink component before or after creation, and a canonical path equal to its
 * place in the run. Returns a description of the refusal, or undefined when the
 * directory is safe to use. Throws when a directory cannot be created.
 */
export function ensureRealDirectory(runReal: string, relDir: string): string | undefined {
  const before = symlinkComponentProblem(runReal, relDir);
  if (before !== undefined) return before;
  const dir = join(runReal, relDir);
  mkdirSync(dir, { recursive: true });
  // Re-check in case a component was replaced while it was created.
  const after = symlinkComponentProblem(runReal, relDir);
  if (after !== undefined) return after;
  const canonical = realpathSync(dir);
  if (canonical !== dir) {
    return `${relDir} resolves to ${canonical}, not its place inside the run directory`;
  }
  return undefined;
}
