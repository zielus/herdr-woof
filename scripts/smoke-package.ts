#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  name: string;
  version: string;
};

if (!existsSync(join(repoRoot, "dist", "index.js"))) {
  throw new Error("dist/index.js is missing; run bun run build before smoke:package");
}

const workDir = mkdtempSync(join(tmpdir(), "woof-package-smoke-"));
const npmCache = join(workDir, "npm-cache");

try {
  const packed = run(
    "npm",
    ["pack", "--json", "--pack-destination", workDir, "--cache", npmCache],
    repoRoot,
  );
  const [packInfo] = JSON.parse(packed) as Array<{
    filename: string;
    files: Array<{ path: string }>;
  }>;
  const shipped = packInfo!.files.map((file) => file.path);
  // The Herdr manifest builds from a checkout (lockfile, sources, tsconfig), so
  // shipping it without those inputs would advertise a build that cannot run.
  // The Bash launcher is checkout-only; the installed bin is the Node entry.
  const strays = shipped.filter((path) => path === "herdr-plugin.toml" || path.startsWith("bin/"));
  if (strays.length > 0) {
    throw new Error(`tarball ships checkout-only files: ${strays.join(", ")}`);
  }
  const pluginFiles = [
    "plugin/claude/.claude-plugin/plugin.json",
    "plugin/claude/commands/run.md",
    "plugin/claude/skills/woof/SKILL.md",
  ];
  const missingPlugin = pluginFiles.filter((path) => !shipped.includes(path));
  if (missingPlugin.length > 0) {
    throw new Error(`tarball is missing Claude Code plugin files: ${missingPlugin.join(", ")}`);
  }
  const tarball = join(workDir, packInfo!.filename);
  const consumer = join(workDir, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "woof-package-smoke", private: true, version: "0.0.0", type: "module" }),
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--cache",
      npmCache,
      tarball,
    ],
    consumer,
  );

  const installedBin = join(consumer, "node_modules", ".bin", "woof");
  const importCheck = [
    'const entry = await import("herdr-woof");',
    "if (entry.SDK_FOUNDATION !== true) process.exit(1);",
    'for (const name of ["openAttempt", "submitResult", "readJournal", "resolveConfiguration", "discoverRoots", "claimHost", "probeHost", "readRunStatus", "listRuns", "openAdmittedRun", "claudeTrustStatus"]) {',
    '  if (typeof entry[name] !== "function") process.exit(2);',
    "}",
    "if (!Array.isArray(entry.REJECTION_REASONS)) process.exit(3);",
  ].join("\n");
  run("node", ["--input-type=module", "--eval", importCheck], consumer);
  const testingCheck = [
    'const testing = await import("herdr-woof/testing");',
    'const entry = await import("herdr-woof");',
    'if (typeof testing.createScriptedRuntime !== "function") process.exit(1);',
    'if ("createScriptedRuntime" in entry) process.exit(2);',
  ].join("\n");
  run("node", ["--input-type=module", "--eval", testingCheck], consumer);
  scriptedStoreRoundTrip(consumer);
  run(installedBin, ["--help"], consumer);
  const version = run(installedBin, ["--version"], consumer).trim();
  if (version !== pkg.version) {
    throw new Error(`installed woof --version printed ${version}, expected ${pkg.version}`);
  }
  // PATH holds node but neither herdr nor claude: the smoke never runs the real Herdr CLI.
  const pathDir = join(workDir, "path");
  mkdirSync(pathDir);
  symlinkSync(process.execPath, join(pathDir, "node"));
  const doctor = run(installedBin, ["doctor"], consumer, {
    ...process.env,
    PATH: `${pathDir}:/usr/bin:/bin`,
  });
  if (!/^herdr: not found$/m.test(doctor)) {
    throw new Error(`installed woof doctor printed ${doctor}`);
  }
  submitRoundTrip(installedBin, consumer);
  snapshotCheck(consumer);
  loaderCheck(consumer);
  inspection(installedBin, consumer, workDir);
  run(installedBin, ["run", "start", "--help"], consumer);

  console.log("installed package entry point ok");
  console.log("installed woof --help ok");
  console.log("installed woof --version ok");
  console.log("installed woof doctor ok");
  console.log("installed herdr-woof/testing entry point ok");
  console.log("installed scripted runtime + store round trip ok");
  console.log("installed openAttempt + woof submit (accepted, duplicate) ok");
  console.log("installed readSnapshot ok");
  console.log("installed loadWorkflowDefinition + buildReviewWorkflow ok");
  console.log("installed woof config show, runs, status, events ok");
  console.log("installed woof run start --help ok");
  console.log("tarball ships the Claude Code plugin files ok");
} finally {
  rmSync(workDir, { force: true, recursive: true });
}

function submitRoundTrip(installedBin: string, consumer: string): void {
  const runDir = join(consumer, "run");
  // The scheduler opens attempts in-process; an agent only ever runs `woof submit`.
  const openScript = [
    'import { openAttempt } from "herdr-woof";',
    'const opened = await openAttempt({ runDir: process.argv[1], runId: "smoke-run", agentId: "smoke-worker", stageId: "report", visit: 1, attempt: 1, verdicts: ["pass"] });',
    "console.log(JSON.stringify(opened));",
  ].join("\n");
  const opened = JSON.parse(
    run("node", ["--input-type=module", "--eval", openScript, runDir], consumer),
  ) as { outcome: string; attempt: { artifactDir: string } };
  if (opened.outcome !== "opened") {
    throw new Error(`installed openAttempt returned outcome ${opened.outcome}`);
  }

  const content = "# Smoke report\n\nThe installed package accepted this artifact.\n";
  writeFileSync(join(opened.attempt.artifactDir, "report.md"), content);
  const envelopePath = join(consumer, "envelope.json");
  writeFileSync(
    envelopePath,
    JSON.stringify({
      schemaVersion: 1,
      runId: "smoke-run",
      agentId: "smoke-worker",
      stageId: "report",
      visit: 1,
      attempt: 1,
      status: "completed",
      verdict: "pass",
      artifact: {
        path: "artifacts/report/visit-1/attempt-1/report.md",
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    }),
  );

  const submitArgs = ["submit", "--run-dir", runDir, "--envelope", envelopePath];
  const first = JSON.parse(run(installedBin, submitArgs, consumer)) as SubmitJson;
  const second = JSON.parse(run(installedBin, submitArgs, consumer)) as SubmitJson;
  if (first.outcome !== "accepted" || second.outcome !== "duplicate") {
    throw new Error(`installed woof submit printed ${first.outcome}, then ${second.outcome}`);
  }
  if (
    first.receipt?.receiptId === undefined ||
    first.receipt.receiptId !== second.receipt?.receiptId
  ) {
    throw new Error("installed woof submit returned different receipts for identical submissions");
  }
}

/** Drives the installed scripted runtime and state store through one attempt. */
function scriptedStoreRoundTrip(consumer: string): void {
  const runDir = join(consumer, "scripted-run");
  const script = `
import { assignAgent, openAttempt, openRun, readSnapshot, recordDispatch, terminateRun } from "herdr-woof";
import { createScriptedRuntime } from "herdr-woof/testing";
const runDir = process.argv[1];
const fail = (code, value) => { console.error(JSON.stringify(value)); process.exit(code); };
const plan = {
  workflow: { name: "smoke", version: "1" },
  agents: [{ agentId: "smoke-worker", role: "worker", kind: "claude", model: null }],
  stages: [{ stageId: "report", agentId: "smoke-worker", verdicts: [] }],
  limits: { maxAttemptsPerVisit: 1, maxVisitsPerStage: 1, maxRounds: 1, runTimeoutMs: 60000, readinessWaitMs: 60000, blockedWaitMs: 60000, deliveryTimeoutMs: 60000 },
};
const opened = await openRun({ runDir, runId: "smoke-scripted", plan });
if (opened.outcome !== "recorded") fail(1, opened);
const runtime = createScriptedRuntime({ agents: { "w-smoke": { timeline: [{ status: "idle" }] } } });
const pane = await runtime.openPane({ near: "current", cwd: runDir });
const handle = await runtime.startAgent({ runtimeName: "w-smoke", kind: "claude", paneId: pane.value.paneId, paneOwned: true, timeoutMs: 1000 });
const assigned = await assignAgent({ runDir, agentId: "smoke-worker", runtime: { adapter: "scripted", runtimeName: "w-smoke", paneId: handle.value.paneId } });
if (assigned.outcome !== "recorded") fail(2, assigned);
const attempt = await openAttempt({ runDir, runId: "smoke-scripted", agentId: "smoke-worker", stageId: "report", visit: 1, attempt: 1 });
if (attempt.outcome !== "opened") fail(3, attempt);
const delivery = await runtime.deliver(handle.value, "write the report", { timeoutMs: 1000 });
const dispatched = await recordDispatch({ runDir, agentId: "smoke-worker", stageId: "report", visit: 1, attempt: 1, delivery: delivery.outcome, reason: "observed_" + delivery.observation.lifecycle });
if (dispatched.outcome !== "recorded") fail(4, dispatched);
await terminateRun({ runDir, outcome: "cancelled", reason: "smoke" });
const snapshot = readSnapshot(runDir);
if (!snapshot.ok || snapshot.snapshot.status !== "cancelled" || snapshot.snapshot.stages[0].visits[0].attempts[0].status !== "abandoned") fail(5, snapshot);
`;
  run("node", ["--input-type=module", "--eval", script, runDir], consumer);
}

/** Loads a consumer-side .mjs workflow definition through the installed SDK. */
function loaderCheck(consumer: string): void {
  const definitionPath = join(consumer, "definition.mjs");
  writeFileSync(
    definitionPath,
    `export default {
  schemaVersion: 1, name: "smoke-definition", version: "1",
  validateInput: (value) => ({ ok: true, input: value }),
  resolveAgents: () => ({ writer: { kind: "claude", model: null, args: [] } }),
  resolveLimits: () => ({}), repository: () => "/repo",
  agents: [{ agentId: "writer", role: "writer" }], start: "draft", roundStage: null,
  stages: [{ kind: "agent", stageId: "draft", agentId: "writer", verdicts: [], artifactFile: "draft.md",
    onFailedStatus: "fail", bindsRevision: false,
    request: () => ({ goal: "g", instructions: "i", inputs: [] }),
    next: () => ({ decision: "pass", reason: "done", outcome: "completed" }) }],
  edges: { draft: ["completed"] },
};
`,
  );
  const script = [
    'import { buildReviewWorkflow, loadWorkflowDefinition, runWorkflow, validateWorkflowDefinition } from "herdr-woof";',
    "const loaded = await loadWorkflowDefinition(process.argv[1]);",
    'if (!loaded.ok || loaded.definition.name !== "smoke-definition") { console.error(JSON.stringify(loaded)); process.exit(1); }',
    "if (!validateWorkflowDefinition(buildReviewWorkflow).ok) process.exit(2);",
    'if (typeof runWorkflow !== "function") process.exit(3);',
  ].join("\n");
  run("node", ["--input-type=module", "--eval", script, definitionPath], consumer);
}

/** Reads the snapshot of the run the submit round trip created, through the installed SDK. */
function snapshotCheck(consumer: string): void {
  const script = [
    'import { readSnapshot } from "herdr-woof";',
    "console.log(JSON.stringify(readSnapshot(process.argv[1])));",
  ].join("\n");
  const shown = JSON.parse(
    run("node", ["--input-type=module", "--eval", script, join(consumer, "run")], consumer),
  ) as {
    ok: boolean;
    snapshot?: {
      runId: string;
      stages: Array<{ visits: Array<{ attempts: Array<{ status: string }> }> }>;
    };
  };
  if (
    !shown.ok ||
    shown.snapshot?.runId !== "smoke-run" ||
    shown.snapshot.stages[0]?.visits[0]?.attempts[0]?.status !== "accepted"
  ) {
    throw new Error(`installed readSnapshot returned ${JSON.stringify(shown)}`);
  }
}

/** Runs the installed inspection commands with a temporary HOME, never the operator's. */
function inspection(installedBin: string, consumer: string, scratch: string): void {
  const home = join(scratch, "home");
  mkdirSync(home);
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" };
  const json = (args: readonly string[]) =>
    JSON.parse(run(installedBin, args, consumer, env).trim().split("\n").at(-1) ?? "null") as {
      outcome?: string;
      kind?: string;
      exists?: boolean;
      runs?: Array<{ runId: string }>;
      status?: { runId: string; liveness: { owner: string } };
    };

  const config = json(["config", "show", "--project", consumer]);
  if (config.outcome !== "config")
    throw new Error(`installed woof config show: ${JSON.stringify(config)}`);
  const none = json(["runs", "--runs-dir", join(scratch, "no-runs")]);
  if (none.outcome !== "runs" || none.exists !== false) {
    throw new Error(`installed woof runs (missing dir): ${JSON.stringify(none)}`);
  }
  const listed = json(["runs", "--runs-dir", consumer, "--all"]);
  if (!listed.runs?.some((entry) => entry.runId === "smoke-run")) {
    throw new Error(`installed woof runs: ${JSON.stringify(listed)}`);
  }
  const status = json(["status", join(consumer, "run")]);
  if (status.status?.runId !== "smoke-run" || status.status.liveness.owner !== "unhosted") {
    throw new Error(`installed woof status: ${JSON.stringify(status)}`);
  }
  const end = json(["events", join(consumer, "run")]);
  if (end.kind !== "woof.events.end")
    throw new Error(`installed woof events: ${JSON.stringify(end)}`);
}

interface SubmitJson {
  outcome: string;
  receipt?: { receiptId: string };
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
  if (result.status !== 0) {
    const detail = result.error?.message ?? `${result.stdout}\n${result.stderr}`;
    throw new Error(`${command} ${args.join(" ")} failed:\n${detail}`);
  }
  return result.stdout;
}
