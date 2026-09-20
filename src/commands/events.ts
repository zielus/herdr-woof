import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { UsageError, milliseconds, parse } from "./common.js";
import { streamEvents, type EventsSink, type StreamOptions } from "../observe/stream.js";
import { watchRun } from "./watch.js";

export const EVENTS_USAGE = `Usage: woof events <run-dir> [--after <cursor>] [--follow] [--timeout-ms <n>] [--poll-ms <n>]
                   [--stats] [--pretty]

Prints the run's lifecycle events as NDJSON, one event per line, resuming after
--after when given. Without --follow it prints the events recorded so far; with
--follow it keeps polling (every --poll-ms, default 250) until the run
terminates, --timeout-ms passes or SIGINT; resumed with --after at a terminated
run's last cursor it ends at once with "terminated". The last line is always
{"kind":"woof.events.end","cursor","terminal","reason"}. --stats prints the
polling statistics to stderr. Read-only: no journal lock, no Herdr; a partial
final journal line unchanged for 2 s ends a follow with a journal_corrupt error.
Exits 0 end or terminated, 7 timeout, 2 resync_required (the cursor cannot
resume; the reason is printed before the end line), 3 journal error, 130 SIGINT.
--pretty prints the same as woof watch (a header and one readable line per
event) with the same exit codes.`;

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const JSON_SINK: EventsSink = {
  event: print,
  problem: print,
  end: (cursor, terminal, reason) => print({ kind: "woof.events.end", cursor, terminal, reason }),
  stats: (line) => process.stderr.write(`${JSON.stringify(line)}\n`),
};

export async function eventsCommand(args: string[]): Promise<number> {
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
          stats: { type: "boolean" },
          pretty: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      }),
    EVENTS_USAGE,
  );
  if (values.help === true) {
    console.log(EVENTS_USAGE);
    return 0;
  }
  const [target, ...extra] = positionals;
  if (target === undefined || target === "" || extra.length > 0)
    throw new UsageError(`expected exactly one <run-dir>\n\n${EVENTS_USAGE}`);
  const runDir = resolve(target);
  const pollMs =
    values["poll-ms"] === undefined ? 250 : milliseconds(values["poll-ms"], "--poll-ms", 1);
  const timeoutMs =
    values["timeout-ms"] === undefined
      ? undefined
      : milliseconds(values["timeout-ms"], "--timeout-ms", 1, 604_800_000);
  const options: StreamOptions = {
    ...(values.after !== undefined ? { after: values.after } : {}),
    follow: values.follow === true,
    pollMs,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    stats: values.stats === true,
  };
  if (values.pretty === true) return watchRun(runDir, options);
  return streamEvents(runDir, options, JSON_SINK);
}
