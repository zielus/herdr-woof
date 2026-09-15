import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { resolveConfiguration } from "../config/resolve.js";
import { listRuns } from "../inspect/runs.js";
import { UsageError, parse } from "./common.js";

export const RUNS_USAGE = `Usage: woof runs [--runs-dir <dir>] [--project <dir>] [--all] [--limit <n>]

Lists the runs under the runs directory (--runs-dir, else the user setting
defaults.runsDir in ~/.woof/woof.json, else ~/.woof/runs) as one JSON line:
every run that has not ended plus the 20 most recent ended runs, newest first
(--all lists every run, --limit caps the list). --project keeps only runs whose
recorded configuration names that project root. Read-only: no journal lock, no
workflow loading, no Herdr. Exits 0 (a missing runs directory lists nothing),
2 when the user configuration is invalid, 3 when the runs directory cannot be read.`;

export async function runsCommand(args: string[]): Promise<number> {
  const { values } = parse(
    () =>
      parseArgs({
        args,
        strict: true,
        allowPositionals: false,
        options: {
          "runs-dir": { type: "string" },
          project: { type: "string" },
          all: { type: "boolean" },
          limit: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      }),
    RUNS_USAGE,
  );
  if (values.help === true) {
    console.log(RUNS_USAGE);
    return 0;
  }
  if (values.limit !== undefined && !/^[1-9][0-9]{0,5}$/.test(values.limit))
    throw new UsageError(`--limit must be an integer between 1 and 999999\n\n${RUNS_USAGE}`);
  let runsDir: string;
  if (values["runs-dir"] !== undefined) {
    runsDir = resolve(values["runs-dir"]);
  } else {
    // The runs directory is a user setting: project configuration is never read here.
    const resolved = await resolveConfiguration({ projectDir: null });
    if (!resolved.ok) {
      console.log(
        JSON.stringify({
          outcome: "rejected",
          reason: resolved.reason,
          message: resolved.message,
          details: resolved.details,
        }),
      );
      return 2;
    }
    runsDir = resolved.configuration.settings.runsDir.value;
  }
  try {
    const listed = listRuns({
      runsDir,
      ...(values.project !== undefined ? { project: resolve(values.project) } : {}),
      ...(values.all === true ? { all: true } : {}),
      ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}),
    });
    console.log(JSON.stringify({ outcome: "runs", ...listed }));
    return 0;
  } catch (error) {
    console.log(
      JSON.stringify({
        outcome: "rejected",
        reason: "runs_dir_unreadable",
        message: `cannot read ${runsDir}: ${(error as Error).message}`,
        details: [],
      }),
    );
    return 3;
  }
}
