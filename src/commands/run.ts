import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { resolveConfiguration } from "../config/resolve.js";
import { sha256Hex } from "../contracts/canonical-json.js";
import { isId, isPlainObject } from "../contracts/envelope.js";
import { claimHost } from "../host/claim.js";
import { entryExists, writeExclusiveFile } from "../host/files.js";
import { LAUNCH_FILE, launchInPane, readLaunchRequest, runDirOccupied } from "../host/launch.js";
import { openWatchPane } from "../host/watch-pane.js";
import {
  OUTCOME_FILE,
  hostWorkflow,
  type HostWorkflowOptions,
  type HostWorkflowResult,
  type RuntimeFactory,
} from "../host/run.js";
import type { RuntimeAdapter } from "../runtime/adapter.js";
import { createHerdrCliRuntime } from "../runtime/herdr/adapter.js";
import { loadModuleDefault } from "../scheduler/loader.js";
import {
  MAX_INPUT_BYTES,
  UsageError,
  milliseconds,
  parse,
  readInputFile,
  readStdin,
  rejected,
  required,
} from "./common.js";

export const RUN_START_USAGE = `Usage: woof run start --input <path|-> [--workflow <name>] [--project <dir>] [--run-id <id>]
                      [--run-dir <dir> | --runs-dir <dir>] [--host herdr-pane|foreground]
                      [--poll-ms <n>] [--keep-panes|--no-keep-panes] [--host-start-timeout-ms <n>]
                      [--split-from <pane-id>] [--runtime-module <path>] [--watch]

Starts a workflow run. The workflow is --workflow, else the configured default,
else build-review. Built in: build-review (build, verify, review, repair) and
plan-build-review (the same with a planner ahead of it, whose plan.md every
builder turn receives as an input); a project or user
.woof/workflows/<name>.{mjs,js,ts} defines any other. Configuration comes from
<project>/.woof and ~/.woof (see woof config show), and the run records what it
resolved in config.json.
--project defaults to the working directory; the input's repository must be
that project's git top level. The run directory is --run-dir, else
<runs-dir>/<run-id> (default ~/.woof/runs).

--host herdr-pane (default) needs HERDR_ENV=1 and HERDR_PANE_ID (or
--split-from): it runs the scheduler in a new Herdr pane next to this one and
returns once that host has opened the run, printing {"outcome":"started"} with
the run directory; follow it with woof status <run-dir> --wait.
--host foreground runs the scheduler in this process and prints
{"outcome":"run","result"} when the run ends.
--watch (herdr-pane only): once the host opened the run, splits a pane below
the host running woof watch <run-dir> --follow and adds "watch" ({paneId,
command}, or {problem} when that pane could not be opened) to the output. The
watch pane stays open after the run unless --no-keep-panes is given. Refused
(exit 2) with --host foreground or outside Herdr.

Exits 0 started (or completed in the foreground), 4 failed, 5 exhausted,
6 cancelled, 2 rejected before launch, 3 runtime, host or journal failure
(host_pane_failed, host_not_started, host_unresponsive), 1 usage.`;

export const RUN_HOST_USAGE = `Usage: woof run host <run-dir>

Internal and unstable: hosts the run described by <run-dir>/launch.json in this
process. woof run start types this command into the Herdr pane it opens.`;

export const RUN_BUILD_REVIEW_USAGE = `Usage: woof run build-review --input <path|-> --run-dir <dir> [--run-id <id>]
                             [--poll-ms <n>] [--keep-panes] [--runtime-module <path>]

Runs the built-in build-review workflow in the foreground: build, verify (when
the input names a command), review and repair until a review passes on the
repaired tree or a limit ends the run. Agents start in Herdr panes next to this
one (HERDR_ENV=1 and HERDR_PANE_ID are required). --run-dir must not hold a run.
--runtime-module loads a module whose default export createRuntime(context)
returns a runtime adapter instead of Herdr (unstable, for tests). Progress goes
to stderr; stdout gets one JSON line. Exits 0 completed, 4 failed, 5 exhausted,
6 cancelled, 2 rejected before launch, 3 runtime or journal failure, 1 usage.
Same as woof run start --workflow build-review --host foreground, with the
input's repository as the project.`;

/** Every RuntimeAdapter method a `--runtime-module` factory result must provide. */
const RUNTIME_METHODS = [
  "openPane",
  "startAgent",
  "observe",
  "waitFor",
  "deliver",
  "stop",
] as const;

export const cliPath = join(dirname(dirname(fileURLToPath(import.meta.url))), "cli.js");

export async function runStartCommand(args: string[]): Promise<number> {
  const { values } = parse(
    () =>
      parseArgs({
        args,
        strict: true,
        allowPositionals: false,
        options: {
          input: { type: "string" },
          workflow: { type: "string" },
          project: { type: "string" },
          "run-id": { type: "string" },
          "run-dir": { type: "string" },
          "runs-dir": { type: "string" },
          host: { type: "string" },
          "poll-ms": { type: "string" },
          "keep-panes": { type: "boolean" },
          "no-keep-panes": { type: "boolean" },
          "host-start-timeout-ms": { type: "string" },
          "split-from": { type: "string" },
          "runtime-module": { type: "string" },
          watch: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      }),
    RUN_START_USAGE,
  );
  if (values.help === true) {
    console.log(RUN_START_USAGE);
    return 0;
  }
  const inputArg = required(values.input, "--input", RUN_START_USAGE);
  const host = values.host ?? "herdr-pane";
  if (host !== "herdr-pane" && host !== "foreground")
    throw new UsageError(`--host must be herdr-pane or foreground\n\n${RUN_START_USAGE}`);
  if (values.workflow !== undefined && !isId(values.workflow))
    throw new UsageError(`--workflow must be a valid id\n\n${RUN_START_USAGE}`);
  if (values["run-dir"] !== undefined && values["runs-dir"] !== undefined)
    throw new UsageError(`--run-dir and --runs-dir cannot be combined\n\n${RUN_START_USAGE}`);
  if (values["keep-panes"] === true && values["no-keep-panes"] === true)
    throw new UsageError(
      `--keep-panes and --no-keep-panes cannot be combined\n\n${RUN_START_USAGE}`,
    );
  const runId = values["run-id"] ?? defaultRunId(values.workflow);
  if (!isId(runId)) throw new UsageError(`--run-id must be a valid id\n\n${RUN_START_USAGE}`);
  const flags = {
    ...(values["poll-ms"] !== undefined
      ? { pollMs: milliseconds(values["poll-ms"], "--poll-ms", 1) }
      : {}),
    ...(values["keep-panes"] === true ? { keepPanes: true } : {}),
    ...(values["no-keep-panes"] === true ? { keepPanes: false } : {}),
    ...(values["host-start-timeout-ms"] !== undefined
      ? {
          hostStartTimeoutMs: milliseconds(
            values["host-start-timeout-ms"],
            "--host-start-timeout-ms",
            1000,
            600_000,
          ),
        }
      : {}),
    ...(values["runs-dir"] !== undefined ? { runsDir: resolve(values["runs-dir"]) } : {}),
  };
  const runtimeModule =
    values["runtime-module"] !== undefined ? resolve(values["runtime-module"]) : undefined;
  const projectDir = resolve(values.project ?? process.cwd());
  const runDir = values["run-dir"] !== undefined ? resolve(values["run-dir"]) : undefined;

  const watch = values.watch === true;
  const paneId = nonEmpty(process.env["HERDR_PANE_ID"]);
  const splitFrom = values["split-from"] ?? (paneId !== undefined ? "current" : undefined);
  // Refused before any input is read, any Herdr call is made or any run directory exists.
  if (watch && host === "foreground")
    return rejected(
      "watch_unavailable",
      "--watch needs --host herdr-pane inside Herdr; --host foreground has no pane to split",
      [],
      2,
    );
  if (watch && (process.env["HERDR_ENV"] !== "1" || splitFrom === undefined))
    return rejected(
      "watch_unavailable",
      "--watch needs a Herdr pane (HERDR_ENV=1 and HERDR_PANE_ID, or --split-from <pane-id>)",
      [],
      2,
    );

  if (host === "herdr-pane") {
    if (process.env["HERDR_ENV"] !== "1" || splitFrom === undefined) {
      return rejected(
        "runtime_unavailable",
        "woof run start --host herdr-pane needs a Herdr pane (HERDR_ENV=1 and HERDR_PANE_ID, or --split-from <pane-id>); use --host foreground to run the scheduler in this process",
        [],
        3,
      );
    }
    const input = await readWorkflowInput(inputArg);
    if (!input.ok) return rejected("input_invalid", input.message, [], 2);
    const launched = await launchInPane({
      runId,
      ...(runDir !== undefined ? { runDir } : {}),
      ...(values.workflow !== undefined ? { workflow: values.workflow } : {}),
      projectDir,
      input: input.value,
      flags: { ...flags, ...(runtimeModule !== undefined ? { runtimeModule } : {}) },
      splitFrom,
      launcherPaneId: paneId ?? null,
      herdrBin: herdrBin(),
      env: process.env,
      nodePath: process.execPath,
      cliPath,
    });
    const hostPaneId = hostPaneOf(launched.output);
    if (
      watch &&
      launched.code === 0 &&
      launched.output["outcome"] === "started" &&
      hostPaneId !== undefined
    ) {
      const opened = await openWatchPane({
        runDir: String(launched.output["runDir"]),
        hostPaneId,
        cwd: projectDir,
        // Only an explicit --no-keep-panes closes the watch pane; the resolved default does not.
        closeOnEnd: values["no-keep-panes"] === true,
        herdrBin: herdrBin(),
        env: process.env,
        nodePath: process.execPath,
        cliPath,
      });
      console.log(JSON.stringify({ ...launched.output, watch: opened }));
      return launched.code;
    }
    console.log(JSON.stringify(launched.output));
    return launched.code;
  }

  const input = await readWorkflowInput(inputArg);
  if (!input.ok) return rejected("input_invalid", input.message, [], 2);
  let foregroundRunDir = runDir;
  if (foregroundRunDir === undefined) {
    const resolved = await resolveConfiguration({ projectDir, flags });
    if (!resolved.ok) return rejected(resolved.reason, resolved.message, resolved.details, 2);
    const runsDir = resolved.configuration.settings.runsDir.value;
    foregroundRunDir = join(runsDir, runId);
    try {
      mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      // An unwritable or file-occupied runs directory is an infrastructure rejection, never a throw.
      return rejected(
        "journal_write_failed",
        `cannot create the runs directory ${runsDir}: ${(error as Error).message}`,
        [],
        3,
      );
    }
  }
  return foreground({
    runDir: foregroundRunDir,
    runId,
    ...(values.workflow !== undefined ? { workflow: values.workflow } : {}),
    projectDir,
    input: input.value,
    flags,
    runtimeModule,
  });
}

export async function runBuildReviewCommand(args: string[]): Promise<number> {
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
  const runId = values["run-id"] ?? defaultRunId("build-review");
  if (!isId(runId))
    throw new UsageError(`--run-id must be a valid id\n\n${RUN_BUILD_REVIEW_USAGE}`);
  const pollMs =
    // At least 1 ms: a zero poll would spin the scheduler (SDK callers may still pass 0).
    values["poll-ms"] === undefined ? undefined : milliseconds(values["poll-ms"], "--poll-ms", 1);
  const input = await readWorkflowInput(inputArg);
  if (!input.ok) return rejected("input_invalid", input.message, [], 2);
  // The project is the input's repository when it names an existing directory.
  const repo = isPlainObject(input.value) ? input.value["repo"] : undefined;
  return foreground({
    runDir,
    runId,
    workflow: "build-review",
    projectDir: typeof repo === "string" && repo.startsWith("/") && isDirectory(repo) ? repo : null,
    input: input.value,
    flags: {
      ...(pollMs !== undefined ? { pollMs } : {}),
      ...(values["keep-panes"] === true ? { keepPanes: true } : {}),
    },
    runtimeModule:
      values["runtime-module"] !== undefined ? resolve(values["runtime-module"]) : undefined,
  });
}

export async function runHostCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(
    () =>
      parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: { help: { type: "boolean", short: "h" } },
      }),
    RUN_HOST_USAGE,
  );
  if (values.help === true) {
    console.log(RUN_HOST_USAGE);
    return 0;
  }
  const [target, ...extra] = positionals;
  if (target === undefined || target === "" || extra.length > 0)
    throw new UsageError(`expected exactly one <run-dir>\n\n${RUN_HOST_USAGE}`);
  const runDir = resolve(target);
  const paneId = nonEmpty(process.env["HERDR_PANE_ID"]) ?? null;
  // Between the claim and hostWorkflow installing its own handlers, a SIGINT/SIGTERM must not end the
  // process by its default action with the claim still hosting. These listeners replace that default;
  // the handoff below is synchronous, so a signal that arrives meanwhile is emitted only after
  // hostWorkflow has installed its handlers, which finalize host_interrupted (PR #6).
  process.on("SIGINT", deferSignal);
  process.on("SIGTERM", deferSignal);
  let hosted: Promise<HostWorkflowResult>;
  try {
    const claim = claimHost(runDir, {
      paneId,
      workspaceId: nonEmpty(process.env["HERDR_WORKSPACE_ID"]) ?? null,
    });
    if (!claim.ok) {
      const refused = {
        outcome: "rejected",
        reason: claim.reason,
        message: claim.message,
        details: [],
      };
      if (claim.reason === "run_host_claimed") {
        console.log(JSON.stringify(refused));
        return 2;
      }
      // Failure handoff (PR #6): this host could not claim and holds nothing. An outcome.json bound to
      // the launch tells the launcher at once, instead of after its host-start timeout; the launcher
      // then closes the run directory.
      const launch = launchDigestOf(runDir);
      const output = launch === null ? refused : { ...refused, launch };
      if (launch !== null) {
        try {
          writeExclusiveFile(
            join(runDir, OUTCOME_FILE),
            Buffer.from(`${JSON.stringify(output)}\n`),
            0o444,
          );
        } catch {
          // Another outcome is already there: the launcher falls back to its timeout.
        }
      }
      console.log(JSON.stringify(output));
      return 3;
    }
    pauseAfterClaim();
    const launch = launchDigestOf(runDir);
    const request = readLaunchRequest(runDir);
    if (typeof request === "string") {
      const output = {
        outcome: "rejected",
        reason: "launch_invalid",
        message: request,
        details: [],
        ...(launch !== null ? { launch } : {}),
      };
      try {
        if (!entryExists(join(runDir, OUTCOME_FILE)))
          writeExclusiveFile(
            join(runDir, OUTCOME_FILE),
            Buffer.from(`${JSON.stringify(output)}\n`),
            0o444,
          );
      } finally {
        claim.release(3);
      }
      console.log(JSON.stringify(output));
      return 3;
    }
    const { runtimeModule, ...flags } = request.flags;
    hosted = hostWorkflow({
      ...baseHostOptions(runtimeModule),
      runDir,
      runId: request.runId,
      ...(request.workflow !== null ? { workflow: request.workflow } : {}),
      projectDir: request.projectDir,
      input: request.input,
      flags,
      claimBeforeOpen: false,
      release: claim.release,
      writeOutcome: true,
      launch,
      paneId,
    });
  } finally {
    process.off("SIGINT", deferSignal);
    process.off("SIGTERM", deferSignal);
  }
  const result = await hosted;
  console.log(JSON.stringify(result.output));
  return result.code;
}

/** The digest of the launch request as the claimed host reads it; null when it cannot be read. */
function launchDigestOf(runDir: string): { sha256: string } | null {
  try {
    return { sha256: sha256Hex(readFileSync(join(runDir, LAUNCH_FILE))) };
  } catch {
    return null;
  }
}

/** Replaces the default SIGINT/SIGTERM termination during the claim handoff; hostWorkflow handles the signal. */
function deferSignal(): void {}

/** Unstable test seam: `woof run host` waits this many milliseconds (1–10 000), synchronously, right after its claim. */
const CLAIM_HANDOFF_ENV = "WOOF_TEST_CLAIM_HANDOFF_MS";

function pauseAfterClaim(): void {
  const raw = process.env[CLAIM_HANDOFF_ENV];
  if (raw === undefined || !/^[1-9][0-9]{0,4}$/.test(raw)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(Number(raw), 10_000));
}

async function foreground(options: {
  runDir: string;
  runId: string;
  workflow?: string;
  projectDir: string | null;
  input: unknown;
  flags: HostWorkflowOptions["flags"];
  runtimeModule: string | undefined;
}): Promise<number> {
  const occupied = runDirOccupied(options.runDir);
  if (occupied !== undefined) return rejected("run_exists", occupied, [], 2);
  const result = await hostWorkflow({
    ...baseHostOptions(options.runtimeModule),
    runDir: options.runDir,
    runId: options.runId,
    ...(options.workflow !== undefined ? { workflow: options.workflow } : {}),
    projectDir: options.projectDir,
    input: options.input,
    flags: options.flags,
    claimBeforeOpen: true,
    writeOutcome: false,
    paneId: nonEmpty(process.env["HERDR_PANE_ID"]) ?? null,
  });
  console.log(JSON.stringify(result.output));
  return result.code;
}

function baseHostOptions(runtimeModule: string | undefined) {
  const hostPaneId = nonEmpty(process.env["HERDR_PANE_ID"]);
  return {
    createRuntime: runtimeFactory(runtimeModule),
    submitCommand: [process.execPath, cliPath],
    workspaceId: nonEmpty(process.env["HERDR_WORKSPACE_ID"]) ?? null,
    metadata:
      process.env["HERDR_ENV"] === "1" && hostPaneId !== undefined
        ? { bin: herdrBin(), env: process.env, hostPaneId }
        : null,
    log: (line: string) => console.error(`woof: ${line}`),
  };
}

function runtimeFactory(runtimeModule: string | undefined): RuntimeFactory {
  return async (context) => {
    if (runtimeModule === undefined) {
      const paneId = process.env["HERDR_PANE_ID"];
      if (process.env["HERDR_ENV"] !== "1" || paneId === undefined || paneId === "") {
        return {
          ok: false,
          message:
            "woof run build-review needs a Herdr pane (HERDR_ENV=1 and HERDR_PANE_ID) or --runtime-module",
        };
      }
      return { ok: true, runtime: createHerdrCliRuntime({ bin: herdrBin() }) };
    }
    const loaded = await loadModuleDefault(runtimeModule);
    if (!loaded.ok) return { ok: false, message: loaded.message };
    if (typeof loaded.value !== "function")
      return { ok: false, message: `${loaded.path} has no default createRuntime function` };
    let runtime: RuntimeAdapter;
    try {
      runtime = (await (
        loaded.value as (context: unknown) => Promise<RuntimeAdapter> | RuntimeAdapter
      )(context)) as RuntimeAdapter;
    } catch (error) {
      return { ok: false, message: `createRuntime failed: ${(error as Error).message}` };
    }
    // The factory result must be a RuntimeAdapter before any run is opened.
    const candidate = runtime as unknown as Record<string, unknown> | null;
    const missing =
      candidate === null || typeof candidate !== "object"
        ? ["adapter", ...RUNTIME_METHODS]
        : [
            ...(candidate["adapter"] === "herdr" || candidate["adapter"] === "scripted"
              ? []
              : ['adapter ("herdr" | "scripted")']),
            ...RUNTIME_METHODS.filter((name) => typeof candidate[name] !== "function"),
          ];
    if (missing.length > 0) {
      return {
        ok: false,
        message: `${loaded.path} createRuntime returned no RuntimeAdapter (missing or invalid: ${missing.join(", ")})`,
      };
    }
    return { ok: true, runtime };
  };
}

export async function readWorkflowInput(
  inputArg: string,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  try {
    const bytes = inputArg === "-" ? await readStdin(MAX_INPUT_BYTES) : readInputFile(inputArg);
    if (bytes.byteLength > MAX_INPUT_BYTES)
      throw new Error(`input is larger than ${MAX_INPUT_BYTES} bytes`);
    return { ok: true, value: JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown };
  } catch (error) {
    return { ok: false, message: `cannot read the workflow input: ${(error as Error).message}` };
  }
}

/** The Herdr executable: WOOF_HERDR_BIN (an unstable test seam) or herdr on PATH. */
export function herdrBin(): string {
  return nonEmpty(process.env["WOOF_HERDR_BIN"]) ?? "herdr";
}

export function defaultRunId(workflow: string | undefined): string {
  const stamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const prefix =
    workflow === undefined || workflow === "build-review" ? "br" : workflow.slice(0, 24);
  return `${prefix}-${stamp}-${randomBytes(3).toString("hex")}`;
}

function hostPaneOf(output: Record<string, unknown>): string | undefined {
  const host = output["host"];
  const paneId = isPlainObject(host) ? host["paneId"] : undefined;
  return typeof paneId === "string" && paneId !== "" ? paneId : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
