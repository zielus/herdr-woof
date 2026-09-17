import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cliPath,
  distUrl,
  repoRoot,
  runNode,
  woof,
  type ProcessResult,
} from "./helpers/process.js";

// `woof run build-review` and `woof run cancel` as real processes (node dist/cli.js).
const runtimeModule = join(repoRoot, "test", "fixtures", "scripted-runtime-module.mjs");
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

type Json = Record<string, unknown>;

function workspace(): {
  root: string;
  repo: string;
  runDir: string;
  inputPath: string;
  log: string;
} {
  const root = mkdtempSync(join(tmpdir(), "woof-br-cli-"));
  dirs.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    spawnSync(
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
      {
        cwd: repo,
        encoding: "utf8",
      },
    );
  git("init", "-q");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return {
    root,
    repo,
    runDir: join(root, "run"),
    inputPath: join(root, "input.json"),
    log: join(root, "runtime.log"),
  };
}

function input(repo: string, overrides: Json = {}): Json {
  return {
    schemaVersion: 1,
    repo,
    task: {
      title: "Change the fixture",
      description: "Write src/change.txt.",
      acceptanceCriteria: ["the file exists"],
    },
    agents: {
      builder: { kind: "claude", model: null, args: [] },
      reviewer: { kind: "claude", model: "sonnet", args: ["--permission-mode", "auto"] },
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

function writeInput(path: string, value: unknown): string {
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

const scriptedEnv = (log: string, script = "happy") => ({
  WOOF_TEST_SCRIPT: script,
  WOOF_TEST_RUNTIME_LOG: log,
});

function runBuildReview(
  ws: ReturnType<typeof workspace>,
  extra: string[] = [],
  env: Record<string, string | undefined> = {},
): ProcessResult {
  return woof(
    [
      "run",
      "build-review",
      "--input",
      ws.inputPath,
      "--run-dir",
      ws.runDir,
      "--run-id",
      "cli-run",
      "--poll-ms",
      "2",
      ...extra,
    ],
    {
      env,
      timeoutMs: 60_000,
    },
  );
}

function startBuildReview(
  ws: ReturnType<typeof workspace>,
  extra: string[],
  env: Record<string, string>,
) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  Reflect.deleteProperty(childEnv, "HERDR_PANE_ID");
  Reflect.deleteProperty(childEnv, "WOOF_RUN_DIR");
  const child = spawn(
    "node",
    [
      cliPath,
      "run",
      "build-review",
      "--input",
      ws.inputPath,
      "--run-dir",
      ws.runDir,
      "--run-id",
      "cli-run",
      ...extra,
    ],
    {
      env: childEnv,
      cwd: repoRoot,
    },
  );
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<{ status: number | null; stdout: string; stderr: string; at: number }>(
    (resolve) => child.on("close", (status) => resolve({ status, stdout, stderr, at: Date.now() })),
  );
  return { child, exited };
}

const journalTypes = (runDir: string): string[] =>
  existsSync(join(runDir, "journal.jsonl"))
    ? readFileSync(join(runDir, "journal.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => (JSON.parse(line) as { type: string }).type)
    : [];

async function waitForRecord(runDir: string, type: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!journalTypes(runDir).includes(type)) {
    if (Date.now() > deadline) throw new Error(`no ${type} in ${runDir} after ${timeoutMs} ms`);
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("woof run build-review: usage and admission", () => {
  it("exits 1 on missing arguments or unknown flags", () => {
    expect(woof(["run", "build-review"]).status).toBe(1);
    expect(
      woof(["run", "build-review", "--input", "x.json", "--run-dir", "/tmp/x", "--bogus"]).status,
    ).toBe(1);
    expect(
      woof(["run", "build-review", "--input", "x.json", "--run-dir", "/tmp/x", "--run-id", "../x"])
        .status,
    ).toBe(1);
    expect(woof(["run", "cancel"]).status).toBe(1);
    expect(woof(["run", "build-review", "--help"])).toMatchObject({ status: 0 });
    expect(woof(["run", "build-review", "--help"]).stdout).toContain("--runtime-module");
  });

  it("rejects invalid input before loading the runtime or writing a journal", () => {
    const ws = workspace();
    writeInput(ws.inputPath, { ...input(ws.repo), task: { title: "" } });
    const result = runBuildReview(ws, ["--runtime-module", runtimeModule], scriptedEnv(ws.log));
    expect(result.status).toBe(2);
    expect(result.json).toMatchObject({ outcome: "rejected", reason: "input_invalid" });
    expect(result.json?.details?.map((detail) => detail.field)).toEqual(
      expect.arrayContaining(["task.title", "task.description", "task.acceptanceCriteria"]),
    );
    expect(existsSync(ws.log)).toBe(false);
    expect(existsSync(join(ws.runDir, "journal.jsonl"))).toBe(false);

    writeInput(ws.inputPath, "{ not json");
    expect(
      runBuildReview(ws, ["--runtime-module", runtimeModule], scriptedEnv(ws.log)).json,
    ).toMatchObject({
      reason: "input_invalid",
    });
  });

  it("rejects a repository that is not a git work tree and an unsupported agent kind", () => {
    const ws = workspace();
    const notRepo = join(ws.root, "plain");
    mkdirSync(notRepo);
    writeInput(ws.inputPath, input(notRepo));
    const repoResult = runBuildReview(ws, ["--runtime-module", runtimeModule], scriptedEnv(ws.log));
    expect(repoResult).toMatchObject({
      status: 2,
      json: { outcome: "rejected", reason: "repo_invalid" },
    });

    const agents = {
      builder: { kind: "codex", model: null, args: [] },
      reviewer: { kind: "claude", model: null, args: [] },
    };
    writeInput(ws.inputPath, input(ws.repo, { agents }));
    const kindResult = runBuildReview(ws, ["--runtime-module", runtimeModule], scriptedEnv(ws.log));
    expect(kindResult).toMatchObject({ status: 2, json: { reason: "agent_kind_unsupported" } });
    expect(existsSync(ws.log)).toBe(false);
    expect(existsSync(join(ws.runDir, "journal.jsonl"))).toBe(false);
  });

  it("rejects a repository path below the git top level, naming both, before anything runs", () => {
    const ws = workspace();
    const nested = join(ws.repo, "src");
    mkdirSync(nested);
    writeInput(ws.inputPath, input(nested));
    // A run directory beside src/ lies inside the real work tree.
    const runDir = join(ws.repo, "run");
    const result = runBuildReview(
      { ...ws, runDir },
      ["--runtime-module", runtimeModule],
      scriptedEnv(ws.log),
    );
    expect(result.status, result.stdout).toBe(2);
    expect(result.json).toMatchObject({ outcome: "rejected", reason: "repo_invalid" });
    expect(result.json?.message).toContain(nested);
    expect(result.json?.message).toMatch(/is not the top level of its git work tree \//);
    expect(existsSync(runDir)).toBe(false);
    expect(existsSync(ws.log)).toBe(false);
  });

  it("rejects a run directory equal to, inside or containing the repository before anything runs", () => {
    const ws = workspace();
    writeInput(ws.inputPath, input(ws.repo));
    const alias = join(ws.root, "alias");
    symlinkSync(ws.repo, alias);
    const cases = [
      join(ws.repo, ".woof-run"),
      join(ws.repo, "not", "created", "yet"),
      ws.repo,
      join(alias, ".woof-run"),
      ws.root,
    ];
    for (const runDir of cases) {
      const result = runBuildReview(
        { ...ws, runDir },
        ["--runtime-module", runtimeModule],
        scriptedEnv(ws.log),
      );
      expect(result.status, `${runDir}: ${result.stdout}`).toBe(2);
      expect(result.json).toMatchObject({ outcome: "rejected", reason: "input_invalid" });
      expect(result.json?.message).toContain(runDir);
      expect(result.json?.message).toContain(ws.repo);
      expect(existsSync(join(runDir, "journal.jsonl"))).toBe(false);
    }
    expect(existsSync(ws.log)).toBe(false);
    expect(existsSync(join(ws.repo, "not"))).toBe(false);
    expect(existsSync(join(ws.repo, ".woof-run"))).toBe(false);
  });

  it("rejects a repository path git cannot take (a NUL byte) as repo_invalid, structured", () => {
    const ws = workspace();
    writeInput(ws.inputPath, input(`${ws.repo}\u0000x`));
    const result = runBuildReview(ws, ["--runtime-module", runtimeModule], scriptedEnv(ws.log));
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.json).toMatchObject({ outcome: "rejected", reason: "repo_invalid" });
    expect(existsSync(ws.log)).toBe(false);
    expect(existsSync(join(ws.runDir, "journal.jsonl"))).toBe(false);
  });

  it("requires --poll-ms of at least 1", () => {
    const ws = workspace();
    writeInput(ws.inputPath, input(ws.repo));
    const zero = woof(
      [
        "run",
        "build-review",
        "--input",
        ws.inputPath,
        "--run-dir",
        ws.runDir,
        "--poll-ms",
        "0",
        "--runtime-module",
        runtimeModule,
      ],
      { env: scriptedEnv(ws.log) },
    );
    expect(zero.status).toBe(1);
    expect(zero.stderr).toContain("--poll-ms must be an integer between 1 and 3600000");
    expect(existsSync(ws.log)).toBe(false);
  });

  it("rejects a runtime module whose adapter discriminator is not herdr or scripted", () => {
    const ws = workspace();
    writeInput(ws.inputPath, input(ws.repo));
    const otherModule = join(repoRoot, "test", "fixtures", "other-adapter-runtime-module.mjs");
    const result = runBuildReview(ws, ["--runtime-module", otherModule], scriptedEnv(ws.log));
    expect(result.status, result.stdout).toBe(3);
    expect(result.json).toMatchObject({ outcome: "rejected", reason: "runtime_unavailable" });
    expect(result.json?.message).toContain('adapter ("herdr" | "scripted")');
    expect(result.json?.message).not.toContain("openPane");
    expect(existsSync(join(ws.runDir, "journal.jsonl"))).toBe(false);
  });

  it("rejects a runtime module whose factory does not return a RuntimeAdapter, before opening a run", () => {
    const ws = workspace();
    writeInput(ws.inputPath, input(ws.repo));
    const badModule = join(repoRoot, "test", "fixtures", "bad-runtime-module.mjs");
    const result = runBuildReview(ws, ["--runtime-module", badModule], scriptedEnv(ws.log));
    expect(result.status, result.stdout).toBe(3);
    expect(result.json).toMatchObject({ outcome: "rejected", reason: "runtime_unavailable" });
    expect(result.json?.message).toContain("openPane");
    expect(result.json?.message).toContain("stop");
    expect(result.json?.message).not.toContain("observe");
    expect(existsSync(join(ws.runDir, "journal.jsonl"))).toBe(false);
  });

  it("refuses to run outside Herdr without a runtime module, without spawning herdr or writing", () => {
    const ws = workspace();
    writeInput(ws.inputPath, input(ws.repo));
    // A stub first on PATH proves no herdr process is started.
    const bin = join(ws.root, "bin");
    mkdirSync(bin);
    const marker = join(ws.root, "herdr-called");
    writeFileSync(join(bin, "herdr"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
    chmodSync(join(bin, "herdr"), 0o755);
    const result = runBuildReview(ws, [], {
      HERDR_ENV: undefined,
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    });
    expect(result).toMatchObject({
      status: 3,
      json: { outcome: "rejected", reason: "runtime_unavailable" },
    });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(ws.runDir, "journal.jsonl"))).toBe(false);
  });
});

describe("woof run build-review: runs", () => {
  it("completes with the scripted runtime and prints the result woof run show derives", () => {
    const ws = workspace();
    writeInput(
      ws.inputPath,
      input(ws.repo, { verify: { command: ["node", "-e", "process.exit(0)"], timeoutMs: 20_000 } }),
    );
    const result = runBuildReview(ws, ["--runtime-module", runtimeModule], scriptedEnv(ws.log));
    expect(result.status, result.stderr).toBe(0);
    const printed = JSON.parse(result.stdout.trim()) as { outcome: string; result: Json };
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(printed).toMatchObject({
      outcome: "run",
      result: { outcome: "completed", runId: "cli-run", limit: null },
    });
    expect(result.stderr).toContain("woof: dispatch build visit 1 attempt 1");

    const shown = woof(["run", "show", ws.runDir]);
    expect(shown.status).toBe(0);
    const derived = runNode(
      `const { deriveRunResult } = await import(${JSON.stringify(distUrl("state/result.js"))});
const shown = JSON.parse(process.argv[1]);
console.log(JSON.stringify(deriveRunResult(shown.snapshot, { runDir: process.argv[2], repository: process.argv[3] })));`,
      // The scheduler reports the canonical run directory.
      [shown.stdout.trim(), realpathSync(ws.runDir), ws.repo],
    );
    expect(derived.status, derived.stderr).toBe(0);
    expect(JSON.parse(derived.stdout.trim())).toEqual(printed.result);

    // The run input is persisted and the plan carries resolved launch arguments.
    expect(JSON.parse(readFileSync(join(ws.runDir, "input.json"), "utf8"))).toMatchObject({
      repo: ws.repo,
    });
    const plan = (
      JSON.parse(
        readFileSync(join(ws.runDir, "journal.jsonl"), "utf8").split("\n")[0] as string,
      ) as { plan: { agents: Json[]; checks: string[] } }
    ).plan;
    expect(plan.agents).toEqual([
      {
        agentId: "builder",
        role: "builder",
        kind: "claude",
        model: null,
        args: ["--add-dir", ws.runDir],
      },
      {
        agentId: "reviewer",
        role: "reviewer",
        kind: "claude",
        model: "sonnet",
        args: ["--model", "sonnet", "--add-dir", ws.runDir, "--permission-mode", "auto"],
      },
    ]);
    expect(plan.checks).toEqual(["verify"]);
    const log = readFileSync(ws.log, "utf8").trim().split("\n");
    expect(log).toHaveLength(1);

    // The run directory now holds a run.
    const again = runBuildReview(
      ws,
      ["--runtime-module", runtimeModule],
      scriptedEnv(join(ws.root, "second.log")),
    );
    expect(again).toMatchObject({ status: 2, json: { outcome: "rejected", reason: "run_exists" } });
  }, 60_000);

  it("fails with engine_file_error, one result line and a recorded termination when an engine file cannot be written", () => {
    const expectEngineFileFailure = (ws: ReturnType<typeof workspace>, path: string) => {
      const result = runBuildReview(ws, ["--runtime-module", runtimeModule], scriptedEnv(ws.log));
      expect(result.status, result.stderr).toBe(4);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(result.stderr).not.toContain("    at ");
      const printed = JSON.parse(result.stdout.trim()) as { outcome: string; result: Json };
      expect(printed).toMatchObject({ outcome: "run", result: { outcome: "failed" } });
      expect(String(printed.result["reason"])).toContain(`engine_file_error: ${path}`);
      expect(journalTypes(ws.runDir).at(-1)).toBe("run.terminated");
    };

    // A pre-planted request file with other bytes.
    const conflict = workspace();
    writeInput(conflict.inputPath, input(conflict.repo));
    const planted = join(conflict.runDir, "requests", "build", "visit-1", "attempt-1");
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "request.md"), "planted\n");
    expectEngineFileFailure(conflict, "requests/build/visit-1/attempt-1/request.md");
    expect(readFileSync(join(planted, "request.md"), "utf8")).toBe("planted\n");
    expect(journalTypes(conflict.runDir)).not.toContain("request.dispatched");

    // A symlinked requests/ component: nothing is written through it.
    const linked = workspace();
    writeInput(linked.inputPath, input(linked.repo));
    const outside = join(linked.root, "outside");
    mkdirSync(outside);
    mkdirSync(linked.runDir);
    symlinkSync(outside, join(linked.runDir, "requests"));
    expectEngineFileFailure(linked, "requests/build/visit-1/attempt-1/request.md");
    expect(readdirSync(outside)).toEqual([]);

    // A symlinked checks/ component on the check evidence path.
    const checks = workspace();
    writeInput(
      checks.inputPath,
      input(checks.repo, {
        verify: { command: ["node", "-e", "process.exit(0)"], timeoutMs: 20_000 },
      }),
    );
    const outsideChecks = join(checks.root, "outside");
    mkdirSync(outsideChecks);
    mkdirSync(checks.runDir);
    symlinkSync(outsideChecks, join(checks.runDir, "checks"));
    expectEngineFileFailure(checks, "checks/verify/build-v1-a1/output.log");
    expect(readdirSync(outsideChecks)).toEqual([]);
  }, 60_000);

  it("fails with engine_file_error, without hanging, when a FIFO sits at the request path", () => {
    const ws = workspace();
    writeInput(ws.inputPath, input(ws.repo));
    const planted = join(ws.runDir, "requests", "build", "visit-1", "attempt-1");
    mkdirSync(planted, { recursive: true });
    expect(spawnSync("mkfifo", [join(planted, "request.md")]).status).toBe(0);
    const began = Date.now();
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...scriptedEnv(ws.log) };
    Reflect.deleteProperty(childEnv, "HERDR_PANE_ID");
    Reflect.deleteProperty(childEnv, "WOOF_RUN_DIR");
    // SIGKILL: a CLI blocked in a synchronous FIFO open ignores SIGTERM (its handler never runs),
    // so a regression must fail this test in bounded time instead of hanging the suite.
    const result = spawnSync(
      "node",
      [
        cliPath,
        "run",
        "build-review",
        "--input",
        ws.inputPath,
        "--run-dir",
        ws.runDir,
        "--run-id",
        "cli-run",
        "--poll-ms",
        "2",
        "--runtime-module",
        runtimeModule,
      ],
      { env: childEnv, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" },
    );
    expect(Date.now() - began).toBeLessThan(15_000);
    expect(result.status, result.stderr).toBe(4);
    const printed = JSON.parse(result.stdout.trim()) as { result: Json };
    expect(printed.result).toMatchObject({ outcome: "failed" });
    expect(String(printed.result["reason"])).toContain(
      "engine_file_error: requests/build/visit-1/attempt-1/request.md",
    );
    expect(String(printed.result["reason"])).toContain("not a regular file");
    expect(journalTypes(ws.runDir).at(-1)).toBe("run.terminated");
  }, 30_000);

  it("exits 5 when the reviewer never passes and the rounds run out", () => {
    const ws = workspace();
    writeInput(ws.inputPath, input(ws.repo, { limits: { maxRounds: 2, runTimeoutMs: 60_000 } }));
    const result = runBuildReview(
      ws,
      ["--runtime-module", runtimeModule],
      scriptedEnv(ws.log, "always-fail"),
    );
    expect(result.status, result.stderr).toBe(5);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      result: { outcome: "exhausted", limit: "maxRounds" },
    });
  }, 60_000);

  it("exits 6 on SIGTERM, records the cancellation and refuses a late submission", async () => {
    const ws = workspace();
    writeInput(ws.inputPath, input(ws.repo));
    const { child, exited } = startBuildReview(
      ws,
      ["--runtime-module", runtimeModule, "--poll-ms", "20"],
      scriptedEnv(ws.log, "hang"),
    );
    await waitForRecord(ws.runDir, "request.dispatched");
    child.kill("SIGTERM");
    const done = await exited;
    expect(done.status, done.stderr).toBe(6);
    expect(JSON.parse(done.stdout.trim())).toMatchObject({
      result: { outcome: "cancelled", reason: "cancel requested" },
    });
    expect(journalTypes(ws.runDir).at(-1)).toBe("run.terminated");

    const rel = "artifacts/build/visit-1/attempt-1/completion.md";
    writeFileSync(join(ws.runDir, rel), "# Late\n");
    const envelope = join(ws.root, "late.json");
    writeFileSync(
      envelope,
      JSON.stringify({
        schemaVersion: 1,
        runId: "cli-run",
        agentId: "builder",
        stageId: "build",
        visit: 1,
        attempt: 1,
        status: "completed",
        verdict: null,
        artifact: { path: rel, sha256: "0".repeat(64) },
      }),
    );
    const late = woof(["submit", "--run-dir", ws.runDir, "--envelope", envelope]);
    expect(late).toMatchObject({ status: 2, json: { outcome: "rejected", reason: "run_closed" } });
  }, 60_000);

  it("stops within three polls when woof run cancel runs in another process", async () => {
    const ws = workspace();
    writeInput(ws.inputPath, input(ws.repo));
    const pollMs = 300;
    const { exited } = startBuildReview(
      ws,
      ["--runtime-module", runtimeModule, "--poll-ms", String(pollMs)],
      scriptedEnv(ws.log, "hang"),
    );
    await waitForRecord(ws.runDir, "request.dispatched");
    const cancel = woof(["run", "cancel", ws.runDir, "--reason", "stop from the test"]);
    const cancelledAt = Date.now();
    expect(cancel).toMatchObject({ status: 0, json: { outcome: "recorded" } });
    const done = await exited;
    expect(done.status, done.stderr).toBe(6);
    expect(done.at - cancelledAt).toBeLessThan(3 * pollMs);
    expect(JSON.parse(done.stdout.trim())).toMatchObject({
      result: { outcome: "cancelled", reason: "stop from the test" },
    });
    expect(journalTypes(ws.runDir).at(-1)).toBe("run.terminated");
    expect(woof(["run", "cancel", ws.runDir])).toMatchObject({
      status: 2,
      json: { outcome: "rejected", reason: "run_closed" },
    });
    expect(woof(["run", "cancel", join(ws.root, "missing")])).toMatchObject({
      status: 3,
      json: { reason: "run_dir_invalid" },
    });
  }, 60_000);
});
