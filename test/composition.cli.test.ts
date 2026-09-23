import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { expectFoldEqualsSnapshot } from "./helpers/fold.js";
import { cliPath, repoRoot } from "./helpers/process.js";

// "A workflow can be a step" (docs/design/composition.md) as real processes: a project workflow
// whose steps run the project's `scribe` workflow as child runs hosted in the same process, with
// the scripted runtime standing in for agents. Child runs are ordinary sibling runs linked both
// ways; their results are the steps' accepted outputs; cancellation follows the parent; a step
// that keeps failing is bounded by the parent's own visit limit.
const runtimeModule = join(repoRoot, "test", "fixtures", "scripted-runtime-module.mjs");
const failingStopModule = join(repoRoot, "test", "fixtures", "failing-stop-runtime-module.mjs");
const fixtures = join(repoRoot, "test", "fixtures", "workflows");

type Json = Record<string, any>; // oxlint-disable-line no-explicit-any

const dirs: string[] = [];
const procs: ChildProcess[] = [];
afterEach(async () => {
  for (const proc of procs.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }
  await delay(50);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface Ws {
  root: string;
  home: string;
  repo: string;
  runs: string;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Woof Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "maintenance.auto=false",
      ...args,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
  );
  expect(result.status, result.stderr).toBe(0);
}

function setup(): Ws {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "woof-composition-")));
  dirs.push(root);
  const ws = { root, home: join(root, "home"), repo: join(root, "repo"), runs: join(root, "runs") };
  mkdirSync(ws.home);
  mkdirSync(join(ws.repo, ".woof", "workflows"), { recursive: true });
  git(ws.repo, "init", "-q", "-b", "main");
  writeFileSync(join(ws.repo, "README.md"), "fixture\n");
  git(ws.repo, "add", "README.md");
  git(ws.repo, "commit", "-q", "-m", "init");
  for (const name of ["scribe.mjs", "composite.mjs"])
    copyFileSync(join(fixtures, name), join(ws.repo, ".woof", "workflows", name));
  return ws;
}

function env(ws: Ws, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: ws.home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    WOOF_TEST_SCRIPT: "happy",
    WOOF_HOST_HEARTBEAT_MS: "200",
    ...extra,
  };
  for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "WOOF_RUN_DIR"])
    Reflect.deleteProperty(childEnv, key);
  return childEnv;
}

function args(ws: Ws, runId: string, input: Json): string[] {
  const path = join(ws.root, `${runId}.json`);
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, repo: ws.repo, ...input }));
  return [
    cliPath,
    "run",
    "start",
    "--input",
    path,
    "--workflow",
    "composite",
    "--project",
    ws.repo,
    "--runs-dir",
    ws.runs,
    "--run-id",
    runId,
    "--host",
    "foreground",
    "--runtime-module",
    runtimeModule,
    "--poll-ms",
    "5",
    "--plain",
  ];
}

function run(ws: Ws, runId: string, input: Json, extra: Record<string, string> = {}) {
  const result = spawnSync("node", args(ws, runId, input), {
    cwd: ws.root,
    env: env(ws, extra),
    encoding: "utf8",
    timeout: 90_000,
  });
  const json = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Json;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function woof(ws: Ws, cli: string[]) {
  return spawnSync("node", [cliPath, ...cli], { cwd: ws.root, env: env(ws), encoding: "utf8" });
}

function journal(runDir: string): Json[] {
  return readFileSync(join(runDir, "journal.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Json);
}

const ofType = (records: Json[], type: string) => records.filter((item) => item["type"] === type);
const terminated = (runDir: string) =>
  existsSync(join(runDir, "journal.jsonl")) && ofType(journal(runDir), "run.terminated").length > 0;

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    // oxlint-disable-next-line no-await-in-loop
    await delay(25);
  }
}

/** A foreground composite run in the background, and a promise of its exit code. */
function startAsync(ws: Ws, runId: string, input: Json, extra: Record<string, string> = {}) {
  const proc = spawn("node", args(ws, runId, input), { cwd: ws.root, env: env(ws, extra) });
  procs.push(proc);
  let stdout = "";
  proc.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  const exited = new Promise<{ code: number | null; stdout: string }>((resolve) =>
    proc.on("close", (code) => resolve({ code, stdout })),
  );
  return { proc, exited };
}

/** The child run's agent was sent its task (the scripted `hang` agent never answers). */
const dispatched = (runDir: string) =>
  existsSync(join(runDir, "journal.jsonl")) &&
  ofType(journal(runDir), "request.dispatched").length > 0;

describe("a workflow can be a step", () => {
  it("W1: steps run as linked sibling child runs; their results and copied artifacts are the steps' accepted outputs; later stages read them", async () => {
    const ws = setup();
    const out = run(ws, "w1", { note: "hello" });
    expect(out.status, out.stdout + out.stderr).toBe(0);
    expect(out.json["result"]).toMatchObject({ outcome: "completed", reason: "summarized" });
    const parentDir = join(ws.runs, "w1");
    const firstDir = join(ws.runs, "w1.first.1");
    const secondDir = join(ws.runs, "w1.second.1");
    const records = journal(parentDir);

    // The parent journals each step: opened with the child's identity, accepted with its result.
    const opened = ofType(records, "stage.child_opened");
    expect(opened.map((item) => [item["stageId"], item["child"]])).toEqual([
      [
        "first",
        { runId: "w1.first.1", runDir: firstDir, workflow: { name: "scribe", version: "1" } },
      ],
      [
        "second",
        { runId: "w1.second.1", runDir: secondDir, workflow: { name: "scribe", version: "1" } },
      ],
    ]);
    const results = ofType(records, "stage.child_result");
    expect(results.map((item) => [item["stageId"], item["verdict"], item["child"]])).toEqual([
      ["first", "completed", { runId: "w1.first.1", outcome: "completed", reason: "noted" }],
      ["second", "completed", { runId: "w1.second.1", outcome: "completed", reason: "noted" }],
    ]);
    // The step's accepted artifact is the child's RunResult; each child artifact is copied, hashed.
    const first = results[0] as Json;
    const resultCopy = readFileSync(join(parentDir, first["artifact"]["acceptedPath"]));
    expect(createHash("sha256").update(resultCopy).digest("hex")).toBe(first["artifact"]["sha256"]);
    expect(JSON.parse(resultCopy.toString("utf8"))).toMatchObject({
      kind: "woof.run.result",
      runId: "w1.first.1",
      outcome: "completed",
    });
    expect(first["artifacts"]).toEqual([
      {
        stageId: "note",
        acceptedPath: "accepted/first/visit-1/attempt-1/note/note.md",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        bytes: expect.any(Number),
      },
    ]);
    const childNote = readFileSync(join(firstDir, "accepted/note/visit-1/attempt-1/note.md"));
    expect(readFileSync(join(parentDir, first["artifacts"][0]["acceptedPath"]))).toEqual(childNote);

    // Declarative mapping: the second child's input was built from the first step's result.
    const secondInput = JSON.parse(readFileSync(join(secondDir, "input.json"), "utf8")) as Json;
    expect(secondInput["note"]).toBe(
      `after w1.first.1 (completed), note sha256 ${first["artifacts"][0]["sha256"]}`,
    );
    // A later agent stage receives the copied child artifact and the step's result by path.
    const request = readFileSync(
      join(parentDir, "requests/note/visit-1/attempt-1/request.md"),
      "utf8",
    );
    expect(request).toContain(
      `- first note: ${join(parentDir, "accepted/first/visit-1/attempt-1/note/note.md")} (stage first (child stage note) visit 1 attempt 1`,
    );
    expect(request).toContain(
      `- second result: ${join(parentDir, "accepted/second/visit-1/attempt-1/result.json")}`,
    );

    // Each child is an ordinary run: linked back, in the parent's checkout, with its own host.
    for (const [dir, stageId] of [
      [firstDir, "first"],
      [secondDir, "second"],
    ] as const) {
      const child = journal(dir);
      expect(child[0]).toMatchObject({
        type: "run.opened",
        parent: { runId: "w1", runDir: parentDir, stageId, visit: 1, attempt: 1 },
        checkout: { mode: "current", path: ws.repo, inherited: true, created: false },
      });
      expect(ofType(child, "host.claimed")[0]?.["pid"]).toBe(
        ofType(records, "host.claimed")[0]?.["pid"],
      );
      expect(ofType(child, "host.exited")).toHaveLength(1);
      expect(existsSync(join(dir, "host.log"))).toBe(true);
      await expectFoldEqualsSnapshot(dir, env(ws));
    }
    const snapshot = await expectFoldEqualsSnapshot(parentDir, env(ws));
    const first1 = snapshot["stages"].find((stage: Json) => stage["stageId"] === "first");
    expect(first1).toMatchObject({ agentId: null, workflow: "scribe" });
    expect(first1["visits"][0]["attempts"][0]).toMatchObject({
      agentId: null,
      status: "accepted",
      child: { runId: "w1.first.1", runDir: firstDir, outcome: "completed" },
    });

    // Inspection: woof runs links the children to their parent; the view shows the steps.
    const listed = JSON.parse(woof(ws, ["runs", "--runs-dir", ws.runs]).stdout) as Json;
    const byId = Object.fromEntries(listed["runs"].map((entry: Json) => [entry["runId"], entry]));
    expect(byId["w1.first.1"]["parent"]).toEqual({ runId: "w1", stageId: "first", visit: 1 });
    expect(byId["w1"]).not.toHaveProperty("parent");
    const view = woof(ws, ["watch", parentDir]).stdout;
    expect(view).toContain("stages note, first (workflow scribe), second (workflow scribe)");
    expect(view).toMatch(/→ run {8}first {3}Workflow started · scribe v1 → run w1\.first\.1/);
    expect(view).toMatch(/✓ run {8}first {3}Workflow completed · run w1\.first\.1/);
    expect(view).toContain("2 workflow steps · 0 reviews · 0 repairs");
    expect(woof(ws, ["watch", firstDir]).stdout).toContain("parent w1 · step first");
  }, 120_000);

  it("W2: a mapping the child workflow refuses fails the parent with child_rejected before any child run exists", () => {
    const ws = setup();
    // The fixture maps `note`; scribe refuses an unknown field, so a `checkout` other than current
    // (nested runs inherit) is the refusal here.
    writeFileSync(
      join(ws.repo, ".woof", "workflows", "composite.mjs"),
      readFileSync(join(fixtures, "composite.mjs"), "utf8").replace(
        "input: (ctx) => ({ schemaVersion: 1, repo: ctx.input.repo, note: ctx.input.note }),",
        'input: (ctx) => ({ schemaVersion: 1, repo: ctx.input.repo, note: ctx.input.note, checkout: { mode: "worktree" } }),',
      ),
    );
    const out = run(ws, "w2", { note: "hello" });
    expect(out.status, out.stdout + out.stderr).toBe(4);
    expect(out.json["result"]["reason"]).toMatch(
      /^child_rejected: first: input_invalid: a nested run inherits its parent's checkout/,
    );
    expect(existsSync(join(ws.runs, "w2.first.1", "journal.jsonl"))).toBe(false);
    expect(ofType(journal(join(ws.runs, "w2")), "stage.child_opened")).toEqual([]);
  }, 60_000);

  it("W3: cancelling the parent (woof run cancel) cancels its running child, which records why", async () => {
    const ws = setup();
    const parentDir = join(ws.runs, "w3");
    const childDir = join(ws.runs, "w3.first.1");
    const started = startAsync(ws, "w3", { note: "hello" }, { WOOF_TEST_SCRIPT: "hang" });
    await waitFor(() => dispatched(childDir), "the child's agent to get its task");
    const cancel = woof(ws, ["run", "cancel", parentDir]);
    expect(cancel.status, cancel.stdout + cancel.stderr).toBe(0);
    const exited = await started.exited;
    expect(exited.code).toBe(6);
    expect(ofType(journal(parentDir), "run.terminated")[0]).toMatchObject({ outcome: "cancelled" });
    // The child ended too, as a cancellation its parent caused, before the host let go.
    const child = journal(childDir);
    expect(ofType(child, "run.terminated")[0]).toMatchObject({
      outcome: "cancelled",
      reason: "parent run ended",
    });
    expect(ofType(child, "host.exited")).toHaveLength(1);
    await expectFoldEqualsSnapshot(childDir, env(ws));
  }, 90_000);

  it("W4: cancelling only the child is the step's result; the parent's next routes on it (here: fail)", async () => {
    const ws = setup();
    const parentDir = join(ws.runs, "w4");
    const childDir = join(ws.runs, "w4.first.1");
    const started = startAsync(ws, "w4", { note: "hello" }, { WOOF_TEST_SCRIPT: "hang" });
    await waitFor(() => dispatched(childDir), "the child's agent to get its task");
    expect(woof(ws, ["run", "cancel", childDir]).status).toBe(0);
    const exited = await started.exited;
    expect(exited.code).toBe(4);
    const records = journal(parentDir);
    expect(ofType(records, "stage.child_result")[0]).toMatchObject({
      verdict: "cancelled",
      status: "failed",
      child: { runId: "w4.first.1", outcome: "cancelled" },
    });
    expect(ofType(records, "gate.recorded")[0]).toMatchObject({
      gate: "first",
      decision: "reject",
      reason: "child_cancelled",
      verdict: "cancelled",
      next: { outcome: "failed" },
    });
    await expectFoldEqualsSnapshot(parentDir, env(ws));
  }, 90_000);

  it("W5: a step that routes back to itself is bounded by the parent's maxVisitsPerStage", async () => {
    const ws = setup();
    const parentDir = join(ws.runs, "w5");
    const started = startAsync(
      ws,
      "w5",
      { note: "hello", on: "retry", limits: { maxVisitsPerStage: 2 } },
      { WOOF_TEST_SCRIPT: "hang" },
    );
    for (const visit of [1, 2]) {
      const childDir = join(ws.runs, `w5.first.${visit}`);
      // oxlint-disable-next-line no-await-in-loop
      await waitFor(() => dispatched(childDir), `child visit ${visit} to get its task`);
      expect(woof(ws, ["run", "cancel", childDir]).status).toBe(0);
    }
    const exited = await started.exited;
    expect(exited.code).toBe(5);
    const records = journal(parentDir);
    expect(ofType(records, "stage.child_opened").map((item) => item["child"]["runId"])).toEqual([
      "w5.first.1",
      "w5.first.2",
    ]);
    expect(ofType(records, "run.terminated")[0]).toMatchObject({
      outcome: "exhausted",
      limit: "maxVisitsPerStage",
    });
    expect(terminated(join(ws.runs, "w5.first.2"))).toBe(true);
    expect(existsSync(join(ws.runs, "w5.first.3"))).toBe(false);
  }, 90_000);

  it("W6: a child that completed but could not stop an agent pane fails the parent instead of starting the next step", () => {
    const ws = setup();
    const result = spawnSync(
      "node",
      args(ws, "w6", { note: "hello" }).map((arg) =>
        arg === runtimeModule ? failingStopModule : arg,
      ),
      { cwd: ws.root, env: env(ws), encoding: "utf8", timeout: 90_000 },
    );
    const json = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Json;
    expect(result.status, result.stdout + result.stderr).toBe(4);
    expect(json["result"]["reason"]).toMatch(
      /^child_error: first visit 1: runtime_cleanup_failed: .*\(child outcome completed\)$/,
    );
    const parent = journal(join(ws.runs, "w6"));
    expect(ofType(parent, "stage.child_result")).toEqual([]);
    expect(existsSync(join(ws.runs, "w6.second.1"))).toBe(false);
    // The child's own host records the infrastructure failure as exit 3.
    expect(ofType(journal(join(ws.runs, "w6.first.1")), "host.exited")[0]).toMatchObject({
      exitCode: 3,
    });
  }, 60_000);
});
