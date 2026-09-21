import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { resolveConfiguration } from "../config/resolve.js";
import { defaultIndexDir } from "../inspect/locator.js";
import { reindexRuns } from "../inspect/reindex.js";
import { listRuns } from "../inspect/runs.js";
import { UsageError, parse } from "./common.js";

export const RUNS_USAGE = `Usage: woof runs [--runs-dir <dir>] [--project <dir>] [--all] [--limit <n>]
       woof runs --reindex [--prune] [--runs-dir <dir>]

Lists the runs under the runs directory (--runs-dir, else the user setting
defaults.runsDir in ~/.woof/woof.json, else ~/.woof/runs) as one JSON line:
every run that has not ended plus the 20 most recent ended runs, newest first
(--all lists every run, --limit caps the list). --project keeps only runs whose
recorded configuration names that project root.

Without --runs-dir the listing also includes every run in the run index
(~/.woof/index, or WOOF_INDEX_DIR), wherever its directory is: a run opened with
its own --run-dir or --runs-dir is registered there when it opens. The index only
locates runs; status always comes from the run journal, and an indexed run whose
directory is gone, has no journal or records another run id is listed under
"skipped", never as a run. With --runs-dir only that directory is listed.

--reindex repairs the index instead of listing: it writes the missing locators
of the runs under the runs directory, printing {"outcome":"reindexed","written",
"pruned","unavailable","kept",...}. A locator whose run directory cannot be
reached is listed under "unavailable" and kept, so a volume that is not mounted
does not lose its runs; --prune removes the locators whose directory does not
exist.
It is the only inspection command that writes, and it never touches a run
directory. Otherwise read-only: no journal lock, no
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
          reindex: { type: "boolean" },
          prune: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      }),
    RUNS_USAGE,
  );
  if (values.help === true) {
    console.log(RUNS_USAGE);
    return 0;
  }
  if (
    values.reindex === true &&
    (values.project !== undefined || values.all === true || values.limit !== undefined)
  )
    throw new UsageError(`--reindex takes only --runs-dir and --prune\n\n${RUNS_USAGE}`);
  if (values.prune === true && values.reindex !== true)
    throw new UsageError(`--prune needs --reindex\n\n${RUNS_USAGE}`);
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
    if (values.reindex === true) {
      const reindexed = reindexRuns({
        runsDir,
        indexDir: defaultIndexDir(),
        prune: values.prune === true,
      });
      console.log(JSON.stringify({ outcome: "reindexed", ...reindexed }));
      return 0;
    }
    const listed = listRuns({
      runsDir,
      // An explicit --runs-dir scopes the listing to that directory.
      ...(values["runs-dir"] === undefined ? { indexDir: defaultIndexDir() } : {}),
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
