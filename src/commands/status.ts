import { realpathSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { readJsonFile } from "../host/files.js";
import { OUTCOME_FILE } from "../host/run.js";
import { readRunStatus, type ReadRunStatusResult } from "../inspect/status.js";
import { colorEnabled, formatHeader, formatHostOutcome } from "../observe/format.js";
import { UsageError, parse } from "./common.js";
import { TARGET_HELP, resolveTarget } from "./target.js";

export const STATUS_USAGE = `Usage: woof status <run-dir|run-id> [--verify-artifacts] [--pretty]

Prints one JSON line {"outcome":"status","status","result"} for the run: status,
owner liveness (unhosted, alive, lost, exited), active attempts, the last gate,
attention and counters; result is the run result once the run has ended. When
the owner exited without a recorded end, its outcome.json (when present) is
printed as hostOutcome. Read-only: no journal lock, no Herdr. It is a snapshot:
it never waits. Inside Herdr the run host pushes the events that need the
caller into the caller's pane ([woof] messages); woof events --follow or
woof watch --follow follow a run to its end.
Exits 0, or 3 when the journal cannot be read (run_dir_invalid, journal_corrupt,
journal_replaced).
--pretty prints the human header of woof watch (run, workflow, current stage,
owner, agents, outcome) instead of the JSON line, with the same exit codes; a
run directory it cannot read prints "woof status: <reason>: <message>".
${TARGET_HELP}`;

export async function statusCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(
    () =>
      parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: {
          "verify-artifacts": { type: "boolean" },
          pretty: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      }),
    STATUS_USAGE,
  );
  if (values.help === true) {
    console.log(STATUS_USAGE);
    return 0;
  }
  const [target, ...extra] = positionals;
  if (target === undefined || target === "" || extra.length > 0)
    throw new UsageError(`expected exactly one <run-dir|run-id>\n\n${STATUS_USAGE}`);
  const located = await resolveTarget(target);
  const print = values.pretty === true ? printPretty : printJson;
  if (!located.ok) {
    return print({ ok: false as const, reason: located.reason, message: located.message }, 3);
  }
  const runDir = canonical(located.runDir);
  const current = readRunStatus(runDir, { verifyArtifacts: values["verify-artifacts"] === true });
  if (!current.ok) return print(current, 3);
  // A host that exited without recording the run's end left its own account of why.
  const hostOutcome =
    current.result === null && current.status.liveness.owner === "exited"
      ? readJsonFile(join(runDir, OUTCOME_FILE))
      : undefined;
  return print(current, 0, hostOutcome);
}

/** A status read, or a `<run-dir|run-id>` argument that named no single run. */
type Printable =
  ReadRunStatusResult | { ok: false; reason: string; message: string; line?: number };

function printPretty(current: Printable, code: number, hostOutcome?: unknown): number {
  const format = { color: colorEnabled({ isTTY: process.stdout.isTTY, env: process.env }) };
  if (!current.ok) {
    console.log(`woof status: ${current.reason}: ${current.message}`);
    return 3;
  }
  const lines = formatHeader(
    { status: current.status, agents: current.snapshot.agents, outcome: current.snapshot.outcome },
    format,
  );
  if (hostOutcome !== undefined) lines.push(formatHostOutcome(hostOutcome, format));
  console.log(lines.join("\n"));
  return code;
}

function printJson(current: Printable, code: number, hostOutcome?: unknown): number {
  if (current.ok) {
    console.log(
      JSON.stringify({
        outcome: "status",
        status: current.status,
        result: current.result,
        ...(hostOutcome !== undefined ? { hostOutcome } : {}),
      }),
    );
    return code;
  }
  console.log(
    JSON.stringify({
      outcome: "rejected",
      reason: current.reason,
      message: current.message,
      ...(current.line !== undefined ? { line: current.line } : {}),
    }),
  );
  return 3;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
