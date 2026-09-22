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
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { expectFoldEqualsSnapshot } from "./helpers/fold.js";
import { cliPath, repoRoot } from "./helpers/process.js";

// The checkout policy in the run input (docs/design/composition.md) as real processes: the
// reserved `checkout` key, the worktree a launch creates through (fake) Herdr, the dirty-tree
// rule for writable workflows, `path`, and `keep: false`. The fake Herdr's `worktree create`
// makes a real `git worktree`, so admission, fingerprints and the scripted agents all work in it.
const fakeHerdr = join(repoRoot, "test", "fixtures", "fake-herdr.mjs");
const runtimeModule = join(repoRoot, "test", "fixtures", "scripted-runtime-module.mjs");
const scribe = join(repoRoot, "test", "fixtures", "workflows", "scribe.mjs");

type Json = Record<string, any>; // oxlint-disable-line no-explicit-any

const dirs: string[] = [];
const hosts: number[] = [];
afterEach(async () => {
  for (const pid of hosts.splice(0)) {
    const deadline = Date.now() + 10_000;
    while (alive(pid) && Date.now() < deadline) await delay(50);
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

interface Ws {
  root: string;
  home: string;
  repo: string;
  worktrees: string;
  log: string;
  scenario: string;
  runtimeLog: string;
}

function setup(): Ws {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "woof-checkout-")));
  dirs.push(root);
  const ws: Ws = {
    root,
    home: join(root, "home"),
    repo: join(root, "repo"),
    worktrees: join(root, "worktrees"),
    log: join(root, "herdr.log"),
    scenario: join(root, "scenario.json"),
    runtimeLog: join(root, "runtime.log"),
  };
  mkdirSync(ws.home);
  mkdirSync(ws.repo);
  mkdirSync(ws.worktrees);
  git(ws.repo, "init", "-q", "-b", "main");
  writeFileSync(join(ws.repo, "README.md"), "fixture\n");
  git(ws.repo, "add", "-A");
  git(ws.repo, "commit", "-q", "-m", "init");
  scenario(ws);
  return ws;
}

/** The fake Herdr: worktree create/remove for real, and the host typed into the worktree's root pane. */
function scenario(ws: Ws): void {
  writeFileSync(
    ws.scenario,
    JSON.stringify([
      {
        match: ["pane", "get"],
        stdout: JSON.stringify({
          id: "x",
          result: { pane: { pane_id: "w9:p1", workspace_id: "w9" } },
        }),
      },
      { match: ["worktree", "create"], worktree: { dir: ws.worktrees, workspaceId: "w7" } },
      { match: ["worktree", "remove"], worktree: { remove: true } },
      {
        match: ["pane", "run", "w7:p1"],
        stdout: "{}",
        spawn: {
          commandIndex: 3,
          env: { HERDR_ENV: "1", HERDR_PANE_ID: "w7:p1", TZ: "UTC" },
          log: join(ws.root, "pane.log"),
        },
      },
      { match: ["pane", "report-metadata"], stdout: "{}" },
      { match: ["notification", "show"], stdout: "{}" },
    ]),
  );
}

function input(ws: Ws, overrides: Json = {}): Json {
  return {
    schemaVersion: 1,
    repo: ws.repo,
    task: {
      title: "Change the fixture",
      description: "Write src/change.txt.",
      acceptanceCriteria: ["the file exists"],
    },
    limits: {
      runTimeoutMs: 60_000,
      readinessWaitMs: 10_000,
      blockedWaitMs: 10_000,
      deliveryTimeoutMs: 10_000,
    },
    ...overrides,
  };
}

function woof(ws: Ws, args: string[], extra: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: ws.home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w9:p1",
    HERDR_WORKSPACE_ID: "w9",
    WOOF_HERDR_BIN: fakeHerdr,
    FAKE_HERDR_LOG: ws.log,
    FAKE_HERDR_SCENARIO: ws.scenario,
    WOOF_TEST_SCRIPT: "happy",
    WOOF_TEST_RUNTIME_LOG: ws.runtimeLog,
    WOOF_HOST_HEARTBEAT_MS: "200",
    ...extra,
  };
  Reflect.deleteProperty(env, "WOOF_RUN_DIR");
  for (const [key, value] of Object.entries(env))
    if (value === undefined) Reflect.deleteProperty(env, key);
  const result = spawnSync("node", [cliPath, ...args], {
    cwd: ws.root,
    env,
    encoding: "utf8",
    timeout: 90_000,
  });
  const last = result.stdout.trim().split("\n").at(-1) ?? "";
  let json: Json = {};
  try {
    json = JSON.parse(last) as Json;
  } catch {
    json = {};
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json, env };
}

function start(ws: Ws, runDir: string, value: Json, extra: string[] = []) {
  const path = join(ws.root, `input-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(value));
  return [
    "run",
    "start",
    "--input",
    path,
    "--project",
    ws.repo,
    "--run-dir",
    runDir,
    "--runtime-module",
    runtimeModule,
    "--poll-ms",
    "5",
    ...extra,
  ];
}

function calls(ws: Ws): string[][] {
  return existsSync(ws.log)
    ? readFileSync(ws.log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as string[])
    : [];
}

function journal(runDir: string): Json[] {
  return readFileSync(join(runDir, "journal.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Json);
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    // oxlint-disable-next-line no-await-in-loop
    await delay(50);
  }
}

describe("checkout policy in the run input", () => {
  it("K1: a malformed checkout is input_invalid naming the field; a worktree outside Herdr is checkout_unsupported; nothing opens", () => {
    const ws = setup();
    const runDir = join(ws.root, "run");
    const outside = { HERDR_ENV: undefined, HERDR_PANE_ID: undefined };
    const bad = woof(
      ws,
      start(ws, runDir, input(ws, { checkout: { mode: "worktree", branch: "-x", extra: 1 } }), [
        "--host",
        "foreground",
      ]),
      outside,
    );
    expect(bad.status, bad.stdout + bad.stderr).toBe(2);
    expect(bad.json).toMatchObject({ outcome: "rejected", reason: "input_invalid" });
    expect(bad.json["details"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "checkout.branch" }),
        expect.objectContaining({ field: "checkout.extra" }),
      ]),
    );
    const mode = woof(
      ws,
      start(ws, runDir, input(ws, { checkout: { mode: "elsewhere" } }), ["--host", "foreground"]),
      outside,
    );
    expect(mode.json["details"]).toEqual([
      { field: "checkout.mode", message: 'must be "current", "worktree" or "path"' },
    ]);
    const unsupported = woof(
      ws,
      start(ws, runDir, input(ws, { checkout: { mode: "worktree" } }), ["--host", "foreground"]),
      outside,
    );
    expect(unsupported.status, unsupported.stdout + unsupported.stderr).toBe(2);
    expect(unsupported.json).toMatchObject({ reason: "checkout_unsupported" });
    expect(existsSync(join(runDir, "journal.jsonl"))).toBe(false);
    expect(calls(ws)).toEqual([]);
  });

  it("K2: a writable workflow refuses a dirty current tree (checkout_dirty); .woof/ does not count; a workflow declaring checkout any runs on it", () => {
    const ws = setup();
    mkdirSync(join(ws.repo, ".woof", "workflows"), { recursive: true });
    const outside = { HERDR_ENV: undefined, HERDR_PANE_ID: undefined };
    // Untracked .woof/ alone is Woof's configuration, not work in progress: the run completes.
    const clean = woof(
      ws,
      start(ws, join(ws.root, "run-clean"), input(ws, { checkout: { mode: "current" } }), [
        "--host",
        "foreground",
      ]),
      outside,
    );
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    expect(clean.json["result"]["outcome"]).toBe("completed");
    // That run left src/change.txt uncommitted: the next writable run refuses the tree.
    const dirty = woof(
      ws,
      start(ws, join(ws.root, "run-dirty"), input(ws), ["--host", "foreground"]),
      outside,
    );
    expect(dirty.status, dirty.stdout + dirty.stderr).toBe(2);
    expect(dirty.json).toMatchObject({ outcome: "rejected", reason: "checkout_dirty" });
    expect(dirty.json["message"]).toContain("?? src/");
    expect(existsSync(join(ws.root, "run-dirty", "journal.jsonl"))).toBe(false);
    // A read-only workflow (checkout: "any") takes the same dirty tree.
    writeFileSync(
      join(ws.repo, ".woof", "workflows", "scribe.mjs"),
      readFileSync(scribe, "utf8").replace(
        "repository: (input) => input.repo,",
        'repository: (input) => input.repo,\n  checkout: "any",',
      ),
    );
    const scribed = woof(
      ws,
      [
        ...start(ws, join(ws.root, "run-any"), { schemaVersion: 1, repo: ws.repo, note: "x" }),
        "--workflow",
        "scribe",
        "--host",
        "foreground",
      ],
      outside,
    );
    expect(scribed.status, scribed.stdout + scribed.stderr).toBe(0);
    const opened = journal(join(ws.root, "run-any"))[0];
    expect(opened?.["checkout"]).toEqual({
      mode: "current",
      path: ws.repo,
      source: ws.repo,
      branch: null,
      base: null,
      workspaceId: null,
      created: false,
      keep: true,
      inherited: false,
    });
  });

  it("K3: inside Herdr a launch creates the worktree, hosts the run in its workspace's root pane, and every agent works there; the source tree is untouched", async () => {
    const ws = setup();
    const runDir = join(ws.root, "run");
    const launched = woof(
      ws,
      start(ws, runDir, input(ws, { checkout: { mode: "worktree", base: "main" } }), [
        "--run-id",
        "k3-run",
      ]),
    );
    expect(launched.status, launched.stdout + launched.stderr).toBe(0);
    const path = join(ws.worktrees, "woof-k3-run");
    const expected = {
      mode: "worktree",
      path,
      source: ws.repo,
      branch: "woof/k3-run",
      base: "main",
      workspaceId: "w7",
      created: true,
      keep: true,
      inherited: false,
    };
    expect(launched.json).toMatchObject({
      outcome: "started",
      host: { mode: "herdr-pane", paneId: "w7:p1", tabId: "w7:t1" },
      checkout: expected,
    });
    const argv = calls(ws);
    expect(argv.find((item) => item[0] === "worktree")).toEqual([
      "worktree",
      "create",
      "--cwd",
      ws.repo,
      "--branch",
      "woof/k3-run",
      "--base",
      "main",
      "--label",
      "woof:build-review",
      "--no-focus",
    ]);
    // No host tab: the host runs in the worktree workspace's root pane, told that workspace.
    expect(argv.some((item) => item[0] === "tab" && item[1] === "create")).toBe(false);
    const typed = argv.find((item) => item[0] === "pane" && item[1] === "run") ?? [];
    expect(typed.slice(0, 5)).toEqual(["pane", "run", "w7:p1", "env", "HERDR_WORKSPACE_ID=w7"]);
    await waitFor(() => existsSync(join(runDir, "host-exit.json")), "the host to exit");
    hosts.push((JSON.parse(readFileSync(join(runDir, "host.json"), "utf8")) as Json)["pid"]);
    const records = journal(runDir);
    expect(records[0]?.["checkout"]).toEqual(expected);
    expect(records.find((record) => record["type"] === "run.terminated")?.["outcome"]).toBe(
      "completed",
    );
    const config = JSON.parse(readFileSync(join(runDir, "config.json"), "utf8")) as Json;
    expect(config["repository"]).toBe(path);
    // The scripted agents were started for the worktree, and their change landed there only.
    const contexts = readFileSync(ws.runtimeLog, "utf8").trim().split("\n");
    expect(contexts.map((line) => (JSON.parse(line) as Json)["repo"])).toEqual([path]);
    expect(readFileSync(join(path, "src", "change.txt"), "utf8")).toMatch(/^version /);
    expect(existsSync(join(ws.repo, "src"))).toBe(false);
    expect(
      git(ws.repo, "branch", "--list", "--format=%(refname:short)", "woof/k3-run").trim(),
    ).toBe("woof/k3-run");
    const status = woof(ws, ["status", runDir]);
    expect(status.json["status"]["checkout"]).toEqual(expected);
    const pretty = woof(ws, ["status", runDir, "--pretty"]);
    expect(pretty.stdout).toContain(`checkout worktree ${path} branch woof/k3-run workspace w7`);
    const view = woof(ws, ["watch", runDir]);
    expect(view.stdout).toContain("checkout worktree · woof/k3-run");
    const snapshot = await expectFoldEqualsSnapshot(runDir, launched.env);
    expect(snapshot["checkout"]).toEqual(expected);
  }, 120_000);

  it("K4: keep false removes the created worktree after a completed run (the branch stays); path works in a caller's own worktree", async () => {
    const ws = setup();
    const runDir = join(ws.root, "run");
    const launched = woof(
      ws,
      start(ws, runDir, input(ws, { checkout: { mode: "worktree", keep: false } }), [
        "--run-id",
        "k4-run",
      ]),
    );
    expect(launched.status, launched.stdout + launched.stderr).toBe(0);
    const path = join(ws.worktrees, "woof-k4-run");
    await waitFor(() => existsSync(join(runDir, "host-exit.json")), "the host to exit");
    hosts.push((JSON.parse(readFileSync(join(runDir, "host.json"), "utf8")) as Json)["pid"]);
    await waitFor(
      () => calls(ws).some((item) => item[0] === "worktree" && item[1] === "remove"),
      "the worktree removal",
    );
    await waitFor(() => !existsSync(path), "the worktree to go");
    expect(calls(ws).find((item) => item[1] === "remove")).toEqual([
      "worktree",
      "remove",
      "--workspace",
      "w7",
      "--force",
    ]);
    expect(
      git(ws.repo, "branch", "--list", "--format=%(refname:short)", "woof/k4-run").trim(),
    ).toBe("woof/k4-run");
    expect(readFileSync(join(runDir, "host.log"), "utf8")).toContain(
      "checkout: the worktree of workspace w7 was removed (keep: false)",
    );

    // mode path: a worktree the caller made; nothing is created or removed.
    const own = join(ws.root, "own");
    git(ws.repo, "worktree", "add", "-q", "-b", "own", own);
    appendFileSync(join(ws.root, "marker"), "");
    const pathDir = join(ws.root, "run-path");
    const ran = woof(
      ws,
      start(ws, pathDir, input(ws, { checkout: { mode: "path", path: own } }), [
        "--host",
        "foreground",
      ]),
    );
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(journal(pathDir)[0]?.["checkout"]).toMatchObject({
      mode: "path",
      path: own,
      source: ws.repo,
      created: false,
    });
    expect(existsSync(join(own, "src", "change.txt"))).toBe(true);
    expect(calls(ws).filter((item) => item[0] === "worktree")).toHaveLength(2);
  }, 120_000);
});
