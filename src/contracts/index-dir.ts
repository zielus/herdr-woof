import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where the run locator index lives: `WOOF_INDEX_DIR` when set, else
 * `~/.woof/index`. It is a fixed user-level location, not configuration: no
 * settings file is read to find it, so the engine areas that register a run
 * take it from here instead of naming the directory themselves.
 */
export function defaultIndexDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["WOOF_INDEX_DIR"];
  if (override !== undefined && override !== "") return resolve(override);
  return join(resolve(homedir()), ".woof", "index");
}
