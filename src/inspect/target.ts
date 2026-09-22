import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { isId } from "../contracts/envelope.js";
import { defaultIndexDir, readRunLocator } from "./locator.js";
import { locateRun, readRunEntry } from "./runs.js";

/**
 * Resolves what an inspection command was given — a run directory or a run id —
 * to a run directory:
 *
 * 1. a path to an existing directory always wins;
 * 2. otherwise a bare run id is looked up in both places that can name it: the
 *    locator index (the run directory it names must exist and record that run
 *    id) and `<runsDir>/<id>`;
 * 3. when both name a run and they are different directories (after symlink
 *    resolution) the id is `run_id_ambiguous`: a command such as `run cancel`
 *    must never pick one of two runs silently. The run directory still works;
 * 4. a bare id found nowhere is `run_dir_invalid`; anything else that is not an
 *    existing directory is kept as a path, so the command reports it as before
 *    (and a follow still waits for a directory that does not exist yet).
 *
 * Directories under the runs directory whose name differs from the run id they
 * record are not searched: that needs every journal read (`woof runs` and the
 * Web API do it).
 */
export type ResolveRunTargetResult =
  | { ok: true; runDir: string; via: "path" | "index" | "runs_dir" }
  | { ok: false; reason: "run_dir_invalid" | "run_id_ambiguous"; message: string };

export async function resolveRunTarget(
  target: string,
  options: {
    indexDir?: string;
    /** The runs directory. Null: none known. */
    runsDir?: () => Promise<string | null>;
  } = {},
): Promise<ResolveRunTargetResult> {
  const path = resolve(target);
  if (isDirectory(path)) return { ok: true, runDir: path, via: "path" };
  if (!isId(target)) return { ok: true, runDir: path, via: "path" };
  const locator = readRunLocator(target, options.indexDir ?? defaultIndexDir());
  let indexed: string | undefined;
  let stale: string | undefined;
  if (locator !== null) {
    const located = locateRun(locator);
    if (located.ok) indexed = located.entry.runDir;
    else stale = `the run index names ${locator.runDir} (${located.reason}: ${located.message})`;
  }
  const runsDir = options.runsDir === undefined ? null : await options.runsDir();
  const candidate = runsDir === null ? undefined : join(runsDir, target);
  const underRunsDir = candidate !== undefined && isDirectory(candidate);
  if (indexed !== undefined) {
    if (underRunsDir && candidate !== undefined && realpathOr(candidate) !== realpathOr(indexed)) {
      // An empty or foreign directory of that name is not a second run with this id.
      const read = readRunEntry(candidate);
      if (read.ok && read.entry.runId === target) {
        return {
          ok: false,
          reason: "run_id_ambiguous",
          message:
            `run id ${target} names more than one run: ${indexed} (run index) and ` +
            `${candidate} (runs directory); pass the run directory instead`,
        };
      }
    }
    return { ok: true, runDir: indexed, via: "index" };
  }
  if (underRunsDir && candidate !== undefined)
    return { ok: true, runDir: candidate, via: "runs_dir" };
  return {
    ok: false,
    reason: "run_dir_invalid",
    message:
      `${target} is neither a run directory nor a known run id` +
      (stale !== undefined ? `; ${stale}` : "") +
      (candidate !== undefined ? `; no ${candidate}` : ""),
  };
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
