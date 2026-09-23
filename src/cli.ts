#!/usr/bin/env node
import { parseArgs } from "node:util";

import { UsageError, parse, readStdin, rejected, required } from "./commands/common.js";
import { configCommand } from "./commands/config.js";
import { doctorCommand } from "./commands/doctor.js";
import { eventsCommand } from "./commands/events.js";
import { herdrCommand } from "./commands/herdr.js";
import {
  RUN_HOST_USAGE,
  RUN_START_USAGE,
  runHostCommand,
  runStartCommand,
} from "./commands/run.js";
import { runsCommand } from "./commands/runs.js";
import { statusCommand } from "./commands/status.js";
import { TARGET_HELP, resolveTarget } from "./commands/target.js";
import { tuiCommand } from "./commands/tui.js";
import { watchCommand } from "./commands/watch.js";
import { isInfraReason } from "./contracts/reasons.js";
import { cancelRun } from "./state/store.js";
import { submitResult } from "./submission/submit.js";
import { VERSION } from "./version.js";

const SUBMIT_USAGE = `Usage: woof submit --envelope <path|-> [--run-dir <dir>]

Validates a result envelope and its artifact and records the outcome in the run
journal. --run-dir defaults to WOOF_RUN_DIR. When HERDR_PANE_ID is set it must
match the pane the attempt was opened for. Prints one JSON line; exits 0 when
accepted or duplicate, 2 when rejected, 3 on run directory or journal failure.`;

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
    case "tui":
      return tuiCommand(args);
    case "herdr":
      return herdrCommand(args);
    case "submit":
      return submitCommand(args);
    case "run":
      if (args[0] === "start") return runStartCommand(args.slice(1));
      if (args[0] === "host") return runHostCommand(args.slice(1));
      if (args[0] === "cancel") return runCancelCommand(args.slice(1));
      throw new UsageError(
        `expected "run start", "run cancel" or "run host"\n\n${RUN_START_USAGE}\n\n${RUN_CANCEL_USAGE}\n\n${RUN_HOST_USAGE}`,
      );
    default:
      console.error(`woof: unknown command ${JSON.stringify(commandName)}; see woof --help`);
      return 1;
  }
}

function printHelp(): void {
  console.log("Usage: woof <command>");
  console.log("");
  console.log("Workflows (unstable):");
  console.log(
    "  run start     Start a workflow run: the one way to run a workflow; inside Herdr it returns",
  );
  console.log("                at once and the run host pushes [woof] messages into your pane;");
  console.log("                --host foreground (tests, CI) stays attached until the run ends");
  console.log("  run cancel    Cancel a run");
  console.log("  run host      Host a launched run in this process (internal; run start uses it)");
  console.log(
    "  submit        Validate an agent's result envelope and record it in the run journal",
  );
  console.log("");
  console.log("Inspection (read-only):");
  console.log("  status        Print a snapshot of a run's status and owner liveness");
  console.log("  runs          List the runs under the runs directory");
  console.log("  events        Print a run's lifecycle events as NDJSON; --follow to keep reading");
  console.log(
    "  watch         Follow a run in plain English (--plain for event lines); --follow to keep reading",
  );
  console.log(
    "  tui           Browse the project's runs interactively: steps, activity, config, artifacts",
  );
  console.log("");
  console.log("Setup:");
  console.log("  doctor        Report Herdr and Claude Code availability");
  console.log("  config show   Print the effective configuration and where each value came from");
  console.log("");
  console.log("Herdr plugin actions (unstable; project from HERDR_PLUGIN_CONTEXT_JSON):");
  console.log("  herdr status  Notify the focused project's active runs");
  console.log("  herdr cancel  Cancel the focused project's single active run");
  console.log(
    "  herdr watch   Open a plugin pane following the focused project's single active run",
  );
  console.log(
    "  herdr doctor  Check Woof, Herdr, Claude Code, trust and config for the focused project",
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
