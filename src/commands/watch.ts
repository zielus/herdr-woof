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
import type { RunRenderer } from "../observe/render.js";
import { unicodeEnabled } from "../observe/render-text.js";
import { rendererFor } from "../observe/run-view.js";
import { streamEvents, type EventsSink, type StreamOptions } from "../observe/stream.js";
import { ALL_HELP, allEventsCommand } from "./all.js";
import { UsageError, milliseconds, parse } from "./common.js";
import { TARGET_HELP, resolveTarget } from "./target.js";

export const WATCH_USAGE = `Usage: woof watch [<run-dir|run-id>] [--follow] [--input summary|json] [--ascii] [--plain]
                  [--after <cursor>] [--poll-ms <n>] [--timeout-ms <n>]
       woof watch --all [--follow] [--project <dir>] [--since <iso>] [--runs-dir <dir>]
                  [--max-runs <n>] [--poll-ms <n>] [--timeout-ms <n>]

Prints one readable account of the run in <run-dir>: an opening block (workflow,
repository, run id and directory, the agent roster with kind, model and stages,
the stage map with its gates and repair routes, the resolved limits and a preview
of the input), then one history row per meaningful fact — time, mark,
participant (agent, gate or run), stage and a plain-English message — and, when
the run ends, an outcome summary with duration, review and repair counts and the
accepted artifact paths relative to the run directory. --input json shows the
input as indented JSON (cut after 24 lines, saying so) instead of the task title
and criteria count. --ascii uses + -> v ~ ! . for the marks (also when LANG,
LC_CTYPE or LC_ALL names a charset other than UTF-8). --plain prints the
technical view instead: a status header and one line per journal event with
#seq, type, subject and summary (what woof events --pretty prints).
<run-dir> defaults to WOOF_RUN_DIR. --follow keeps reading exactly like
woof events --follow (every --poll-ms, default 250) until the run terminates,
--timeout-ms passes or SIGINT; stopping the observer is reported as such and is
not the end of the run. Colors only when stdout is a terminal and NO_COLOR is
unset or empty. Read-only: no journal lock, no Herdr.
Exits like woof events: 0 end or terminated, 7 timeout, 2 resync_required,
3 journal error, 130 SIGINT; 1 usage.
${TARGET_HELP}

${ALL_HELP}
woof watch --all prints the same stream as woof events --all, one readable line
per event behind a short run id, with the same exit codes.`;

/** How watchRun presents the run: the human view of docs/design/run-output.md, or the event lines. */
export type WatchView =
  { mode: "plain" } | { mode: "human"; input: "summary" | "json"; ascii: boolean };

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
          input: { type: "string" },
          ascii: { type: "boolean" },
          plain: { type: "boolean" },
          all: { type: "boolean" },
          project: { type: "string" },
          since: { type: "string" },
          "runs-dir": { type: "string" },
          "max-runs": { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      }),
    WATCH_USAGE,
  );
  if (values.help === true) {
    console.log(WATCH_USAGE);
    return 0;
  }
  const pollMs =
    values["poll-ms"] === undefined ? 250 : milliseconds(values["poll-ms"], "--poll-ms", 1);
  const timeoutMs =
    values["timeout-ms"] === undefined
      ? undefined
      : milliseconds(values["timeout-ms"], "--timeout-ms", 1, 604_800_000);
  if (values.input !== undefined && values.input !== "summary" && values.input !== "json")
    throw new UsageError(`--input must be summary or json\n\n${WATCH_USAGE}`);
  if (values.all === true) {
    if (positionals.length > 0 || values.after !== undefined)
      throw new UsageError(`--all takes no <run-dir> or --after\n\n${WATCH_USAGE}`);
    if (values.input !== undefined || values.ascii === true || values.plain === true)
      throw new UsageError(`--all takes no --input, --ascii or --plain\n\n${WATCH_USAGE}`);
    return allEventsCommand(
      {
        "runs-dir": values["runs-dir"],
        project: values.project,
        since: values.since,
        follow: values.follow === true,
        pollMs,
        timeoutMs,
        maxRuns: values["max-runs"],
        pretty: true,
      },
      WATCH_USAGE,
    );
  }
  if (
    values.project !== undefined ||
    values.since !== undefined ||
    values["runs-dir"] !== undefined ||
    values["max-runs"] !== undefined
  )
    throw new UsageError(
      `--project, --since, --runs-dir and --max-runs need --all\n\n${WATCH_USAGE}`,
    );
  const [positional, ...extra] = positionals;
  const envRunDir = process.env["WOOF_RUN_DIR"];
  const target =
    positional ?? (envRunDir !== undefined && envRunDir !== "" ? envRunDir : undefined);
  if (target === undefined || target === "" || extra.length > 0)
    throw new UsageError(`expected one <run-dir|run-id> (or WOOF_RUN_DIR)\n\n${WATCH_USAGE}`);
  const located = await resolveTarget(target);
  if (!located.ok) {
    console.log(`woof watch: ${located.reason}: ${located.message}`);
    return 3;
  }
  const view: WatchView =
    values.plain === true
      ? { mode: "plain" }
      : {
          mode: "human",
          input: values.input ?? "summary",
          ascii: values.ascii === true || !unicodeEnabled(process.env),
        };
  return watchRun(
    located.runDir,
    {
      ...(values.after !== undefined ? { after: values.after } : {}),
      follow: values.follow === true,
      pollMs,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      stats: false,
    },
    view,
  );
}

/**
 * woof watch (human view by default, `--plain` for the event lines) and woof events --pretty (the
 * event lines): the opening block or header, then the event stream, then the summary or end line.
 */
export async function watchRun(
  runDir: string,
  options: StreamOptions,
  view: WatchView = { mode: "plain" },
): Promise<number> {
  const format: FormatOptions = {
    color: colorEnabled({ isTTY: process.stdout.isTTY, env: process.env }),
  };
  // A reader that went away (woof watch | head) stops the follow and exits 0 instead of an EPIPE
  // crash; any other stdout error still throws. The handler lives only as long as this call.
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
    const sink =
      view.mode === "plain"
        ? plainSink(runDir, format, write)
        : humanSink(runDir, view, format, write);
    const code = await streamEvents(runDir, { ...options, signal: closed.signal }, sink);
    // A queued write to a pipe reports EPIPE to its callback before the error event: wait for the
    // flush and, when it failed, for the close after the error event, so the handler above sees it.
    await new Promise<void>((done) => {
      if (closed.signal.aborted) return done();
      process.stdout.write("", (error) => {
        if (error === null || error === undefined || closed.signal.aborted) done();
        else process.stdout.once("close", () => done());
      });
    });
    return closed.signal.aborted ? 0 : code;
  } finally {
    process.stdout.off("error", onError);
  }
}

function plainSink(
  runDir: string,
  format: FormatOptions,
  write: (line: string) => void,
): EventsSink {
  const header = readRunStatus(runDir);
  if (header.ok) {
    for (const line of formatHeader(
      { status: header.status, agents: header.snapshot.agents, outcome: header.snapshot.outcome },
      format,
    ))
      write(line);
  } else {
    // The stream decides the exit code: a follow on a directory without a journal yet still waits.
    write(`run      ${runDir}: ${header.reason}`);
  }
  write("");
  return {
    event: (event) => write(formatEventLine(event, format)),
    problem: (item) => write(formatProblem(item, format)),
    end: (cursor, _terminal, reason) => write(formatEnd(cursor, reason, format)),
    stats: (line) => process.stderr.write(`${JSON.stringify(line)}\n`),
  };
}

function humanSink(
  runDir: string,
  view: Extract<WatchView, { mode: "human" }>,
  format: FormatOptions,
  write: (line: string) => void,
): EventsSink {
  let renderer: RunRenderer | undefined;
  // The opening block needs a snapshot; a follow on a directory whose journal does not exist yet
  // prints it with the first event instead, once there is a run to describe.
  const open = (): boolean => {
    const read = readRunStatus(runDir);
    if (!read.ok) return false;
    renderer = rendererFor(runDir, read, {
      color: format.color,
      ascii: view.ascii,
      input: view.input,
      width: process.stdout.columns ?? 80,
    });
    for (const line of renderer.opening()) write(line);
    return true;
  };
  if (!open()) {
    const read = readRunStatus(runDir);
    write(`run      ${runDir}: ${read.ok ? "?" : read.reason}`);
    write("");
  }
  return {
    event: (event) => {
      if (renderer === undefined && !open()) {
        write(formatEventLine(event, format));
        return;
      }
      for (const line of (renderer as RunRenderer).row(event)) write(line);
    },
    problem: (item) => write(formatProblem(item, format)),
    end: (cursor, terminal, reason) => {
      if (renderer === undefined || reason === "error" || reason === "resync_required") {
        write(formatEnd(cursor, reason, format));
        return;
      }
      const final = readRunStatus(runDir);
      if (terminal && final.ok && final.snapshot.outcome !== null) {
        for (const line of renderer.summary({
          status: final.status,
          result: final.result,
          snapshot: final.snapshot,
        }))
          write(line);
        return;
      }
      if (final.ok) for (const line of renderer.blocked(final.status)) write(line);
      write(renderer.observerStopped(reason));
    },
    stats: (line) => process.stderr.write(`${JSON.stringify(line)}\n`),
  };
}
