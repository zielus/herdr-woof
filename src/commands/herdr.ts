import { existsSync } from "node:fs";
import { join } from "node:path";

import { discoverRoots } from "../config/discover.js";
import { resolveConfiguration } from "../config/resolve.js";
import { isInfraReason } from "../contracts/reasons.js";
import { launchInPane } from "../host/launch.js";
import { clip } from "../host/metadata.js";
import { listRuns, type RunListEntry } from "../inspect/runs.js";
import { readRunStatus } from "../inspect/status.js";
import { execHerdr } from "../runtime/herdr/exec.js";
import { terminateRun } from "../state/store.js";
import { UsageError } from "./common.js";
import { cliPath, defaultRunId, herdrBin, readWorkflowInput } from "./run.js";

export const HERDR_USAGE = `Usage: woof herdr <status|start|cancel>

Herdr plugin actions (unstable). The project is the git top level of the
invocation context's worktree checkout, else the focused pane's directory, else
the workspace directory (HERDR_PLUGIN_CONTEXT_JSON); never the working directory.
Each action shows a Herdr notification and prints one JSON line.

  status  the project's runs that have not ended; exits 0
  start   start the default workflow with <project>/.woof/start.json in a pane
          split from the focused pane; exits like woof run start
  cancel  cancel the project's single active run; refuses (exit 2) when several are active

Exits 2 without a project context.`;

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "exhausted"]);
const NOTIFICATION_TIMEOUT_MS = 5000;
const MAX_NOTIFICATION_BODY = 1000;
const MAX_LISTED_RUNS = 5;

interface Project {
  root: string;
  runsDir: string;
  focusedPaneId: string | null;
}

type Outcome = { ok: true; project: Project } | { ok: false; reason: string; message: string };

export async function herdrCommand(args: string[]): Promise<number> {
  const [action, ...extra] = args;
  if (action === "--help" || action === "-h") {
    console.log(HERDR_USAGE);
    return 0;
  }
  if ((action !== "status" && action !== "start" && action !== "cancel") || extra.length > 0) {
    throw new UsageError(
      `expected "herdr status", "herdr start" or "herdr cancel"\n\n${HERDR_USAGE}`,
    );
  }
  const resolved = await projectOf(process.env["HERDR_PLUGIN_CONTEXT_JSON"]);
  if (!resolved.ok) {
    await notify(
      resolved.reason === "project_context_missing"
        ? "Woof: no project context"
        : `Woof: rejected (${resolved.reason})`,
      resolved.message,
    );
    print({ outcome: "rejected", reason: resolved.reason, message: resolved.message, details: [] });
    return 2;
  }
  const { project } = resolved;
  if (action === "start") return start(project);
  let runs: RunListEntry[];
  let listed: ReturnType<typeof listRuns>;
  try {
    listed = listRuns({ runsDir: project.runsDir, project: project.root, all: true });
    runs = listed.runs.filter((run) => !TERMINAL.has(run.status));
  } catch (error) {
    const message = `cannot read ${project.runsDir}: ${(error as Error).message}`;
    await notify("Woof: rejected (runs_dir_unreadable)", message);
    print({ outcome: "rejected", reason: "runs_dir_unreadable", message, details: [] });
    return 3;
  }
  if (action === "status") {
    const lines = runs.slice(0, MAX_LISTED_RUNS).map((run) => {
      const read = readRunStatus(run.runDir);
      const active = read.ok ? read.status.activeAttempts[0] : undefined;
      const where =
        active === undefined ? "-" : `${active.stageId} v${active.visit}/a${active.attempt}`;
      return `${run.runId} ${run.status} ${where} owner ${run.owner}`;
    });
    await notify(
      `Woof: ${runs.length} active run(s)`,
      runs.length === 0 ? `no active Woof run in ${project.root}` : lines.join("\n"),
    );
    print({ outcome: "runs", ...listed, runs });
    return 0;
  }
  return cancel(project, runs);
}

async function start(project: Project): Promise<number> {
  const inputPath = join(project.root, ".woof", "start.json");
  const refuse = async (reason: string, message: string, code: number) => {
    await notify(`Woof: rejected (${reason})`, message);
    print({ outcome: "rejected", reason, message, details: [] });
    return code;
  };
  if (!existsSync(inputPath)) {
    const message = `${inputPath} does not exist; create it with a workflow input`;
    await notify("Woof: create .woof/start.json with a workflow input", message);
    print({ outcome: "rejected", reason: "input_invalid", message, details: [] });
    return 2;
  }
  const input = await readWorkflowInput(inputPath);
  if (!input.ok) return refuse("input_invalid", input.message, 2);
  // An action process has no pane of its own; a pane Herdr names for it wins.
  const paneId = nonEmpty(process.env["HERDR_PANE_ID"]);
  const splitFrom = paneId !== undefined ? "current" : project.focusedPaneId;
  if (splitFrom === null) {
    return refuse(
      "runtime_unavailable",
      "the invocation context names no focused pane to split the run host from",
      3,
    );
  }
  const launched = await launchInPane({
    runId: defaultRunId(undefined),
    projectDir: project.root,
    input: input.value,
    flags: {},
    splitFrom,
    launcherPaneId: paneId ?? null,
    herdrBin: herdrBin(),
    env: process.env,
    nodePath: process.execPath,
    cliPath,
  });
  const out = launched.output;
  if (out["outcome"] === "started") {
    await notify(`Woof: started ${String(out["runId"])}`, `run directory ${String(out["runDir"])}`);
  } else {
    const details = out["details"];
    const first: unknown = Array.isArray(details) ? details[0] : undefined;
    await notify(
      `Woof: rejected (${String(out["reason"])})`,
      isObject(first)
        ? `${String(first["field"])}: ${String(first["message"])}`
        : String(out["message"] ?? ""),
    );
  }
  print(out);
  return launched.code;
}

async function cancel(project: Project, runs: RunListEntry[]): Promise<number> {
  const [run, ...others] = runs;
  if (run === undefined) {
    const message = `no active Woof run in ${project.root}`;
    await notify("Woof: nothing to cancel", message);
    print({ outcome: "rejected", reason: "no_active_run", message, details: [] });
    return 0;
  }
  if (others.length > 0) {
    const commands = runs.map((entry) => `woof run cancel ${entry.runDir}`);
    const message = `${runs.length} active Woof runs in ${project.root}; cancel one with woof run cancel <run-dir>`;
    await notify(`Woof: ${runs.length} active runs, none cancelled`, commands.join("\n"));
    print({
      outcome: "rejected",
      reason: "run_ambiguous",
      message,
      details: commands.map((command) => ({ field: "runDir", message: command })),
    });
    return 2;
  }
  const outcome = await terminateRun({
    runDir: run.runDir,
    outcome: "cancelled",
    reason: "cancelled via Herdr action",
  });
  if (outcome.outcome === "recorded") {
    await notify(`Woof: cancelled ${run.runId}`, run.runDir);
    print({ ...outcome, runId: run.runId, runDir: run.runDir });
    return 0;
  }
  await notify(`Woof: rejected (${outcome.reason})`, outcome.message);
  print({ ...outcome, runId: run.runId, runDir: run.runDir });
  return isInfraReason(outcome.reason) ? 3 : 2;
}

async function projectOf(raw: string | undefined): Promise<Outcome> {
  let value: unknown;
  try {
    value = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    value = undefined;
  }
  const context = isObject(value) ? value : {};
  const worktree = isObject(context["worktree"]) ? context["worktree"] : {};
  const dir = [
    worktree["checkout_path"],
    context["focused_pane_cwd"],
    context["workspace_cwd"],
  ].find((candidate): candidate is string => typeof candidate === "string" && candidate !== "");
  if (dir === undefined) {
    return {
      ok: false,
      reason: "project_context_missing",
      message:
        "HERDR_PLUGIN_CONTEXT_JSON names no worktree checkout, focused pane directory or workspace directory",
    };
  }
  const roots = await discoverRoots({ projectDir: dir });
  if (!roots.ok) return { ok: false, reason: roots.reason, message: roots.message };
  const root = roots.roots.project?.root;
  if (root === undefined) {
    return {
      ok: false,
      reason: "project_context_missing",
      message: `${dir} is not inside a git work tree`,
    };
  }
  const resolved = await resolveConfiguration({ projectDir: root });
  if (!resolved.ok) return { ok: false, reason: resolved.reason, message: resolved.message };
  const focused = context["focused_pane_id"];
  return {
    ok: true,
    project: {
      root,
      runsDir: resolved.configuration.settings.runsDir.value,
      focusedPaneId: typeof focused === "string" && focused !== "" ? focused : null,
    },
  };
}

async function notify(title: string, body: string): Promise<void> {
  const result = await execHerdr(
    ["notification", "show", title, "--body", clip(body, MAX_NOTIFICATION_BODY)],
    { bin: herdrBin(), env: process.env, timeoutMs: NOTIFICATION_TIMEOUT_MS, graceMs: 1000 },
  );
  if (result.exitCode !== 0) {
    const detail =
      result.spawnErrorMessage ??
      (result.stderr.trim().split("\n")[0] || `exit ${result.exitCode ?? result.signal}`);
    console.error(`woof herdr: herdr notification show failed: ${detail}`);
  }
}

function print(value: unknown): void {
  console.log(JSON.stringify(value));
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
