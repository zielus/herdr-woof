import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { readRunStatus } from "../inspect/status.js";
import {
  colorEnabled,
  formatEnd,
  formatEventLine,
  formatHeader,
  formatProblem,
  type FormatOptions,
} from "../observe/format.js";
import { UsageError, milliseconds, parse } from "./common.js";
import { streamEvents, type EventsSink, type StreamOptions } from "./events.js";

export const WATCH_USAGE = `Usage: woof watch [<run-dir>] [--follow] [--after <cursor>] [--poll-ms <n>] [--timeout-ms <n>]

Prints a short header for the run in <run-dir> (run id, workflow, current
stage, host owner, each agent with role, kind, model and pane) and then one
readable line per journal event: local time, #seq, type, subject and a summary.
<run-dir> defaults to WOOF_RUN_DIR. --follow keeps reading exactly like
woof events --follow (every --poll-ms, default 250) until the run terminates,
--timeout-ms passes or SIGINT. Colors only when stdout is a terminal and
NO_COLOR is unset or empty. Read-only: no journal lock, no Herdr.
Exits like woof events: 0 end or terminated, 7 timeout, 2 resync_required,
3 journal error, 130 SIGINT; 1 usage.`;

export async function watchCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(
    () =>
      parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: {
          after: { type: "string" },
          follow: { type: "boolean" },
          "timeout-ms": { type: "string" },
          "poll-ms": { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      }),
    WATCH_USAGE,
  );
  if (values.help === true) {
    console.log(WATCH_USAGE);
    return 0;
  }
  const [positional, ...extra] = positionals;
  const envRunDir = process.env["WOOF_RUN_DIR"];
  const target =
    positional ?? (envRunDir !== undefined && envRunDir !== "" ? envRunDir : undefined);
  if (target === undefined || target === "" || extra.length > 0)
    throw new UsageError(`expected one <run-dir> (or WOOF_RUN_DIR)\n\n${WATCH_USAGE}`);
  return watchRun(resolve(target), {
    ...(values.after !== undefined ? { after: values.after } : {}),
    follow: values.follow === true,
    pollMs: values["poll-ms"] === undefined ? 250 : milliseconds(values["poll-ms"], "--poll-ms", 1),
    ...(values["timeout-ms"] !== undefined
      ? { timeoutMs: milliseconds(values["timeout-ms"], "--timeout-ms", 1, 604_800_000) }
      : {}),
    stats: false,
  });
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** woof watch and woof events --pretty: the header, then the event stream as readable lines. */
export async function watchRun(runDir: string, options: StreamOptions): Promise<number> {
  const format: FormatOptions = {
    color: colorEnabled({ isTTY: process.stdout.isTTY, env: process.env }),
  };
  // A reader that went away (woof watch | head) ends the watch quietly instead of an EPIPE crash.
  process.stdout.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
    process.exit(0);
  });
  const header = readRunStatus(runDir);
  if (header.ok) {
    for (const line of formatHeader(
      {
        status: header.status,
        agents: header.snapshot.agents,
        outcome: header.snapshot.outcome,
      },
      format,
    ))
      write(line);
  } else {
    // The stream decides the exit code: a follow on a directory without a journal yet still waits.
    write(`run      ${runDir}: ${header.reason}`);
  }
  write("");
  const sink: EventsSink = {
    event: (event) => write(formatEventLine(event, format)),
    problem: (item) => write(formatProblem(item, format)),
    end: (cursor, _terminal, reason) => write(formatEnd(cursor, reason, format)),
    stats: (line) => process.stderr.write(`${JSON.stringify(line)}\n`),
  };
  return streamEvents(runDir, options, sink);
}
