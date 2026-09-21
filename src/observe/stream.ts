import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { MAX_EVENTS_LIMIT, readEvents, type RunEvent } from "./events.js";
import { subscribeEvents } from "./subscribe.js";
import { parseCursor, readSnapshot } from "../state/snapshot.js";

/** Heartbeat assumed for a host whose claim does not state one. */
const DEFAULT_HEARTBEAT_MS = 2000;
/**
 * How many heartbeats a follower keeps waiting, after `run.terminated`, for the `host.exited` of a
 * host that still looks alive. A host killed right after the termination never writes it.
 */
export const HOST_EXIT_GRACE_HEARTBEATS = 3;

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

  // A resume cursor at or past the run's terminal record: the only lifecycle record that can follow
  // a termination is the host's own host.exited, so deliver it (waiting for it while its host still
  // lives, see followHostExit) with whatever else is left, and end instead of waiting for the
  // timeout (PR #6).
  if (options.after !== undefined) {
    const read = readEvents(runDir, { after: options.after });
    const resumedAt = parseCursor(options.after)?.seq;
    if (read.ok && resumedAt !== undefined) {
      const snapshot = readSnapshot(runDir);
      if (
        snapshot.ok &&
        snapshot.snapshot.outcome !== null &&
        snapshot.snapshot.outcome.seq <= resumedAt
      ) {
        const cursor = await followHostExit(runDir, options.after, sink, {
          pollMs,
          deliverRest: true,
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
        sink.end(cursor, true, "terminated");
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
        // The run's outcome is final from here; what may still follow is its host's host.exited.
        // The timeout and a signal only cut that wait short: the follow still ends terminated.
        // oxlint-disable-next-line no-await-in-loop
        cursor = await followHostExit(runDir, item.cursor, sink, {
          pollMs,
          deliverRest: false,
          signal: controller.signal,
        });
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

/**
 * After `run.terminated`: delivers the one record that may still follow it, the `host.exited` of
 * the host that ran it, and returns the last cursor delivered. A host records the termination,
 * drains for a while and only then journals its exit, so ending at the termination would lose that
 * record for every live follower. The wait ends as soon as nothing more can come: the journal holds
 * no `host.claimed`, or the host's `host.exited`/`host.lost` is recorded, or the read-time probe no
 * longer sees a live host (exit marker, dead pid, stale heartbeat, no claim file). A host that
 * still looks alive is waited for at most HOST_EXIT_GRACE_HEARTBEATS of its heartbeats, so a host
 * killed right after the termination never makes a follower hang. Lock-free like every read here;
 * a read problem ends the wait silently, because the terminal event was already delivered.
 */
async function followHostExit(
  runDir: string,
  after: string,
  sink: EventsSink,
  options: {
    pollMs: number;
    /** A resume delivers whatever else follows its cursor; a live follow stops at the termination. */
    deliverRest: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<string> {
  const started = Date.now();
  let cursor = after;
  for (;;) {
    // Settledness is decided before the read: a host journals host.exited before it writes its
    // exit marker, so whatever made the probe say "gone" is already in the journal read below.
    const snapshot = readSnapshot(runDir);
    let settled = true;
    let heartbeatMs = DEFAULT_HEARTBEAT_MS;
    if (snapshot.ok) {
      const { lifecycle, liveness } = snapshot.snapshot;
      settled =
        lifecycle.host === null || lifecycle.host.state !== "claimed" || liveness.owner !== "alive";
      heartbeatMs = liveness.host?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    }
    const read = readEvents(runDir, { after: cursor, limit: MAX_EVENTS_LIMIT });
    if (!read.ok) return cursor;
    // Records refused after the termination (a late submission.rejected) may precede the exit;
    // they are delivered with it so the sequence stays contiguous, never on their own.
    const exit = read.events.findIndex((event) => event.type === "host.exited");
    if (exit !== -1) {
      for (const event of read.events.slice(0, exit + 1)) {
        sink.event(event);
        cursor = event.cursor;
      }
      return cursor;
    }
    const waited = Date.now() - started;
    const graceMs = Math.min(
      HOST_EXIT_GRACE_HEARTBEATS * heartbeatMs,
      options.timeoutMs ?? Number.POSITIVE_INFINITY,
    );
    if (settled || waited >= graceMs || options.signal?.aborted === true) {
      if (!options.deliverRest) return cursor;
      for (const event of read.events) sink.event(event);
      return read.cursor;
    }
    try {
      // Polling is sequential by design: each wait precedes the next read.
      // oxlint-disable-next-line no-await-in-loop
      await delay(
        Math.max(1, Math.min(options.pollMs, graceMs - waited)),
        undefined,
        options.signal === undefined ? {} : { signal: options.signal },
      );
    } catch {
      return cursor;
    }
  }
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
