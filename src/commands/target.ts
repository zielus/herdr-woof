import { resolveConfiguration } from "../config/resolve.js";
import { resolveRunTarget, type ResolveRunTargetResult } from "../inspect/target.js";

/** The user's runs directory (defaults.runsDir, else ~/.woof/runs); null when the user configuration is invalid. */
export async function userRunsDir(): Promise<string | null> {
  // The runs directory is a user setting: project configuration is never read here.
  const resolved = await resolveConfiguration({ projectDir: null });
  return resolved.ok ? resolved.configuration.settings.runsDir.value : null;
}

/** A `<run-dir|run-id>` argument as a run directory: an existing directory, else the run index, else the runs directory. */
export function resolveTarget(target: string): Promise<ResolveRunTargetResult> {
  return resolveRunTarget(target, { runsDir: userRunsDir });
}

export const TARGET_HELP = `<run-dir|run-id>: an existing directory wins; otherwise a run id is looked up in
the run index (~/.woof/index, or WOOF_INDEX_DIR) and then as <runs-dir>/<id>. An
unknown id is rejected as run_dir_invalid (exit 3).`;
