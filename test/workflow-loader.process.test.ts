import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
