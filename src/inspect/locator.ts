import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { defaultIndexDir } from "../contracts/index-dir.js";
import { locatorPath, locatorsDir, readLocatorFile, type RunLocator } from "../state/locator.js";

/**
 * The read, list and repair side of the run locator index. The locator shape,
 * its paths and the write side live in `state/locator.ts` and are re-exported
 * here for inspection callers.
 */

export { defaultIndexDir } from "../contracts/index-dir.js";
export {
  locatorPath,
  projectRootOf,
  readRunLocator,
  registerRunLocator,
  writeRunLocator,
  type RegisterRunLocatorInput,
  type RunLocator,
} from "../state/locator.js";

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
    const locator = readLocatorFile(path);
    if (locator === null || `${locator.runId}.json` !== name) {
      result.skipped.push({ path, reason: "locator_invalid" });
      continue;
    }
    result.locators.push(locator);
  }
  return result;
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
