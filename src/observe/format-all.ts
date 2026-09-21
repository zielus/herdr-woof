import { formatEventLine, type FormatOptions, type FormattableEvent } from "./format.js";

/**
 * Human-readable lines of the cross-run stream (`woof watch --all`), pure like
 * `format.ts`: the single-run event line behind a short run id, plus the lines
 * that introduce a run, report a per-run problem and end the stream.
 */

const SHORT_ID_WIDTH = 12;

/** A run id at most 12 characters wide: the id itself, or `~` and its last 11 characters. */
export function shortRunId(runId: string): string {
  const clean = sanitize(runId);
  return clean.length <= SHORT_ID_WIDTH ? clean : `~${clean.slice(-(SHORT_ID_WIDTH - 1))}`;
}

export function formatAllEventLine(
  event: FormattableEvent & { runId: string },
  options: FormatOptions,
): string {
  return `${paint(shortRunId(event.runId).padEnd(SHORT_ID_WIDTH), "36", options)} ${formatEventLine(event, options)}`;
}

export function formatAllRun(
  info: { runId: string; runDir: string; project: string | null },
  options: FormatOptions,
): string {
  const project = info.project === null ? "" : `  project ${sanitize(info.project)}`;
  return paint(
    `== ${shortRunId(info.runId)}  run ${sanitize(info.runId)}  ${sanitize(info.runDir)}${project}`,
    "1",
    options,
  );
}

export function formatAllProblem(
  problem: { runId: string | null; runDir: string; type: string; reason: string; message: string },
  options: FormatOptions,
): string {
  const who = problem.runId === null ? sanitize(problem.runDir) : shortRunId(problem.runId);
  return paint(
    `!! ${who} ${sanitize(problem.type)} ${sanitize(problem.reason)}: ${sanitize(problem.message)}`,
    "31",
    options,
  );
}

export function formatAllEnd(reason: string, runs: number, options: FormatOptions): string {
  return paint(`-- end (${sanitize(reason)}) ${runs} run(s)`, "2", options);
}

function paint(value: string, code: string, options: FormatOptions): string {
  return options.color ? `\u001B[${code}m${value}\u001B[0m` : value;
}

/** Control characters become spaces, as in `format.ts`: a line never carries an escape it did not add. */
function sanitize(value: string): string {
  // oxlint-disable-next-line no-control-regex
  return value.replaceAll(/[\u0000-\u001F\u007F-\u009F]/g, " ");
}
