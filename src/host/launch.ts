import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { admissionConfiguration, builtinWorkflowDefinition } from "../config/record.js";
import {
  resolveConfiguration,
  type ConfigFlags,
  type ResolvedConfiguration,
} from "../config/resolve.js";
import { isId, isPlainObject } from "../contracts/envelope.js";
import { execHerdr } from "../runtime/herdr/exec.js";
import { admitWorkflow } from "../scheduler/admission.js";
import { validateWorkflowDefinition } from "../scheduler/definition.js";
import { readSnapshot } from "../state/snapshot.js";
import { abandonHost } from "./claim.js";
import { entryExists, readJsonFile, shellQuote, writeExclusiveFile } from "./files.js";
import { HOST_EXIT_FILE, HOST_FILE, readHostInfo } from "./probe.js";
import { OUTCOME_FILE, isHostInfraReason } from "./run.js";

/**
 * `woof run start --host herdr-pane` (p4 D1, §3.7): pre-admit a built-in
 * workflow in memory, write a launch request into the run directory, split a
 * Herdr pane and run `woof run host <run-dir>` there, then return once that
 * host has claimed and opened the run (or has written a rejection). A host
 * that never claims within `hostStartTimeoutMs` is closed out with an
 * abandoned claim, so it can never start an unobserved run later.
 */

export const LAUNCH_FILE = "launch.json";
const JOURNAL_FILE = "journal.jsonl";
const LAUNCH_POLL_MS = 100;
const PANE_COMMAND_TIMEOUT_MS = 10_000;

export interface LaunchFlags extends ConfigFlags {
  /** Absolute path of a `--runtime-module` (unstable, for tests). */
  runtimeModule?: string;
}

export interface LaunchRequest {
  schemaVersion: 1;
  kind: "woof.launch";
  workflow: string | null;
  projectDir: string | null;
  input: unknown;
  flags: LaunchFlags;
  runId: string;
  requestedAt: string;
  launcher: { pid: number; paneId: string | null };
}

/** Why a run directory cannot take a new run, or undefined when it can. */
export function runDirOccupied(runDir: string): string | undefined {
  // Any entry at a reserved path occupies the directory, even an empty journal: `run start`
  // never adopts one (the SDK's openRun keeps its own empty-journal tolerance).
  for (const name of [JOURNAL_FILE, HOST_FILE, HOST_EXIT_FILE, LAUNCH_FILE]) {
    if (entryExists(join(runDir, name))) return `${runDir} already holds a run (${name})`;
  }
  return undefined;
}

export function readLaunchRequest(runDir: string): LaunchRequest | string {
  const path = join(runDir, LAUNCH_FILE);
  const value = readJsonFile(path);
  if (!isPlainObject(value)) return `${path} is missing or is not a JSON object`;
  if (value["schemaVersion"] !== 1 || value["kind"] !== "woof.launch")
    return `${path} is not a woof.launch request`;
  if (!isId(value["runId"])) return `${path}: runId is invalid`;
  if (value["workflow"] !== null && !isId(value["workflow"])) return `${path}: workflow is invalid`;
  if (value["projectDir"] !== null && typeof value["projectDir"] !== "string")
    return `${path}: projectDir is invalid`;
  if (!isPlainObject(value["flags"])) return `${path}: flags is invalid`;
  return value as unknown as LaunchRequest;
}

export interface LaunchOptions {
  runId: string;
  /** Absolute run directory; default `<runsDir>/<runId>`. */
  runDir?: string;
  workflow?: string;
  projectDir: string | null;
  input: unknown;
  flags: LaunchFlags;
  /** "current" (the caller's pane) or a pane id to split. */
  splitFrom: string;
  launcherPaneId: string | null;
  herdrBin: string;
  env: NodeJS.ProcessEnv;
  nodePath: string;
  cliPath: string;
  homeDir?: string;
}

export async function launchInPane(
  options: LaunchOptions,
): Promise<{ code: number; output: Record<string, unknown> }> {
  // The runtime module is the host's concern; configuration never sees it.
  const configFlags: ConfigFlags = { ...options.flags };
  Reflect.deleteProperty(configFlags, "runtimeModule");
  const resolved = await resolveConfiguration({
    projectDir: options.projectDir,
    flags: {
      ...configFlags,
      ...(options.workflow !== undefined ? { workflow: options.workflow } : {}),
    },
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
  });
  if (!resolved.ok) return rejected(resolved.reason, resolved.message, resolved.details);
  const configuration = resolved.configuration;
  const runsDir = configuration.settings.runsDir.value;
  const runDir = options.runDir ?? join(runsDir, options.runId);

  // Only a built-in workflow is admitted here: a project module's code runs once, in the host.
  if (configuration.workflow?.source === "builtin") {
    const definition = validateWorkflowDefinition(
      builtinWorkflowDefinition(configuration.workflow.value.name),
    );
    if (!definition.ok)
      return rejected(
        "definition_invalid",
        "the built-in definition is invalid",
        definition.details,
      );
    const admitted = await admitWorkflow({
      definition: definition.definition,
      input: options.input,
      runDir,
      configuration: admissionConfiguration(configuration),
    });
    if (!admitted.ok) return rejected(admitted.reason, admitted.message, admitted.details);
  }

  const occupied = runDirOccupied(runDir);
  if (occupied !== undefined) return rejected("run_exists", occupied);
  try {
    if (options.runDir === undefined) mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    mkdirSync(runDir, { recursive: true });
  } catch (error) {
    // A file at the runs directory makes mkdir fail with EEXIST: that is no run, it is infrastructure.
    return rejected(
      "journal_write_failed",
      `cannot create the run directory ${runDir}: ${(error as Error).message}`,
    );
  }
  try {
    const request: LaunchRequest = {
      schemaVersion: 1,
      kind: "woof.launch",
      workflow: options.workflow ?? null,
      projectDir: options.projectDir,
      input: options.input,
      flags: options.flags,
      runId: options.runId,
      requestedAt: new Date().toISOString(),
      launcher: { pid: process.pid, paneId: options.launcherPaneId },
    };
    writeExclusiveFile(
      join(runDir, LAUNCH_FILE),
      Buffer.from(`${JSON.stringify(request, null, 2)}\n`, "utf8"),
      0o444,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EEXIST"
      ? rejected("run_exists", `${runDir} already holds a run (${LAUNCH_FILE})`)
      : rejected("journal_write_failed", `cannot prepare ${runDir}: ${(error as Error).message}`);
  }

  const exec = (args: string[]) =>
    execHerdr(args, {
      bin: options.herdrBin,
      env: options.env,
      timeoutMs: PANE_COMMAND_TIMEOUT_MS,
      graceMs: 2000,
    });
  const projectRoot = configuration.roots.project?.root ?? options.projectDir ?? process.cwd();
  const split = await exec([
    "pane",
    "split",
    ...(options.splitFrom === "current" ? ["--current"] : [options.splitFrom]),
    "--direction",
    "right",
    "--cwd",
    projectRoot,
    "--no-focus",
  ]);
  // A launch this launcher reports as failed must never start later: close the unclaimed directory.
  const paneFailed = (message: string) => {
    let abandoned: ReturnType<typeof abandonHost>;
    try {
      abandoned = abandonHost(runDir, `woof run start (pid ${process.pid})`);
    } catch (error) {
      abandoned = { ok: false, host: null, message: (error as Error).message };
    }
    return rejected(
      "host_pane_failed",
      abandoned.ok
        ? `${message}; the run directory is closed (abandoned) and no run will start there`
        : `${message}; the run directory could not be closed (abandoned): ${abandoned.message}`,
    );
  };
  const paneId = split.exitCode === 0 ? paneIdOf(split.stdout) : undefined;
  if (paneId === undefined) {
    return paneFailed(
      `herdr pane split failed: ${split.spawnErrorMessage ?? (split.stderr.trim().split("\n")[0] || `exit ${split.exitCode ?? split.signal ?? "unknown"}, stdout ${JSON.stringify(split.stdout.slice(0, 200))}`)}`,
    );
  }
  const typed = await exec([
    "pane",
    "run",
    paneId,
    shellQuote(options.nodePath),
    shellQuote(options.cliPath),
    "run",
    "host",
    shellQuote(runDir),
  ]);
  if (typed.exitCode !== 0) {
    return paneFailed(
      `herdr pane run ${paneId} failed: ${typed.spawnErrorMessage ?? (typed.stderr.trim().split("\n")[0] || `exit ${typed.exitCode ?? typed.signal ?? "unknown"}`)}`,
    );
  }

  const timeoutMs = configuration.settings.hostStartTimeoutMs.value;
  const startedAt = Date.now();
  let hostSeenAt: number | undefined;
  for (;;) {
    const snapshot = readSnapshot(runDir);
    if (snapshot.ok) {
      return {
        code: 0,
        output: startedOutput(runDir, paneId, snapshot.snapshot),
      };
    }
    const outcome = readJsonFile(join(runDir, OUTCOME_FILE));
    if (isPlainObject(outcome)) {
      const reason = typeof outcome["reason"] === "string" ? outcome["reason"] : "";
      return {
        code: outcome["outcome"] === "rejected" && !isHostInfraReason(reason) ? 2 : 3,
        output: outcome,
      };
    }
    const now = Date.now();
    if (!entryExists(join(runDir, HOST_FILE))) {
      if (now - startedAt >= timeoutMs) {
        const abandoned = abandonHost(runDir, `woof run start (pid ${process.pid})`);
        if (abandoned.ok) {
          return rejected(
            "host_not_started",
            `the run host in pane ${paneId} did not claim ${runDir} within ${timeoutMs} ms; the run directory is closed (abandoned) and no run will start there`,
          );
        }
        hostSeenAt = now;
      }
    } else {
      hostSeenAt ??= now;
      if (now - hostSeenAt >= timeoutMs) {
        return rejected(
          "host_unresponsive",
          `the run host in pane ${paneId} claimed ${runDir} but neither opened the run nor wrote ${OUTCOME_FILE} within ${timeoutMs} ms; it keeps ownership`,
        );
      }
    }
    // Waiting on files another process writes is sequential by design.
    // oxlint-disable-next-line no-await-in-loop
    await delay(LAUNCH_POLL_MS);
  }
}

function rejected(
  reason: string,
  message: string,
  details: unknown[] = [],
): { code: number; output: Record<string, unknown> } {
  return {
    code: isHostInfraReason(reason) ? 3 : 2,
    output: { outcome: "rejected", reason, message, details },
  };
}

function paneIdOf(stdout: string): string | undefined {
  try {
    const value = JSON.parse(stdout) as { result?: { pane?: { pane_id?: unknown } } };
    const id = value.result?.pane?.pane_id;
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}

function startedOutput(
  runDir: string,
  splitPaneId: string,
  snapshot: { runId: string; workflow: unknown; config: { sha256: string } | null },
): Record<string, unknown> {
  const host = readHostInfo(runDir);
  const recorded = readJsonFile(join(runDir, "config.json")) as
    Partial<ResolvedConfiguration> | undefined;
  const agents: Record<string, unknown> = {};
  for (const [agentId, agent] of Object.entries(recorded?.agents ?? {})) {
    agents[agentId] = {
      kind: agent.value.kind,
      model: agent.value.model,
      source: agent.source,
      path: agent.path,
    };
  }
  return {
    outcome: "started",
    runId: snapshot.runId,
    runDir,
    workflow: snapshot.workflow,
    host: { mode: "herdr-pane", paneId: host?.paneId ?? splitPaneId, pid: host?.pid ?? null },
    configuration: {
      sha256: snapshot.config?.sha256 ?? null,
      agents,
      warnings: recorded?.warnings ?? [],
    },
    next: {
      status: ["woof", "status", runDir, "--wait"],
      cancel: ["woof", "run", "cancel", runDir],
    },
  };
}
