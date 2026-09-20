import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cliPath } from "./helpers/process.js";

/**
 * `woof doctor` probes real executables through spawnSync, so these run the
 * built CLI as a real process against a fixture PATH holding shell scripts for
 * claude and pi. PATH keeps the node directory plus /usr/bin and /bin (git
 * lives there) and nothing else, so a probe finds exactly the shims the case
 * writes -- never the operator's real claude or pi.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface Env {
  root: string;
  home: string;
  repo: string;
  bin: string;
  herdrBin: string;
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
      "-c",
      "maintenance.auto=false",
      ...args,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

/** An executable shell script that prints `version` on its first line. */
function shim(dir: string, name: string, version: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "${version}"\n`);
  chmodSync(path, 0o755);
}

/**
 * A repository whose doctor report is otherwise clean: herdr, claude and pi all
 * probe, the operator accepted this exact folder in Claude Code, and the
 * configuration resolves. Each case then removes one thing.
 */
function setup(options: { pi?: boolean; claude?: boolean } = {}): Env {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "woof-doctor-")));
  dirs.push(root);
  const home = join(root, "home");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(repo);
  mkdirSync(bin);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");

  if (options.claude !== false) shim(bin, "claude", "9.9.9 (Claude Code)");
  if (options.pi !== false) shim(bin, "pi", "0.86.0");
  const herdrBin = join(bin, "herdr-fixture");
  writeFileSync(herdrBin, `#!/bin/sh\necho "herdr 0.9.1"\n`);
  chmodSync(herdrBin, 0o755);

  // The trust key doctor reads is the git top level, which is this realpath'd repo.
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
  );
  return { root, home, repo, bin, herdrBin };
}

function role(env: Env, name: string, body: Record<string, unknown>): string {
  const path = join(env.repo, ".woof", "roles", `${name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, model: null, args: [], ...body }));
  return path;
}

type Report = {
  claude: { status: string; version: string | null };
  pi: { status: string; version: string | null };
  problems: string[];
} & Record<string, any>; // oxlint-disable-line no-explicit-any

function doctor(
  env: Env,
  args: string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [cliPath, "doctor", "--repo", env.repo, ...args], {
    cwd: env.root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: env.home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      WOOF_HERDR_BIN: env.herdrBin,
      // Only the fixture bin, node and the system directories: no operator claude or pi.
      PATH: `${env.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HERDR_ENV: undefined,
      HERDR_PANE_ID: undefined,
      WOOF_RUN_DIR: undefined,
    } as NodeJS.ProcessEnv,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function report(env: Env, args: string[] = []): Report {
  const out = doctor(env, ["--json", ...args]);
  const last = out.stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(last) as Report;
}

describe("woof doctor probes pi", () => {
  it("D1: reports the pi probe whether or not a role uses it", () => {
    const env = setup();
    const json = report(env);
    expect(json.pi).toEqual({ status: "available", version: "0.86.0" });
    // Nothing else is wrong in this fixture, so the report is clean and --strict passes.
    expect(json.problems).toEqual([]);
    expect(doctor(env, ["--strict"]).status).toBe(0);
  }, 60_000);

  it("D2: a missing pi is not a problem when no resolved role uses it", () => {
    const env = setup({ pi: false });
    const json = report(env);
    expect(json.pi).toEqual({ status: "not_found", version: null });
    expect(json.problems).not.toContain("pi_unavailable");
    expect(json.problems).toEqual([]);
    // The same fixture with pi present exits 0 too: pi alone decides nothing here.
    expect(doctor(env, ["--strict"]).status).toBe(0);
  }, 60_000);

  it("D3: a missing pi is a problem when a resolved role selects it, and --strict exits 2", () => {
    const env = setup({ pi: false });
    role(env, "builder", { kind: "pi", model: "openai-codex/gpt-5.6-sol" });
    const json = report(env);
    expect(json.pi.status).toBe("not_found");
    expect(json.problems).toContain("pi_unavailable");
    // Everything else in this fixture is clean, so pi alone moved the exit code.
    expect(json.problems).toEqual(["pi_unavailable"]);
    expect(doctor(env, ["--strict"]).status).toBe(2);
  }, 60_000);

  it("D4: a custom role selecting pi counts, not only builder, planner and reviewer", () => {
    const env = setup({ pi: false });
    role(env, "scribe", { kind: "pi", model: null });
    expect(report(env).problems).toContain("pi_unavailable");
  }, 60_000);

  it("D5: claude_unavailable still fires when every built-in role is shadowed by a pi role", () => {
    // Built-in roles are the bottom layer, so an all-pi project resolves no claude role.
    // claude_unavailable is unconditional anyway: gating it would silently weaken --strict.
    const env = setup({ pi: false, claude: false });
    for (const name of ["builder", "planner", "reviewer"]) role(env, name, { kind: "pi" });
    const json = report(env);
    expect(json.claude).toEqual({ status: "not_found", version: null });
    expect(json.problems).toContain("claude_unavailable");
    expect(json.problems).toContain("pi_unavailable");
    expect(doctor(env, ["--strict"]).status).toBe(2);
  }, 60_000);

  it("D6: the text report and the usage name pi", () => {
    const env = setup();
    const text = doctor(env).stdout;
    expect(text).toContain("pi: available (0.86.0)");
    expect(text).toContain("claude: available (9.9.9 (Claude Code))");
    const usage = doctor(env, ["--help"]).stdout;
    expect(usage).toContain("pi_unavailable");
  }, 60_000);
});
