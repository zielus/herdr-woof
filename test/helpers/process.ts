// Real-process helpers: every behavior path spawns `node` against the built
// package (dist/), never an import of src/ inside the test runner.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const cliPath = join(repoRoot, "dist", "cli.js");
export const distIndexUrl = pathToFileURL(join(repoRoot, "dist", "index.js")).href;

export const CONTENT = "# Report\n\nThe change set was reviewed and no blocking findings remain.\n";

export interface ReceiptJson {
  receiptId: string;
  seq: number;
  runId: string;
  agentId: string;
  stageId: string;
  visit: number;
  attempt: number;
  acceptedAt: string;
  envelopeDigest: string;
  artifact: { path: string; sha256: string; bytes: number; acceptedPath: string };
}

export interface CliJson {
  outcome: string;
  reason?: string;
  message?: string;
  details?: Array<{ field: string; message: string }>;
  receipt?: ReceiptJson;
  attempt?: { artifactDir: string; seq: number; paneId?: string };
}

export interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  json: CliJson | undefined;
}

export interface RunOptions {
  /** Extra environment; `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
  input?: string;
  /** Kill the child after this many ms, so a regression that blocks fails instead of hanging. */
  timeoutMs?: number;
}

export interface JournalLine {
  schemaVersion: number;
  seq: number;
  ts: string;
  type: string;
  reason?: string;
  receiptId?: string;
  acceptedSeq?: number;
  paneId?: string;
  envelopeDigest?: string;
  identity?: Record<string, unknown>;
  artifact?: { path: string; sha256: string; bytes: number; acceptedPath: string };
}

export type EnvelopeJson = Record<string, unknown> & {
  artifact: { path: string; sha256: string };
};

let testHome: string | undefined;

/** A per-test-process HOME, so no child reads the operator's ~/.woof or ~/.claude.json (p4). */
function childHome(): string {
  testHome ??= mkdtempSync(join(tmpdir(), "woof-test-home-"));
  return testHome;
}

function childEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  // Tests may run inside a Herdr pane; never inherit the caller's run or pane.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: childHome() };
  env["HERDR_PANE_ID"] = undefined;
  // A test run inside Herdr must not leak the developer's workspace into `tab create` argv.
  env["HERDR_WORKSPACE_ID"] = undefined;
  env["WOOF_RUN_DIR"] = undefined;
  Object.assign(env, overrides);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) Reflect.deleteProperty(env, key);
  }
  return env;
}

function toResult(status: number | null, stdout: string, stderr: string): ProcessResult {
  const last = stdout.trim().split("\n").at(-1) ?? "";
  let json: CliJson | undefined;
  try {
    json = last === "" ? undefined : (JSON.parse(last) as CliJson);
  } catch {
    json = undefined;
  }
  return { status, stdout, stderr, json };
}

/** Runs `node dist/cli.js <args>` synchronously. */
export function woof(args: readonly string[], options: RunOptions = {}): ProcessResult {
  const result = spawnSync("node", [cliPath, ...args], {
    encoding: "utf8",
    env: childEnv(options.env),
    cwd: repoRoot,
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  });
  return toResult(result.status, result.stdout, result.stderr);
}

/** Runs `node dist/cli.js <args>` without blocking, for concurrency tests. */
export function woofAsync(
  args: readonly string[],
  options: RunOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, ...args], { env: childEnv(options.env), cwd: repoRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve(toResult(status, stdout, stderr)));
    child.stdin.end(options.input ?? "");
  });
}

/** Runs an ES module script in a child `node` process; extra args land in process.argv[1..]. */
export function runNode(
  script: string,
  args: readonly string[] = [],
  options: RunOptions = {},
): ProcessResult {
  const result = spawnSync("node", ["--input-type=module", "--eval", script, ...args], {
    encoding: "utf8",
    env: childEnv(options.env),
    cwd: repoRoot,
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  });
  return toResult(result.status, result.stdout, result.stderr);
}

const runDirs: string[] = [];

export function makeRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "woof-run-"));
  runDirs.push(dir);
  return dir;
}

export function cleanupRunDirs(): void {
  for (const dir of runDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export interface AttemptSpec {
  run?: string;
  agent?: string;
  stage?: string;
  visit?: number;
  attempt?: number;
  verdicts?: string;
  pane?: string;
}

export function openAttempt(runDir: string, spec: AttemptSpec = {}): ProcessResult {
  const args = [
    "attempt",
    "open",
    "--run-dir",
    runDir,
    "--run",
    spec.run ?? "run-1",
    "--agent",
    spec.agent ?? "worker",
    "--stage",
    spec.stage ?? "report",
    "--visit",
    String(spec.visit ?? 1),
    "--attempt",
    String(spec.attempt ?? 1),
    "--verdicts",
    spec.verdicts ?? "pass,fail",
  ];
  if (spec.pane !== undefined) args.push("--pane", spec.pane);
  return woof(args);
}

/**
 * Opens an attempt declaring an artifact verdict marker (p5 D5), through the
 * compiled `openAttempt` in a child process. `woof attempt open` has no flag for
 * it: the marker is the scheduler's to pass, from the stage that declares it.
 */
export function openAttemptWithMarker(
  runDir: string,
  marker: string,
  spec: AttemptSpec = {},
): void {
  const out = runSdk<{ outcome: string }>(
    runDir,
    `out = await openAttempt({ runDir, ...input });`,
    {
      runId: spec.run ?? "run-1",
      agentId: spec.agent ?? "worker",
      stageId: spec.stage ?? "report",
      visit: spec.visit ?? 1,
      attempt: spec.attempt ?? 1,
      verdicts:
        spec.verdicts === undefined
          ? ["pass", "fail"]
          : spec.verdicts === ""
            ? []
            : spec.verdicts.split(","),
      artifactVerdictMarker: marker,
      ...(spec.pane !== undefined ? { paneId: spec.pane } : {}),
    },
  );
  if (out.outcome !== "opened") throw new Error(`openAttempt: ${JSON.stringify(out)}`);
}

/** Opens an attempt and fails loudly if the CLI does not report it opened. */
export function openAttemptOk(runDir: string, spec: AttemptSpec = {}): ProcessResult {
  const result = openAttempt(runDir, spec);
  if (result.status !== 0 || result.json?.outcome !== "opened") {
    throw new Error(`attempt open failed (${result.status}): ${result.stdout}${result.stderr}`);
  }
  return result;
}

export function artifactRel(stage = "report", visit = 1, attempt = 1, name = "report.md"): string {
  return `artifacts/${stage}/visit-${visit}/attempt-${attempt}/${name}`;
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Writes an artifact under the run directory and returns its sha256. */
export function writeArtifact(runDir: string, rel: string, content: string | Uint8Array): string {
  const path = join(runDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return sha256(content);
}

export function envelopeFor(overrides: Record<string, unknown> = {}): EnvelopeJson {
  return {
    schemaVersion: 1,
    runId: "run-1",
    agentId: "worker",
    stageId: "report",
    visit: 1,
    attempt: 1,
    status: "completed",
    verdict: "pass",
    artifact: { path: artifactRel(), sha256: sha256(CONTENT) },
    ...overrides,
  };
}

let envelopeCount = 0;

export function writeEnvelope(runDir: string, envelope: Record<string, unknown> | string): string {
  envelopeCount += 1;
  const path = join(runDir, "outbox", `envelope-${envelopeCount}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof envelope === "string" ? envelope : JSON.stringify(envelope));
  return path;
}

export function submit(
  runDir: string,
  envelope: Record<string, unknown> | string,
  options: RunOptions = {},
): ProcessResult {
  return woof(
    ["submit", "--run-dir", runDir, "--envelope", writeEnvelope(runDir, envelope)],
    options,
  );
}

/** Opened attempt (run-1/worker/report/1/1) with a written artifact and matching envelope. */
export function readyAttempt(spec: AttemptSpec = {}): {
  runDir: string;
  envelope: EnvelopeJson;
  sha: string;
} {
  const runDir = makeRunDir();
  openAttemptOk(runDir, spec);
  const sha = writeArtifact(runDir, artifactRel(), CONTENT);
  return { runDir, envelope: envelopeFor({ artifact: { path: artifactRel(), sha256: sha } }), sha };
}

export function journal(runDir: string): JournalLine[] {
  return readFileSync(join(runDir, "journal.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as JournalLine);
}

export function ofType(lines: readonly JournalLine[], type: string): JournalLine[] {
  return lines.filter((line) => line.type === type);
}

/** File URL of a compiled module, relative to dist/, e.g. "state/store.js". */
export function distUrl(rel: string): string {
  return pathToFileURL(join(repoRoot, "dist", rel)).href;
}

/** Runs an ES module script in a child `node` process without blocking. */
export function runNodeAsync(
  script: string,
  args: readonly string[] = [],
  options: RunOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--input-type=module", "--eval", script, ...args], {
      env: childEnv(options.env),
      cwd: repoRoot,
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve(toResult(status, stdout, stderr)));
    child.stdin.end(options.input ?? "");
  });
}

/**
 * A child script with the compiled store, snapshot, attempt, submit and journal
 * modules loaded. `body` sees `runDir` (argv[1]) and `input` (argv[2] as JSON)
 * and assigns the JSON-printed result to `out`.
 */
export function sdkScript(body: string): string {
  return `
const store = await import(${JSON.stringify(distUrl("state/store.js"))});
const snapshots = await import(${JSON.stringify(distUrl("state/snapshot.js"))});
const { openAttempt } = await import(${JSON.stringify(distUrl("submission/attempt.js"))});
const { submitResult } = await import(${JSON.stringify(distUrl("submission/submit.js"))});
const { readJournal } = await import(${JSON.stringify(distUrl("journal/journal.js"))});
const runDir = process.argv[1];
const input = process.argv[2] === undefined ? {} : JSON.parse(process.argv[2]);
let out;
${body}
console.log(JSON.stringify(out));
`;
}

/** Runs `sdkScript(body)` in a child process and returns its printed result. */
export function runSdk<T = Record<string, unknown>>(
  runDir: string,
  body: string,
  input?: unknown,
): T {
  const result = runNode(
    sdkScript(body),
    input === undefined ? [runDir] : [runDir, JSON.stringify(input)],
  );
  if (result.status !== 0) {
    throw new Error(`sdk script failed (${result.status}): ${result.stdout}${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null") as T;
}

/** Plan matching the CLI helper defaults: stage report is owned by worker with verdicts pass,fail. */
export function testPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workflow: { name: "report-review", version: "1" },
    agents: [
      { agentId: "worker", role: "writer", kind: "claude", model: null },
      { agentId: "reviewer", role: "reviewer", kind: "claude", model: null },
    ],
    stages: [
      { stageId: "report", agentId: "worker", verdicts: ["pass", "fail"] },
      { stageId: "review", agentId: "reviewer", verdicts: ["approve", "reject"] },
    ],
    limits: {
      maxAttemptsPerVisit: 2,
      maxVisitsPerStage: 3,
      maxRounds: 3,
      runTimeoutMs: 600_000,
      readinessWaitMs: 60_000,
      blockedWaitMs: 60_000,
      deliveryTimeoutMs: 10_000,
    },
    ...overrides,
  };
}

/** Opens run-1 with a plan through the store, failing loudly unless it is recorded. */
export function openPlannedRun(runDir: string, plan = testPlan()): void {
  const out = runSdk<{ outcome: string }>(
    runDir,
    `out = await store.openRun({ runDir, runId: "run-1", plan: input });`,
    plan,
  );
  if (out.outcome !== "recorded") throw new Error(`openRun: ${JSON.stringify(out)}`);
}

/** Terminates the run through the store, failing loudly unless it is recorded. */
export function terminateRunOk(runDir: string, outcome = "cancelled"): void {
  const out = runSdk<{ outcome: string }>(
    runDir,
    `out = await store.terminateRun({ runDir, outcome: input.outcome, reason: "test termination" });`,
    { outcome },
  );
  if (out.outcome !== "recorded") throw new Error(`terminateRun: ${JSON.stringify(out)}`);
}
