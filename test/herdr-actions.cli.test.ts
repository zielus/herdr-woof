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

import { repoRoot, runSdk, testPlan } from "./helpers/process.js";

// Herdr plugin actions (plan T8, A1–A4): `bin/woof herdr <action>` as Herdr runs
// it, from the plugin root, with a fake invocation context and the fake Herdr
// CLI by absolute path. A failing `herdr` first on PATH guards against the real one.
const fakeHerdr = join(repoRoot, "test", "fixtures", "fake-herdr.mjs");
const bin = join(repoRoot, "bin", "woof");
const dirs: string[] = [];
const hosted: string[] = [];
afterEach(() => {
  for (const runDir of hosted.splice(0)) {
    try {
      const host = JSON.parse(readFileSync(join(runDir, "host.json"), "utf8")) as Json;
      if (
        host["state"] === "hosting" &&
        !existsSync(join(runDir, "host-exit.json")) &&
        typeof host["pid"] === "number"
      )
        process.kill(host["pid"], "SIGKILL");
    } catch {
      // No claim, or the host is already gone.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Json = Record<string, any>; // oxlint-disable-line no-explicit-any

interface Setup {
  root: string;
  home: string;
  runsDir: string;
  log: string;
  scenario: string;
  guardLog: string;
  repo: (name: string) => string;
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
      ...args,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
  );
  expect(result.status, result.stderr).toBe(0);
}

function setup(): Setup {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "woof-herdr-actions-")));
  dirs.push(root);
  const home = join(root, "home");
  const runsDir = join(root, "runs");
  const guard = join(root, "guard");
  for (const dir of [home, runsDir, guard, join(home, ".woof")])
    mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(home, ".woof", "woof.json"),
    JSON.stringify({ schemaVersion: 1, defaults: { runsDir } }),
  );
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
    runsDir,
    log: join(root, "herdr.log"),
    scenario: join(root, "scenario.json"),
    guardLog,
    repo: (name) => {
      const repo = join(root, name);
      if (!existsSync(repo)) {
        mkdirSync(repo);
        git(repo, "init", "-q");
        writeFileSync(join(repo, "README.md"), "fixture\n");
        appendFileSync(join(repo, ".git", "info", "exclude"), ".woof/\n");
        git(repo, "add", "-A");
        git(repo, "commit", "-q", "-m", "init");
      }
      return repo;
    },
  };
  writeFileSync(
    s.scenario,
    JSON.stringify([
      { match: ["notification", "show"], stdout: "{}" },
      {
        match: ["pane", "split"],
        call: 1,
        stdout: JSON.stringify({ result: { pane: { pane_id: "w5:p8" } } }),
      },
      {
        match: ["pane", "run"],
        call: 1,
        stdout: "{}",
        spawn: {
          commandIndex: 3,
          env: { HERDR_ENV: "1", HERDR_PANE_ID: "w5:p8", WOOF_HOST_HEARTBEAT_MS: "200" },
          log: join(root, "host.log"),
        },
      },
      { match: ["pane", "report-metadata"], stdout: "{}" },
    ]),
  );
  return s;
}

function action(
  s: Setup,
  name: string,
  context: Json | undefined,
): { status: number | null; json: Json; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(s.root, "guard")}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: s.home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    WOOF_HERDR_BIN: fakeHerdr,
    FAKE_HERDR_LOG: s.log,
    FAKE_HERDR_SCENARIO: s.scenario,
    ...(context !== undefined ? { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context) } : {}),
  };
  for (const key of ["HERDR_PANE_ID", "HERDR_ENV", "WOOF_RUN_DIR"])
    Reflect.deleteProperty(env, key);
  if (context === undefined) Reflect.deleteProperty(env, "HERDR_PLUGIN_CONTEXT_JSON");
  const result = spawnSync(bin, ["herdr", name], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  const last = result.stdout.trim().split("\n").at(-1) ?? "null";
  return {
    status: result.status,
    json: JSON.parse(last) as Json,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function calls(s: Setup): string[][] {
  return existsSync(s.log)
    ? readFileSync(s.log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as string[])
    : [];
}

function notifications(s: Setup): Array<{ title: string; body: string }> {
  return calls(s)
    .filter((argv) => argv[0] === "notification" && argv[1] === "show")
    .map((argv) => ({ title: argv[2] ?? "", body: argv[4] ?? "" }));
}

function openRun(s: Setup, name: string, repo: string): string {
  const runDir = join(s.runsDir, name);
  mkdirSync(runDir);
  const out = runSdk<{ outcome: string }>(
    runDir,
    `out = await store.openRun({ runDir, runId: input.runId, plan: input.plan, configuration: input.configuration });`,
    {
      runId: name,
      plan: testPlan(),
      configuration: { repository: repo, roots: { project: { root: repo } } },
    },
  );
  expect(out.outcome).toBe("recorded");
  return runDir;
}

function statusOf(runDir: string): string {
  const out = runSdk<{ snapshot: { status: string; outcome: { reason: string } | null } }>(
    runDir,
    `out = snapshots.readSnapshot(runDir);`,
  );
  return out.snapshot.outcome === null
    ? out.snapshot.status
    : `${out.snapshot.status}: ${out.snapshot.outcome.reason}`;
}

describe("woof herdr actions", () => {
  it("A1: without a project context each action notifies and exits 2", () => {
    const s = setup();
    for (const name of ["status", "start", "cancel"]) {
      const result = action(s, name, undefined);
      expect(result.status, result.stdout + result.stderr).toBe(2);
      expect(result.json).toMatchObject({ outcome: "rejected", reason: "project_context_missing" });
    }
    const notDir = action(s, "status", { focused_pane_cwd: s.home });
    expect(notDir.status).toBe(2);
    expect(notDir.json["message"]).toContain("not inside a git work tree");
    expect(notifications(s)).toEqual([
      {
        title: "Woof: no project context",
        body: expect.stringContaining("HERDR_PLUGIN_CONTEXT_JSON"),
      },
      { title: "Woof: no project context", body: expect.any(String) },
      { title: "Woof: no project context", body: expect.any(String) },
      { title: "Woof: no project context", body: expect.stringContaining(s.home) },
    ]);
    expect(existsSync(s.guardLog)).toBe(false);
  });

  it("A2: status lists only the context project's active runs; the worktree checkout wins", () => {
    const s = setup();
    const [a, b] = [s.repo("repo-a"), s.repo("repo-b")];
    openRun(s, "a-active", a);
    const ended = openRun(s, "a-ended", a);
    runSdk(ended, `out = await store.terminateRun({ runDir, outcome: "failed", reason: "test" });`);
    openRun(s, "b-active", b);

    const result = action(s, "status", {
      worktree: { checkout_path: a },
      focused_pane_cwd: b,
      workspace_cwd: b,
      focused_pane_id: "w5:p3",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.json).toMatchObject({ outcome: "runs", runsDir: s.runsDir, exists: true });
    expect(result.json["runs"].map((run: Json) => run["runId"])).toEqual(["a-active"]);
    expect(notifications(s)).toEqual([
      { title: "Woof: 1 active run(s)", body: "a-active created - owner unhosted" },
    ]);

    const none = action(s, "status", { workspace_cwd: s.repo("repo-c") });
    expect(none.json["runs"]).toEqual([]);
    expect(notifications(s).at(-1)).toEqual({
      title: "Woof: 0 active run(s)",
      body: `no active Woof run in ${s.repo("repo-c")}`,
    });
    expect(existsSync(s.guardLog)).toBe(false);
  });

  it("A3: start needs .woof/start.json, then splits the host pane from the focused pane", () => {
    const s = setup();
    const repo = s.repo("repo-a");
    const context = { focused_pane_id: "w5:p3", focused_pane_cwd: repo };
    const missing = action(s, "start", context);
    expect(missing.status, missing.stdout + missing.stderr).toBe(2);
    expect(missing.json).toMatchObject({ outcome: "rejected", reason: "input_invalid" });
    expect(notifications(s)).toEqual([
      {
        title: "Woof: create .woof/start.json with a workflow input",
        body: expect.stringContaining(join(repo, ".woof", "start.json")),
      },
    ]);
    expect(calls(s).some((argv) => argv[0] === "pane")).toBe(false);

    mkdirSync(join(repo, ".woof"));
    writeFileSync(
      join(repo, ".woof", "start.json"),
      JSON.stringify({
        schemaVersion: 1,
        repo,
        task: {
          title: "Change the fixture",
          description: "Write src/change.txt.",
          acceptanceCriteria: ["the file exists"],
        },
        limits: {
          runTimeoutMs: 20_000,
          readinessWaitMs: 2000,
          blockedWaitMs: 2000,
          deliveryTimeoutMs: 2000,
        },
      }),
    );
    const started = action(s, "start", context);
    if (typeof started.json["runDir"] === "string") hosted.push(started.json["runDir"]);
    expect(started.status, started.stdout + started.stderr).toBe(0);
    expect(started.json).toMatchObject({
      outcome: "started",
      runDir: join(s.runsDir, started.json["runId"]),
      host: { mode: "herdr-pane", paneId: "w5:p8" },
    });
    expect(calls(s).find((argv) => argv[0] === "pane" && argv[1] === "split")).toEqual([
      "pane",
      "split",
      "w5:p3",
      "--direction",
      "right",
      "--cwd",
      repo,
      "--no-focus",
    ]);
    expect(notifications(s).at(-1)).toEqual({
      title: `Woof: started ${started.json["runId"]}`,
      body: `run directory ${started.json["runDir"]}`,
    });
    expect(existsSync(s.guardLog)).toBe(false);
  }, 90_000);

  it("A4: cancel ends the single active run and refuses when several are active", () => {
    const s = setup();
    const [a, b] = [s.repo("repo-a"), s.repo("repo-b")];
    const single = openRun(s, "a-only", a);
    const [b1, b2] = [openRun(s, "b-one", b), openRun(s, "b-two", b)];

    const cancelled = action(s, "cancel", { focused_pane_cwd: a });
    expect(cancelled.status, cancelled.stdout + cancelled.stderr).toBe(0);
    expect(cancelled.json).toMatchObject({ outcome: "recorded", runId: "a-only", runDir: single });
    expect(statusOf(single)).toBe("cancelled: cancelled via Herdr action");
    expect(notifications(s).at(-1)).toEqual({ title: "Woof: cancelled a-only", body: single });

    const nothing = action(s, "cancel", { focused_pane_cwd: a });
    expect(nothing.status).toBe(0);
    expect(nothing.json).toMatchObject({ outcome: "rejected", reason: "no_active_run" });
    expect(notifications(s).at(-1)?.title).toBe("Woof: nothing to cancel");

    const refused = action(s, "cancel", { focused_pane_cwd: b });
    expect(refused.status, refused.stdout).toBe(2);
    expect(refused.json).toMatchObject({ outcome: "rejected", reason: "run_ambiguous" });
    expect(refused.json["details"].map((detail: Json) => detail["message"]).toSorted()).toEqual(
      [`woof run cancel ${b1}`, `woof run cancel ${b2}`].toSorted(),
    );
    const refusal = notifications(s).at(-1);
    expect(refusal?.title).toBe("Woof: 2 active runs, none cancelled");
    expect(refusal?.body).toContain(b1);
    expect(refusal?.body).toContain(b2);
    expect([statusOf(b1), statusOf(b2)]).toEqual(["created", "created"]);
    expect(existsSync(s.guardLog)).toBe(false);
  });
});
