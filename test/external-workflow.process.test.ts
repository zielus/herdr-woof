import { spawnSync } from "node:child_process";
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
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cliPath, repoRoot } from "./helpers/process.js";

/**
 * An external, project-authored workflow (p5 D4/§3.2): `scribe` lives in the
 * project's `.woof/workflows/`, is never shipped by Woof, and must load, admit
 * and run through the same entry point the built-ins use. It exercises the
 * shapes neither built-in does — `roundStage: null`, no `limitDefaults`, an
 * agent id that is not its role, and a stage the engine has never seen.
 *
 * Every step is a real `node dist/cli.js` process with a temporary HOME and
 * GIT_CONFIG_GLOBAL=/dev/null.
 */
const fixture = join(repoRoot, "test", "fixtures", "workflows", "scribe.mjs");
const runtimeModule = join(repoRoot, "test", "fixtures", "scripted-runtime-module.mjs");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Json = Record<string, unknown>;

interface Env {
  root: string;
  home: string;
  repo: string;
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Woof Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

/**
 * A project repository whose `.woof/workflows/scribe.mjs` is **committed**, not
 * untracked: `revisionOf` fingerprints the work tree through a temporary index
 * with `git add --all`, so an untracked definition would move the tree
 * fingerprint the moment it appeared.
 */
function setup(): Env {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "woof-ext-")));
  dirs.push(root);
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  const target = join(repo, ".woof", "workflows", "scribe.mjs");
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(fixture, target);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return { root, home, repo };
}

function runWoof(env: Env, args: string[], extraEnv: Record<string, string> = {}) {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: env.home,
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  for (const key of ["HERDR_PANE_ID", "HERDR_ENV", "WOOF_RUN_DIR"])
    Reflect.deleteProperty(childEnv, key);
  Object.assign(childEnv, extraEnv);
  const result = spawnSync("node", [cliPath, ...args], {
    cwd: env.root,
    env: childEnv,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  const last = result.stdout.trim().split("\n").at(-1) ?? "";
  let json: Json | undefined;
  try {
    json = JSON.parse(last) as Json;
  } catch {
    json = undefined;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

let runCount = 0;

function startScribe(env: Env, input: Json, extraEnv: Record<string, string> = {}) {
  runCount += 1;
  const runDir = join(env.root, `run-${runCount}`);
  const inputPath = join(env.root, `input-${runCount}.json`);
  writeFileSync(inputPath, JSON.stringify(input));
  const out = runWoof(
    env,
    [
      "run",
      "start",
      "--workflow",
      "scribe",
      "--host",
      "foreground",
      "--project",
      env.repo,
      "--input",
      inputPath,
      "--run-dir",
      runDir,
      "--run-id",
      `scribe-${runCount}`,
      "--poll-ms",
      "2",
      "--runtime-module",
      runtimeModule,
    ],
    { WOOF_TEST_SCRIPT: "happy", ...extraEnv },
  );
  return { ...out, runDir };
}

describe("an external project workflow loads, admits and runs", () => {
  it("runs scribe end to end from the project .woof, with roundStage null and no limitDefaults", () => {
    const env = setup();
    const sideEffect = join(env.root, "side-effect.log");
    const out = startScribe(
      env,
      { schemaVersion: 1, repo: env.repo, note: "The fixture is unchanged." },
      { WOOF_TEST_SIDE_EFFECT: sideEffect },
    );
    expect(out.status, out.stdout + out.stderr).toBe(0);
    expect(out.json).toMatchObject({
      outcome: "run",
      result: { outcome: "completed", limit: null },
    });

    const records = readFileSync(join(out.runDir, "journal.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Json);
    const plan = (records[0] as { plan: { agents: Json[]; limits: Json; checks: string[] } }).plan;

    // One agent, whose id is not its role name.
    expect(plan.agents).toEqual([
      {
        agentId: "scribe",
        role: "builder",
        kind: "claude",
        model: null,
        args: ["--add-dir", out.runDir],
      },
    ]);
    expect(plan.checks).toEqual([]);
    // The complete limit set came from resolveLimits, not from limitDefaults.
    expect(plan.limits).toMatchObject({
      maxAttemptsPerVisit: 1,
      maxVisitsPerStage: 1,
      maxRounds: 1,
      runTimeoutMs: 900_000,
      deliveryTimeoutMs: 60_000,
    });

    // A stage the engine has never seen, and a run with no rounds at all.
    const gates = records
      .filter((record) => record["type"] === "gate.recorded")
      .map((record) => `${String(record["gate"])}:${String(record["reason"])}`);
    expect(gates).toEqual(["note:noted"]);
    expect(
      records.filter((record) => record["type"] === "attempt.opened").map((r) => r["stageId"]),
    ).toEqual(["note"]);
    expect(
      readFileSync(join(out.runDir, "accepted", "note", "visit-1", "attempt-1", "note.md"), "utf8"),
    ).not.toBe("");

    // The module body ran exactly once, in the process that hosted the run.
    expect(readFileSync(sideEffect, "utf8")).toBe("evaluated\n");

    // The run is not in the built-in catalog: its recorded workflow is the project file.
    const config = JSON.parse(readFileSync(join(out.runDir, "config.json"), "utf8")) as {
      workflow: { source: string; path: string; sha256: string; value: Json };
    };
    expect(config.workflow).toMatchObject({
      source: "project",
      path: join(env.repo, ".woof", "workflows", "scribe.mjs"),
      // config show never imports the module, so admission is what supplies the version.
      value: { name: "scribe", version: "1" },
    });
    expect(config.workflow.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it("reports the project workflow in config show with version null, without importing it", () => {
    const env = setup();
    const marker = join(env.root, "imported.log");
    const out = runWoof(env, ["config", "show", "--project", env.repo, "--workflow", "scribe"], {
      WOOF_TEST_SIDE_EFFECT: marker,
    });
    expect(out.status, out.stdout + out.stderr).toBe(0);
    const configuration = (out.json ?? {})["configuration"] as { workflow: Json };
    const workflow = configuration["workflow"] as {
      source: string;
      path: string;
      sha256: string;
      value: { name: string; version: string | null };
      shadowed: Json[];
    };
    expect(workflow.source).toBe("project");
    expect(workflow.path).toBe(join(env.repo, ".woof", "workflows", "scribe.mjs"));
    expect(workflow.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Not executed: the version is unknown until the run host loads the module.
    expect(workflow.value).toEqual({ name: "scribe", version: null });
    // Shadows no built-in: `scribe` is not in the catalog.
    expect(workflow.shadowed).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses the input the definition refuses, without opening a run", () => {
    const env = setup();
    const out = startScribe(env, { schemaVersion: 1, repo: env.repo, note: "  ", extra: 1 });
    expect(out.status, out.stdout + out.stderr).toBe(2);
    expect(out.json).toMatchObject({ outcome: "rejected", reason: "input_invalid" });
    const details = ((out.json ?? {})["details"] ?? []) as Array<{ field: string }>;
    expect(details.map((detail) => detail.field).toSorted()).toEqual(["extra", "note"]);
    expect(existsSync(join(out.runDir, "journal.jsonl"))).toBe(false);
  });

  it("refuses a sibling definition whose callback is missing, naming the callback", () => {
    const env = setup();
    const broken = join(env.repo, ".woof", "workflows", "quill.mjs");
    writeFileSync(
      broken,
      readFileSync(fixture, "utf8")
        .replace('name: "scribe"', 'name: "quill"')
        .replace("  validateInput,\n", "  validateInput: null,\n"),
    );
    git(env.repo, "add", "-A");
    git(env.repo, "commit", "-q", "-m", "broken sibling");
    const runDir = join(env.root, "run-broken");
    const inputPath = join(env.root, "input-broken.json");
    writeFileSync(inputPath, JSON.stringify({ schemaVersion: 1, repo: env.repo, note: "hi" }));
    const out = runWoof(env, [
      "run",
      "start",
      "--workflow",
      "quill",
      "--host",
      "foreground",
      "--project",
      env.repo,
      "--input",
      inputPath,
      "--run-dir",
      runDir,
      "--run-id",
      "quill-run",
      "--runtime-module",
      runtimeModule,
    ]);
    expect(out.status, out.stdout + out.stderr).toBe(2);
    expect(out.json).toMatchObject({ reason: "definition_invalid" });
    expect(JSON.stringify(out.json)).toContain("validateInput");

    // The valid sibling in the same directory is unaffected.
    const ok = startScribe(env, { schemaVersion: 1, repo: env.repo, note: "still fine" });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
  }, 60_000);

  it("keeps the committed fixture copy and the project copy byte-identical", () => {
    const env = setup();
    expect(readFileSync(join(env.repo, ".woof", "workflows", "scribe.mjs"), "utf8")).toBe(
      readFileSync(fixture, "utf8"),
    );
  });
});
