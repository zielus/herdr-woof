import { readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { readJsonFile } from "../host/files.js";
import {
  readRunLocators,
  removeRunLocator,
  staleTemporaryFiles,
  writeRunLocator,
} from "./locator.js";
import { locateRun, readRunEntry } from "./runs.js";

/** A temporary locator file this old was left by a writer that died before its rename. */
const STALE_TEMPORARY_MS = 10 * 60_000;

export interface ReindexResult {
  runsDir: string;
  indexDir: string;
  /** Whether the runs directory exists. */
  exists: boolean;
  /** Locators written for runs under the runs directory that had none, or a dead one. */
  written: Array<{ runId: string; runDir: string }>;
  /** Locators removed because their run directory does not exist; only with `prune`. */
  pruned: Array<{ runId: string; runDir: string }>;
  /**
   * Locators whose run directory cannot be reached right now (it does not exist, or its volume is
   * not mounted). Left in place: only `prune` removes those whose directory does not exist.
   */
  unavailable: Array<{ runId: string; runDir: string; reason: string }>;
  /** Locators whose run directory is there, left as they were. */
  kept: number;
  /** A run whose id is already indexed at another readable run directory: left alone. */
  conflicts: Array<{ runId: string; runDir: string; indexedRunDir: string }>;
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Repairs the locator index from a runs directory (`woof runs --reindex`), the
 * only inspector that writes anything: a locator is written for every readable
 * run under `runsDir` that has none (or one whose directory holds no such run).
 * A locator whose run directory cannot be reached is reported as `unavailable`
 * and kept — a volume that is not mounted right now must not lose its runs —
 * unless `prune` is set, which removes the locators whose directory does not
 * exist. It never touches a run directory. Throws when the runs directory exists
 * but cannot be read.
 */
export function reindexRuns(options: {
  runsDir: string;
  indexDir: string;
  /** Remove locators whose run directory does not exist (`woof runs --reindex --prune`). */
  prune?: boolean;
}): ReindexResult {
  const { runsDir, indexDir } = options;
  const prune = options.prune === true;
  const result: ReindexResult = {
    runsDir,
    indexDir,
    exists: true,
    written: [],
    pruned: [],
    unavailable: [],
    kept: 0,
    conflicts: [],
    skipped: [],
  };
  try {
    if (!statSync(runsDir).isDirectory()) throw new Error(`${runsDir} is not a directory`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    result.exists = false;
  }
  const index = readRunLocators(indexDir);
  result.skipped.push(...index.skipped);
  const locators = new Map(index.locators.map((locator) => [locator.runId, locator]));

  for (const name of result.exists ? readdirSync(runsDir).toSorted() : []) {
    if (name.startsWith(".")) continue;
    const path = join(runsDir, name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    const read = readRunEntry(path);
    if (!read.ok) {
      result.skipped.push({ path, reason: read.reason });
      continue;
    }
    const { entry } = read;
    const real = realpathSync(path);
    const existing = locators.get(entry.runId);
    if (existing !== undefined && existing.runDir === real) continue;
    // The indexed directory holds that run, or cannot be reached and may hold it once it is back.
    if (
      existing !== undefined &&
      (locateRun(existing).ok || (!prune && reachable(existing.runDir) !== "present"))
    ) {
      result.conflicts.push({ runId: entry.runId, runDir: real, indexedRunDir: existing.runDir });
      continue;
    }
    try {
      const written = writeRunLocator({
        runDir: real,
        runId: entry.runId,
        openedAt: entry.openedAt,
        workflow: entry.workflow,
        configuration: readJsonFile(join(path, "config.json")),
        indexDir,
      });
      locators.set(written.runId, written);
      result.written.push({ runId: written.runId, runDir: written.runDir });
    } catch (error) {
      result.skipped.push({ path, reason: `locator_write_failed: ${(error as Error).message}` });
    }
  }

  for (const locator of locators.values()) {
    const state = reachable(locator.runDir);
    if (state === "present") {
      if (!result.written.some((item) => item.runId === locator.runId)) result.kept += 1;
      continue;
    }
    if (!prune || state !== "run_dir_missing") {
      result.unavailable.push({ runId: locator.runId, runDir: locator.runDir, reason: state });
      continue;
    }
    try {
      removeRunLocator(indexDir, locator.runId);
      result.pruned.push({ runId: locator.runId, runDir: locator.runDir });
    } catch (error) {
      result.skipped.push({
        path: locator.runDir,
        reason: `locator_remove_failed: ${(error as Error).message}`,
      });
    }
  }
  for (const path of staleTemporaryFiles(indexDir, STALE_TEMPORARY_MS)) {
    try {
      unlinkSync(path);
    } catch {
      // Best effort: readers ignore temporary files.
    }
  }
  return result;
}

/** Whether a locator's directory is there, does not exist, or cannot be examined. */
function reachable(runDir: string): "present" | "run_dir_missing" | "run_dir_unavailable" {
  try {
    return statSync(runDir).isDirectory() ? "present" : "run_dir_missing";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "run_dir_missing" : "run_dir_unavailable";
  }
}
