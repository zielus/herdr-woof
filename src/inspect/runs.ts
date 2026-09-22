import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import { readJsonFile } from "../host/files.js";
import type { HostOwner } from "../host/probe.js";
import { readSnapshot } from "../state/snapshot.js";
import { projectRootOf, readRunLocators, type RunLocator } from "./locator.js";

/**
 * Run listing (p4 D8, §3.8): every run directory under a runs directory, plus
 * the runs the locator index names, with status and owner liveness. Read-only:
 * no lock, no definition loading, no Herdr. Entries that hold no readable run
 * are reported in `skipped`.
 */

export interface RunListEntry {
  runId: string;
  runDir: string;
  workflow: { name: string; version: string } | null;
  status: string;
  owner: HostOwner;
  openedAt: string;
  updatedAt: string;
  /** `roots.project.root` of the recorded configuration; null for runs without one. */
  project: string | null;
}

export interface ListRunsResult {
  runsDir: string;
  /** The locator index that was also read; absent when only the runs directory was listed. */
  indexDir?: string;
  /** Whether the runs directory exists. */
  exists: boolean;
  runs: RunListEntry[];
  /** Entries that hold no readable run; `runId` is set for a locator that could not be followed. */
  skipped: Array<{ path: string; reason: string; runId?: string }>;
}

/** Terminal runs listed by default, most recent first; every non-terminal run is always listed. */
export const DEFAULT_TERMINAL_RUNS = 20;

/**
 * Lists the runs under `runsDir` and, when `indexDir` is given, the runs the
 * locator index names wherever their directories are. A run found both ways is
 * listed once (by resolved directory). The index is only a locator: every
 * entry's status comes from `readSnapshot`, and a locator whose directory is
 * gone, holds no readable journal, or records another run id is reported in
 * `skipped`, never as a run. Throws when the runs directory exists but cannot
 * be read.
 */
export function listRuns(options: {
  runsDir: string;
  /** Also list the runs of this locator index. Omitted or null: the runs directory only. */
  indexDir?: string | null;
  /** Only runs whose recorded project root is this directory (after symlink resolution). */
  project?: string | null;
  all?: boolean;
  limit?: number;
}): ListRunsResult {
  const { runsDir } = options;
  const indexDir = options.indexDir ?? null;
  let exists = true;
  try {
    if (!statSync(runsDir).isDirectory()) throw new Error(`${runsDir} is not a directory`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }
  const project =
    options.project === undefined || options.project === null ? null : realpathOr(options.project);
  const runs: RunListEntry[] = [];
  const skipped: ListRunsResult["skipped"] = [];
  const seen = new Set<string>();
  for (const name of exists ? readdirSync(runsDir).toSorted() : []) {
    if (name.startsWith(".")) continue;
    const path = join(runsDir, name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(realpathOr(path));
    const read = readRunEntry(path);
    if (!read.ok) {
      skipped.push({ path, reason: read.reason });
      continue;
    }
    if (matchesProject(read.entry, project)) runs.push(read.entry);
  }
  if (indexDir !== null) {
    const index = readRunLocators(indexDir);
    skipped.push(...index.skipped);
    for (const locator of index.locators) {
      if (seen.has(realpathOr(locator.runDir))) continue;
      const located = locateRun(locator);
      if (!located.ok) {
        skipped.push({ path: locator.runDir, reason: located.reason, runId: locator.runId });
        continue;
      }
      seen.add(realpathOr(located.entry.runDir));
      if (matchesProject(located.entry, project)) runs.push(located.entry);
    }
  }
  const terminal = new Set(["completed", "failed", "cancelled", "exhausted"]);
  const byOpened = runs.toSorted((a, b) => b.openedAt.localeCompare(a.openedAt));
  let selected = byOpened;
  if (options.all !== true) {
    let terminalKept = 0;
    selected = byOpened.filter((run) => {
      if (!terminal.has(run.status)) return true;
      terminalKept += 1;
      return terminalKept <= DEFAULT_TERMINAL_RUNS;
    });
  }
  if (options.limit !== undefined) selected = selected.slice(0, options.limit);
  return {
    runsDir,
    ...(indexDir !== null ? { indexDir } : {}),
    exists,
    runs: selected,
    skipped,
  };
}

export type LocateRunResult =
  { ok: true; entry: RunListEntry } | { ok: false; reason: string; message: string };

/**
 * The run a locator points at, read from its own journal. Refused when the
 * directory is gone (`run_dir_missing`) or cannot be resolved right now
 * (`run_dir_unavailable`), its journal cannot be read (the snapshot's own
 * reason, e.g. `run_dir_invalid`), or the journal records another run id
 * (`run_id_mismatch`). The locator's path is resolved on every load, so the
 * entry names the real directory.
 */
export function locateRun(locator: RunLocator): LocateRunResult {
  let runDir: string;
  try {
    runDir = realpathSync(locator.runDir);
    if (!statSync(runDir).isDirectory()) {
      return {
        ok: false,
        reason: "run_dir_missing",
        message: `${locator.runDir} is not a directory`,
      };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? { ok: false, reason: "run_dir_missing", message: `${locator.runDir} does not exist` }
      : {
          ok: false,
          reason: "run_dir_unavailable",
          message: `cannot resolve ${locator.runDir}: ${(error as Error).message}`,
        };
  }
  const read = readRunEntry(runDir);
  if (!read.ok) return read;
  if (read.entry.runId !== locator.runId) {
    return {
      ok: false,
      reason: "run_id_mismatch",
      message: `${locator.runDir} records run ${read.entry.runId}, not ${locator.runId}`,
    };
  }
  return read;
}

/** One run directory as a list entry, from its snapshot and recorded configuration. */
export function readRunEntry(path: string): LocateRunResult {
  const read = readSnapshot(path);
  if (!read.ok) return { ok: false, reason: read.reason, message: read.message };
  const snapshot = read.snapshot;
  const recorded = snapshot.config === null ? undefined : readJsonFile(join(path, "config.json"));
  return {
    ok: true,
    entry: {
      runId: snapshot.runId,
      runDir: path,
      workflow: snapshot.workflow,
      status: snapshot.status,
      owner: snapshot.liveness.owner,
      openedAt: snapshot.openedAt,
      updatedAt: snapshot.updatedAt,
      project: projectRootOf(recorded),
    },
  };
}

function matchesProject(entry: RunListEntry, project: string | null): boolean {
  return project === null || (entry.project !== null && realpathOr(entry.project) === project);
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
