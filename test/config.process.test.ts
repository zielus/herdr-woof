import { spawnSync } from "node:child_process";
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
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cliPath, repoRoot } from "./helpers/process.js";

// §6(a) configuration matrix, `woof config show` rows: real `node dist/cli.js`
// processes with a temporary HOME, temporary git repositories and no global git config.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Json = Record<string, any>; // oxlint-disable-line no-explicit-any

interface Env {
  root: string;
  home: string;
  repo: string;
}

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
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

function setup(): Env {
  const root = temp("woof-config-");
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return { root, home, repo };
}

function writeJson(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

const role = (value: Json) => ({ schemaVersion: 1, kind: "claude", model: null, ...value });

function show(env: Env, args: string[], options: { cwd?: string; timeoutMs?: number } = {}) {
  return runWoof(env, ["config", "show", ...args], {}, options);
}

const runtimeModule = join(repoRoot, "test", "fixtures", "scripted-runtime-module.mjs");
let runCount = 0;

function baseInput(env: Env, overrides: Json = {}): Json {
  return {
    schemaVersion: 1,
    repo: env.repo,
    task: {
      title: "Change the fixture",
      description: "Write src/change.txt.",
      acceptanceCriteria: ["the file exists"],
    },
    ...overrides,
  };
}

/** `woof run start --host foreground` with the scripted runtime into a fresh run directory. */
function startForeground(
  env: Env,
  input: Json,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
) {
  runCount += 1;
  const runDir = join(env.root, `run-${runCount}`);
  const inputPath = writeJson(join(env.root, `input-${runCount}.json`), input);
  const out = runWoof(
    env,
    [
      "run",
      "start",
      "--host",
      "foreground",
      "--input",
      inputPath,
      "--project",
      env.repo,
      "--run-dir",
      runDir,
      "--runtime-module",
      runtimeModule,
      "--poll-ms",
      "2",
      ...extraArgs,
    ],
    { WOOF_TEST_SCRIPT: "happy", ...extraEnv },
    { timeoutMs: 60_000 },
  );
  return { ...out, runDir };
}

function runDirOf(out: { runDir: string }): string {
  return out.runDir;
}

function recordedConfig(out: { runDir: string }): Json {
  return JSON.parse(readFileSync(join(out.runDir, "config.json"), "utf8")) as Json;
}

function runWoof(
  env: Env,
  args: string[],
  extraEnv: Record<string, string> = {},
  options: { cwd?: string; timeoutMs?: number } = {},
) {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: env.home,
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  for (const key of ["HERDR_PANE_ID", "HERDR_ENV", "WOOF_RUN_DIR"])
    Reflect.deleteProperty(childEnv, key);
  Object.assign(childEnv, extraEnv);
  const result = spawnSync("node", [cliPath, ...args], {
    cwd: options.cwd ?? env.root,
    env: childEnv,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 20_000,
    killSignal: "SIGKILL",
  });
  const last = result.stdout.trim().split("\n").at(-1) ?? "";
  let json: Json | undefined;
  try {
    json = JSON.parse(last) as Json;
  } catch {
    json = undefined;
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json,
    error: result.error,
  };
}

describe("woof config show: configuration matrix", () => {
  it("C1: a user role reports source user with its path and sha256", () => {
    const env = setup();
    const path = writeJson(
      join(env.home, ".woof", "roles", "builder.json"),
      role({ model: "sonnet" }),
    );
    const out = show(env, ["--project", env.repo]);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    const builder = out.json?.["configuration"]["roles"]["builder"];
    expect(builder).toMatchObject({
      source: "user",
      path,
      value: { kind: "claude", model: "sonnet", args: [] },
    });
    expect(builder.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.json?.["configuration"]["files"]).toEqual([
      { scope: "user", path, sha256: builder.sha256, bytes: expect.any(Number) },
    ]);
    expect(out.json?.["configuration"]["roots"]).toEqual({
      project: { root: env.repo, dir: join(env.repo, ".woof"), exists: false },
      user: { dir: join(env.home, ".woof"), exists: true },
    });
  });

  it("C2: a project role replaces the user role whole", () => {
    const env = setup();
    const user = writeJson(
      join(env.home, ".woof", "roles", "builder.json"),
      role({ args: ["--permission-mode", "auto"] }),
    );
    writeJson(join(env.repo, ".woof", "roles", "builder.json"), role({}));
    const out = show(env, ["--project", env.repo]);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    const builder = out.json?.["configuration"]["roles"]["builder"];
    expect(builder).toMatchObject({ source: "project", value: { args: [] } });
    expect(builder.shadowed[0]).toMatchObject({
      source: "user",
      path: user,
      value: { args: ["--permission-mode", "auto"] },
    });
  });

  it("C5 (config half): an unknown settings key is config_invalid naming the file and pointer", () => {
    const env = setup();
    const path = writeJson(join(env.repo, ".woof", "woof.json"), {
      schemaVersion: 1,
      defaults: { limitz: {} },
    });
    const out = show(env, ["--project", env.repo]);
    expect(out.status).toBe(2);
    expect(out.json).toMatchObject({ outcome: "rejected", reason: "config_invalid" });
    expect(out.json?.["details"]).toEqual([
      {
        field: `${path}#/defaults/limitz`,
        message: "unknown key",
        path,
        pointer: "/defaults/limitz",
      },
    ]);
  });

  it("C6: a role file with an unknown key is config_invalid, even when the role is unused", () => {
    const env = setup();
    writeJson(join(env.repo, ".woof", "roles", "planner.json"), role({ colour: "blue" }));
    const out = show(env, ["--project", env.repo]);
    expect(out.status).toBe(2);
    expect(out.json).toMatchObject({ reason: "config_invalid", details: [{ pointer: "/colour" }] });
  });

  it("C7 (config half): an unsupported kind is a warning in config show", () => {
    const env = setup();
    const path = writeJson(
      join(env.repo, ".woof", "roles", "planner.json"),
      role({ kind: "codex" }),
    );
    const out = show(env, ["--project", env.repo]);
    expect(out.status, out.stdout).toBe(0);
    expect(out.json?.["configuration"]["warnings"]).toEqual([
      { code: "role_kind_unsupported", message: expect.stringContaining("codex"), path },
    ]);
  });

  it("C9: a project-scope runsDir is setting_scope_invalid", () => {
    const env = setup();
    writeJson(join(env.repo, ".woof", "woof.json"), {
      schemaVersion: 1,
      defaults: { runsDir: "/tmp/runs" },
    });
    const out = show(env, ["--project", env.repo]);
    expect(out.status).toBe(2);
    expect(out.json).toMatchObject({
      reason: "setting_scope_invalid",
      details: [{ pointer: "/defaults/runsDir" }],
    });
  });

  it("C10: two workflow files with one stem in one scope are config_conflict", () => {
    const env = setup();
    for (const ext of ["ts", "mjs"])
      writeJson(
        join(env.repo, ".woof", "workflows", `build-review.${ext}`),
        "export default {};\n",
      );
    const out = show(env, ["--project", env.repo]);
    expect(out.status).toBe(2);
    expect(out.json).toMatchObject({ reason: "config_conflict" });
    expect(out.json?.["message"]).toContain("build-review");
  });

  it("C11: a git worktree resolves its own top level and its own .woof", () => {
    const env = setup();
    writeJson(join(env.repo, ".woof", "roles", "builder.json"), role({ model: "main" }));
    const tree = join(env.root, "tree");
    git(env.repo, "worktree", "add", "-q", tree);
    writeJson(join(tree, ".woof", "roles", "reviewer.json"), role({ model: "tree" }));
    const out = show(env, [], { cwd: tree });
    expect(out.status, out.stdout + out.stderr).toBe(0);
    const configuration = out.json?.["configuration"];
    expect(configuration["roots"]["project"]).toEqual({
      root: tree,
      dir: join(tree, ".woof"),
      exists: true,
    });
    expect(configuration["roles"]["reviewer"]).toMatchObject({
      source: "project",
      value: { model: "tree" },
    });
    expect(configuration["roles"]["builder"]).toMatchObject({ source: "builtin" });
  });

  it("C12: a nested .woof is ignored with a warning and the project root is the top level", () => {
    const env = setup();
    const nested = join(env.repo, "packages", "app");
    writeJson(join(nested, ".woof", "roles", "builder.json"), role({ model: "nested" }));
    const out = show(env, [], { cwd: nested });
    expect(out.status, out.stdout + out.stderr).toBe(0);
    const configuration = out.json?.["configuration"];
    expect(configuration["roots"]["project"]["root"]).toBe(env.repo);
    expect(configuration["roles"]["builder"]).toMatchObject({ source: "builtin" });
    expect(configuration["warnings"]).toEqual([
      { code: "nested_config_ignored", message: expect.any(String), path: join(nested, ".woof") },
    ]);
  });

  it("C13: HOME at the project root reads that .woof once, as user scope", () => {
    const env = setup();
    const path = writeJson(
      join(env.repo, ".woof", "roles", "builder.json"),
      role({ model: "same" }),
    );
    const out = show({ ...env, home: env.repo }, ["--project", env.repo]);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    const configuration = out.json?.["configuration"];
    expect(configuration["roles"]["builder"]).toMatchObject({
      source: "user",
      path,
      shadowed: [{ source: "builtin" }],
    });
    expect(configuration["files"].map((file: Json) => file["scope"])).toEqual(["user"]);
  });

  it("C14: outside a git work tree there is no project scope", () => {
    const env = setup();
    const plain = join(env.root, "plain");
    mkdirSync(plain);
    writeJson(join(plain, ".woof", "roles", "builder.json"), role({ model: "ignored" }));
    writeJson(join(env.home, ".woof", "roles", "reviewer.json"), role({ model: "user" }));
    const out = show(env, [], { cwd: plain });
    expect(out.status, out.stdout + out.stderr).toBe(0);
    const configuration = out.json?.["configuration"];
    expect(configuration["roots"]["project"]).toBeNull();
    expect(configuration["roles"]["builder"]).toMatchObject({ source: "builtin" });
    expect(configuration["roles"]["reviewer"]).toMatchObject({ source: "user" });
  });

  it("C17: a FIFO at .woof/woof.json is config_invalid without hanging", () => {
    const env = setup();
    mkdirSync(join(env.repo, ".woof"));
    expect(spawnSync("mkfifo", [join(env.repo, ".woof", "woof.json")]).status).toBe(0);
    const started = Date.now();
    const out = show(env, ["--project", env.repo], { timeoutMs: 5000 });
    expect(out.error).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out.status).toBe(2);
    expect(out.json).toMatchObject({ reason: "config_invalid" });
    expect(out.json?.["message"]).toContain("not a regular file");
  });

  it("C18: role args that set --model are role_invalid", () => {
    const env = setup();
    writeJson(
      join(env.repo, ".woof", "roles", "builder.json"),
      role({ args: ["--model", "opus"] }),
    );
    const out = show(env, ["--project", env.repo]);
    expect(out.status).toBe(2);
    expect(out.json).toMatchObject({ reason: "role_invalid", details: [{ pointer: "/args/0" }] });
  });

  it("C19 (config half): an explicit permission bypass is allowed and reported with its path", () => {
    const env = setup();
    const path = writeJson(
      join(env.repo, ".woof", "roles", "builder.json"),
      role({ args: ["--dangerously-skip-permissions"] }),
    );
    const out = show(env, ["--project", env.repo]);
    expect(out.status, out.stdout).toBe(0);
    expect(out.json?.["configuration"]["warnings"]).toEqual([
      { code: "permission_bypass_configured", message: expect.any(String), path },
    ]);
    expect(out.json?.["configuration"]["roles"]["builder"]["value"]["args"]).toEqual([
      "--dangerously-skip-permissions",
    ]);
  });

  it("PR #6 (resolve.ts:174): role files named after Object.prototype keys resolve as their own roles; __proto__ and an undefined prototype-key role are refused cleanly", () => {
    const env = setup();
    const ctor = writeJson(
      join(env.repo, ".woof", "roles", "constructor.json"),
      role({ model: "sonnet" }),
    );
    const str = writeJson(join(env.repo, ".woof", "roles", "toString.json"), role({}));
    const out = show(env, ["--project", env.repo]);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    const roles = out.json?.["configuration"]["roles"] as Json;
    expect(Object.keys(roles).toSorted()).toEqual([
      "builder",
      "constructor",
      "reviewer",
      "toString",
    ]);
    expect(roles["constructor"]).toMatchObject({
      source: "project",
      path: ctor,
      value: { kind: "claude", model: "sonnet", args: [] },
      shadowed: [],
    });
    expect(roles["toString"]).toMatchObject({ source: "project", path: str, shadowed: [] });

    writeJson(join(env.repo, ".woof", "roles", "__proto__.json"), role({}));
    const proto = show(env, ["--project", env.repo]);
    expect(proto.status, proto.stdout + proto.stderr).toBe(2);
    expect(proto.json).toMatchObject({ outcome: "rejected" });
    expect(proto.json?.["message"]).toContain("is not a valid id");
    expect(proto.stderr).not.toMatch(/TypeError|at .*\.js:\d+/);
    rmSync(join(env.repo, ".woof", "roles", "__proto__.json"));

    // A workflow whose role is an inherited key nobody defines is role_unresolved, never a throw.
    const module = readFileSync(
      join(repoRoot, "test", "fixtures", "workflows", "planner-role.mjs"),
      "utf8",
    )
      .replace('name: "planner-role"', 'name: "proto-role"')
      .replace('role: "planner"', 'role: "hasOwnProperty"');
    writeJson(join(env.repo, ".woof", "workflows", "proto-role.mjs"), module);
    const unresolved = startForeground(env, {}, ["--workflow", "proto-role"], {
      WOOF_TEST_REPO: env.repo,
    });
    expect(unresolved.status, unresolved.stdout + unresolved.stderr).toBe(2);
    expect(unresolved.json).toMatchObject({ reason: "role_unresolved" });
  }, 60_000);

  it("resolves --workflow and refuses an unknown one as workflow_not_found", () => {
    const env = setup();
    const ok = show(env, ["--project", env.repo, "--workflow", "build-review"]);
    expect(ok.json?.["configuration"]["workflow"]).toMatchObject({
      source: "builtin",
      value: { name: "build-review", version: "1" },
    });
    const out = show(env, ["--project", env.repo, "--workflow", "nope"]);
    expect(out.status).toBe(2);
    expect(out.json).toMatchObject({
      reason: "workflow_not_found",
      configuration: { workflow: null },
    });
  });

  it("C8 (admission): a workflow role nobody defines is role_unresolved listing the searched paths", () => {
    const env = setup();
    const module = join(env.repo, ".woof", "workflows", "planner-role.mjs");
    writeJson(
      module,
      readFileSync(join(repoRoot, "test", "fixtures", "workflows", "planner-role.mjs"), "utf8"),
    );
    const out = startForeground(env, {}, ["--workflow", "planner-role"], {
      WOOF_TEST_REPO: env.repo,
    });
    expect(out.status, out.stdout + out.stderr).toBe(2);
    expect(out.json).toMatchObject({ reason: "role_unresolved" });
    expect(out.json?.["message"]).toContain(join(env.repo, ".woof", "roles", "planner.json"));
    expect(out.json?.["message"]).toContain(join(env.home, ".woof", "roles", "planner.json"));
  });

  it("C3: limits compose per key across input, project, user and built-in, recorded in config.json", () => {
    const env = setup();
    writeJson(join(env.home, ".woof", "woof.json"), {
      schemaVersion: 1,
      defaults: { limits: { maxRounds: 5 } },
    });
    const project = writeJson(join(env.repo, ".woof", "woof.json"), {
      schemaVersion: 1,
      defaults: { limits: { runTimeoutMs: 120_000 } },
    });
    const out = startForeground(env, baseInput(env, { limits: { maxAttemptsPerVisit: 1 } }));
    expect(out.status, out.stdout + out.stderr).toBe(0);
    const limits = recordedConfig(out)["settings"]["limits"];
    expect(limits["maxRounds"]).toMatchObject({
      value: 5,
      source: "user",
      path: join(env.home, ".woof", "woof.json"),
    });
    expect(limits["runTimeoutMs"]).toMatchObject({
      value: 120_000,
      source: "project",
      path: project,
    });
    expect(limits["maxAttemptsPerVisit"]).toMatchObject({
      value: 1,
      source: "input",
      shadowed: [{ source: "builtin", value: 2 }],
    });
    expect(limits["readinessWaitMs"]).toMatchObject({ value: 180_000, source: "builtin" });
  }, 60_000);

  it("C4: an input agent is recorded as source input, shadowing the project role", () => {
    const env = setup();
    const path = writeJson(
      join(env.repo, ".woof", "roles", "builder.json"),
      role({ model: "sonnet" }),
    );
    const out = startForeground(
      env,
      baseInput(env, { agents: { builder: { kind: "claude", model: "opus", args: [] } } }),
    );
    expect(out.status, out.stdout + out.stderr).toBe(0);
    const builder = recordedConfig(out)["agents"]["builder"];
    expect(builder).toMatchObject({ role: "builder", source: "input", value: { model: "opus" } });
    expect(builder["shadowed"][0]).toMatchObject({
      source: "project",
      path,
      value: { model: "sonnet" },
    });
  }, 60_000);

  it("C5 (start): an invalid settings file stops run start before any pane is split", () => {
    const env = setup();
    writeJson(join(env.repo, ".woof", "woof.json"), { schemaVersion: 1, defaults: { limitz: {} } });
    const log = join(env.root, "herdr.log");
    const scenario = writeJson(join(env.root, "scenario.json"), []);
    const out = runWoof(
      env,
      [
        "run",
        "start",
        "--input",
        writeJson(join(env.root, "input.json"), baseInput(env)),
        "--project",
        env.repo,
      ],
      {
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w9:p1",
        WOOF_HERDR_BIN: join(repoRoot, "test", "fixtures", "fake-herdr.mjs"),
        FAKE_HERDR_LOG: log,
        FAKE_HERDR_SCENARIO: scenario,
      },
    );
    expect(out.status, out.stdout + out.stderr).toBe(2);
    expect(out.json).toMatchObject({
      reason: "config_invalid",
      details: [{ pointer: "/defaults/limitz" }],
    });
    expect(existsSync(log)).toBe(false);
  });

  it("C7 (admission): a used role with an unsupported kind is rejected naming its file; an unused one only warns", () => {
    const env = setup();
    const path = writeJson(
      join(env.repo, ".woof", "roles", "builder.json"),
      role({ kind: "codex" }),
    );
    const used = startForeground(env, baseInput(env));
    expect(used.status, used.stdout).toBe(2);
    expect(used.json).toMatchObject({ reason: "agent_kind_unsupported" });
    expect(used.json?.["message"]).toContain(path);

    const other = setup();
    const planner = writeJson(
      join(other.repo, ".woof", "roles", "planner.json"),
      role({ kind: "codex" }),
    );
    const unused = startForeground(other, baseInput(other));
    expect(unused.status, unused.stdout + unused.stderr).toBe(0);
    expect(recordedConfig(unused)["warnings"]).toContainEqual({
      code: "role_kind_unsupported",
      message: expect.any(String),
      path: planner,
    });
  }, 60_000);

  it("C15: a run whose repository is not the --project is project_mismatch naming both", () => {
    const env = setup();
    const other = setup();
    const out = startForeground(env, baseInput(other));
    expect(out.status).toBe(2);
    expect(out.json).toMatchObject({ reason: "project_mismatch" });
    expect(out.json?.["message"]).toContain(env.repo);
    expect(out.json?.["message"]).toContain(other.repo);
  });

  it("C19 (recorded): a permission bypass in a role runs as configured and config.json carries the warning", () => {
    const env = setup();
    const path = writeJson(
      join(env.repo, ".woof", "roles", "builder.json"),
      role({ args: ["--dangerously-skip-permissions"] }),
    );
    const out = startForeground(env, baseInput(env));
    expect(out.status, out.stdout + out.stderr).toBe(0);
    const recorded = recordedConfig(out);
    expect(recorded["warnings"]).toContainEqual({
      code: "permission_bypass_configured",
      message: expect.any(String),
      path,
    });
    // No Claude trust entry exists in the temporary HOME: the pre-flight warns, it never rejects.
    expect(recorded["warnings"].map((warning: Json) => warning["code"])).toContain(
      "claude_trust_unknown",
    );
    const plan = JSON.parse(
      readFileSync(join(runDirOf(out), "journal.jsonl"), "utf8").split("\n")[0] as string,
    ) as Json;
    expect(plan["plan"]["agents"][0]["args"]).toContain("--dangerously-skip-permissions");
    expect(plan["plan"]["agents"][1]["args"]).not.toContain("--dangerously-skip-permissions");
  }, 60_000);

  it("PI-002: input agent args that set --model or --add-dir are role_invalid before any run opens", () => {
    const env = setup();
    for (const args of [
      ["--model", "opus"],
      ["--model=opus"],
      ["--add-dir", "/tmp"],
      ["--add-dir=/tmp"],
    ]) {
      const out = startForeground(
        env,
        baseInput(env, { agents: { builder: { kind: "claude", model: "sonnet", args } } }),
      );
      expect(out.status, out.stdout + out.stderr).toBe(2);
      expect(out.json).toMatchObject({
        outcome: "rejected",
        reason: "role_invalid",
        details: [
          {
            field: "agents.builder.args.0",
            message: expect.stringContaining("set by the workflow input"),
          },
        ],
      });
      expect(existsSync(join(out.runDir, "journal.jsonl"))).toBe(false);
    }
  }, 60_000);

  it("PI-004: a permission bypass set by the input is reported in config.json and on stderr", () => {
    const env = setup();
    const out = startForeground(
      env,
      baseInput(env, {
        agents: {
          builder: { kind: "claude", model: null, args: ["--dangerously-skip-permissions"] },
        },
      }),
    );
    expect(out.status, out.stdout + out.stderr).toBe(0);
    const bypass = (recordedConfig(out)["warnings"] as Json[]).filter(
      (warning) => warning["code"] === "permission_bypass_configured",
    );
    expect(bypass).toEqual([
      {
        code: "permission_bypass_configured",
        message: expect.stringContaining("set by the workflow input"),
      },
    ]);
    expect(out.stderr).toContain("warning permission_bypass_configured");
  }, 60_000);

  it("PI-004: a role-file bypass that runs is reported once", () => {
    const env = setup();
    const path = writeJson(
      join(env.repo, ".woof", "roles", "builder.json"),
      role({ args: ["--dangerously-skip-permissions"] }),
    );
    const out = startForeground(env, baseInput(env));
    expect(out.status, out.stdout + out.stderr).toBe(0);
    const bypass = (recordedConfig(out)["warnings"] as Json[]).filter(
      (warning) => warning["code"] === "permission_bypass_configured",
    );
    expect(bypass).toEqual([
      { code: "permission_bypass_configured", message: expect.any(String), path },
    ]);
  }, 60_000);

  it("PI-103: a role-file bypass an input agent replaces is not reported for the run; an input bypass over it is reported once", () => {
    const env = setup();
    writeJson(
      join(env.repo, ".woof", "roles", "builder.json"),
      role({ args: ["--dangerously-skip-permissions"] }),
    );
    const bypassWarnings = (out: { runDir: string }) =>
      (recordedConfig(out)["warnings"] as Json[]).filter(
        (warning) => warning["code"] === "permission_bypass_configured",
      );
    const safe = startForeground(
      env,
      baseInput(env, { agents: { builder: { kind: "claude", model: null, args: [] } } }),
    );
    expect(safe.status, safe.stdout + safe.stderr).toBe(0);
    expect(bypassWarnings(safe)).toEqual([]);
    expect(safe.stderr).not.toContain("permission_bypass_configured");

    const unsafe = startForeground(
      env,
      baseInput(env, {
        agents: {
          builder: { kind: "claude", model: null, args: ["--dangerously-skip-permissions"] },
        },
      }),
    );
    expect(unsafe.status, unsafe.stdout + unsafe.stderr).toBe(0);
    expect(bypassWarnings(unsafe)).toEqual([
      {
        code: "permission_bypass_configured",
        message: expect.stringContaining("set by the workflow input"),
      },
    ]);
    expect(unsafe.stderr.split("warning permission_bypass_configured")).toHaveLength(2);
  }, 60_000);

  it("PR #6 (run.ts:414): a FIFO or directory given as --input is input_invalid at once, without blocking", () => {
    const env = setup();
    const fifo = join(env.root, "input.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const directory = join(env.root, "input-dir");
    mkdirSync(directory);
    for (const [path, host] of [
      [fifo, "foreground"],
      [fifo, "herdr-pane"],
      [directory, "foreground"],
    ] as const) {
      const started = Date.now();
      const out = runWoof(
        env,
        [
          "run",
          "start",
          "--host",
          host,
          "--input",
          path,
          "--project",
          env.repo,
          "--run-dir",
          join(env.root, "never"),
        ],
        { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", WOOF_HERDR_BIN: "/nonexistent/herdr" },
        { timeoutMs: 15_000 },
      );
      expect(out.error, `${host} ${path}`).toBeUndefined();
      expect(out.status, `${host} ${path}: ${out.stdout}${out.stderr}`).toBe(2);
      expect(out.json, `${host} ${path}`).toMatchObject({
        outcome: "rejected",
        reason: "input_invalid",
        message: expect.stringContaining("is not a regular file"),
      });
      expect(Date.now() - started).toBeLessThan(10_000);
    }
    expect(existsSync(join(env.root, "never"))).toBe(false);
  });

  it("rejects a --project that is not a directory", () => {
    const env = setup();
    const out = show(env, ["--project", join(env.root, "missing")]);
    expect(out.status).toBe(2);
    expect(out.json).toMatchObject({ reason: "config_invalid", details: [{ field: "project" }] });
  });
});
