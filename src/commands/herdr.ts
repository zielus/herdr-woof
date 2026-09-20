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
import { doctorReport } from "./doctor.js";
import { cliPath, defaultRunId, herdrBin, readWorkflowInput } from "./run.js";

export const HERDR_USAGE = `Usage: woof herdr <status|start|cancel|doctor|watch>

Herdr plugin actions (unstable). The project is the git top level of the
invocation context's focused pane directory, else the workspace directory, else
the workspace's worktree checkout (HERDR_PLUGIN_CONTEXT_JSON); never the
working directory.
Each action shows a Herdr notification and prints one JSON line.

  status  the project's runs that have not ended; exits 0
  start   start the default workflow with <project>/.woof/start.json in a pane
          split from the focused pane; exits like woof run start
  cancel  cancel the project's single active run; exits 0 with outcome noop when
          none is active; refuses (exit 2) when several are
  doctor  woof doctor --json for the project: Herdr, Claude Code, folder trust and
          configuration (a configuration problem is reported, not refused); exits 0
  watch   open a Herdr plugin pane running woof watch --follow for the project's
          single active run (herdr plugin pane open, run directory in
          WOOF_RUN_DIR); exits 0 with outcome noop when none is active; refuses
          (exit 2) when several are; 3 when the pane cannot be opened

Exits 2 without a project context.`;

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "exhausted"]);
const NOTIFICATION_TIMEOUT_MS = 5000;
const MAX_NOTIFICATION_BODY = 1000;
const MAX_LISTED_RUNS = 5;
const PANE_OPEN_TIMEOUT_MS = 10_000;
const PLUGIN_ID = "herdr-woof";

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
  if (
    (action !== "status" &&
      action !== "start" &&
      action !== "cancel" &&
      action !== "doctor" &&
      action !== "watch") ||
    extra.length > 0
  ) {
    throw new UsageError(
      `expected "herdr status", "herdr start", "herdr cancel", "herdr doctor" or "herdr watch"\n\n${HERDR_USAGE}`,
    );
  }
  const context = process.env["HERDR_PLUGIN_CONTEXT_JSON"];
  if (action === "doctor") {
    // Doctor needs only the project root: a configuration that does not resolve is what it reports.
    const rooted = await projectRootOf(context);
    return rooted.ok ? doctor(rooted.root) : refuseContext(rooted);
  }
  const resolved = await projectOf(context);
  if (!resolved.ok) return refuseContext(resolved);
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
  if (action === "watch") return watch(project, runs);
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
    // Nothing to do is not a failure: Herdr logs a non-zero action exit as "failed" (verify-1 L1).
    print({ outcome: "noop", reason: "no_active_run", message, details: [] });
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

async function watch(project: Project, runs: RunListEntry[]): Promise<number> {
  const [run, ...others] = runs;
  if (run === undefined) {
    const message = `no active Woof run in ${project.root}`;
    await notify("Woof: nothing to watch", message);
    print({ outcome: "noop", reason: "no_active_run", message, details: [] });
    return 0;
  }
  if (others.length > 0) {
    const commands = runs.map((entry) => `woof watch ${entry.runDir}`);
    const message = `${runs.length} active Woof runs in ${project.root}; watch one with woof watch <run-dir>`;
    await notify(`Woof: ${runs.length} active runs, none watched`, commands.join("\n"));
    print({
      outcome: "rejected",
      reason: "run_ambiguous",
      message,
      details: commands.map((command) => ({ field: "runDir", message: command })),
    });
    return 2;
  }
  // The [[panes]] entry runs bin/woof watch --follow from the plugin root; the run travels in its env.
  const opened = await execHerdr(
    [
      "plugin",
      "pane",
      "open",
      "--plugin",
      PLUGIN_ID,
      "--entrypoint",
      "watch",
      "--placement",
      "split",
      ...(project.focusedPaneId !== null ? ["--target-pane", project.focusedPaneId] : []),
      "--direction",
      "right",
      "--env",
      `WOOF_RUN_DIR=${run.runDir}`,
      "--no-focus",
    ],
    { bin: herdrBin(), env: process.env, timeoutMs: PANE_OPEN_TIMEOUT_MS, graceMs: 2000 },
  );
  if (opened.exitCode !== 0) {
    const message = `herdr plugin pane open failed: ${
      opened.spawnErrorMessage ??
      (opened.stderr.trim().split("\n")[0] || `exit ${opened.exitCode ?? opened.signal}`)
    }`;
    await notify("Woof: rejected (watch_pane_failed)", message);
    print({ outcome: "rejected", reason: "watch_pane_failed", message, details: [] });
    return 3;
  }
  await notify(`Woof: watching ${run.runId}`, run.runDir);
  print({
    outcome: "watching",
    runId: run.runId,
    runDir: run.runDir,
    paneId: pluginPaneIdOf(opened.stdout),
  });
  return 0;
}

/** The pane id Herdr 0.9 reports for an opened plugin pane (result.plugin_pane.pane.pane_id). */
function pluginPaneIdOf(stdout: string): string | null {
  try {
    const value = JSON.parse(stdout) as {
      result?: { plugin_pane?: { pane?: { pane_id?: unknown } } };
    };
    const id = value.result?.plugin_pane?.pane?.pane_id;
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

async function refuseContext(refused: { reason: string; message: string }): Promise<number> {
  await notify(
    refused.reason === "project_context_missing"
      ? "Woof: no project context"
      : `Woof: rejected (${refused.reason})`,
    refused.message,
  );
  print({ outcome: "rejected", reason: refused.reason, message: refused.message, details: [] });
  return 2;
}

async function doctor(root: string): Promise<number> {
  const report = await doctorReport(root);
  const count = report.problems.length;
  await notify(
    count === 0 ? "Woof: doctor" : `Woof: doctor (${count} problem${count === 1 ? "" : "s"})`,
    [
      root,
      `herdr ${probeLine(report.herdr.status, report.herdr.version)}`,
      `claude ${probeLine(report.claude.status, report.claude.version)}`,
      `pi ${probeLine(report.pi.status, report.pi.version)}`,
      `trust ${report.trust.status}`,
      report.config.ok ? "config ok" : `config ${report.config.reason}: ${report.config.message}`,
    ].join("\n"),
  );
  print({ outcome: "doctor", project: root, ...report });
  return 0;
}

function probeLine(status: string, version: string | null): string {
  return version === null ? status : `${status} (${version})`;
}

async function projectOf(raw: string | undefined): Promise<Outcome> {
  const rooted = await projectRootOf(raw);
  if (!rooted.ok) return rooted;
  const resolved = await resolveConfiguration({ projectDir: rooted.root });
  if (!resolved.ok) return { ok: false, reason: resolved.reason, message: resolved.message };
  return {
    ok: true,
    project: {
      root: rooted.root,
      runsDir: resolved.configuration.settings.runsDir.value,
      focusedPaneId: rooted.focusedPaneId,
    },
  };
}

/** The git top level named by the invocation context: focused pane, then workspace, then worktree. */
async function projectRootOf(
  raw: string | undefined,
): Promise<
  | { ok: true; root: string; focusedPaneId: string | null }
  | { ok: false; reason: string; message: string }
> {
  let value: unknown;
  try {
    value = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    value = undefined;
  }
  const context = isObject(value) ? value : {};
  const worktree = isObject(context["worktree"]) ? context["worktree"] : {};
  // The focused pane is what the operator points at. A workspace bound to one git worktree
  // (the Woof checkout, say) reports that checkout whichever pane is focused, so it comes last.
  // A candidate outside any git work tree, or one that no longer exists, falls through to the next.
  const candidates = [
    context["focused_pane_cwd"],
    context["workspace_cwd"],
    worktree["checkout_path"],
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate !== "");
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "project_context_missing",
      message:
        "HERDR_PLUGIN_CONTEXT_JSON names no focused pane directory, workspace directory or worktree checkout",
    };
  }
  const skipped: string[] = [];
  for (const dir of candidates) {
    // Candidates are tried in precedence order; each depends on the previous one failing.
    // oxlint-disable-next-line no-await-in-loop
    const roots = await discoverRoots({ projectDir: dir });
    const root = roots.ok ? roots.roots.project?.root : undefined;
    if (root !== undefined) {
      const focused = context["focused_pane_id"];
      return {
        ok: true,
        root,
        focusedPaneId: typeof focused === "string" && focused !== "" ? focused : null,
      };
    }
    skipped.push(roots.ok ? `${dir} is not inside a git work tree` : roots.message);
  }
  return { ok: false, reason: "project_context_missing", message: skipped.join("; ") };
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
