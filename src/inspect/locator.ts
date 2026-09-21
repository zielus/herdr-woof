import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { isId } from "../contracts/envelope.js";
import { readJsonFile } from "../host/files.js";

/**
 * The run locator index: one small file per run id under
 * `<index>/runs/<runId>.json` that says where the run directory is, so runs
 * opened with an explicit `--run-dir` or `--runs-dir` can be found without
 * knowing the directory in advance.
 *
 * A locator is never state. It holds no status and no events: every reader
 * takes the run's status from `readSnapshot(runDir)` and its events from the
 * run's own `journal.jsonl`, and reports a locator whose directory is gone, has
 * no journal, or records another run id as skipped.
 */

export interface RunLocator {
  schemaVersion: 1;
  kind: "woof.run.locator";
  runId: string;
  /** Absolute, symlink-resolved run directory. */
  runDir: string;
  projectRoot: string | null;
  workflow: { name: string; version: string } | null;
  openedAt: string;
  registeredAt: string;
}

/** The index root: `WOOF_INDEX_DIR` when set, else `~/.woof/index`. */
export function defaultIndexDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["WOOF_INDEX_DIR"];
  if (override !== undefined && override !== "") return resolve(override);
  return join(resolve(homedir()), ".woof", "index");
}

function locatorsDir(indexDir: string): string {
  return join(indexDir, "runs");
}

export function locatorPath(indexDir: string, runId: string): string {
  return join(locatorsDir(indexDir), `${runId}.json`);
}

/** `roots.project.root` of a resolved configuration document; null when it names none. */
export function projectRootOf(configuration: unknown): string | null {
  if (!isObject(configuration)) return null;
  const roots = configuration["roots"];
  const project = isObject(roots) ? roots["project"] : undefined;
  return isObject(project) && typeof project["root"] === "string" ? project["root"] : null;
}

export interface RegisterRunLocatorInput {
  runDir: string;
  runId: string;
  openedAt: string;
  workflow?: { name: string; version: string } | null;
  /** The run's resolved configuration, when it has one; only its project root is kept. */
  configuration?: unknown;
  indexDir?: string;
}

/** Writes the locator through a temporary file and a rename. Throws on failure. */
export function writeRunLocator(input: RegisterRunLocatorInput): RunLocator {
  if (!isId(input.runId)) throw new TypeError("runId must be a valid id");
  const indexDir = input.indexDir ?? defaultIndexDir();
  const locator: RunLocator = {
    schemaVersion: 1,
    kind: "woof.run.locator",
    runId: input.runId,
    runDir: realpathSync(input.runDir),
    projectRoot: projectRootOf(input.configuration),
    workflow:
      input.workflow === undefined || input.workflow === null
        ? null
        : { name: input.workflow.name, version: input.workflow.version },
    openedAt: input.openedAt,
    registeredAt: new Date().toISOString(),
  };
  mkdirSync(locatorsDir(indexDir), { recursive: true });
  const target = locatorPath(indexDir, input.runId);
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(locator, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing to remove, or it cannot be removed: readers ignore *.tmp either way.
    }
    throw error;
  }
  return locator;
}

/**
 * Registers a newly opened run in the index. The index only helps find runs:
 * a failure here is logged to stderr and never fails the run.
 */
export function registerRunLocator(input: RegisterRunLocatorInput): void {
  try {
    writeRunLocator(input);
  } catch (error) {
    process.stderr.write(
      `woof: cannot index run ${input.runId} (the run is unaffected): ${(error as Error).message}\n`,
    );
  }
}

export interface ReadLocatorsResult {
  indexDir: string;
  locators: RunLocator[];
  skipped: Array<{ path: string; reason: string }>;
}

/** Reads every `<runId>.json` locator. Temporary files and other entries are ignored. */
export function readRunLocators(indexDir: string = defaultIndexDir()): ReadLocatorsResult {
  const dir = locatorsDir(indexDir);
  const result: ReadLocatorsResult = { indexDir, locators: [], skipped: [] };
  let names: string[];
  try {
    names = readdirSync(dir).toSorted();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      result.skipped.push({ path: dir, reason: "index_unreadable" });
    return result;
  }
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    const path = join(dir, name);
    const locator = parseLocator(readJsonFile(path, 64 * 1024));
    if (locator === null || `${locator.runId}.json` !== name) {
      result.skipped.push({ path, reason: "locator_invalid" });
      continue;
    }
    result.locators.push(locator);
  }
  return result;
}

/** The locator of one run id; null when absent or invalid. */
export function readRunLocator(
  runId: string,
  indexDir: string = defaultIndexDir(),
): RunLocator | null {
  if (!isId(runId)) return null;
  const locator = parseLocator(readJsonFile(locatorPath(indexDir, runId), 64 * 1024));
  return locator !== null && locator.runId === runId ? locator : null;
}

export function removeRunLocator(indexDir: string, runId: string): void {
  unlinkSync(locatorPath(indexDir, runId));
}

/** Temporary files a crashed writer left behind, older than `olderThanMs`. */
export function staleTemporaryFiles(indexDir: string, olderThanMs: number): string[] {
  const dir = locatorsDir(indexDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const stale: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".tmp")) continue;
    const path = join(dir, name);
    try {
      if (Date.now() - statSync(path).mtimeMs >= olderThanMs) stale.push(path);
    } catch {
      // Renamed or removed meanwhile.
    }
  }
  return stale;
}

function parseLocator(value: unknown): RunLocator | null {
  if (!isObject(value)) return null;
  if (value["schemaVersion"] !== 1 || value["kind"] !== "woof.run.locator") return null;
  const { runId, runDir, projectRoot, workflow, openedAt, registeredAt } = value;
  if (!isId(runId) || typeof runDir !== "string" || runDir === "") return null;
  if (projectRoot !== null && typeof projectRoot !== "string") return null;
  if (typeof openedAt !== "string" || typeof registeredAt !== "string") return null;
  let parsedWorkflow: RunLocator["workflow"] = null;
  if (workflow !== null) {
    if (
      !isObject(workflow) ||
      typeof workflow["name"] !== "string" ||
      typeof workflow["version"] !== "string"
    )
      return null;
    parsedWorkflow = { name: workflow["name"], version: workflow["version"] };
  }
  return {
    schemaVersion: 1,
    kind: "woof.run.locator",
    runId,
    runDir,
    projectRoot,
    workflow: parsedWorkflow,
    openedAt,
    registeredAt,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
