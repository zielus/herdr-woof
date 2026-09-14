#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { MAX_ENVELOPE_BYTES, isId, type RejectionDetail } from "./contracts/envelope.js";
import { isInfraReason } from "./contracts/reasons.js";
import type { RuntimeAdapter } from "./runtime/adapter.js";
import { createHerdrCliRuntime } from "./runtime/herdr/adapter.js";
import { admitWorkflow } from "./scheduler/admission.js";
import type { Action } from "./scheduler/core.js";
import { validateWorkflowDefinition } from "./scheduler/definition.js";
import { runWorkflow } from "./scheduler/driver.js";
import { loadModuleDefault } from "./scheduler/loader.js";
import { readSnapshot } from "./state/snapshot.js";
import { openRun, terminateRun } from "./state/store.js";
import { openAttempt } from "./submission/attempt.js";
import { submitResult } from "./submission/submit.js";
import { VERSION } from "./version.js";
import { buildReviewWorkflow } from "./workflows/build-review.js";

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

const RUN_SHOW_USAGE = `Usage: woof run show <run-dir> [--verify-artifacts]

Prints one JSON line with a snapshot of the run journal in <run-dir>. It takes
no journal lock, never contacts Herdr and works on terminated runs.
--verify-artifacts re-hashes every accepted copy against its journal record.
Exits 0 with the snapshot. Exits 3 with a rejection (outcome "rejected") when
the run directory has no journal or records (run_dir_invalid), the journal is
corrupt (journal_corrupt), or its line 1 changed during each of three
consecutive reads (journal_replaced).`;

const RUN_BUILD_REVIEW_USAGE = `Usage: woof run build-review --input <path|-> --run-dir <dir> [--run-id <id>]
                             [--poll-ms <n>] [--keep-panes] [--runtime-module <path>]

Runs the built-in build-review workflow in the foreground: build, verify (when
the input names a command), review and repair until a review passes on the
repaired tree or a limit ends the run. Agents start in Herdr panes next to this
one (HERDR_ENV=1 and HERDR_PANE_ID are required). --run-dir must not hold a run.
--runtime-module loads a module whose default export createRuntime(context)
returns a runtime adapter instead of Herdr (unstable, for tests). Progress goes
to stderr; stdout gets one JSON line. Exits 0 completed, 4 failed, 5 exhausted,
6 cancelled, 2 rejected before launch, 3 runtime or journal failure, 1 usage.`;

const RUN_CANCEL_USAGE = `Usage: woof run cancel <run-dir> [--reason <text>]

Records that the run in <run-dir> is cancelled. A scheduler still running it
stops at its next tick; late submissions are refused. Prints one JSON line;
exits 0 when recorded, 2 when the run is already terminated, 3 on journal failure.`;

/** Largest workflow input read from a file or stdin, in bytes. */
const MAX_INPUT_BYTES = 1024 * 1024;

const OUTCOME_EXIT_CODES = { completed: 0, failed: 4, exhausted: 5, cancelled: 6 } as const;
/** Every RuntimeAdapter method a `--runtime-module` factory result must provide. */
const RUNTIME_METHODS = [
  "openPane",
  "startAgent",
  "observe",
  "waitFor",
  "deliver",
  "stop",
] as const;

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
    case "run":
      if (args[0] === "show") return runShowCommand(args.slice(1));
      if (args[0] === "build-review") return runBuildReviewCommand(args.slice(1));
      if (args[0] === "cancel") return runCancelCommand(args.slice(1));
      throw new UsageError(
        `expected "run show", "run build-review" or "run cancel"\n\n${RUN_SHOW_USAGE}\n\n${RUN_BUILD_REVIEW_USAGE}\n\n${RUN_CANCEL_USAGE}`,
      );
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
  console.log("  run show      Print a JSON snapshot of a run journal (read-only)");
  console.log("");
  console.log("Workflows (unstable):");
  console.log("  run build-review  Run the build-review workflow with agents in Herdr panes");
  console.log("  run cancel        Cancel a run recorded in a run directory");
}

async function runBuildReviewCommand(args: string[]): Promise<number> {
  const { values } = parse(
    () =>
      parseArgs({
        args,
        strict: true,
        allowPositionals: false,
        options: {
          input: { type: "string" },
          "run-dir": { type: "string" },
          "run-id": { type: "string" },
          "poll-ms": { type: "string" },
          "keep-panes": { type: "boolean" },
          "runtime-module": { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      }),
    RUN_BUILD_REVIEW_USAGE,
  );
  if (values.help === true) {
    console.log(RUN_BUILD_REVIEW_USAGE);
    return 0;
  }
  const inputArg = required(values.input, "--input", RUN_BUILD_REVIEW_USAGE);
  const runDir = resolve(required(values["run-dir"], "--run-dir", RUN_BUILD_REVIEW_USAGE));
  const runId = values["run-id"] ?? defaultRunId();
  if (!isId(runId))
    throw new UsageError(`--run-id must be a valid id\n\n${RUN_BUILD_REVIEW_USAGE}`);
  const pollMs =
    // At least 1 ms: a zero poll would spin the scheduler (SDK callers may still pass 0).
    values["poll-ms"] === undefined ? 1000 : milliseconds(values["poll-ms"], "--poll-ms", 1);

  // Admission: nothing is launched and nothing is written until the run opens.
  const definition = validateWorkflowDefinition(buildReviewWorkflow);
  if (!definition.ok) {
    return rejected(
      "definition_invalid",
      "the built-in definition is invalid",
      definition.details,
      2,
    );
  }
  let raw: unknown;
  try {
    const bytes = inputArg === "-" ? await readStdin(MAX_INPUT_BYTES) : readInputFile(inputArg);
    if (bytes.byteLength > MAX_INPUT_BYTES)
      throw new Error(`input is larger than ${MAX_INPUT_BYTES} bytes`);
    raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    return rejected(
      "input_invalid",
      `cannot read the workflow input: ${(error as Error).message}`,
      [],
      2,
    );
  }
  const admitted = await admitWorkflow({ definition: definition.definition, input: raw, runDir });
  if (!admitted.ok) return rejected(admitted.reason, admitted.message, admitted.details, 2);

  let runtime: RuntimeAdapter;
  const runtimeModule = values["runtime-module"];
  if (runtimeModule !== undefined) {
    const loaded = await loadModuleDefault(runtimeModule);
    if (!loaded.ok) return rejected("runtime_unavailable", loaded.message, [], 3);
    if (typeof loaded.value !== "function") {
      return rejected(
        "runtime_unavailable",
        `${loaded.path} has no default createRuntime function`,
        [],
        3,
      );
    }
    try {
      runtime = (await (
        loaded.value as (context: unknown) => Promise<RuntimeAdapter> | RuntimeAdapter
      )({
        runDir,
        runId,
        plan: admitted.plan,
        repo: admitted.repository,
      })) as RuntimeAdapter;
    } catch (error) {
      return rejected(
        "runtime_unavailable",
        `createRuntime failed: ${(error as Error).message}`,
        [],
        3,
      );
    }
    // The factory result must be a RuntimeAdapter before any run is opened.
    const candidate = runtime as unknown as Record<string, unknown> | null;
    const missing =
      candidate === null || typeof candidate !== "object"
        ? ["adapter", ...RUNTIME_METHODS]
        : [
            ...(typeof candidate["adapter"] === "string" ? [] : ["adapter"]),
            ...RUNTIME_METHODS.filter((name) => typeof candidate[name] !== "function"),
          ];
    if (missing.length > 0) {
      return rejected(
        "runtime_unavailable",
        `${loaded.path} createRuntime returned no RuntimeAdapter (missing or invalid: ${missing.join(", ")})`,
        [],
        3,
      );
    }
  } else {
    const paneId = process.env["HERDR_PANE_ID"];
    if (process.env["HERDR_ENV"] !== "1" || paneId === undefined || paneId === "") {
      return rejected(
        "runtime_unavailable",
        "woof run build-review needs a Herdr pane (HERDR_ENV=1 and HERDR_PANE_ID) or --runtime-module",
        [],
        3,
      );
    }
    runtime = createHerdrCliRuntime({ bin: "herdr" });
  }

  const opened = await openRun({ runDir, runId, plan: admitted.plan, input: raw });
  if (opened.outcome === "rejected") {
    return rejected(
      opened.reason,
      opened.message,
      opened.details,
      isInfraReason(opened.reason) ? 3 : 2,
    );
  }

  const controller = new AbortController();
  let signals = 0;
  const onSignal = () => {
    signals += 1;
    // A second signal exits at once without writing anything.
    if (signals > 1) process.exit(130);
    console.error("woof: cancelling the run (send the signal again to exit without recording)");
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  console.error(`woof: run ${runId} in ${runDir}`);
  let lastWait = "";
  const out = await runWorkflow({
    runDir,
    definition: definition.definition,
    input: admitted.input,
    repository: admitted.repository,
    runtime,
    submitCommand: [process.execPath, fileURLToPath(import.meta.url)],
    signal: controller.signal,
    pollMs,
    keepPanes: values["keep-panes"] === true,
    onAction: (action) => {
      const line = describeAction(action);
      if (action.type === "wait" && line === lastWait) return;
      lastWait = action.type === "wait" ? line : "";
      console.error(`woof: ${line}`);
    },
  });
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  if (out.error !== null || out.result === null) {
    console.log(
      JSON.stringify({
        outcome: "rejected",
        reason: out.error?.reason ?? "engine_invariant",
        message: out.error?.message ?? "the run ended without a result",
        details: [],
        result: out.result,
      }),
    );
    return 3;
  }
  console.log(JSON.stringify({ outcome: "run", result: out.result }));
  return OUTCOME_EXIT_CODES[out.result.outcome];
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
  const outcome = await terminateRun({
    runDir: resolve(runDir),
    outcome: "cancelled",
    reason: values.reason ?? "cancelled via woof run cancel",
  });
  console.log(JSON.stringify(outcome));
  if (outcome.outcome === "recorded") return 0;
  return isInfraReason(outcome.reason) ? 3 : 2;
}

function describeAction(action: Action): string {
  switch (action.type) {
    case "wait":
      return `waiting (${action.reason}${action.observe !== null ? `, ${action.observe}` : ""})`;
    case "dispatch":
      return `dispatch ${action.stageId} visit ${action.visit} attempt ${action.attempt} (${action.cause}) to ${action.agentId}`;
    case "terminate":
      return `terminate ${action.outcome}${action.limit !== undefined ? ` (${action.limit})` : ""}: ${action.reason}`;
    case "record_gate":
      return `gate ${action.gate.gate} ${action.gate.decision} (${action.gate.reason})`;
    case "start_agent":
    case "block":
    case "unblock":
      return `${action.type.replace("_", " ")} ${action.agentId}`;
    case "run_check":
      return `check ${action.gate}: ${action.argv.join(" ")}`;
    case "compute_revision":
      return `revision for ${action.gate}`;
    case "reconcile":
      return `reconcile ${action.stageId} attempt ${action.attempt}: ${action.resolution}`;
    case "settle":
      return "run ended";
  }
}

function rejected(
  reason: string,
  message: string,
  details: RejectionDetail[],
  code: number,
): number {
  console.log(JSON.stringify({ outcome: "rejected", reason, message, details }));
  return code;
}

function readInputFile(path: string): Uint8Array {
  const size = statSync(path).size;
  if (size > MAX_INPUT_BYTES) throw new Error(`${path} is larger than ${MAX_INPUT_BYTES} bytes`);
  return readFileSync(path);
}

function defaultRunId(): string {
  const stamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `br-${stamp}-${randomBytes(3).toString("hex")}`;
}

function milliseconds(value: string, flag: string, min = 0): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) < min || Number(value) > 3_600_000) {
    throw new UsageError(`${flag} must be an integer between ${min} and 3600000`);
  }
  return Number(value);
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

function runShowCommand(args: string[]): number {
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
  const result = readSnapshot(resolve(runDir), {
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

/**
 * Reads file descriptor 0 through the stdin stream, stopping one chunk past
 * `limit` (MAX_ENVELOPE_BYTES for envelopes) so the caller can report the size. The
 * stdin device is never opened by path: on Linux that fails with ENXIO when
 * stdin is a socket, as it is for many process spawners.
 */
async function readStdin(limit = MAX_ENVELOPE_BYTES): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
      chunks.push(buffer);
      size += buffer.byteLength;
      if (size > limit) break;
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
