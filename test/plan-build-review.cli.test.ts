import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "./helpers/dist.js";
import { repoRoot, woof, type ProcessResult } from "./helpers/process.js";

// The built-in plan-build-review workflow end to end as a real process
// (node dist/cli.js run start --workflow plan-build-review), against the
// scripted runtime module. Nothing here imports src/.
const runtimeModule = join(repoRoot, "test", "fixtures", "scripted-runtime-module.mjs");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

type Json = Record<string, unknown>;

function workspace(): { root: string; repo: string; runDir: string; inputPath: string } {
  const root = mkdtempSync(join(tmpdir(), "woof-pbr-cli-"));
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
      { cwd: repo, encoding: "utf8" },
    );
  git("init", "-q");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { root, repo, runDir: join(root, "run"), inputPath: join(root, "input.json") };
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
    limits: {
      runTimeoutMs: 60_000,
      readinessWaitMs: 10_000,
      blockedWaitMs: 10_000,
      deliveryTimeoutMs: 10_000,
    },
    ...overrides,
  };
}

/**
 * `woof run start --workflow plan-build-review --host foreground`. The project is
 * the repository, and HOME is the per-test-process temporary home, so no
 * operator configuration reaches the run.
 */
function runPlanBuildReview(
  ws: ReturnType<typeof workspace>,
  extra: string[] = [],
  script = "happy",
): ProcessResult {
  return woof(
    [
      "run",
      "start",
      "--workflow",
      "plan-build-review",
      "--host",
      "foreground",
      "--project",
      ws.repo,
      "--input",
      ws.inputPath,
      "--run-dir",
      ws.runDir,
      "--run-id",
      "pbr-run",
      "--poll-ms",
      "2",
      "--runtime-module",
      runtimeModule,
      ...extra,
    ],
    { env: { WOOF_TEST_SCRIPT: script }, timeoutMs: 90_000 },
  );
}

function writeInput(path: string, value: unknown): string {
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

const journalLines = (runDir: string): Json[] =>
  readFileSync(join(runDir, "journal.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Json);

/** The rendered request text of one attempt. */
const requestText = (runDir: string, stage: string, visit: number, attempt: number): string =>
  readFileSync(
    join(runDir, "requests", stage, `visit-${visit}`, `attempt-${attempt}`, "request.md"),
    "utf8",
  );

describe("plan-build-review: the definition itself", () => {
  let workflow: {
    name: string;
    version: string;
    start: string;
    roundStage: string | null;
    edges: Record<string, string[]>;
    validateInput: (value: unknown) => { ok: boolean; details?: Array<{ field: string }> };
  };
  let validate: (value: unknown) => { ok: boolean; details?: Array<{ field: string }> };

  beforeAll(async () => {
    ({ planBuildReviewWorkflow: workflow } = await loadDist<{
      planBuildReviewWorkflow: typeof workflow;
    }>("workflows/plan-build-review.js"));
    ({ validateWorkflowDefinition: validate } = await loadDist<{
      validateWorkflowDefinition: typeof validate;
    }>("scheduler/definition.js"));
  });

  it("validates against the p3 definition contract with no engine change", () => {
    expect(validate(workflow)).toMatchObject({ ok: true });
    expect(workflow.name).toBe("plan-build-review");
    expect(workflow.start).toBe("plan");
    expect(workflow.roundStage).toBe("review");
    expect(workflow.edges).toEqual({
      plan: ["build"],
      build: ["verify", "review"],
      verify: ["review", "repair"],
      review: ["completed", "review", "repair"],
      repair: ["verify", "review"],
    });
  });

  it("admits a bare input and refuses unknown fields, bad constraints and a too-large request", () => {
    const base = {
      schemaVersion: 1,
      repo: "/repo",
      task: { title: "t", description: "d", acceptanceCriteria: ["a"] },
    };
    expect(workflow.validateInput(base)).toMatchObject({ ok: true });
    expect(workflow.validateInput({ ...base, constraints: ["no new dependencies"] })).toMatchObject(
      {
        ok: true,
      },
    );
    const fields = (value: unknown) =>
      (workflow.validateInput(value).details ?? []).map((detail) => detail.field);
    expect(fields({ ...base, constraints: [] })).toEqual(["constraints"]);
    expect(fields({ ...base, constraints: ["ok", ""] })).toEqual(["constraints"]);
    expect(fields({ ...base, agents: { architect: {} } })).toEqual(["agents.architect"]);
    expect(fields({ ...base, instructions: { planner: "" } })).toEqual(["instructions.planner"]);
    expect(fields({ ...base, limits: { maxRounds: 0 } })).toEqual(["limits.maxRounds"]);

    // The ported admission-time bound: the repair request carries the plan, the
    // evidence that entered it and the previous completion report, so this
    // workflow refuses a context build-review would still admit.
    const blob = (size: number) => ({
      ...base,
      task: { ...base.task, context: { blob: "x".repeat(size) } },
    });
    // Re-measured with LV-102's canonical-review sentence in the repair request
    // (276 bytes), which moved this from 21 857: the repair is the binding case.
    expect(workflow.validateInput(blob(21_581))).toMatchObject({ ok: true });
    const refused = workflow.validateInput(blob(21_582));
    expect(refused.ok).toBe(false);
    expect(refused.details?.[0]).toMatchObject({ field: "task" });
    expect(JSON.stringify(refused.details)).toContain("32769 bytes; the limit is 32768");
  });
});

describe("plan-build-review: a full run on the scripted runtime", () => {
  it("plans, builds, verifies, repairs after a failed review and completes, with the plan as an input everywhere", () => {
    const ws = workspace();
    writeInput(
      ws.inputPath,
      input(ws.repo, {
        constraints: ["change only files under src/"],
        verify: { command: ["node", "-e", "process.exit(0)"], timeoutMs: 20_000 },
      }),
    );
    const result = runPlanBuildReview(ws);
    expect(result.status, result.stderr).toBe(0);
    const printed = JSON.parse(result.stdout.trim()) as { outcome: string; result: Json };
    expect(printed).toMatchObject({
      outcome: "run",
      result: { outcome: "completed", runId: "pbr-run", limit: null },
    });

    const records = journalLines(ws.runDir);
    const typed = (type: string) => records.filter((record) => record["type"] === type);

    // Three identities, three panes: the reuse proof is a new agent, not a second
    // identity of the builder.
    const assigned = typed("agent.assigned") as Array<{
      agentId: string;
      runtime: { runtimeName: string; paneId: string };
    }>;
    expect(assigned.map((record) => record.agentId)).toEqual(["planner", "builder", "reviewer"]);
    expect(new Set(assigned.map((record) => record.runtime.runtimeName)).size).toBe(3);
    expect(new Set(assigned.map((record) => record.runtime.paneId)).size).toBe(3);

    // The stage order: plan, build, verify, review(fail), repair, verify, review(pass).
    const gates = typed("gate.recorded").map(
      (record) => `${String(record["gate"])}:${String(record["reason"])}`,
    );
    expect(gates).toEqual([
      "plan:planned",
      "build:built",
      "verify:checks_passed",
      "review:changes_requested",
      "repair:built",
      "verify:checks_passed",
      "review:approved",
    ]);

    // The plan reaches the builder as a resolved input, by path, receipt and sha256.
    const planAccepted = typed("submission.accepted").find(
      (record) => record["stageId"] === "plan",
    ) as { receiptId: string; artifact: { sha256: string; acceptedPath: string } } | undefined;
    expect(planAccepted).toBeDefined();
    // The scheduler renders the canonical run directory, so resolve it the same way.
    const acceptedPlan = join(realpathSync(ws.runDir), String(planAccepted?.artifact.acceptedPath));
    for (const [stage, visit] of [
      ["build", 1],
      ["repair", 1],
    ] as const) {
      const text = requestText(ws.runDir, stage, visit, 1);
      expect(text, stage).toContain(`- plan: ${acceptedPlan} (stage plan visit 1 attempt 1`);
      expect(text, stage).toContain(`receipt ${String(planAccepted?.receiptId)}`);
      expect(text, stage).toContain(`sha256 ${String(planAccepted?.artifact.sha256)}`);
      // The plan is addressed, never inlined: its body is not in the request.
      expect(text, stage).not.toContain("1. Write src/change.txt.");
      // The plan is the first input of every builder turn.
      const inputs = text.split("## Inputs — read these exact files\n")[1]?.split("\n") ?? [];
      expect(inputs[0], stage).toContain("plan:");
    }

    // The repair carries the plan, the review and the previous completion report.
    const repair = requestText(ws.runDir, "repair", 1, 1);
    expect(repair).toContain("- review: ");
    expect(repair).toContain("- your previous completion report: ");

    // The planner's request states the constraints and forbids repository changes.
    const plan = requestText(ws.runDir, "plan", 1, 1);
    expect(plan).toContain("- change only files under src/");
    expect(plan).toContain("the planner reads, the builder writes");
    expect(plan).toContain("Write your artifact to exactly:");

    // The engine-owned result names every stage's accepted artifact generically:
    // `lastAcceptedByStage` carries the plan with no engine change for the new stage.
    const artifacts = printed.result["artifacts"] as {
      completion: Json | null;
      review: Json | null;
      verification: Json | null;
      lastAcceptedByStage: Record<string, Json>;
    };
    expect(Object.keys(artifacts.lastAcceptedByStage).toSorted()).toEqual([
      "build",
      "plan",
      "repair",
      "review",
    ]);
    expect(artifacts.lastAcceptedByStage["plan"]).toMatchObject({ stageId: "plan", visit: 1 });
    expect(artifacts.completion).toMatchObject({ stageId: "repair" });
    expect(artifacts.review).toMatchObject({ stageId: "review" });
    expect(artifacts.verification).not.toBeNull();
    expect(readdirSync(join(ws.runDir, "accepted")).toSorted()).toEqual([
      "build",
      "plan",
      "repair",
      "review",
    ]);

    // The builder's change is real.
    expect(readFileSync(join(ws.repo, "src", "change.txt"), "utf8")).toContain("version");
  }, 90_000);

  it("resolves all three roles from the built-in catalog when the input names no agents", () => {
    const ws = workspace();
    writeInput(ws.inputPath, input(ws.repo));
    const result = runPlanBuildReview(ws);
    expect(result.status, result.stderr).toBe(0);
    const plan = (journalLines(ws.runDir)[0] as { plan: { agents: Json[]; checks: string[] } })
      .plan;
    expect(plan.agents).toEqual([
      {
        agentId: "planner",
        role: "planner",
        kind: "claude",
        model: null,
        args: ["--add-dir", ws.runDir],
      },
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
        model: null,
        args: ["--add-dir", ws.runDir],
      },
    ]);
    expect(plan.checks).toEqual(["verify"]);
    // No verify command in the input: the build routes straight to the review.
    const gates = journalLines(ws.runDir)
      .filter((record) => record["type"] === "gate.recorded")
      .map((record) => String(record["gate"]));
    expect(gates).not.toContain("verify");
    const config = JSON.parse(readFileSync(join(ws.runDir, "config.json"), "utf8")) as {
      workflow: Json;
      agents: Record<string, { source: string }>;
    };
    expect(config.workflow).toMatchObject({
      source: "builtin",
      value: { name: "plan-build-review", version: "1" },
    });
    for (const agentId of ["planner", "builder", "reviewer"]) {
      expect(config.agents[agentId], agentId).toMatchObject({ source: "builtin" });
    }
  }, 90_000);

  it("exhausts maxRounds when the reviewer never passes, and never re-enters the plan stage", () => {
    const ws = workspace();
    writeInput(ws.inputPath, input(ws.repo, { limits: { maxRounds: 2, runTimeoutMs: 60_000 } }));
    const result = runPlanBuildReview(ws, [], "always-fail");
    expect(result.status, result.stderr).toBe(5);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      result: { outcome: "exhausted", limit: "maxRounds" },
    });
    // A failed review routes to repair, never back to the planner (0.1.0 takes no
    // position on whether an old plan is still canonical).
    const planAttempts = journalLines(ws.runDir).filter(
      (record) => record["type"] === "attempt.opened" && record["stageId"] === "plan",
    );
    expect(planAttempts).toHaveLength(1);
  }, 90_000);
});
