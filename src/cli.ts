#!/usr/bin/env node
import { parseArgs } from "node:util";

import { agentCommand } from "./commands/agent.js";
import { UsageError, parse, readStdin, rejected, required } from "./commands/common.js";
import { configCommand } from "./commands/config.js";
import { doctorCommand } from "./commands/doctor.js";
import { eventsCommand } from "./commands/events.js";
import { herdrCommand } from "./commands/herdr.js";
import {
  RUN_BUILD_REVIEW_USAGE,
  RUN_HOST_USAGE,
  RUN_START_USAGE,
  runBuildReviewCommand,
  runHostCommand,
  runStartCommand,
} from "./commands/run.js";
import { runsCommand } from "./commands/runs.js";
import { statusCommand } from "./commands/status.js";
import { TARGET_HELP, resolveTarget } from "./commands/target.js";
import { tuiCommand } from "./commands/tui.js";
import { uiCommand } from "./commands/ui.js";
import { watchCommand } from "./commands/watch.js";
import { isInfraReason } from "./contracts/reasons.js";
import { readSnapshot } from "./state/snapshot.js";
import { cancelRun } from "./state/store.js";
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

const RUN_SHOW_USAGE = `Usage: woof run show <run-dir|run-id> [--verify-artifacts]

Prints one JSON line with a snapshot of the run journal of the run. It takes
no journal lock, never contacts Herdr and works on terminated runs.
--verify-artifacts re-hashes every accepted copy against its journal record.
Exits 0 with the snapshot. Exits 3 with a rejection (outcome "rejected") when
the run directory has no journal or records (run_dir_invalid), the journal is
corrupt (journal_corrupt), or its line 1 changed during each of three
consecutive reads (journal_replaced).
${TARGET_HELP}`;

const RUN_CANCEL_USAGE = `Usage: woof run cancel <run-dir|run-id> [--reason <text>]

Records that the run is cancelled. A scheduler still running it
stops at its next tick; late submissions are refused. Prints one JSON line;
exits 0 when recorded, 2 when the run is already terminated, 3 on journal failure.
${TARGET_HELP}`;

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
    case "agent":
      return agentCommand(args);
    case "doctor":
      return doctorCommand(args);
    case "config":
      return configCommand(args);
    case "status":
      return statusCommand(args);
    case "runs":
      return runsCommand(args);
    case "events":
      return eventsCommand(args);
    case "watch":
      return watchCommand(args);
    case "ui":
      return uiCommand(args);
    case "tui":
      return tuiCommand(args);
    case "herdr":
      return herdrCommand(args);
    case "submit":
      return submitCommand(args);
    case "attempt":
      if (args[0] === "open") return attemptOpenCommand(args.slice(1));
      throw new UsageError(`expected "attempt open"\n\n${ATTEMPT_OPEN_USAGE}`);
    case "run":
      if (args[0] === "start") return runStartCommand(args.slice(1));
      if (args[0] === "host") return runHostCommand(args.slice(1));
      if (args[0] === "show") return runShowCommand(args.slice(1));
      if (args[0] === "build-review") return runBuildReviewCommand(args.slice(1));
      if (args[0] === "cancel") return runCancelCommand(args.slice(1));
      throw new UsageError(
        `expected "run start", "run show", "run cancel" or "run build-review"\n\n${RUN_START_USAGE}\n\n${RUN_SHOW_USAGE}\n\n${RUN_CANCEL_USAGE}\n\n${RUN_BUILD_REVIEW_USAGE}\n\n${RUN_HOST_USAGE}`,
      );
    default:
      console.error(`woof: unknown command ${JSON.stringify(commandName)}; see woof --help`);
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
  console.log("  run show      Print a JSON snapshot of a run journal (read-only)");
  console.log("");
  console.log("Inspection (read-only):");
  console.log("  status        Print a run's status and owner liveness; --wait until it needs you");
  console.log("  runs          List the runs under the runs directory");
  console.log("  events        Print a run's lifecycle events as NDJSON; --follow to keep reading");
  console.log(
    "  watch         Follow a run in plain English (--plain for event lines); --follow to keep reading",
  );
  console.log(
    "  tui           Browse the project's runs interactively: steps, activity, config, artifacts",
  );
  console.log("");
  console.log("Web UI (unstable):");
  console.log(
    "  ui            Serve the run dashboard and its inspection API on 127.0.0.1; reads,",
  );
  console.log("                plus one mutating action, cancel");
  console.log("");
  console.log("Configuration:");
  console.log("  config show   Print the effective configuration and where each value came from");
  console.log("");
  console.log("Workflows (unstable):");
  console.log(
    "  run start         Start a workflow run hosted in a Herdr pane (or --host foreground)",
  );
  console.log("  run cancel        Cancel a run recorded in a run directory");
  console.log("  run build-review  Run the build-review workflow in this process (compatibility)");
  console.log("  run host          Host a launched run in this process (internal)");
  console.log("");
  console.log("Agents (unstable):");
  console.log("  agent start       Start one agent from a role in a Herdr pane, outside any run");
  console.log("");
  console.log("Herdr plugin actions (unstable; project from HERDR_PLUGIN_CONTEXT_JSON):");
  console.log("  herdr status      Notify the focused project's active runs");
  console.log("  herdr start       Start a run with the project's .woof/start.json input");
  console.log("  herdr cancel      Cancel the focused project's single active run");
  console.log(
    "  herdr watch       Open a plugin pane following the focused project's single active run",
  );
  console.log(
    "  herdr doctor      Check Woof, Herdr, Claude Code, trust and config for the focused project",
  );
}

async function runCancelCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(
    () =>
      parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: { reason: { type: "string" }, help: { type: "boolean", short: "h" } },
      }),
    RUN_CANCEL_USAGE,
  );
  if (values.help === true) {
    console.log(RUN_CANCEL_USAGE);
    return 0;
  }
  const [runDir, ...extra] = positionals;
  if (runDir === undefined || runDir === "" || extra.length > 0) {
    throw new UsageError(`expected exactly one <run-dir>\n\n${RUN_CANCEL_USAGE}`);
  }
  if (values.reason === "")
    throw new UsageError(`--reason must not be empty\n\n${RUN_CANCEL_USAGE}`);
  const located = await resolveTarget(runDir);
  if (!located.ok) return rejected(located.reason, located.message, [], 3);
  const outcome = await cancelRun({
    runDir: located.runDir,
    source: "cli",
    reason: values.reason ?? "cancelled via woof run cancel",
  });
  console.log(JSON.stringify(outcome));
  if (outcome.outcome === "recorded") return 0;
  return isInfraReason(outcome.reason) ? 3 : 2;
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

async function runShowCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(
    () =>
      parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: {
          "verify-artifacts": { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      }),
    RUN_SHOW_USAGE,
  );
  if (values.help === true) {
    console.log(RUN_SHOW_USAGE);
    return 0;
  }
  const [runDir, ...extra] = positionals;
  if (runDir === undefined || runDir === "" || extra.length > 0) {
    throw new UsageError(`expected exactly one <run-dir>\n\n${RUN_SHOW_USAGE}`);
  }
  const located = await resolveTarget(runDir);
  if (!located.ok) return rejected(located.reason, located.message, [], 3);
  const result = readSnapshot(located.runDir, {
    verifyArtifacts: values["verify-artifacts"] === true,
  });
  if (result.ok) {
    console.log(JSON.stringify({ outcome: "snapshot", snapshot: result.snapshot }));
    return 0;
  }
  console.log(
    JSON.stringify({
      outcome: "rejected",
      reason: result.reason,
      message: result.message,
      ...(result.line !== undefined ? { line: result.line } : {}),
    }),
  );
  return 3;
}

function count(value: string, flag: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new UsageError(`${flag} must be an integer >= 1`);
  return Number(value);
}
