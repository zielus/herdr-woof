#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

import { MAX_ENVELOPE_BYTES } from "./contracts/envelope.js";
import { isInfraReason } from "./contracts/reasons.js";
import { openAttempt } from "./submission/attempt.js";
import { submitResult } from "./submission/submit.js";
import { VERSION } from "./version.js";

const SUBMIT_USAGE = `Usage: woof submit --envelope <path|-> [--run-dir <dir>]

Validates a result envelope and its artifact and records the outcome in the run
journal. --run-dir defaults to WOOF_RUN_DIR. When HERDR_PANE_ID is set it must
match the pane the attempt was opened for. Prints one JSON line; exits 0 when
accepted or duplicate, 2 when rejected, 3 on run directory or journal failure.`;

const ATTEMPT_OPEN_USAGE = `Usage: woof attempt open --run-dir <dir> --run <id> --agent <id> --stage <id>
                         --visit <n> --attempt <n> [--verdicts a,b] [--pane <pane-id>]

Declares an open attempt and its owner in the run journal and creates the
attempt's artifact directory. --run-dir defaults to WOOF_RUN_DIR. Prints one JSON
line; exits 0 when opened, 2 on conflict, 3 on journal failure.`;

class UsageError extends Error {}

const [command, ...rest] = process.argv.slice(2);

try {
  process.exitCode = await main(command, rest);
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(`woof: ${error.message}`);
  process.exitCode = 1;
}

async function main(commandName: string | undefined, args: string[]): Promise<number> {
  switch (commandName) {
    case undefined:
    case "--help":
    case "-h":
      printHelp();
      return 0;
    case "--version":
    case "-V":
      console.log(VERSION);
      return 0;
    case "doctor":
      console.log(`woof ${VERSION}`);
      console.log(probe("herdr", ["status"]));
      console.log(probe("claude", ["--version"]));
      return 0;
    case "submit":
      return submitCommand(args);
    case "attempt":
      if (args[0] === "open") return attemptOpenCommand(args.slice(1));
      throw new UsageError(`expected "attempt open"\n\n${ATTEMPT_OPEN_USAGE}`);
    default:
      console.error(`woof: ${commandName} is not implemented in the SDK foundation`);
      return 1;
  }
}

function printHelp(): void {
  console.log("Usage: woof <command>");
  console.log("");
  console.log("Commands:");
  console.log("  doctor        Report Herdr and Claude Code availability");
  console.log("");
  console.log("Prototype result handoff (unstable):");
  console.log("  attempt open  Declare an open attempt and its owner in a run journal");
  console.log("  submit        Validate a result envelope and record it in the run journal");
  console.log("");
  console.log("Workflow orchestration is not implemented yet.");
}

async function submitCommand(args: string[]): Promise<number> {
  const { values } = parse(
    () =>
      parseArgs({
        args,
        strict: true,
        allowPositionals: false,
        options: {
          envelope: { type: "string" },
          "run-dir": { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      }),
    SUBMIT_USAGE,
  );
  if (values.help === true) {
    console.log(SUBMIT_USAGE);
    return 0;
  }
  const envelope = required(values.envelope, "--envelope", SUBMIT_USAGE);
  const runDir = values["run-dir"] ?? process.env["WOOF_RUN_DIR"];
  const paneId = process.env["HERDR_PANE_ID"];

  const outcome = await submitResult({
    ...(envelope === "-" ? { envelopeRaw: await readStdin() } : { envelopePath: envelope }),
    ...(runDir !== undefined ? { runDir } : {}),
    ...(paneId !== undefined ? { paneId } : {}),
  });
  console.log(JSON.stringify(outcome));
  if (outcome.outcome !== "rejected") return 0;
  return isInfraReason(outcome.reason) ? 3 : 2;
}

async function attemptOpenCommand(args: string[]): Promise<number> {
  const { values } = parse(
    () =>
      parseArgs({
        args,
        strict: true,
        allowPositionals: false,
        options: {
          "run-dir": { type: "string" },
          run: { type: "string" },
          agent: { type: "string" },
          stage: { type: "string" },
          visit: { type: "string" },
          attempt: { type: "string" },
          verdicts: { type: "string" },
          pane: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      }),
    ATTEMPT_OPEN_USAGE,
  );
  if (values.help === true) {
    console.log(ATTEMPT_OPEN_USAGE);
    return 0;
  }

  const runDir = required(
    values["run-dir"] ?? process.env["WOOF_RUN_DIR"],
    "--run-dir",
    ATTEMPT_OPEN_USAGE,
  );
  const input = {
    runDir,
    runId: required(values.run, "--run", ATTEMPT_OPEN_USAGE),
    agentId: required(values.agent, "--agent", ATTEMPT_OPEN_USAGE),
    stageId: required(values.stage, "--stage", ATTEMPT_OPEN_USAGE),
    visit: count(required(values.visit, "--visit", ATTEMPT_OPEN_USAGE), "--visit"),
    attempt: count(required(values.attempt, "--attempt", ATTEMPT_OPEN_USAGE), "--attempt"),
    verdicts:
      values.verdicts === undefined || values.verdicts === "" ? [] : values.verdicts.split(","),
    ...(values.pane !== undefined ? { paneId: values.pane } : {}),
  };

  let outcome;
  try {
    outcome = await openAttempt(input);
  } catch (error) {
    if (error instanceof TypeError)
      throw new UsageError(`${error.message}\n\n${ATTEMPT_OPEN_USAGE}`);
    throw error;
  }
  console.log(JSON.stringify(outcome));
  if (outcome.outcome === "opened") return 0;
  return isInfraReason(outcome.reason) ? 3 : 2;
}

/**
 * Reads the envelope from file descriptor 0 through the stdin stream, stopping
 * one chunk past MAX_ENVELOPE_BYTES so submitResult can report the size. The
 * stdin device is never opened by path: on Linux that fails with ENXIO when
 * stdin is a socket, as it is for many process spawners.
 */
async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
      chunks.push(buffer);
      size += buffer.byteLength;
      if (size > MAX_ENVELOPE_BYTES) break;
    }
  } catch (error) {
    throw new UsageError(`cannot read the envelope from stdin: ${(error as Error).message}`);
  }
  return Buffer.concat(chunks);
}

function parse<T>(run: () => T, usage: string): T {
  try {
    return run();
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n\n${usage}`);
  }
}

function required(value: string | undefined, flag: string, usage: string): string {
  if (value === undefined || value === "") throw new UsageError(`${flag} is required\n\n${usage}`);
  return value;
}

function count(value: string, flag: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new UsageError(`${flag} must be an integer >= 1`);
  return Number(value);
}

function probe(commandName: string, args: readonly string[]): string {
  const label = `${commandName} ${args.join(" ")}`;
  const result = spawnSync(commandName, args, { encoding: "utf8" });

  if (result.error !== undefined && "code" in result.error && result.error.code === "ENOENT") {
    return `${label}: not found`;
  }
  if (result.status === 0) {
    const output = result.stdout.trim();
    return output === "" ? `${label}: available` : `${label}:\n${indent(output)}`;
  }

  // stdio is null when the executable exists but cannot be started (EACCES).
  const detail =
    (result.stderr ?? "").trim() || result.error?.message || `exit ${result.status ?? "unknown"}`;
  return `${label}: failed (${detail.split("\n")[0]})`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
