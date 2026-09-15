import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cliPath } from "./helpers/process.js";

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
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: env.home,
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  for (const key of ["HERDR_PANE_ID", "HERDR_ENV", "WOOF_RUN_DIR"])
    Reflect.deleteProperty(childEnv, key);
  const result = spawnSync("node", [cliPath, "config", "show", ...args], {
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

  it("rejects a --project that is not a directory", () => {
    const env = setup();
    const out = show(env, ["--project", join(env.root, "missing")]);
    expect(out.status).toBe(2);
    expect(out.json).toMatchObject({ reason: "config_invalid", details: [{ field: "project" }] });
  });
});
