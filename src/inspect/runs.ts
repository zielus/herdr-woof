import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import { readJsonFile } from "../host/files.js";
import type { HostOwner } from "../host/probe.js";
import { readSnapshot } from "../state/snapshot.js";

/**
 * Run listing (p4 D8, §3.8): every run directory under a runs directory with
 * its status and owner liveness. Read-only: no lock, no definition loading, no
 * Herdr. Entries that hold no readable run are reported in `skipped`.
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
  exists: boolean;
  runs: RunListEntry[];
  skipped: Array<{ path: string; reason: string }>;
}

/** Terminal runs listed by default, most recent first; every non-terminal run is always listed. */
export const DEFAULT_TERMINAL_RUNS = 20;

/** Throws when the runs directory exists but cannot be read. */
export function listRuns(options: {
  runsDir: string;
  /** Only runs whose recorded project root is this directory (after symlink resolution). */
  project?: string | null;
  all?: boolean;
  limit?: number;
}): ListRunsResult {
  const { runsDir } = options;
  try {
    if (!statSync(runsDir).isDirectory()) throw new Error(`${runsDir} is not a directory`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { runsDir, exists: false, runs: [], skipped: [] };
    throw error;
  }
  const project =
    options.project === undefined || options.project === null ? null : realpathOr(options.project);
  const runs: RunListEntry[] = [];
  const skipped: ListRunsResult["skipped"] = [];
  for (const name of readdirSync(runsDir).toSorted()) {
    if (name.startsWith(".")) continue;
    const path = join(runsDir, name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    const read = readSnapshot(path);
    if (!read.ok) {
      skipped.push({ path, reason: read.reason });
      continue;
    }
    const snapshot = read.snapshot;
    const recorded = snapshot.config === null ? undefined : readJsonFile(join(path, "config.json"));
    const root = projectRootOf(recorded);
    if (project !== null && (root === null || realpathOr(root) !== project)) continue;
    runs.push({
      runId: snapshot.runId,
      runDir: path,
      workflow: snapshot.workflow,
      status: snapshot.status,
      owner: snapshot.liveness.owner,
      openedAt: snapshot.openedAt,
      updatedAt: snapshot.updatedAt,
      project: root,
    });
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
  return { runsDir, exists: true, runs: selected, skipped };
}

function projectRootOf(recorded: unknown): string | null {
  if (!isObject(recorded)) return null;
  const roots = recorded["roots"];
  const project = isObject(roots) ? roots["project"] : undefined;
  return isObject(project) && typeof project["root"] === "string" ? project["root"] : null;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
