import { resolve } from "node:path";

import { resolveConfiguration } from "../config/resolve.js";
import { defaultIndexDir } from "../inspect/locator.js";
import { streamAllEvents, type AllEventsSink, type AllStreamOptions } from "../observe/all.js";
import { colorEnabled, type FormatOptions } from "../observe/format.js";
import {
  formatAllEnd,
  formatAllEventLine,
  formatAllProblem,
  formatAllRun,
} from "../observe/format-all.js";
import { UsageError, rejected } from "./common.js";

/** `woof events --all` and `woof watch --all`: the cross-run stream as NDJSON or readable lines. */

export const ALL_HELP = `--all reads every known run instead of one: the runs directory (--runs-dir, else
the user setting defaults.runsDir, else ~/.woof/runs) and, unless --runs-dir is
given, every run in the run index (~/.woof/index, or WOOF_INDEX_DIR), wherever
its directory is. --project keeps only runs recorded for that project root and
--since only events at or after an ISO time. Recorded events come first, merged
by time; with --follow each run is then followed and runs opened later are
picked up, until --timeout-ms passes or SIGINT. A run that cannot be read is
reported with its run id and does not end the stream. A follow polls at most
--max-runs runs at a time (default 64), runs that have not ended and the most
recent first; a run that ended is no longer polled, and a run that has to wait
for a free place is reported once as {"kind":"woof.events.skipped","runId",
"runDir","reason":"follow_cap"} and followed from where it stands when a place
frees.`;

export interface AllFlags {
  "runs-dir"?: string | undefined;
  project?: string | undefined;
  since?: string | undefined;
  follow: boolean;
  pollMs: number;
  timeoutMs?: number | undefined;
  /** The raw --max-runs value; validated here. */
  maxRuns?: string | undefined;
  pretty: boolean;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const JSON_SINK: AllEventsSink = {
  run: (info) => print({ kind: "woof.events.run", ...info }),
  event: (event) => print(event),
  problem: (problem) => print(problem),
  notFollowed: (item) => print({ kind: "woof.events.skipped", ...item }),
  end: (reason, runs) =>
    print({ kind: "woof.events.end", scope: "all", runs, cursor: null, terminal: false, reason }),
};

export async function allEventsCommand(flags: AllFlags, usage: string): Promise<number> {
  if (flags.since !== undefined && Number.isNaN(Date.parse(flags.since)))
    throw new UsageError(`--since must be an ISO 8601 time\n\n${usage}`);
  if (flags.maxRuns !== undefined && !/^[1-9][0-9]{0,3}$/.test(flags.maxRuns))
    throw new UsageError(`--max-runs must be an integer between 1 and 9999\n\n${usage}`);
  let runsDir: string;
  let indexDir: string | null;
  if (flags["runs-dir"] !== undefined) {
    // An explicit runs directory scopes the stream to it, as it scopes woof runs.
    runsDir = resolve(flags["runs-dir"]);
    indexDir = null;
  } else {
    const resolved = await resolveConfiguration({ projectDir: null });
    if (!resolved.ok) return rejected(resolved.reason, resolved.message, resolved.details, 2);
    runsDir = resolved.configuration.settings.runsDir.value;
    indexDir = defaultIndexDir();
  }
  const options: AllStreamOptions = {
    runsDir,
    indexDir,
    ...(flags.project !== undefined ? { project: resolve(flags.project) } : {}),
    ...(flags.since !== undefined ? { since: flags.since } : {}),
    follow: flags.follow,
    pollMs: flags.pollMs,
    ...(flags.timeoutMs !== undefined ? { timeoutMs: flags.timeoutMs } : {}),
    ...(flags.maxRuns !== undefined ? { maxRuns: Number(flags.maxRuns) } : {}),
  };
  if (!flags.pretty) return streamAllEvents(options, JSON_SINK);

  const format: FormatOptions = {
    color: colorEnabled({ isTTY: process.stdout.isTTY, env: process.env }),
  };
  // A reader that went away (woof watch --all | head) ends the stream with exit 0, as woof watch does.
  const closed = new AbortController();
  const onError = (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
    closed.abort();
  };
  const write = (line: string) => {
    if (!closed.signal.aborted) process.stdout.write(`${line}\n`);
  };
  process.stdout.on("error", onError);
  try {
    const code = await streamAllEvents(
      { ...options, signal: closed.signal },
      {
        run: (info) => write(formatAllRun(info, format)),
        event: (event) => write(formatAllEventLine(event, format)),
        problem: (problem) => write(formatAllProblem(problem, format)),
        notFollowed: (item) => write(formatAllProblem({ ...item, type: "skipped" }, format)),
        end: (reason, runs) => write(formatAllEnd(reason, runs, format)),
      },
    );
    return closed.signal.aborted ? 0 : code;
  } finally {
    process.stdout.off("error", onError);
  }
}
