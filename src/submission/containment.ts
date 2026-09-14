import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * Walks `relDir` (POSIX, relative) below the run directory's real path and
 * describes the first existing component that is a symlink. A symlinked
 * engine directory could place attempt artifacts or accepted copies outside the
 * run, or alias another attempt. The walk stops at the first missing component;
 * the caller creates the rest as real directories.
 */
export function symlinkComponentProblem(runReal: string, relDir: string): string | undefined {
  let current = runReal;
  let rel = "";
  for (const segment of relDir.split("/")) {
    current = join(current, segment);
    rel = rel === "" ? segment : `${rel}/${segment}`;
    let isSymlink: boolean;
    try {
      isSymlink = lstatSync(current).isSymbolicLink();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      return `cannot inspect ${rel}: ${(error as Error).message}`;
    }
    if (isSymlink) {
      return `${rel} is a symlink; engine directories under the run directory must be real directories`;
    }
  }
  return undefined;
}

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
