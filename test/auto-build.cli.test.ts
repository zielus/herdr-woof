import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
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

// The built-in `plan` and `auto-build` workflows (docs/design/composition.md, scenarios (a) and
// (c)) as real processes with the scripted runtime: the plan step's accepted plan.md reaches the
// build-review child as a digest-checked input artifact, both children work in the parent's
// checkout on one branch, a pure composite reads as running while its children run, and inputs
// are refused before any step runs.
const runtimeModule = join(repoRoot, "test", "fixtures", "scripted-runtime-module.mjs");

type Json = Record<string, any>; // oxlint-disable-line no-explicit-any

const dirs: string[] = [];
const procs: ChildProcess[] = [];
afterEach(async () => {
  for (const proc of procs.splice(0))
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
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

function git(cwd: string, ...args: string[]): string {
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
  return result.stdout;
}

function setup(): Ws {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "woof-auto-build-")));
  dirs.push(root);
  const ws = { root, home: join(root, "home"), repo: join(root, "repo"), runs: join(root, "runs") };
  mkdirSync(ws.home);
  mkdirSync(ws.repo);
  git(ws.repo, "init", "-q", "-b", "main");
  writeFileSync(join(ws.repo, "README.md"), "fixture\n");
  git(ws.repo, "add", "-A");
  git(ws.repo, "commit", "-q", "-m", "init");
  return ws;
}

const task = {
  title: "Change the fixture",
  description: "Write src/change.txt.",
  acceptanceCriteria: ["the file exists"],
};

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

function args(ws: Ws, workflow: string, runId: string, input: Json): string[] {
  const path = join(ws.root, `${runId}.json`);
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, repo: ws.repo, task, ...input }));
  return [
    cliPath,
    "run",
    "start",
    "--input",
    path,
    "--workflow",
    workflow,
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

function run(
  ws: Ws,
  workflow: string,
  runId: string,
  input: Json,
  extra: Record<string, string> = {},
) {
  const result = spawnSync("node", args(ws, workflow, runId, input), {
    cwd: ws.root,
    env: env(ws, extra),
    encoding: "utf8",
    timeout: 120_000,
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
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    // oxlint-disable-next-line no-await-in-loop
    await delay(25);
  }
}

describe("plan and auto-build", () => {
  it("B1: auto-build plans, publishes the plan on the branch, then builds and reviews with the accepted plan as a checked input", async () => {
    const ws = setup();
    const out = run(
      ws,
      "auto-build",
      "b1",
      { publish: { path: "docs/plans/change.md" } },
      { WOOF_TEST_PUBLISH: "docs/plans/change.md" },
    );
    expect(out.status, out.stdout + out.stderr).toBe(0);
    expect(out.json["result"]).toMatchObject({ outcome: "completed", reason: "built" });
    const parentDir = join(ws.runs, "b1");
    const planDir = join(ws.runs, "b1.plan.1");
    const buildDir = join(ws.runs, "b1.build.1");

    // A pure composite: no agents of its own, two workflow steps.
    const opened = journal(parentDir)[0] as Json;
    expect(opened["plan"]).toMatchObject({
      agents: [],
      stages: [],
      workflows: [
        { stageId: "plan", workflow: "plan" },
        { stageId: "build", workflow: "build-review" },
      ],
    });
    expect(ofType(journal(parentDir), "gate.recorded").map((gate) => gate["reason"])).toEqual([
      "planned",
      "built",
    ]);

    // Scenario (a): the plan child checked that its plan is committed at HEAD.
    const planGates = ofType(journal(planDir), "gate.recorded");
    expect(planGates.map((gate) => [gate["gate"], gate["reason"]])).toEqual([
      ["plan", "planned"],
      ["published", "published_ok"],
      ["committed", "committed_ok"],
      ["matches", "matches_ok"],
      ["changed", "published"],
    ]);
    expect(git(ws.repo, "log", "--format=%s").split("\n")[0]).toBe("plan");

    // The accepted plan.md flows by digest: plan child → parent copy → build child's input artifact.
    const accepted = readFileSync(join(planDir, "accepted/plan/visit-1/attempt-1/plan.md"));
    const parentCopy = join(parentDir, "accepted/plan/visit-1/attempt-1/plan/plan.md");
    expect(readFileSync(parentCopy)).toEqual(accepted);
    const buildInput = JSON.parse(readFileSync(join(buildDir, "input.json"), "utf8")) as Json;
    expect(buildInput["inputs"]).toEqual([
      { label: "plan", path: parentCopy, sha256: sha256(accepted) },
    ]);
    const buildOpened = journal(buildDir)[0] as Json;
    expect(buildOpened["inputArtifacts"]).toEqual([
      {
        label: "plan",
        path: "inputs/1/plan.md",
        sha256: sha256(accepted),
        bytes: accepted.byteLength,
        source: parentCopy,
      },
    ]);
    expect(readFileSync(join(buildDir, "inputs/1/plan.md"))).toEqual(accepted);
    for (const stage of ["build", "review", "repair"]) {
      const request = readFileSync(
        join(buildDir, `requests/${stage}/visit-1/attempt-1/request.md`),
        "utf8",
      );
      expect(request, stage).toContain(
        `- plan: ${join(buildDir, "inputs/1/plan.md")} (run input artifact, sha256 ${sha256(accepted)})`,
      );
    }
    expect(
      readFileSync(join(buildDir, "requests/build/visit-1/attempt-1/request.md"), "utf8"),
    ).toContain("Follow the plan: it is the input labelled `plan`.");

    // Both children worked in the parent's checkout, the build child on top of the plan commit.
    for (const dir of [planDir, buildDir])
      expect((journal(dir)[0] as Json)["checkout"]).toMatchObject({
        mode: "current",
        path: ws.repo,
        inherited: true,
      });
    expect(readFileSync(join(ws.repo, "src", "change.txt"), "utf8")).toMatch(/^version \d/);
    for (const dir of [parentDir, planDir, buildDir]) await expectFoldEqualsSnapshot(dir, env(ws));

    const view = woof(ws, ["watch", parentDir]).stdout;
    expect(view).toContain("plan → build → completed");
    expect(view).toContain("plan: runs workflow plan · build: runs workflow build-review");
    expect(view).toContain("no planned agents");
  }, 120_000);

  it("B2: a pure composite reads as running while a child runs; cancelling it cancels the child", async () => {
    const ws = setup();
    const proc = spawn("node", args(ws, "auto-build", "b2", {}), {
      cwd: ws.root,
      env: env(ws, { WOOF_TEST_SCRIPT: "hang" }),
    });
    procs.push(proc);
    const exited = new Promise<number | null>((resolve) => proc.on("close", resolve));
    const parentDir = join(ws.runs, "b2");
    const planDir = join(ws.runs, "b2.plan.1");
    await waitFor(
      () =>
        existsSync(join(planDir, "journal.jsonl")) &&
        ofType(journal(planDir), "request.dispatched").length > 0,
      "the planner to get its task",
    );
    const status = JSON.parse(woof(ws, ["status", parentDir]).stdout) as Json;
    expect(status["status"]["status"]).toBe("running");
    const listed = JSON.parse(woof(ws, ["runs", "--runs-dir", ws.runs]).stdout) as Json;
    expect(
      listed["runs"].map((entry: Json) => [entry["runId"], entry["status"], entry["parent"]]),
    ).toEqual([
      ["b2.plan.1", "running", { runId: "b2", stageId: "plan", visit: 1 }],
      ["b2", "running", undefined],
    ]);
    expect(woof(ws, ["run", "cancel", parentDir]).status).toBe(0);
    expect(await exited).toBe(6);
    expect(ofType(journal(planDir), "run.terminated")[0]).toMatchObject({ outcome: "cancelled" });
  }, 90_000);

  it("B3: every child's input is validated up front: a bad field is refused before any step or run exists", () => {
    const ws = setup();
    const bad = run(ws, "auto-build", "b3", {
      verify: { command: "npm test", timeoutMs: 1000 },
      publish: { path: "../escape.md" },
      inputs: [],
    });
    expect(bad.status, bad.stdout + bad.stderr).toBe(2);
    expect(bad.json).toMatchObject({ outcome: "rejected", reason: "input_invalid" });
    expect(bad.json["details"].map((detail: Json) => detail["field"]).toSorted()).toEqual([
      "inputs",
    ]);
    const children = run(ws, "auto-build", "b3", {
      verify: { command: "npm test", timeoutMs: 1000 },
      publish: { path: "../escape.md" },
    });
    expect(children.status).toBe(2);
    expect(children.json["details"].map((detail: Json) => detail["field"]).toSorted()).toEqual([
      "publish.path",
      "verify.command",
    ]);
    expect(existsSync(join(ws.runs, "b3"))).toBe(false);
  }, 60_000);

  it("B4: a plan that is not committed sends the planner back, bounded by maxVisitsPerStage; a stale input artifact digest is refused", () => {
    const ws = setup();
    // The scripted planner does not commit (no WOOF_TEST_PUBLISH): the published check fails twice.
    const out = run(ws, "plan", "b4", { publish: { path: "docs/plan.md" } });
    expect(out.status, out.stdout + out.stderr).toBe(5);
    expect(out.json["result"]).toMatchObject({ outcome: "exhausted", limit: "maxVisitsPerStage" });
    const gates = ofType(journal(join(ws.runs, "b4")), "gate.recorded");
    expect(gates.map((gate) => [gate["gate"], gate["reason"]])).toEqual([
      ["plan", "planned"],
      ["published", "not_published"],
      ["plan", "planned"],
      ["published", "not_published"],
    ]);
    const second = readFileSync(
      join(ws.runs, "b4", "requests/plan/visit-2/attempt-1/request.md"),
      "utf8",
    );
    expect(second).toContain(
      "Publish the plan: docs/plan.md in the checkout's HEAD commit is not exactly your accepted plan.md (check published failed).",
    );
    expect(second).toContain("- publish check output:");

    // build-review with an input artifact whose bytes no longer match the named digest.
    const file = join(ws.root, "spec.md");
    writeFileSync(file, "spec\n");
    const stale = run(ws, "build-review", "b4-stale", {
      inputs: [{ label: "spec", path: file, sha256: "0".repeat(64) }],
    });
    expect(stale.status, stale.stdout + stale.stderr).toBe(2);
    expect(stale.json).toMatchObject({ reason: "input_invalid" });
    expect(stale.json["details"]).toEqual([
      {
        field: "inputArtifacts.spec",
        message: `${file} has sha256 ${sha256(Buffer.from("spec\n"))}, not ${"0".repeat(64)}`,
      },
    ]);
  }, 90_000);

  it("B5: an older plan already committed at the publish path does not count as publishing the accepted one", () => {
    const ws = setup();
    mkdirSync(join(ws.repo, "docs"), { recursive: true });
    writeFileSync(join(ws.repo, "docs", "plan.md"), "# an older plan\n");
    git(ws.repo, "add", "-A");
    git(ws.repo, "commit", "-q", "-m", "older plan");
    // The scripted planner does not publish: the path exists in HEAD, but not with its plan.
    const out = run(ws, "plan", "b5", { publish: { path: "docs/plan.md" } });
    expect(out.status, out.stdout + out.stderr).toBe(5);
    const gates = ofType(journal(join(ws.runs, "b5")), "gate.recorded");
    expect(gates.map((gate) => [gate["gate"], gate["reason"]])).toEqual([
      ["plan", "planned"],
      ["published", "published_ok"],
      ["committed", "committed_ok"],
      ["matches", "not_matches"],
      ["plan", "planned"],
      ["published", "published_ok"],
      ["committed", "committed_ok"],
      ["matches", "not_matches"],
    ]);
    const argv = gates.find((gate) => gate["gate"] === "matches")?.["check"]?.["command"];
    expect(argv).toEqual([
      "git",
      "diff",
      "--no-index",
      "--quiet",
      "--",
      join(ws.runs, "b5", "accepted/plan/visit-1/attempt-1/plan.md"),
      "docs/plan.md",
    ]);
  }, 90_000);

  it("B6: the exact plan already committed at the publish path fails the run: no new commit is possible", () => {
    const ws = setup();
    mkdirSync(join(ws.repo, "docs"), { recursive: true });
    // The bytes the scripted planner writes for visit 1, attempt 1.
    writeFileSync(
      join(ws.repo, "docs", "plan.md"),
      "# plan 1.1\n\n1. Write src/change.txt.\n2. Done when the file exists.\n",
    );
    git(ws.repo, "add", "-A");
    git(ws.repo, "commit", "-q", "-m", "same plan");
    const start = git(ws.repo, "rev-parse", "HEAD").trim();
    // The planner's commit finds nothing to commit: HEAD stays where the run started.
    const out = run(
      ws,
      "plan",
      "b6",
      { publish: { path: "docs/plan.md" } },
      { WOOF_TEST_PUBLISH: "docs/plan.md" },
    );
    expect(out.json["result"]).toMatchObject({ outcome: "failed", reason: "not_changed" });
    const gates = ofType(journal(join(ws.runs, "b6")), "gate.recorded");
    expect(gates.map((gate) => [gate["gate"], gate["reason"]])).toEqual([
      ["plan", "planned"],
      ["published", "published_ok"],
      ["committed", "committed_ok"],
      ["matches", "matches_ok"],
      ["changed", "not_changed"],
    ]);
    const argv = gates.find((gate) => gate["gate"] === "changed")?.["check"]?.["command"];
    expect(argv).toEqual(["git", "diff", "--quiet", start, "HEAD", "--", "docs/plan.md"]);
    expect(git(ws.repo, "rev-parse", "HEAD").trim()).toBe(start);
  }, 90_000);
});
