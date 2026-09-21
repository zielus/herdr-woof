import { statSync } from "node:fs";
import { join, resolve } from "node:path";

import { isId } from "../contracts/envelope.js";
import { defaultIndexDir, readRunLocator } from "./locator.js";
import { locateRun } from "./runs.js";

/**
 * Resolves what an inspection command was given — a run directory or a run id —
 * to a run directory:
 *
 * 1. a path to an existing directory always wins;
 * 2. otherwise a bare run id is looked up in the locator index, and the run
 *    directory it names must exist and record that run id;
 * 3. otherwise `<runsDir>/<id>`, when that directory exists;
 * 4. a bare id found nowhere is `run_dir_invalid`; anything else that is not an
 *    existing directory is kept as a path, so the command reports it as before
 *    (and a follow still waits for a directory that does not exist yet).
 */
export type ResolveRunTargetResult =
  | { ok: true; runDir: string; via: "path" | "index" | "runs_dir" }
  | { ok: false; reason: "run_dir_invalid"; message: string };

export async function resolveRunTarget(
  target: string,
  options: {
    indexDir?: string;
    /** The runs directory, resolved only when the index does not answer. Null: none known. */
    runsDir?: () => Promise<string | null>;
  } = {},
): Promise<ResolveRunTargetResult> {
  const path = resolve(target);
  if (isDirectory(path)) return { ok: true, runDir: path, via: "path" };
  if (!isId(target)) return { ok: true, runDir: path, via: "path" };
  const locator = readRunLocator(target, options.indexDir ?? defaultIndexDir());
  let stale: string | undefined;
  if (locator !== null) {
    const located = locateRun(locator);
    if (located.ok) return { ok: true, runDir: locator.runDir, via: "index" };
    stale = `the run index names ${locator.runDir} (${located.reason}: ${located.message})`;
  }
  const runsDir = options.runsDir === undefined ? null : await options.runsDir();
  if (runsDir !== null) {
    const candidate = join(runsDir, target);
    if (isDirectory(candidate)) return { ok: true, runDir: candidate, via: "runs_dir" };
  }
  return {
    ok: false,
    reason: "run_dir_invalid",
    message:
      `${target} is neither a run directory nor a known run id` +
      (stale !== undefined ? `; ${stale}` : "") +
      (runsDir !== null ? `; no ${join(runsDir, target)}` : ""),
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
