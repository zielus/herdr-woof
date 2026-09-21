import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { readRunLocators } from "./locator.js";
import { listRuns, locateRun, readRunEntry, type RunListEntry } from "./runs.js";
import { MAX_EVENTS_LIMIT, readEvents, type RunEvent } from "../observe/events.js";
import { streamEvents, type EventsSink } from "../observe/stream.js";

/**
 * The cross-run event stream (`woof events --all`, `woof watch --all`): the
 * events of every known run — the runs directory plus the locator index — read
 * from each run's own journal. Nothing is copied or stored: a backlog is
 * `readEvents` per run merged by time, and a follow is one `streamEvents` follow
 * per run, the same loop a single-run follow uses. A problem with one run is
 * reported with its run id and never ends the stream.
 *
 * A follow is bounded: at most `maxRuns` runs are followed at a time, a follower
 * is dropped as soon as its run has ended, and a run that has to wait for a free
 * follower is reported once (`follow_cap`), never silently left out.
 */

/** How many runs a follow polls at the same time unless `maxRuns` says otherwise. */
export const DEFAULT_MAX_FOLLOWED_RUNS = 64;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "exhausted",
]);

export interface AllStreamOptions {
  runsDir: string;
  /** The locator index to read as well; null reads the runs directory only. */
  indexDir: string | null;
  /** Only runs whose recorded project root is this directory. */
  project?: string;
  /** Only events whose `ts` is at or after this ISO time. */
  since?: string;
  follow: boolean;
  pollMs: number;
  /** How often a follow looks for new runs; defaults to `pollMs`, at least 500 ms. */
  discoverMs?: number;
  timeoutMs?: number;
  /** How many runs a follow polls at the same time; defaults to DEFAULT_MAX_FOLLOWED_RUNS. */
  maxRuns?: number;
  /** Ends a follow early with reason "end" and exit 0. */
  signal?: AbortSignal;
  /** Whether the follow installs its own SIGINT listener (see `StreamOptions.handleSigint`). */
  handleSigint?: boolean;
}

export interface AllRunInfo {
  runId: string;
  runDir: string;
  project: string | null;
}

export interface AllProblem {
  runId: string | null;
  runDir: string;
  type: "resync_required" | "error" | "skipped";
  reason: string;
  message: string;
}

/** A run the follow is not polling right now, because `maxRuns` other runs are being followed. */
export interface AllNotFollowed extends AllRunInfo {
  reason: "follow_cap";
  message: string;
}

export interface AllEventsSink {
  /** Once per run, before its first event. */
  run(info: AllRunInfo): void;
  event(event: RunEvent, info: AllRunInfo): void;
  problem(problem: AllProblem): void;
  /** Once per run that has to wait for a free follower. */
  notFollowed(item: AllNotFollowed): void;
  end(reason: string, runs: number): void;
}

interface Backlog {
  entry: RunListEntry;
  info: AllRunInfo;
  events: RunEvent[];
  /** Cursor after the last event read, for the follow to resume from; undefined when the read failed. */
  cursor: string | undefined;
}

/**
 * Exit codes as `woof events`: 0 end, 7 timeout, 130 SIGINT, 3 when the runs
 * directory cannot be read. A single run's resync or journal error is a
 * `problem` line, not an exit code.
 */
export async function streamAllEvents(
  options: AllStreamOptions,
  sink: AllEventsSink,
): Promise<number> {
  const since = options.since === undefined ? undefined : Date.parse(options.since);
  const wanted = (event: RunEvent): boolean =>
    since === undefined || !(Date.parse(event.ts) < since);

  let listed;
  try {
    listed = listRuns({
      runsDir: options.runsDir,
      indexDir: options.indexDir,
      all: true,
      ...(options.project !== undefined ? { project: options.project } : {}),
    });
  } catch (error) {
    sink.problem({
      runId: null,
      runDir: options.runsDir,
      type: "error",
      reason: "runs_dir_unreadable",
      message: `cannot read ${options.runsDir}: ${(error as Error).message}`,
    });
    sink.end("error", 0);
    return 3;
  }

  const reported = new Set<string>();
  const report = (path: string, runId: string | null, reason: string, message: string): void => {
    if (reported.has(path)) return;
    reported.add(path);
    sink.problem({ runId, runDir: path, type: "skipped", reason, message });
  };
  for (const skipped of listed.skipped)
    report(skipped.path, skipped.runId ?? null, skipped.reason, `${skipped.path} holds no run`);

  // The backlog: every run's recorded events, merged by time, then run id, then seq.
  const announced = new Set<string>();
  const backlogs = listed.runs.map((entry) => readBacklog(entry, sink));
  const merged = backlogs
    .flatMap((backlog) => backlog.events.filter(wanted).map((event) => ({ event, backlog })))
    .toSorted(
      (a, b) =>
        compare(a.event.ts, b.event.ts) ||
        compare(a.event.runId, b.event.runId) ||
        a.event.seq - b.event.seq,
    );
  const emit = (event: RunEvent, info: AllRunInfo): void => {
    if (!announced.has(info.runDir)) {
      announced.add(info.runDir);
      sink.run(info);
    }
    sink.event(event, info);
  };
  for (const { event, backlog } of merged) emit(event, backlog.info);

  if (!options.follow) {
    sink.end("end", backlogs.length);
    return 0;
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

  const maxRuns = Math.max(1, options.maxRuns ?? DEFAULT_MAX_FOLLOWED_RUNS);
  const known = new Set<string>();
  // Only followers that are still running: a settled one removes itself.
  const live = new Set<Promise<void>>();
  const waiting: Array<{ entry: RunListEntry; after: string | undefined }> = [];
  const told = new Set<string>();
  const start = (info: AllRunInfo, after: string | undefined): void => {
    const runSink: EventsSink = {
      event: (event) => {
        if (wanted(event)) emit(event, info);
      },
      problem: (item) => sink.problem({ runId: info.runId, runDir: info.runDir, ...item }),
      // One run ending (terminated, resync, error, or the stream stopping) is not the stream's end.
      end: () => {},
      stats: () => {},
    };
    // streamEvents returns once the run has terminated and its host's exit was delivered (or the
    // follow failed): the run is not polled again, and its place goes to a waiting run.
    const tail: Promise<void> = streamEvents(
      info.runDir,
      {
        ...(after !== undefined ? { after } : {}),
        follow: true,
        pollMs: options.pollMs,
        stats: false,
        signal: controller.signal,
        handleSigint: false,
      },
      runSink,
    )
      .then(
        () => {},
        (error: unknown) => {
          sink.problem({
            runId: info.runId,
            runDir: info.runDir,
            type: "error",
            reason: "stream_failed",
            message: (error as Error).message,
          });
        },
      )
      .finally(() => {
        live.delete(tail);
        pump();
      });
    live.add(tail);
  };
  // Runs that have not ended first, then the most recently opened.
  const pump = (): void => {
    if (controller.signal.aborted) return;
    waiting.sort(
      (a, b) =>
        Number(TERMINAL_STATUSES.has(a.entry.status)) -
          Number(TERMINAL_STATUSES.has(b.entry.status)) ||
        compare(b.entry.openedAt, a.entry.openedAt),
    );
    while (live.size < maxRuns) {
      const next = waiting.shift();
      if (next === undefined) break;
      start(infoOf(next.entry), next.after);
    }
    for (const { entry } of waiting) {
      if (told.has(entry.runDir)) continue;
      told.add(entry.runDir);
      sink.notFollowed({
        ...infoOf(entry),
        reason: "follow_cap",
        message:
          `not followed: ${maxRuns} runs are being followed (--max-runs); ` +
          `it is followed from where it stands once one of them ends`,
      });
    }
  };
  const follow = (entry: RunListEntry, after: string | undefined): void => {
    known.add(real(entry.runDir));
    waiting.push({ entry, after });
  };
  for (const backlog of backlogs) {
    const { entry } = backlog;
    // A run whose backlog could not be read was reported; following it would only repeat that.
    // A run that ended and whose host is gone has nothing left to deliver: its follow is over.
    if (
      backlog.cursor === undefined ||
      (TERMINAL_STATUSES.has(entry.status) && entry.owner !== "alive")
    )
      known.add(real(entry.runDir));
    else follow(entry, backlog.cursor);
  }
  pump();

  const discoverMs = Math.max(500, options.discoverMs ?? options.pollMs);
  try {
    while (!controller.signal.aborted) {
      try {
        // Sequential by design: one discovery pass per interval.
        // oxlint-disable-next-line no-await-in-loop
        await delay(discoverMs, undefined, { signal: controller.signal });
      } catch {
        break;
      }
      for (const entry of discover(options, known)) follow(entry, undefined);
      pump();
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (handleSigint) process.off("SIGINT", onSignal);
    options.signal?.removeEventListener("abort", onStop);
    controller.abort();
    await Promise.allSettled(live);
  }
  sink.end(stopped === "timeout" ? "timeout" : stopped === "signal" ? "signal" : "end", known.size);
  return stopped === "timeout" ? 7 : stopped === "signal" ? 130 : 0;
}

function readBacklog(entry: RunListEntry, sink: AllEventsSink): Backlog {
  const info = infoOf(entry);
  const events: RunEvent[] = [];
  let after: string | undefined;
  for (;;) {
    const read = readEvents(entry.runDir, {
      ...(after !== undefined ? { after } : {}),
      limit: MAX_EVENTS_LIMIT,
    });
    if (!read.ok) {
      sink.problem({
        runId: info.runId,
        runDir: info.runDir,
        type: "error",
        reason: read.reason,
        message: read.message,
      });
      return { entry, info, events, cursor: undefined };
    }
    events.push(...read.events);
    after = read.cursor;
    if (read.events.length < MAX_EVENTS_LIMIT) return { entry, info, events, cursor: read.cursor };
  }
}

/**
 * Runs that appeared since the last pass: directories under the runs directory
 * and locator targets not yet known, each read from its own journal. A
 * directory with no readable run yet is left for the next pass.
 */
function discover(options: AllStreamOptions, known: ReadonlySet<string>): RunListEntry[] {
  const found: RunListEntry[] = [];
  const project = options.project === undefined ? null : real(options.project);
  const seen = new Set<string>();
  const consider = (result: ReturnType<typeof readRunEntry>, path: string): void => {
    seen.add(path);
    if (!result.ok) return;
    const { entry } = result;
    if (project !== null && (entry.project === null || real(entry.project) !== project)) return;
    found.push(entry);
  };
  let names: string[] = [];
  try {
    names = readdirSync(options.runsDir).toSorted();
  } catch {
    // Missing or unreadable now: the index may still name runs.
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const path = join(options.runsDir, name);
    const resolved = real(path);
    if (known.has(resolved) || seen.has(resolved)) continue;
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    consider(readRunEntry(path), resolved);
  }
  if (options.indexDir !== null) {
    for (const locator of readRunLocators(options.indexDir).locators) {
      const resolved = real(locator.runDir);
      if (known.has(resolved) || seen.has(resolved)) continue;
      consider(locateRun(locator), resolved);
    }
  }
  return found;
}

function infoOf(entry: RunListEntry): AllRunInfo {
  return { runId: entry.runId, runDir: entry.runDir, project: entry.project };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
