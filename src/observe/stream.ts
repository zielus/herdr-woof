import { performance } from "node:perf_hooks";

import { MAX_EVENTS_LIMIT, readEvents, type RunEvent } from "./events.js";
import { subscribeEvents } from "./subscribe.js";
import { readSnapshot } from "../state/snapshot.js";

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
  /** Ends a follow early with reason "end" and exit 0, e.g. when the reader of stdout went away. */
  signal?: AbortSignal;
  /**
   * Whether the follow loop installs its own process SIGINT listener. True for
   * the CLI commands, whose process this loop owns. A server running many
   * concurrent follows passes false and ends them through `signal` instead: one
   * process-level listener per stream is a signal concern in a library loop.
   */
  handleSigint?: boolean;
}

/** Where streamEvents writes: the NDJSON sink of woof events, or the readable one of woof watch. */
export interface EventsSink {
  event(event: RunEvent): void;
  problem(item: { type: "resync_required" | "error"; reason: string; message: string }): void;
  end(cursor: string | null, terminal: boolean, reason: string): void;
  stats(line: Record<string, unknown>): void;
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
  const handleSigint = options.handleSigint !== false;
  const onSignal = () => {
    stopped = "signal";
    controller.abort();
  };
  if (handleSigint) process.on("SIGINT", onSignal);
  const onStop = () => controller.abort();
  if (options.signal?.aborted === true) controller.abort();
  else options.signal?.addEventListener("abort", onStop, { once: true });
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
    if (handleSigint) process.off("SIGINT", onSignal);
    options.signal?.removeEventListener("abort", onStop);
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
