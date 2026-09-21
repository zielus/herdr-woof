import { realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { readJsonFile } from "../host/files.js";
import { OUTCOME_EXIT_CODES, OUTCOME_FILE } from "../host/run.js";
import { readRunStatus, type ReadRunStatusResult } from "../inspect/status.js";
import { colorEnabled, formatHeader, formatHostOutcome } from "../observe/format.js";
import { UsageError, milliseconds, parse } from "./common.js";
import { TARGET_HELP, resolveTarget } from "./target.js";

export const STATUS_USAGE = `Usage: woof status <run-dir|run-id> [--wait] [--timeout-ms <n>] [--allow-blocked] [--poll-ms <n>]
                   [--verify-artifacts] [--pretty]

Prints one JSON line {"outcome":"status","status","result"} for the run: status,
owner liveness (unhosted, alive, lost, exited), active attempts, the last gate, attention and counters; result is the run result once
the run has ended. Read-only: no journal lock, no Herdr.

Without --wait: exits 0, or 3 when the journal cannot be read (run_dir_invalid,
journal_corrupt, journal_replaced).
With --wait (poll every --poll-ms, default 1000; --timeout-ms default 540000):
  0 completed, 4 failed, 5 exhausted, 6 cancelled (a recorded outcome always wins);
  7 still running when the timeout passes;
  8 the owner is gone without a recorded outcome: lost (confirmed by two probes
    at least two heartbeats apart), or exited (a host interrupted before the run
    recorded its end; its outcome.json, when present, is printed as hostOutcome);
  9 the run is blocked and needs the operator (unless --allow-blocked).
The last line printed is always the status at return time.
--pretty prints the human header of woof watch (run, workflow, current stage,
owner, agents, outcome) instead of the JSON line, with the same exit codes; a
run directory it cannot read prints "woof status: <reason>: <message>".
${TARGET_HELP}`;

const DEFAULT_WAIT_TIMEOUT_MS = 540_000;
const DEFAULT_HEARTBEAT_MS = 2000;

export async function statusCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(
    () =>
      parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: {
          wait: { type: "boolean" },
          "timeout-ms": { type: "string" },
          "allow-blocked": { type: "boolean" },
          "poll-ms": { type: "string" },
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
  if (!located.ok) {
    const unknown = { ok: false as const, reason: located.reason, message: located.message };
    return (values.pretty === true ? printPretty : printJson)(unknown, 3);
  }
  const runDir = canonical(located.runDir);
  const pollMs =
    values["poll-ms"] === undefined ? 1000 : milliseconds(values["poll-ms"], "--poll-ms", 1);
  const timeoutMs =
    values["timeout-ms"] === undefined
      ? DEFAULT_WAIT_TIMEOUT_MS
      : milliseconds(values["timeout-ms"], "--timeout-ms", 0, 604_800_000);
  const read = () =>
    readRunStatus(runDir, { verifyArtifacts: values["verify-artifacts"] === true });
  const print = values.pretty === true ? printPretty : printJson;

  let current = read();
  if (values.wait !== true) return print(current, 0);

  const deadline = Date.now() + timeoutMs;
  let lostSince: number | undefined;
  for (;;) {
    if (!current.ok) return print(current, 3);
    const { status, result } = current;
    if (result !== null) return print(current, OUTCOME_EXIT_CODES[result.outcome]);
    if (status.attention.blocked !== null && values["allow-blocked"] !== true)
      return print(current, 9);
    const now = Date.now();
    if (status.liveness.owner === "exited") {
      // The host recorded its exit but the journal has no end: nothing will record one. Read once
      // more first, so a host that exited just after its final journal write is not caught between.
      const settled = read();
      if (!settled.ok || settled.result !== null || settled.status.liveness.owner !== "exited") {
        current = settled;
        continue;
      }
      return print(settled, 8, readJsonFile(join(runDir, OUTCOME_FILE)));
    }
    if (status.liveness.owner === "lost") {
      lostSince ??= now;
      const heartbeatMs = status.liveness.host?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
      if (now - lostSince >= 2 * heartbeatMs) return print(current, 8);
    } else {
      lostSince = undefined;
    }
    if (now >= deadline) return print(current, 7);
    // Waiting on the journal another process writes is sequential by design.
    // oxlint-disable-next-line no-await-in-loop
    await delay(Math.max(1, Math.min(pollMs, deadline - now)));
    current = read();
  }
}

function printPretty(current: ReadRunStatusResult, code: number, hostOutcome?: unknown): number {
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

function printJson(current: ReadRunStatusResult, code: number, hostOutcome?: unknown): number {
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
