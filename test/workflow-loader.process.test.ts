import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { distUrl, repoRoot, runNode } from "./helpers/process.js";

type Json = Record<string, unknown>;

// The loader runs in a real child `node`, so .ts loading uses Node's own type stripping.
const fixtures = join(repoRoot, "test", "fixtures", "workflows");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface LoadOut {
  ok: boolean;
  reason?: string;
  message?: string;
  details?: Array<{ field: string; message: string }>;
  name?: string;
  path?: string;
  repository?: string;
}

function load(path: string, env: Record<string, string> = {}): LoadOut {
  const result = runNode(
    `const { loadWorkflowDefinition } = await import(${JSON.stringify(distUrl("scheduler/loader.js"))});
const loaded = await loadWorkflowDefinition(process.argv[1]);
console.log(JSON.stringify(loaded.ok
  ? { ok: true, name: loaded.definition.name, path: loaded.path, repository: loaded.definition.repository({ topic: "t" }) }
  : loaded));`,
    [path],
    { env },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.json as unknown as LoadOut;
}

describe("loadWorkflowDefinition in a real node process", () => {
  it("loads and validates a compiled .mjs definition", () => {
    expect(load(join(fixtures, "valid.mjs"))).toEqual({
      ok: true,
      name: "fixture-mjs",
      path: join(fixtures, "valid.mjs"),
      repository: "/repo",
    });
  });

  it("loads an erasable TypeScript definition through Node's type stripping", () => {
    expect(load(join(fixtures, "valid.ts"))).toMatchObject({
      ok: true,
      name: "fixture-ts",
      repository: "/repo/t",
    });
  });

  it("maps non-erasable TypeScript syntax to definition_syntax_unsupported", () => {
    const out = load(join(fixtures, "enum.ts"));
    expect(out).toMatchObject({ ok: false, reason: "definition_syntax_unsupported", details: [] });
    expect(out.message).toContain("erasable");
  });

  it("rejects a module without a default export or with an invalid one as definition_invalid", () => {
    expect(load(join(fixtures, "no-default.mjs"))).toMatchObject({
      ok: false,
      reason: "definition_invalid",
      details: [{ field: "default" }],
    });
    const bad = load(join(fixtures, "bad-shape.mjs"));
    expect(bad).toMatchObject({ ok: false, reason: "definition_invalid" });
    expect(bad.details?.map((detail) => detail.field)).toEqual(
      expect.arrayContaining([
        "schemaVersion",
        "name",
        "validateInput",
        "agents",
        "stages",
        "start",
      ]),
    );
  });

  it("reports a module that throws while loading as definition_load_failed", () => {
    const out = load(join(fixtures, "throws.mjs"));
    expect(out).toMatchObject({ ok: false, reason: "definition_load_failed" });
    expect(out.message).toContain("fixture definition failed while loading");
  });

  it("reports a missing path or a directory as definition_not_found", () => {
    expect(load(join(fixtures, "missing.mjs"))).toMatchObject({
      ok: false,
      reason: "definition_not_found",
    });
    expect(load(fixtures)).toMatchObject({ ok: false, reason: "definition_not_found" });
  });

  it("executes the module's code when loading it", () => {
    const dir = mkdtempSync(join(tmpdir(), "woof-loader-"));
    dirs.push(dir);
    const marker = join(dir, "marker.txt");
    const out = load(join(fixtures, "side-effect.mjs"), { WOOF_TEST_MARKER: marker });
    expect(out).toMatchObject({ ok: false, reason: "definition_invalid" });
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("loaded\n");
  });
});

describe("admitWorkflow with a loaded definition whose callbacks misbehave", () => {
  function admit(mode: string): LoadOut & { threw?: string } {
    const dir = mkdtempSync(join(tmpdir(), "woof-admit-"));
    dirs.push(dir);
    const repo = join(dir, "repo");
    mkdirSync(repo);
    expect(spawnSync("git", ["init", "-q"], { cwd: repo }).status).toBe(0);
    const result = runNode(
      `const { loadWorkflowDefinition } = await import(${JSON.stringify(distUrl("scheduler/loader.js"))});
const { admitWorkflow } = await import(${JSON.stringify(distUrl("scheduler/admission.js"))});
const loaded = await loadWorkflowDefinition(process.argv[1]);
if (!loaded.ok) { console.log(JSON.stringify(loaded)); process.exit(0); }
try {
  const admitted = await admitWorkflow({ definition: loaded.definition, input: { topic: "t" }, runDir: process.argv[2] });
  console.log(JSON.stringify(admitted.ok ? { ok: true } : admitted));
} catch (error) {
  console.log(JSON.stringify({ ok: false, threw: error.message }));
}`,
      [join(fixtures, "callbacks.mjs"), join(dir, "run")],
      { env: { WOOF_TEST_CALLBACK: mode, WOOF_TEST_REPO: repo } },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.json as unknown as LoadOut & { threw?: string };
  }

  it("rejects a relative or overlong run directory as input_invalid before any callback", () => {
    for (const runDir of ["relative/run", `/${"x".repeat(1100)}`]) {
      const result = runNode(
        `const { loadWorkflowDefinition } = await import(${JSON.stringify(distUrl("scheduler/loader.js"))});
const { admitWorkflow } = await import(${JSON.stringify(distUrl("scheduler/admission.js"))});
const loaded = await loadWorkflowDefinition(process.argv[1]);
const admitted = await admitWorkflow({ definition: loaded.definition, input: { topic: "t" }, runDir: process.argv[2] });
console.log(JSON.stringify(admitted));`,
        [join(fixtures, "callbacks.mjs"), runDir],
        { env: { WOOF_TEST_CALLBACK: "validate-throws", WOOF_TEST_REPO: "/nonexistent" } },
      );
      expect(result.status, result.stderr).toBe(0);
      // validate-throws would be definition_invalid: the run directory check comes first.
      expect(result.json).toMatchObject({
        ok: false,
        reason: "input_invalid",
        details: [{ field: "runDir" }],
      });
    }
  });

  it("opens an admitted run with the validated input, not the raw input", () => {
    const dir = mkdtempSync(join(tmpdir(), "woof-admit-open-"));
    dirs.push(dir);
    const repo = join(dir, "repo");
    mkdirSync(repo);
    expect(spawnSync("git", ["init", "-q"], { cwd: repo }).status).toBe(0);
    const runDir = join(dir, "run");
    const result = runNode(
      `const { loadWorkflowDefinition } = await import(${JSON.stringify(distUrl("scheduler/loader.js"))});
const { admitWorkflow, openAdmittedRun } = await import(${JSON.stringify(distUrl("scheduler/admission.js"))});
const loaded = await loadWorkflowDefinition(process.argv[1]);
const admitted = await admitWorkflow({ definition: loaded.definition, input: { topic: "  draft  " }, runDir: process.argv[2] });
const opened = admitted.ok ? await openAdmittedRun(admitted, { runDir: process.argv[2], runId: "run-1" }) : admitted;
console.log(JSON.stringify({ outcome: opened.outcome ?? opened.reason }));`,
      [join(fixtures, "callbacks.mjs"), runDir],
      { env: { WOOF_TEST_CALLBACK: "normalize", WOOF_TEST_REPO: repo } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({ outcome: "recorded" });
    expect(JSON.parse(readFileSync(join(runDir, "input.json"), "utf8"))).toEqual({
      topic: "DRAFT",
      normalized: true,
    });
  });

  it("admits the well-behaved definition", () => {
    expect(admit("none")).toEqual({ ok: true });
  });

  it.each([
    ["validate-throws", "validateInput", "validateInput failed on purpose"],
    ["validate-bad", "validateInput", "returned no { ok } result"],
    ["details-bad", "validateInput", "{ field: string, message: string }"],
    ["repository-throws", "repository", "repository failed on purpose"],
    ["repository-bad", "repository", "not a path string"],
    ["agents-throws", "resolveAgents", "resolveAgents failed on purpose"],
    ["agents-bad", "resolveAgents", "agent writer is not"],
    ["limits-throws", "resolveLimits", "resolveLimits failed on purpose"],
    ["limits-bad", "resolveLimits", "returned no limits object"],
  ])("maps %s to a structured definition_invalid rejection", (mode, field, message) => {
    const out = admit(mode);
    expect(out.threw).toBeUndefined();
    expect(out).toMatchObject({ ok: false, reason: "definition_invalid", details: [{ field }] });
    expect(out.message).toContain(message);
  });
});

describe("admitWorkflow with resolved configuration (p4)", () => {
  function repoDir(): { dir: string; repo: string; runDir: string } {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "woof-admit-config-")));
    dirs.push(dir);
    const repo = join(dir, "repo");
    mkdirSync(repo);
    expect(spawnSync("git", ["init", "-q"], { cwd: repo }).status).toBe(0);
    return { dir, repo, runDir: join(dir, "run") };
  }

  /** Admits `definition` (a fixture path, or "build-review") with `input` and `configuration`. */
  function admitWith(
    definition: string,
    input: unknown,
    configuration: unknown,
    runDir: string,
    env: Record<string, string> = {},
  ): Json {
    const result = runNode(
      `const { loadWorkflowDefinition } = await import(${JSON.stringify(distUrl("scheduler/loader.js"))});
const { admitWorkflow } = await import(${JSON.stringify(distUrl("scheduler/admission.js"))});
const { buildReviewWorkflow } = await import(${JSON.stringify(distUrl("workflows/build-review.js"))});
const [path, input, configuration, runDir] = [process.argv[1], JSON.parse(process.argv[2]), JSON.parse(process.argv[3]), process.argv[4]];
let definition = buildReviewWorkflow;
if (path !== "build-review") {
  const loaded = await loadWorkflowDefinition(path);
  if (!loaded.ok) { console.log(JSON.stringify(loaded)); process.exit(0); }
  definition = loaded.definition;
}
const admitted = await admitWorkflow({ definition, input, runDir, ...(configuration === null ? {} : { configuration }) });
console.log(JSON.stringify(admitted));`,
      [definition, JSON.stringify(input), JSON.stringify(configuration), runDir],
      { env },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.json as unknown as Json;
  }

  const task = { title: "T", description: "D", acceptanceCriteria: ["holds"] };
  const roles = (dir: string) => ({
    builder: {
      kind: "claude",
      model: "sonnet",
      args: ["--permission-mode", "auto"],
      source: "project",
      path: `${dir}/.woof/roles/builder.json`,
    },
    reviewer: { kind: "claude", model: null, args: [], source: "builtin", path: null },
  });

  it("fills omitted agents from configured roles and records each agent's source", () => {
    const { repo, runDir } = repoDir();
    const out = admitWith(
      "build-review",
      { schemaVersion: 1, repo, task },
      { projectRoot: repo, roles: roles(repo), limits: {} },
      runDir,
    );
    expect(out).toMatchObject({ ok: true });
    expect((out["plan"] as Json)["agents"]).toEqual([
      {
        agentId: "builder",
        role: "builder",
        kind: "claude",
        model: "sonnet",
        args: ["--model", "sonnet", "--add-dir", runDir, "--permission-mode", "auto"],
      },
      {
        agentId: "reviewer",
        role: "reviewer",
        kind: "claude",
        model: null,
        args: ["--add-dir", runDir],
      },
    ]);
    expect((out["provenance"] as Json)["agents"]).toEqual({
      builder: {
        role: "builder",
        kind: "claude",
        model: "sonnet",
        args: ["--permission-mode", "auto"],
        source: "project",
        path: `${repo}/.woof/roles/builder.json`,
      },
      reviewer: {
        role: "reviewer",
        kind: "claude",
        model: null,
        args: [],
        source: "builtin",
        path: null,
      },
    });
  });

  it("PI-002: refuses engine-owned args from a definition's resolveAgents and from a configured role", () => {
    const { repo, runDir } = repoDir();
    const fromDefinition = admitWith(
      join(repoRoot, "test", "fixtures", "workflows", "engine-flag-agent.mjs"),
      { anything: true },
      null,
      runDir,
      { WOOF_TEST_REPO: repo },
    );
    expect(fromDefinition).toMatchObject({
      ok: false,
      reason: "role_invalid",
      details: [
        {
          field: "agents.planner.args.1",
          message: expect.stringContaining("resolveAgents for planner"),
        },
      ],
    });
    const configured = roles(repo);
    configured.builder.args = ["--model", "opus"];
    const fromRole = admitWith(
      "build-review",
      { schemaVersion: 1, repo, task },
      { projectRoot: repo, roles: configured, limits: {} },
      runDir,
    );
    expect(fromRole).toMatchObject({
      ok: false,
      reason: "role_invalid",
      details: [
        {
          field: "roles.builder.args.0",
          message: expect.stringContaining(`${repo}/.woof/roles/builder.json`),
        },
      ],
    });
  });

  it("lets an input agent override the configured role", () => {
    const { repo, runDir } = repoDir();
    const out = admitWith(
      "build-review",
      {
        schemaVersion: 1,
        repo,
        task,
        agents: { builder: { kind: "claude", model: "opus", args: [] } },
      },
      { projectRoot: repo, roles: roles(repo), limits: {} },
      runDir,
    );
    expect(((out["provenance"] as Json)["agents"] as Json)["builder"]).toMatchObject({
      model: "opus",
      source: "input",
      path: null,
    });
  });

  it("composes limits per key: input, then configuration, then the definition's defaults", () => {
    const { repo, runDir } = repoDir();
    const out = admitWith(
      "build-review",
      { schemaVersion: 1, repo, task, limits: { maxAttemptsPerVisit: 1 } },
      {
        projectRoot: repo,
        roles: roles(repo),
        limits: {
          maxRounds: { value: 5, source: "user", path: "/home/.woof/woof.json" },
          runTimeoutMs: { value: 1000, source: "project", path: `${repo}/.woof/woof.json` },
          maxAttemptsPerVisit: { value: 9, source: "project", path: `${repo}/.woof/woof.json` },
        },
      },
      runDir,
    );
    expect((out["plan"] as Json)["limits"]).toEqual({
      maxAttemptsPerVisit: 1,
      maxVisitsPerStage: 3,
      maxRounds: 5,
      maxFormatRepairs: 2,
      runTimeoutMs: 1000,
      readinessWaitMs: 180_000,
      blockedWaitMs: 600_000,
      deliveryTimeoutMs: 60_000,
    });
    const limits = (out["provenance"] as Json)["limits"] as Record<string, Json>;
    expect(limits["maxAttemptsPerVisit"]).toEqual({ value: 1, source: "input", path: null });
    expect(limits["maxRounds"]).toEqual({
      value: 5,
      source: "user",
      path: "/home/.woof/woof.json",
    });
    expect(limits["runTimeoutMs"]).toMatchObject({ source: "project" });
    expect(limits["readinessWaitMs"]).toEqual({ value: 180_000, source: "builtin", path: null });
  });

  it("annotates plan_invalid details with the layer that set the key", () => {
    const { repo, runDir } = repoDir();
    const out = admitWith(
      "build-review",
      { schemaVersion: 1, repo, task },
      {
        projectRoot: repo,
        roles: roles(repo),
        limits: { maxRounds: { value: 0, source: "user", path: "/home/.woof/woof.json" } },
      },
      runDir,
    );
    expect(out).toMatchObject({ ok: false, reason: "plan_invalid" });
    expect(out["details"]).toEqual([
      {
        field: "limits.maxRounds",
        message: "must be an integer between 1 and 1000 (set by user /home/.woof/woof.json)",
      },
    ]);
  });

  it("refuses an agent no input, role file or built-in role defines as role_unresolved", () => {
    const { repo, runDir } = repoDir();
    const unresolved = join(fixtures, "unresolved-role.mjs");
    const out = admitWith(
      unresolved,
      {},
      {
        projectRoot: repo,
        roles: roles(repo),
        limits: {},
        roleDirs: [`${repo}/.woof/roles`, "/home/.woof/roles"],
      },
      runDir,
      { WOOF_TEST_REPO: repo },
    );
    expect(out).toMatchObject({
      ok: false,
      reason: "role_unresolved",
      details: [{ field: "agents.auditor" }],
    });
    expect(out["message"]).toContain(`${repo}/.woof/roles/auditor.json`);
    expect(out["message"]).toContain("/home/.woof/roles/auditor.json");
    // Without configuration the omitted agent is refused the same way.
    expect(admitWith(unresolved, {}, null, runDir, { WOOF_TEST_REPO: repo })).toMatchObject({
      ok: false,
      reason: "role_unresolved",
    });
    // A configured auditor role admits it.
    const configured = admitWith(
      unresolved,
      {},
      {
        roles: {
          auditor: {
            kind: "claude",
            model: null,
            args: [],
            source: "user",
            path: "/home/.woof/roles/auditor.json",
          },
        },
        limits: {},
      },
      runDir,
      { WOOF_TEST_REPO: repo },
    );
    expect(configured).toMatchObject({
      ok: true,
      provenance: { agents: { auditor: { source: "user" } } },
    });
  });

  it("names the role file when a configured role's kind is unsupported", () => {
    const { repo, runDir } = repoDir();
    const configured = roles(repo);
    configured.builder.kind = "codex";
    const out = admitWith(
      "build-review",
      { schemaVersion: 1, repo, task },
      { projectRoot: repo, roles: configured, limits: {} },
      runDir,
    );
    expect(out).toMatchObject({
      ok: false,
      reason: "agent_kind_unsupported",
      details: [{ field: "roles.builder.kind" }],
    });
    expect(out["message"]).toContain(`${repo}/.woof/roles/builder.json`);
  });

  it("refuses a repository that is not the configured project as project_mismatch", () => {
    const { repo, runDir } = repoDir();
    const other = repoDir();
    const out = admitWith(
      "build-review",
      { schemaVersion: 1, repo, task },
      { projectRoot: other.repo, roles: roles(repo), limits: {} },
      runDir,
    );
    expect(out).toMatchObject({ ok: false, reason: "project_mismatch" });
    expect(out["message"]).toContain(repo);
    expect(out["message"]).toContain(other.repo);
    expect(out["message"]).toContain(`--project ${repo}`);
    const none = admitWith(
      "build-review",
      { schemaVersion: 1, repo, task },
      { projectRoot: null, roles: roles(repo), limits: {} },
      runDir,
    );
    expect(none).toMatchObject({ ok: false, reason: "project_mismatch" });
  });

  it("keeps an external p3 definition's complete limits: configuration fills only missing keys", () => {
    const { repo, runDir } = repoDir();
    const out = admitWith(
      join(fixtures, "callbacks.mjs"),
      { topic: "t" },
      {
        roles: {},
        limits: { maxRounds: { value: 7, source: "project", path: "/p/.woof/woof.json" } },
      },
      runDir,
      { WOOF_TEST_CALLBACK: "none", WOOF_TEST_REPO: repo },
    );
    expect(out).toMatchObject({ ok: true });
    expect((out["plan"] as Json)["limits"]).toEqual({
      maxAttemptsPerVisit: 2,
      maxVisitsPerStage: 3,
      maxRounds: 1,
      maxFormatRepairs: 1,
      runTimeoutMs: 60_000,
      readinessWaitMs: 10_000,
      blockedWaitMs: 10_000,
      deliveryTimeoutMs: 10_000,
    });
  });
});
