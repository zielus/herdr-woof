import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { distUrl, repoRoot, runNode } from "./helpers/process.js";

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
