import { spawnSync } from "node:child_process";
import {
  appendFileSync,
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

// `woof agent start <role>` (phase 7 T6b) as a real process with a temporary HOME. Herdr is only
// the fake fixture, by absolute path; a failing `herdr` first on PATH guards against the real one.
const fakeHerdr = join(repoRoot, "test", "fixtures", "fake-herdr.mjs");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Json = Record<string, any>; // oxlint-disable-line no-explicit-any

interface Setup {
  root: string;
  home: string;
  repo: string;
  log: string;
  scenario: string;
  guardLog: string;
}

const agentInfo = (name: string, paneId: string) =>
  JSON.stringify({
    id: "cli:agent",
    result: {
      type: "agent_info",
      agent: {
        agent: "claude",
        agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "session-1" },
        agent_status: "idle",
        name,
        pane_id: paneId,
        revision: 1,
        state_change_seq: 1,
        tab_id: "w9:t1",
        terminal_id: "term_1",
        workspace_id: "w9",
      },
    },
  });

function setup(): Setup {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "woof-agent-start-")));
  dirs.push(root);
  const home = join(root, "home");
  const repo = join(root, "repo");
  const guard = join(root, "guard");
  for (const dir of [home, repo, guard]) mkdirSync(dir);
  const git = spawnSync("git", ["init", "-q", repo], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  expect(git.status).toBe(0);
  appendFileSync(join(repo, ".git", "info", "exclude"), ".woof/\n");
  const guardLog = join(root, "guard.log");
  writeFileSync(
    join(guard, "herdr"),
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(guardLog)}\nexit 1\n`,
    {
      mode: 0o755,
    },
  );
  const s: Setup = {
    root,
    home,
    repo,
    log: join(root, "herdr.log"),
    scenario: join(root, "scenario.json"),
    guardLog,
  };
  scenario(s, "builder");
  return s;
}

/** A Herdr that splits w9:p7 and starts `name` in whichever pane it is given. */
function scenario(s: Setup, name: string, extra: Json[] = []): void {
  writeFileSync(
    s.scenario,
    JSON.stringify([
      ...extra,
      {
        match: ["pane", "split"],
        stdout: JSON.stringify({ id: "cli:pane", result: { pane: { pane_id: "w9:p7" } } }),
      },
      {
        match: ["agent", "start", name, "--kind", "claude", "--pane", "w9:p7"],
        stdout: agentInfo(name, "w9:p7"),
      },
      {
        match: ["agent", "start", name, "--kind", "claude", "--pane", "w9:p3"],
        stdout: agentInfo(name, "w9:p3"),
      },
    ]),
  );
}

function role(dir: string, name: string, body: Json): string {
  const path = join(dir, ".woof", "roles", `${name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, ...body }));
  return path;
}

function agentStart(
  s: Setup,
  args: string[],
  env: Record<string, string | undefined> = {},
): { status: number | null; stdout: string; stderr: string; json: Json | undefined } {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(s.root, "guard")}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: s.home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    WOOF_HERDR_BIN: fakeHerdr,
    FAKE_HERDR_LOG: s.log,
    FAKE_HERDR_SCENARIO: s.scenario,
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w9:p1",
    ...env,
  };
  for (const key of ["WOOF_RUN_DIR", "HERDR_PLUGIN_CONTEXT_JSON"])
    Reflect.deleteProperty(childEnv, key);
  for (const [key, value] of Object.entries(childEnv))
    if (value === undefined) Reflect.deleteProperty(childEnv, key);
  const result = spawnSync("node", [cliPath, "agent", "start", ...args], {
    cwd: s.repo,
    env: childEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  const last = result.stdout.trim().split("\n").at(-1) ?? "";
  let json: Json | undefined;
  try {
    json = last === "" ? undefined : (JSON.parse(last) as Json);
  } catch {
    json = undefined;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function calls(s: Setup): string[][] {
  return existsSync(s.log)
    ? readFileSync(s.log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as string[])
    : [];
}

describe("woof agent start <role>", () => {
  it("starts a built-in role in a pane split from the caller, with no run directory and no --add-dir", () => {
    const s = setup();
    const started = agentStart(s, ["builder"]);
    expect(started.status, started.stdout + started.stderr).toBe(0);
    expect(started.stdout.trim().split("\n")).toHaveLength(1);
    expect(started.json).toEqual({
      outcome: "started",
      role: "builder",
      roleSource: "builtin",
      agent: {
        adapter: "herdr",
        runtimeName: "builder",
        kind: "claude",
        paneId: "w9:p7",
        paneOwned: true,
        terminalId: "term_1",
        sessionId: "session-1",
      },
    });
    expect(calls(s)).toEqual([
      ["pane", "split", "--current", "--direction", "down", "--cwd", s.repo, "--no-focus"],
      ["agent", "start", "builder", "--kind", "claude", "--pane", "w9:p7", "--timeout", "30000"],
    ]);
    expect(calls(s).flat()).not.toContain("--add-dir");
    // No run, no journal, nothing written anywhere a run would live.
    expect(existsSync(join(s.home, ".woof"))).toBe(false);
    expect(existsSync(join(s.repo, ".woof"))).toBe(false);
    expect(existsSync(s.guardLog)).toBe(false);
  });

  it("resolves a project role over the user and built-in roles and passes its model and args", () => {
    const s = setup();
    const projectRole = role(s.repo, "builder", {
      kind: "claude",
      model: "sonnet",
      args: ["--permission-mode", "auto"],
    });
    role(s.home, "builder", { kind: "claude", model: "opus", args: [] });
    scenario(s, "w-builder-2");
    const started = agentStart(s, [
      "builder",
      "--split",
      "right",
      "--name",
      "w-builder-2",
      "--project",
      s.repo,
    ]);
    expect(started.status, started.stdout + started.stderr).toBe(0);
    expect(started.json).toMatchObject({
      outcome: "started",
      role: "builder",
      roleSource: `project ${projectRole}`,
      agent: { runtimeName: "w-builder-2", paneId: "w9:p7" },
    });
    expect(calls(s)).toEqual([
      ["pane", "split", "--current", "--direction", "right", "--cwd", s.repo, "--no-focus"],
      [
        "agent",
        "start",
        "w-builder-2",
        "--kind",
        "claude",
        "--pane",
        "w9:p7",
        "--timeout",
        "30000",
        "--",
        "--model",
        "sonnet",
        "--permission-mode",
        "auto",
      ],
    ]);
  });

  it("resolves a user role in an existing pane with --pane, without splitting", () => {
    const s = setup();
    const userRole = role(s.home, "scribe", {
      kind: "claude",
      model: "haiku",
      args: ["--verbose"],
    });
    scenario(s, "scribe");
    const started = agentStart(s, ["scribe", "--pane", "w9:p3"]);
    expect(started.status, started.stdout + started.stderr).toBe(0);
    expect(started.json).toMatchObject({
      role: "scribe",
      roleSource: `user ${userRole}`,
      agent: { runtimeName: "scribe", paneId: "w9:p3", paneOwned: false },
    });
    expect(calls(s)).toEqual([
      [
        "agent",
        "start",
        "scribe",
        "--kind",
        "claude",
        "--pane",
        "w9:p3",
        "--timeout",
        "30000",
        "--",
        "--model",
        "haiku",
        "--verbose",
      ],
    ]);
  });

  it("refuses an unresolved role, an invalid role file and invalid configuration with exit 2 before calling Herdr", () => {
    const s = setup();
    const unresolved = agentStart(s, ["nosuchrole"]);
    expect(unresolved.status, unresolved.stdout + unresolved.stderr).toBe(2);
    expect(unresolved.json).toMatchObject({ outcome: "rejected", reason: "role_unresolved" });
    const message = String(unresolved.json?.["message"]);
    expect(message).toContain(join(s.repo, ".woof", "roles", "nosuchrole.json"));
    expect(message).toContain(join(s.home, ".woof", "roles", "nosuchrole.json"));
    expect(message).toContain("built-in roles");

    // The engine owns --model and --add-dir: a role that sets one is refused, as for a run.
    const owned = role(s.repo, "builder", {
      kind: "claude",
      model: null,
      args: ["--model", "opus"],
    });
    const invalidRole = agentStart(s, ["builder"]);
    expect(invalidRole.status).toBe(2);
    expect(invalidRole.json).toMatchObject({ outcome: "rejected", reason: "role_invalid" });
    expect(String(invalidRole.json?.["message"])).toContain(owned);
    rmSync(owned);

    // A kind the engine cannot launch.
    role(s.repo, "builder", { kind: "codex", model: null, args: [] });
    const kind = agentStart(s, ["builder"]);
    expect(kind.status).toBe(2);
    expect(kind.json).toMatchObject({ outcome: "rejected", reason: "agent_kind_unsupported" });

    mkdirSync(join(s.repo, ".woof"), { recursive: true });
    writeFileSync(join(s.repo, ".woof", "woof.json"), "{");
    const config = agentStart(s, ["builder"]);
    expect(config.status).toBe(2);
    expect(config.json).toMatchObject({ outcome: "rejected", reason: "config_invalid" });

    expect(calls(s)).toEqual([]);
    expect(existsSync(s.guardLog)).toBe(false);
  });

  it("refuses invalid arguments with exit 1 before calling Herdr", () => {
    const s = setup();
    const cases: string[][] = [
      [],
      ["builder", "reviewer"],
      ["builder", "--split", "up"],
      ["builder", "--split", "right", "--pane", "w9:p3"],
      ["builder", "--name", "Not A Name"],
      ["builder", "--pane", ""],
      ["bad role!"],
      ["builder", "--model", "opus"],
    ];
    for (const args of cases) {
      const result = agentStart(s, args);
      expect(result.status, JSON.stringify(args) + result.stdout + result.stderr).toBe(1);
      expect(result.stderr, JSON.stringify(args)).toContain("Usage: woof agent start <role>");
    }
    // A role whose name is not a valid Herdr agent name needs --name.
    role(s.home, "Scribe", { kind: "claude", model: null, args: [] });
    const unnamed = agentStart(s, ["Scribe"]);
    expect(unnamed.status).toBe(1);
    expect(unnamed.stderr).toContain("--name");
    expect(calls(s)).toEqual([]);

    const help = agentStart(s, ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: woof agent start <role>");
  });

  it("outside Herdr, or with no pane to split from, refuses with exit 3 herdr_unavailable", () => {
    const s = setup();
    const outside = agentStart(s, ["builder"], { HERDR_ENV: undefined });
    expect(outside.status, outside.stdout + outside.stderr).toBe(3);
    expect(outside.json).toMatchObject({ outcome: "rejected", reason: "herdr_unavailable" });

    const noPane = agentStart(s, ["builder"], { HERDR_PANE_ID: undefined });
    expect(noPane.status).toBe(3);
    expect(noPane.json).toMatchObject({ outcome: "rejected", reason: "herdr_unavailable" });
    expect(String(noPane.json?.["message"])).toContain("--pane");
    expect(calls(s)).toEqual([]);
  });

  it("reports a failed split or agent start as exit 3 agent_start_failed with the runtime error", () => {
    const s = setup();
    writeFileSync(
      s.scenario,
      JSON.stringify([
        {
          match: ["pane", "split"],
          stderr: `${JSON.stringify({ error: { code: "pane_not_found", message: "no pane" }, id: "x" })}\n`,
          exit: 1,
        },
      ]),
    );
    const split = agentStart(s, ["builder"]);
    expect(split.status, split.stdout + split.stderr).toBe(3);
    expect(split.json).toMatchObject({
      outcome: "rejected",
      reason: "agent_start_failed",
      runtime: { code: "not_found", runtimeCode: "pane_not_found" },
    });
    expect(String(split.json?.["message"])).toContain("pane split failed");

    writeFileSync(
      s.scenario,
      JSON.stringify([
        {
          match: ["pane", "split"],
          stdout: JSON.stringify({ id: "cli:pane", result: { pane: { pane_id: "w9:p7" } } }),
        },
        {
          match: ["agent", "start"],
          stderr: `${JSON.stringify({ error: { code: "agent_name_taken", message: "taken" }, id: "x" })}\n`,
          exit: 1,
        },
      ]),
    );
    const start = agentStart(s, ["builder"]);
    expect(start.status).toBe(3);
    expect(start.json).toMatchObject({
      outcome: "rejected",
      reason: "agent_start_failed",
      runtime: { code: "runtime_error", runtimeCode: "agent_name_taken" },
    });
    expect(String(start.json?.["message"])).toContain("agent start failed");
    expect(existsSync(s.guardLog)).toBe(false);
  });

  it("R3: closes the pane it split when agent start fails, and never a pane it was given", () => {
    const s = setup();
    const failedStart = {
      match: ["agent", "start"],
      stderr: `${JSON.stringify({ error: { code: "agent_name_taken", message: "taken" }, id: "x" })}\n`,
      exit: 1,
    };
    const split = {
      match: ["pane", "split"],
      stdout: JSON.stringify({ id: "cli:pane", result: { pane: { pane_id: "w9:p7" } } }),
    };
    writeFileSync(
      s.scenario,
      JSON.stringify([
        split,
        failedStart,
        { match: ["pane", "close"], stdout: JSON.stringify({ id: "cli:pane", result: {} }) },
      ]),
    );
    const closed = agentStart(s, ["builder"]);
    expect(closed.status, closed.stdout + closed.stderr).toBe(3);
    expect(closed.json).toMatchObject({
      outcome: "rejected",
      reason: "agent_start_failed",
      runtime: { code: "runtime_error", runtimeCode: "agent_name_taken" },
      paneClosed: true,
    });
    expect(String(closed.json?.["message"])).toContain("the pane w9:p7 it split was closed");
    expect(calls(s).map((argv) => argv.slice(0, 3))).toEqual([
      ["pane", "split", "--current"],
      ["agent", "start", "builder"],
      ["pane", "close", "w9:p7"],
    ]);

    // A close that fails is reported, not hidden: the operator has a pane to close by hand.
    rmSync(s.log);
    writeFileSync(
      s.scenario,
      JSON.stringify([
        split,
        failedStart,
        {
          match: ["pane", "close"],
          stderr: `${JSON.stringify({ error: { code: "server_exploded", message: "boom" }, id: "x" })}\n`,
          exit: 1,
        },
      ]),
    );
    const leftOpen = agentStart(s, ["builder"]);
    expect(leftOpen.status).toBe(3);
    expect(leftOpen.json).toMatchObject({ reason: "agent_start_failed", paneClosed: false });
    expect(String(leftOpen.json?.["message"])).toContain(
      "the pane w9:p7 it split could not be closed",
    );

    // A pane named with --pane is the caller's: it is never closed.
    rmSync(s.log);
    writeFileSync(s.scenario, JSON.stringify([failedStart]));
    const given = agentStart(s, ["builder", "--pane", "w9:p3"]);
    expect(given.status).toBe(3);
    expect(given.json).toMatchObject({ reason: "agent_start_failed" });
    expect(given.json).not.toHaveProperty("paneClosed");
    expect(calls(s).map((argv) => argv.slice(0, 2))).toEqual([["agent", "start"]]);
    expect(existsSync(s.guardLog)).toBe(false);
  });
});
