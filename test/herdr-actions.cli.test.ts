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
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
      "-c",
      "maintenance.auto=false",
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
  writeFileSync(s.scenario, JSON.stringify([{ match: ["notification", "show"], stdout: "{}" }]));
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
  for (const key of ["HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_ENV", "WOOF_RUN_DIR"])
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
    for (const name of ["status", "cancel", "doctor", "watch"]) {
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
      { title: "Woof: no project context", body: expect.any(String) },
      { title: "Woof: no project context", body: expect.stringContaining(s.home) },
    ]);
    expect(existsSync(s.guardLog)).toBe(false);
  });

  it("A2 (LV-003): status lists only the focused pane's project runs, even when the workspace's worktree checkout is another repository", () => {
    const s = setup();
    const [a, b] = [s.repo("repo-a"), s.repo("repo-b")];
    openRun(s, "a-active", a);
    const ended = openRun(s, "a-ended", a);
    runSdk(ended, `out = await store.terminateRun({ runDir, outcome: "failed", reason: "test" });`);
    openRun(s, "b-active", b);

    // The live topology: a workspace bound to one checkout (b) with the target project (a) focused.
    const result = action(s, "status", {
      worktree: { checkout_path: b },
      focused_pane_cwd: a,
      workspace_cwd: b,
      focused_pane_id: "w5:p3",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.json).toMatchObject({ outcome: "runs", runsDir: s.runsDir, exists: true });
    expect(result.json["runs"].map((run: Json) => run["runId"])).toEqual(["a-active"]);
    expect(notifications(s)).toEqual([
      { title: "Woof: 1 active run(s)", body: "a-active created - owner unhosted" },
    ]);
    // Without a focused pane directory the workspace directory, then the checkout, decide.
    const workspace = action(s, "status", { worktree: { checkout_path: a }, workspace_cwd: b });
    expect(workspace.json["runs"].map((run: Json) => run["runId"])).toEqual(["b-active"]);
    const checkout = action(s, "status", { worktree: { checkout_path: a } });
    expect(checkout.json["runs"].map((run: Json) => run["runId"])).toEqual(["a-active"]);

    // PR #6 (herdr.ts:256): a focused pane outside git, or a directory that no longer exists, falls
    // through to the next candidate in the same precedence.
    const gone = join(s.root, "deleted-pane-dir");
    const outside = action(s, "status", {
      focused_pane_cwd: s.home,
      workspace_cwd: a,
      worktree: { checkout_path: b },
      focused_pane_id: "w5:p3",
    });
    expect(outside.status, outside.stdout + outside.stderr).toBe(0);
    expect(outside.json["runs"].map((run: Json) => run["runId"])).toEqual(["a-active"]);
    const deleted = action(s, "status", { focused_pane_cwd: gone, worktree: { checkout_path: b } });
    expect(deleted.status, deleted.stdout + deleted.stderr).toBe(0);
    expect(deleted.json["runs"].map((run: Json) => run["runId"])).toEqual(["b-active"]);
    const nowhere = action(s, "status", { focused_pane_cwd: s.home, workspace_cwd: gone });
    expect(nowhere.status).toBe(2);
    expect(nowhere.json).toMatchObject({ outcome: "rejected", reason: "project_context_missing" });
    expect(nowhere.json["message"]).toContain(`${s.home} is not inside a git work tree`);
    expect(nowhere.json["message"]).toContain(gone);

    const none = action(s, "status", { workspace_cwd: s.repo("repo-c") });
    expect(none.json["runs"]).toEqual([]);
    expect(notifications(s).at(-1)).toEqual({
      title: "Woof: 0 active run(s)",
      body: `no active Woof run in ${s.repo("repo-c")}`,
    });
    expect(existsSync(s.guardLog)).toBe(false);
  });

  it("A5, PR #6 (herdr-plugin.toml:21): doctor checks the focused pane's project with its trust and configuration, not the working directory", () => {
    const s = setup();
    const [a, b] = [s.repo("repo-a"), s.repo("repo-b")];
    mkdirSync(join(a, ".woof"), { recursive: true });
    writeFileSync(join(a, ".woof", "woof.json"), "{");
    writeFileSync(
      join(s.home, ".claude.json"),
      JSON.stringify({ projects: { [a]: { hasTrustDialogAccepted: true } } }),
    );
    // Claude Code on PATH is a shim; Herdr is only the fake, by absolute path.
    writeFileSync(join(s.root, "guard", "claude"), "#!/bin/sh\necho '9.9.9 (Claude Code)'\n", {
      mode: 0o755,
    });
    const scenario = JSON.parse(readFileSync(s.scenario, "utf8")) as Json[];
    writeFileSync(
      s.scenario,
      JSON.stringify([...scenario, { match: ["--version"], stdout: "herdr 0.0.0-fake\n" }]),
    );

    // The live topology: the workspace is bound to checkout b while project a is focused.
    const focused = action(s, "doctor", {
      worktree: { checkout_path: b },
      focused_pane_cwd: a,
      workspace_cwd: b,
      focused_pane_id: "w5:p3",
    });
    expect(focused.status, focused.stdout + focused.stderr).toBe(0);
    expect(focused.json).toMatchObject({
      outcome: "doctor",
      project: a,
      woof: { cli: join(repoRoot, "dist", "cli.js") },
      herdr: { status: "available", version: "herdr 0.0.0-fake" },
      claude: { status: "available", version: "9.9.9 (Claude Code)" },
      trust: { dir: a, status: "trusted" },
      config: { ok: false, reason: "config_invalid" },
    });
    const workspace = action(s, "doctor", { worktree: { checkout_path: a }, workspace_cwd: b });
    expect(workspace.status).toBe(0);
    expect(workspace.json).toMatchObject({
      project: b,
      trust: { dir: b, status: "untrusted" },
      config: { ok: true, project: b },
    });
    expect(focused.json["problems"]).toEqual(["config_invalid"]);
    expect(workspace.json["problems"]).toEqual(["trust_untrusted"]);
    const [first, second] = notifications(s);
    expect(notifications(s)).toHaveLength(2);
    // F-016: the title counts the report's problems; the action still exits 0 (a report, not a refusal).
    expect(first).toEqual({ title: "Woof: doctor (1 problem)", body: expect.stringContaining(a) });
    expect(second?.title).toBe("Woof: doctor (1 problem)");
    expect(first?.body).toContain("herdr available (herdr 0.0.0-fake)");
    expect(first?.body).toContain("trust trusted");
    expect(first?.body).toContain("config config_invalid");
    expect(second?.body).toContain("config ok");
    expect(calls(s).filter((argv) => argv[0] === "--version")).toHaveLength(2);
    expect(existsSync(s.guardLog)).toBe(false);

    // Nothing wrong: the plain title. Two problems: the plural.
    writeFileSync(
      join(s.home, ".claude.json"),
      JSON.stringify({ projects: { [b]: { hasTrustDialogAccepted: true } } }),
    );
    const healthy = action(s, "doctor", { worktree: { checkout_path: b }, workspace_cwd: b });
    expect(healthy.status).toBe(0);
    expect(healthy.json["problems"]).toEqual([]);
    expect(notifications(s).at(-1)?.title).toBe("Woof: doctor");
    const two = action(s, "doctor", { worktree: { checkout_path: a }, workspace_cwd: a });
    expect(two.status).toBe(0);
    expect(two.json["problems"]).toEqual(["trust_untrusted", "config_invalid"]);
    expect(notifications(s).at(-1)?.title).toBe("Woof: doctor (2 problems)");
  });

  it("A4: cancel ends the single active run and refuses when several are active", () => {
    const s = setup();
    const [a, b] = [s.repo("repo-a"), s.repo("repo-b")];
    const single = openRun(s, "a-only", a);
    const [b1, b2] = [openRun(s, "b-one", b), openRun(s, "b-two", b)];

    // LV-003: the focused pane's project wins over the workspace's worktree checkout (b).
    const cancelled = action(s, "cancel", { focused_pane_cwd: a, worktree: { checkout_path: b } });
    expect(cancelled.status, cancelled.stdout + cancelled.stderr).toBe(0);
    expect(cancelled.json).toMatchObject({ outcome: "recorded", runId: "a-only", runDir: single });
    expect(statusOf(single)).toBe("cancelled: cancelled via Herdr action");
    expect(notifications(s).at(-1)).toEqual({ title: "Woof: cancelled a-only", body: single });

    const nothing = action(s, "cancel", { focused_pane_cwd: a });
    // R2 (verify-1 L1): Herdr logs a non-zero action exit as "failed", like a crash, so nothing to
    // cancel exits 0 with outcome noop; several active runs stay a refusal (exit 2).
    expect(nothing.status, nothing.stdout + nothing.stderr).toBe(0);
    expect(nothing.json).toEqual({
      outcome: "noop",
      reason: "no_active_run",
      message: `no active Woof run in ${a}`,
      details: [],
    });
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

  it("A6: watch opens a plugin pane following the single active run; none is a noop, several a refusal", () => {
    const s = setup();
    /** Adds entries ahead of setup()'s scenario. */
    const script = (...entries: Json[]) =>
      writeFileSync(
        s.scenario,
        JSON.stringify([...entries, ...(JSON.parse(readFileSync(s.scenario, "utf8")) as Json[])]),
      );
    const [a, b] = [s.repo("repo-a"), s.repo("repo-b")];
    const pluginCalls = () => calls(s).filter((argv) => argv[0] === "plugin");

    const nothing = action(s, "watch", { focused_pane_cwd: a });
    expect(nothing.status, nothing.stdout + nothing.stderr).toBe(0);
    expect(nothing.json).toEqual({
      outcome: "noop",
      reason: "no_active_run",
      message: `no active Woof run in ${a}`,
      details: [],
    });
    expect(notifications(s).at(-1)).toEqual({
      title: "Woof: nothing to watch",
      body: `no active Woof run in ${a}`,
    });

    const [b1, b2] = [openRun(s, "b-one", b), openRun(s, "b-two", b)];
    const refused = action(s, "watch", { focused_pane_cwd: b });
    expect(refused.status, refused.stdout).toBe(2);
    expect(refused.json).toMatchObject({ outcome: "rejected", reason: "run_ambiguous" });
    expect(refused.json["details"].map((detail: Json) => detail["message"]).toSorted()).toEqual(
      [`woof watch ${b1}`, `woof watch ${b2}`].toSorted(),
    );
    expect(notifications(s).at(-1)?.title).toBe("Woof: 2 active runs, none watched");
    expect(pluginCalls()).toEqual([]);

    // Herdr 0.9 reports the opened pane as result.plugin_pane.pane.
    script({
      match: ["plugin", "pane", "open"],
      call: 1,
      stdout: JSON.stringify({
        result: { plugin_pane: { entrypoint: "watch", pane: { pane_id: "w5:p9" } } },
      }),
    });
    const single = openRun(s, "a-only", a);
    const watched = action(s, "watch", { focused_pane_id: "w5:p3", focused_pane_cwd: a });
    expect(watched.status, watched.stdout + watched.stderr).toBe(0);
    expect(watched.json).toEqual({
      outcome: "watching",
      runId: "a-only",
      runDir: single,
      paneId: "w5:p9",
    });
    expect(pluginCalls()).toEqual([
      [
        "plugin",
        "pane",
        "open",
        "--plugin",
        "herdr-woof",
        "--entrypoint",
        "watch",
        "--placement",
        "split",
        "--target-pane",
        "w5:p3",
        "--direction",
        "right",
        "--env",
        `WOOF_RUN_DIR=${single}`,
        "--no-focus",
      ],
    ]);
    expect(notifications(s).at(-1)).toEqual({ title: "Woof: watching a-only", body: single });
    // Watching never changes the run.
    expect(statusOf(single)).toBe("created");

    script({ match: ["plugin", "pane", "open"], call: 2, exit: 1, stderr: "no such plugin\n" });
    const failed = action(s, "watch", { focused_pane_cwd: a });
    expect(failed.status, failed.stdout).toBe(3);
    expect(failed.json).toEqual({
      outcome: "rejected",
      reason: "watch_pane_failed",
      message: "herdr plugin pane open failed: no such plugin",
      details: [],
    });
    expect(pluginCalls().at(-1)).not.toContain("--target-pane");
    expect(notifications(s).at(-1)?.title).toBe("Woof: rejected (watch_pane_failed)");
    expect(existsSync(s.guardLog)).toBe(false);
  });
});
