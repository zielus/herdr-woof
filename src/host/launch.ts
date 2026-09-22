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
import { execHerdr, type ExecResult } from "../runtime/herdr/exec.js";
import { paneWorkspaceId, parseTabCreated } from "../runtime/herdr/parse.js";
import { admitWorkflow } from "../scheduler/admission.js";
import { validateWorkflowDefinition } from "../scheduler/definition.js";
import { readSnapshot } from "../state/snapshot.js";
import { abandonHost } from "./claim.js";
import { entryExists, readJsonFile, shellQuote, writeExclusiveFile } from "./files.js";
import { sha256Hex } from "../contracts/canonical-json.js";
import { HOST_EXIT_FILE, HOST_FILE, readHostInfo } from "./probe.js";
import { OUTCOME_FILE, isHostInfraReason } from "./run.js";

/**
 * `woof run start --host herdr-pane` (p4 D1, §3.7): pre-admit a built-in
 * workflow in memory, write a launch request into the run directory, create a
 * Herdr tab and run `woof run host <run-dir>` in its root pane, then return once that
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
  for (const name of [JOURNAL_FILE, HOST_FILE, HOST_EXIT_FILE, LAUNCH_FILE, OUTCOME_FILE]) {
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
  launcherPaneId: string | null;
  /** The pane whose workspace the host's tab joins (a Herdr action's focused pane); default the launcher's. */
  workspacePaneId?: string | null;
  herdrBin: string;
  env: NodeJS.ProcessEnv;
  nodePath: string;
  cliPath: string;
  /** Arguments typed after `run host <run-dir>` (the host's view flags: `--plain`, `--ascii`, `--input json`). */
  hostArgs?: readonly string[];
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
  // The digest of its admitted input is what the host's run.opened records (input.json).
  let expectedInputSha256: string | undefined;
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
    expectedInputSha256 = sha256Hex(
      Buffer.from(`${JSON.stringify(admitted.input, null, 2)}\n`, "utf8"),
    );
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
  // The digest of the launch request written below: only an outcome.json carrying it is this launch's.
  let launchSha256: string;
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
    const bytes = Buffer.from(`${JSON.stringify(request, null, 2)}\n`, "utf8");
    launchSha256 = sha256Hex(bytes);
    writeExclusiveFile(join(runDir, LAUNCH_FILE), bytes, 0o444);
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
  // The run host gets its own unfocused tab and runs in that tab's root pane. The tab goes to the
  // workspace Herdr reports for the launcher's (or the action's focused) pane; HERDR_WORKSPACE_ID,
  // which can be absent or stale, is only the fallback, and with neither Herdr's default decides.
  const workspaceId = await launchWorkspaceId(
    exec,
    options.workspacePaneId ?? options.launcherPaneId,
    options.env,
  );
  const createArgs = [
    "tab",
    "create",
    ...(workspaceId !== undefined ? ["--workspace", workspaceId] : []),
    "--cwd",
    projectRoot,
    "--label",
    `woof:${configuration.workflow?.value.name ?? options.workflow ?? "host"}`,
    "--no-focus",
  ];
  const created = await exec(createArgs);
  // A launch this launcher reports as failed must never start later: close the unclaimed directory.
  // An abandonment that succeeds proves no host claimed the directory, so the tab created for that
  // host is closed too; a directory a host did claim keeps its tab (that host may still run there).
  const paneFailed = async (message: string, createdTabId: string | undefined) => {
    const closed = closeRunDir(runDir, "woof run start");
    const tabNote =
      createdTabId === undefined
        ? ""
        : closed.ok
          ? `; ${await closeTab(exec, createdTabId)}`
          : `; the created tab ${createdTabId} is left open`;
    return rejected("host_pane_failed", `${message}; ${closed.message}${tabNote}`);
  };
  const reply = created.exitCode === 0 ? resultOf(created.stdout) : undefined;
  if (reply === undefined) {
    return paneFailed(
      `herdr tab create failed: ${created.spawnErrorMessage ?? (created.stderr.trim().split("\n")[0] || `exit ${created.exitCode ?? created.signal ?? "unknown"}, stdout ${JSON.stringify(created.stdout.slice(0, 200))}`)}`,
      undefined,
    );
  }
  // Herdr has created the tab by now: a reply that does not verify still names the tab to close.
  const tab = parseTabCreated(reply, workspaceId);
  if (!tab.ok) return paneFailed(`herdr tab create failed: ${tab.message}`, tab.createdTabId);
  const { paneId, tabId } = tab;
  // The verified workspace of the host's tab travels to the host process (`env` works in any
  // shell), whose runtime adapter creates the agents' tabs there whatever the pane inherited.
  const typed = await exec([
    "pane",
    "run",
    paneId,
    "env",
    shellQuote(`HERDR_WORKSPACE_ID=${tab.workspaceId}`),
    shellQuote(`WOOF_HOST_TAB_ID=${tabId}`),
    shellQuote(options.nodePath),
    shellQuote(options.cliPath),
    "run",
    "host",
    shellQuote(runDir),
    ...(options.hostArgs ?? []).map(shellQuote),
  ]);
  if (typed.exitCode !== 0) {
    return paneFailed(`herdr pane run ${paneId} failed: ${failureOf(typed)}`, tabId);
  }

  const timeoutMs = configuration.settings.hostStartTimeoutMs.value;
  const startedAt = Date.now();
  let hostSeenAt: number | undefined;
  for (;;) {
    const outcome = readJsonFile(join(runDir, OUTCOME_FILE));
    // An outcome.json that does not name this launch (a stale or foreign file) is not this host's
    // result: keep waiting for the run to open, the host's claim or the timeout (PR #6).
    const own =
      isPlainObject(outcome) &&
      isPlainObject(outcome["launch"]) &&
      outcome["launch"]["sha256"] === launchSha256
        ? outcome
        : undefined;
    // This host's rejection wins over any journal: a run it refused to open is never "started".
    const refused = own !== undefined && own["outcome"] === "rejected";
    if (!refused) {
      const snapshot = readSnapshot(runDir);
      if (snapshot.ok) {
        // Only the journal this launch's host opened is this run (PR #6): its run id, and for a
        // built-in workflow the admitted input, must match. Another run is refused without naming it.
        const opened = snapshot.snapshot;
        if (
          opened.runId !== options.runId ||
          (expectedInputSha256 !== undefined && opened.input?.sha256 !== expectedInputSha256)
        ) {
          return rejected(
            "run_exists",
            `${runDir} holds a run that this launch did not open; nothing was started`,
          );
        }
        return { code: 0, output: startedOutput(runDir, paneId, tabId, opened) };
      }
    }
    if (own !== undefined) {
      const reason = typeof own["reason"] === "string" ? own["reason"] : "";
      if (reason === "host_claim_failed") {
        // The host's failure handoff: it holds no claim, so close the directory before reporting.
        // An abandonment that succeeds proves no host owns the directory: its tab is closed too.
        const closed = closeRunDir(runDir, "woof run start after the run host's claim failed");
        // oxlint-disable-next-line no-await-in-loop
        const tabNote = closed.ok ? `; ${await closeTab(exec, tabId)}` : "";
        return {
          code: 3,
          output: { ...own, message: `${String(own["message"])}; ${closed.message}${tabNote}` },
        };
      }
      return {
        code: own["outcome"] === "rejected" && !isHostInfraReason(reason) ? 2 : 3,
        output: own,
      };
    }
    const now = Date.now();
    if (!entryExists(join(runDir, HOST_FILE))) {
      if (now - startedAt >= timeoutMs) {
        const abandoned = abandonHost(runDir, `woof run start (pid ${process.pid})`);
        if (abandoned.ok) {
          // No host claimed and none can any more: the tab created for it is closed with the directory.
          return rejected(
            "host_not_started",
            // oxlint-disable-next-line no-await-in-loop
            `the run host in pane ${paneId} did not claim ${runDir} within ${timeoutMs} ms; the run directory is closed (abandoned) and no run will start there; ${await closeTab(exec, tabId)}`,
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

/**
 * Closes an unclaimed run directory as abandoned so no later host starts the launch, and says how
 * that went (a host that did claim first keeps the directory, and the message names it).
 */
function closeRunDir(runDir: string, by: string): { ok: boolean; message: string } {
  let abandoned: ReturnType<typeof abandonHost>;
  try {
    abandoned = abandonHost(runDir, `${by} (pid ${process.pid})`);
  } catch (error) {
    abandoned = { ok: false, host: null, message: (error as Error).message };
  }
  return abandoned.ok
    ? { ok: true, message: "the run directory is closed (abandoned) and no run will start there" }
    : {
        ok: false,
        message: `the run directory could not be closed (abandoned): ${abandoned.message}`,
      };
}

type Exec = (args: string[]) => Promise<ExecResult>;

/** Closes a tab this launch created (best effort) and says how that went. */
async function closeTab(exec: Exec, tabId: string): Promise<string> {
  const closed = await exec(["tab", "close", tabId]);
  return closed.exitCode === 0
    ? `the created tab ${tabId} was closed`
    : `the created tab ${tabId} could not be closed (${failureOf(closed)})`;
}

/**
 * The workspace the host's tab goes to: the one Herdr reports for `paneId` (`herdr pane get`),
 * else a non-empty HERDR_WORKSPACE_ID, else undefined (no `--workspace`: Herdr's default).
 */
async function launchWorkspaceId(
  exec: Exec,
  paneId: string | null,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (paneId !== null && paneId !== "") {
    const got = await exec(["pane", "get", paneId]);
    const result = got.exitCode === 0 ? resultOf(got.stdout) : undefined;
    const fromPane = result === undefined ? undefined : paneWorkspaceId(result);
    if (fromPane !== undefined) return fromPane;
  }
  const fromEnv = env["HERDR_WORKSPACE_ID"];
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined;
}

function failureOf(result: ExecResult): string {
  return (
    result.spawnErrorMessage ??
    (result.stderr.trim().split("\n")[0] || `exit ${result.exitCode ?? result.signal ?? "unknown"}`)
  );
}

/** The `result` object of a Herdr reply, else undefined. */
function resultOf(stdout: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    return isPlainObject(value) && isPlainObject(value["result"]) ? value["result"] : undefined;
  } catch {
    return undefined;
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

function startedOutput(
  runDir: string,
  rootPaneId: string,
  tabId: string,
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
    host: {
      mode: "herdr-pane",
      paneId: host?.paneId ?? rootPaneId,
      tabId,
      pid: host?.pid ?? null,
    },
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
