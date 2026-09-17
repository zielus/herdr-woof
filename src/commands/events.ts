import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import { MAX_EVENTS_LIMIT, readEvents, type RunEvent } from "../observe/events.js";
import { subscribeEvents } from "../observe/subscribe.js";
import { readSnapshot } from "../state/snapshot.js";
import { UsageError, milliseconds, parse } from "./common.js";
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

const CURSOR_REASONS: ReadonlySet<string> = new Set([
  "cursor_ahead",
  "cursor_foreign",
  "cursor_malformed",
  "cursor_expired",
]);

export interface StreamOptions {
  after?: string;
  follow: boolean;
  pollMs: number;
  timeoutMs?: number;
  stats: boolean;
}

/** Where streamEvents writes: the NDJSON sink of woof events, or the readable one of woof watch. */
export interface EventsSink {
  event(event: RunEvent): void;
  problem(item: { type: "resync_required" | "error"; reason: string; message: string }): void;
  end(cursor: string | null, terminal: boolean, reason: string): void;
  stats(line: Record<string, unknown>): void;
}

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

/**
 * Reads the run's events, or follows them with options.follow, into a sink; returns the exit code of
 * woof events (0 end or terminated, 7 timeout, 2 resync_required, 3 journal error, 130 SIGINT).
 */
export async function streamEvents(
  runDir: string,
  options: StreamOptions,
  sink: EventsSink,
): Promise<number> {
  const { pollMs } = options;
  if (!options.follow) {
    let after = options.after;
    let cursor: string | null = after ?? null;
    let terminal = false;
    for (;;) {
      const read = readEvents(runDir, {
        ...(after !== undefined ? { after } : {}),
        limit: MAX_EVENTS_LIMIT,
      });
      if (!read.ok) {
        if (CURSOR_REASONS.has(read.reason)) {
          sink.problem({ type: "resync_required", reason: read.reason, message: read.message });
          sink.end(cursor, false, "resync_required");
          return 2;
        }
        sink.problem({ type: "error", reason: read.reason, message: read.message });
        sink.end(cursor, false, "error");
        return 3;
      }
      for (const event of read.events) {
        sink.event(event);
        if (event.type === "run.terminated") terminal = true;
      }
      cursor = read.cursor;
      after = read.cursor;
      if (read.events.length < MAX_EVENTS_LIMIT) break;
    }
    if (!terminal) {
      const snapshot = readSnapshot(runDir);
      terminal = snapshot.ok && snapshot.snapshot.outcome !== null;
    }
    sink.end(cursor, terminal, "end");
    return 0;
  }

  // A resume cursor already at the run's terminal record: no event can follow, so end now instead of
  // waiting for the timeout (PR #6). The snapshot's cursor equal to the resume cursor proves no record
  // was appended between the two lock-free reads.
  if (options.after !== undefined) {
    const read = readEvents(runDir, { after: options.after, limit: 1 });
    if (read.ok && read.events.length === 0) {
      const snapshot = readSnapshot(runDir);
      if (
        snapshot.ok &&
        snapshot.snapshot.outcome !== null &&
        snapshot.snapshot.cursor === read.cursor
      ) {
        sink.end(read.cursor, true, "terminated");
        if (options.stats) sink.stats(statsLine(0, 0, pollMs));
        return 0;
      }
    }
  }

  const controller = new AbortController();
  let stopped: "timeout" | "signal" | undefined;
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          stopped = "timeout";
          controller.abort();
        }, options.timeoutMs);
  const onSignal = () => {
    stopped = "signal";
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  // Inspection never takes the journal lock (PR #6): a partial final line that persists past the
  // subscription's grace period ends the follow with error/journal_corrupt instead of a locked read.
  const iterator = subscribeEvents(runDir, {
    ...(options.after !== undefined ? { after: options.after } : {}),
    pollMs,
    lockFree: true,
    signal: controller.signal,
  });
  let cursor: string | null = options.after ?? null;
  let terminal = false;
  let reason = "end";
  let code = 0;
  // Estimated from the wall time of each iterator step: a step that waited a poll
  // interval is counted as a poll and its time beyond the interval as read + projection.
  let polls = 1;
  let maxProjectionMs = 0;
  try {
    for (;;) {
      const started = performance.now();
      // Each step waits for the subscription's next item.
      // oxlint-disable-next-line no-await-in-loop
      const next = await iterator.next();
      const took = performance.now() - started;
      if (took >= pollMs) {
        polls += Math.max(1, Math.floor(took / pollMs));
        maxProjectionMs = Math.max(maxProjectionMs, took % pollMs);
      } else {
        maxProjectionMs = Math.max(maxProjectionMs, took);
      }
      if (next.done === true) {
        reason = stopped ?? "end";
        code = stopped === "timeout" ? 7 : stopped === "signal" ? 130 : 0;
        break;
      }
      const item = next.value;
      if (item.type === "resync_required") {
        sink.problem(item);
        reason = "resync_required";
        code = 2;
        break;
      }
      if (item.type === "error") {
        sink.problem(item);
        reason = "error";
        code = 3;
        break;
      }
      sink.event(item);
      cursor = item.cursor;
      if (item.type === "run.terminated") {
        terminal = true;
        reason = "terminated";
        break;
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    process.off("SIGINT", onSignal);
    await iterator.return(undefined);
  }
  sink.end(cursor, terminal, reason);
  if (options.stats) sink.stats(statsLine(polls, maxProjectionMs, pollMs));
  return code;
}

function statsLine(
  polls: number,
  maxProjectionMs: number,
  pollMs: number,
): Record<string, unknown> {
  return {
    kind: "woof.events.stats",
    polls,
    maxProjectionMs: Math.round(maxProjectionMs * 100) / 100,
    pollMs,
    method: "iterator step wall time beyond the poll interval",
  };
}
