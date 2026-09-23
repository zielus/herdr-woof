import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

type Json = Record<string, unknown>;
type Result = {
  ok: boolean;
  reason?: string;
  message?: string;
  details?: Json[];
  configuration?: Json;
} & Json;

let compose: (input: Json) => Result;
let builtinCatalog: () => Json;
let builtInWorkflowNames: () => string[];
let validateSettingsFile: (value: unknown, file: Json) => Result;
let validateRoleFile: (value: unknown, file: Json) => Result;

beforeAll(async () => {
  const resolve = await loadDist<{
    composeConfiguration: typeof compose;
    builtinCatalog: typeof builtinCatalog;
  }>("config/resolve.js");
  compose = resolve.composeConfiguration;
  builtinCatalog = resolve.builtinCatalog;
  ({ builtInWorkflowNames } = await loadDist<{ builtInWorkflowNames: typeof builtInWorkflowNames }>(
    "workflows/catalog.js",
  ));
  ({ validateSettingsFile, validateRoleFile } = await loadDist<{
    validateSettingsFile: typeof validateSettingsFile;
    validateRoleFile: typeof validateRoleFile;
  }>("config/schema.js"));
});

const hash = (char: string) => char.repeat(64);

function scope(
  name: "project" | "user",
  parts: { settings?: Json; roles?: Record<string, Json>; workflows?: string[] } = {},
): Json {
  const dir = `/${name}/.woof`;
  return {
    scope: name,
    dir,
    exists: true,
    settings:
      parts.settings === undefined
        ? null
        : { path: `${dir}/woof.json`, sha256: hash("a"), bytes: 10, defaults: parts.settings },
    roles: Object.fromEntries(
      Object.entries(parts.roles ?? {}).map(([role, value]) => [
        role,
        {
          path: `${dir}/roles/${role}.json`,
          sha256: hash("b"),
          bytes: 10,
          role: { args: [], ...value },
        },
      ]),
    ),
    workflows: Object.fromEntries(
      (parts.workflows ?? []).map((workflow) => [
        workflow,
        { path: `${dir}/workflows/${workflow}.mjs`, sha256: hash("c"), bytes: 10 },
      ]),
    ),
  };
}

function resolved(parts: { project?: Json | null; user?: Json | null; flags?: Json } = {}): Json {
  const result = compose({
    roots: {
      project: { root: "/project", dir: "/project/.woof", exists: true },
      user: { dir: "/user/.woof", exists: true },
    },
    project: parts.project ?? null,
    user: parts.user ?? null,
    flags: parts.flags ?? {},
    builtin: builtinCatalog(),
    defaultRunsDir: "/home/.woof/runs",
    warnings: [],
    resolvedAt: "2026-09-15T00:00:00.000Z",
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.configuration as Json;
}

describe("configuration composition", () => {
  it("replaces a role whole and lists the shadowed layers in precedence order", () => {
    const configuration = resolved({
      project: scope("project", { roles: { builder: { kind: "claude", model: "opus" } } }),
      user: scope("user", {
        roles: {
          builder: { kind: "claude", model: "sonnet", args: ["--permission-mode", "auto"] },
        },
      }),
    });
    const builder = (configuration["roles"] as Record<string, Json>)["builder"];
    expect(builder).toEqual({
      value: { kind: "claude", model: "opus", args: [] },
      source: "project",
      path: "/project/.woof/roles/builder.json",
      sha256: hash("b"),
      shadowed: [
        {
          source: "user",
          path: "/user/.woof/roles/builder.json",
          value: { kind: "claude", model: "sonnet", args: ["--permission-mode", "auto"] },
        },
        { source: "builtin", path: null, value: { kind: "claude", model: null, args: [] } },
      ],
    });
    expect((configuration["roles"] as Record<string, Json>)["reviewer"]).toMatchObject({
      source: "builtin",
      shadowed: [],
    });
  });

  it("serves every built-in workflow and role from the catalog, with no name in a branch (p5 D2)", () => {
    const catalog = builtinCatalog() as {
      workflows: Record<string, { version: string; limitDefaults?: Record<string, number> }>;
      roles: Record<string, Json>;
    };
    // The catalog is the only source of workflow names: no branch in resolve.ts names one.
    expect(Object.keys(catalog.workflows).toSorted()).toEqual(builtInWorkflowNames().toSorted());
    expect(builtInWorkflowNames().toSorted()).toEqual([
      "auto-build",
      "build-review",
      "plan",
      "plan-build-review",
    ]);
    expect(Object.keys(catalog.roles).toSorted()).toEqual(["builder", "planner", "reviewer"]);
    // Prototype-free: a workflow or role named after an Object.prototype key is simply absent.
    expect(Object.getPrototypeOf(catalog.workflows)).toBe(null);
    expect(Object.getPrototypeOf(catalog.roles)).toBe(null);
    expect(Object.hasOwn(catalog.workflows, "constructor")).toBe(false);
    expect(Object.hasOwn(catalog.roles, "toString")).toBe(false);
    // Review loops get three rounds; plan and the composite auto-build have no rounds of their own.
    const rounds: Record<string, number> = {
      "auto-build": 1,
      "build-review": 3,
      plan: 1,
      "plan-build-review": 3,
    };
    for (const [name, entry] of Object.entries(catalog.workflows)) {
      expect(entry.version).toBe("1");
      expect(entry.limitDefaults?.["maxRounds"], name).toBe(rounds[name]);
    }
    for (const role of Object.values(catalog.roles)) {
      expect(role).toEqual({ kind: "claude", model: null, args: [] });
    }
    // Every built-in workflow resolves with source "builtin" and no configuration at all.
    for (const name of builtInWorkflowNames()) {
      const configuration = resolved({ user: scope("user", { settings: { workflow: name } }) });
      expect(configuration["workflow"], name).toMatchObject({
        source: "builtin",
        value: { name, version: "1" },
      });
    }
  });

  it("composes limits per key: project, then user, then the built-in definition's defaults", () => {
    const configuration = resolved({
      project: scope("project", { settings: { limits: { runTimeoutMs: 1000 } } }),
      user: scope("user", { settings: { limits: { maxRounds: 5, runTimeoutMs: 9000 } } }),
    });
    const limits = (configuration["settings"] as Json)["limits"] as Record<string, Json>;
    expect(limits["runTimeoutMs"]).toMatchObject({
      value: 1000,
      source: "project",
      shadowed: [
        { source: "user", value: 9000 },
        { source: "builtin", value: 7_200_000 },
      ],
    });
    expect(limits["maxRounds"]).toMatchObject({ value: 5, source: "user" });
    expect(limits["maxAttemptsPerVisit"]).toMatchObject({
      value: 2,
      source: "builtin",
      path: null,
    });
  });

  it("puts flags above every scope and never takes runsDir from built-ins when the user sets it", () => {
    const configuration = resolved({
      project: scope("project", { settings: { pollMs: 50, keepPanes: true } }),
      user: scope("user", { settings: { pollMs: 70, runsDir: "/runs" } }),
      flags: { pollMs: 5 },
    });
    const settings = configuration["settings"] as Record<string, Json>;
    expect(settings["pollMs"]).toMatchObject({
      value: 5,
      source: "flag",
      shadowed: [{ source: "project" }, { source: "user" }, { source: "builtin", value: 1000 }],
    });
    expect(settings["keepPanes"]).toMatchObject({ value: true, source: "project" });
    expect(settings["runsDir"]).toMatchObject({
      value: "/runs",
      source: "user",
      shadowed: [{ source: "builtin", value: "/home/.woof/runs" }],
    });
    expect(settings["hostStartTimeoutMs"]).toMatchObject({ value: 30_000, source: "builtin" });
    expect(settings["workflow"]).toMatchObject({ value: "build-review", source: "builtin" });
  });

  it("resolves a project workflow file over the built-in and drops the built-in limit fallback", () => {
    const configuration = resolved({ project: scope("project", { workflows: ["build-review"] }) });
    expect(configuration["workflow"]).toMatchObject({
      value: { name: "build-review", version: null },
      source: "project",
      path: "/project/.woof/workflows/build-review.mjs",
      shadowed: [{ source: "builtin", value: { name: "build-review", version: "1" } }],
    });
    expect((configuration["settings"] as Json)["limits"]).toEqual({});
  });

  it("refuses an undefined workflow with the partial configuration", () => {
    const result = compose({
      roots: { project: null, user: null },
      project: null,
      user: scope("user", { settings: { workflow: "missing" } }),
      flags: {},
      builtin: builtinCatalog(),
      defaultRunsDir: "/home/.woof/runs",
      warnings: [],
      resolvedAt: "2026-09-15T00:00:00.000Z",
    });
    expect(result).toMatchObject({ ok: false, reason: "workflow_not_found" });
    expect(result.message).toContain("/user/.woof/workflows/missing.{mjs,js,ts}");
    expect(result.configuration).toMatchObject({
      workflow: null,
      settings: { workflow: { source: "user" } },
    });
  });

  it("warns about unsupported kinds and explicit permission bypasses in effective roles only", () => {
    const configuration = resolved({
      project: scope("project", {
        roles: {
          planner: { kind: "gemini", model: null },
          builder: { kind: "claude", model: null },
        },
      }),
      user: scope("user", {
        roles: {
          builder: { kind: "claude", model: null, args: ["--dangerously-skip-permissions"] },
          reviewer: {
            kind: "claude",
            model: null,
            args: ["--permission-mode", "bypassPermissions"],
          },
        },
      }),
    });
    expect(configuration["warnings"]).toEqual([
      {
        code: "role_kind_unsupported",
        message: expect.stringContaining("planner"),
        path: "/project/.woof/roles/planner.json",
      },
      {
        code: "permission_bypass_configured",
        message: expect.stringContaining("reviewer"),
        path: "/user/.woof/roles/reviewer.json",
      },
    ]);
  });
});

describe("configuration file refusals", () => {
  const file = { path: "/p/.woof/woof.json", scope: "project" };

  it("names the file and JSON pointer of an unknown key", () => {
    expect(
      validateSettingsFile({ schemaVersion: 1, defaults: { limitz: {} } }, file),
    ).toMatchObject({
      ok: false,
      reason: "config_invalid",
      details: [
        {
          field: "/p/.woof/woof.json#/defaults/limitz",
          path: "/p/.woof/woof.json",
          pointer: "/defaults/limitz",
        },
      ],
    });
    expect(validateSettingsFile({ defaults: {} }, file)).toMatchObject({
      reason: "config_invalid",
      details: [{ pointer: "/schemaVersion" }],
    });
    expect(
      validateSettingsFile({ schemaVersion: 1, defaults: { limits: { maxRounds: 0 } } }, file),
    ).toMatchObject({
      reason: "config_invalid",
      details: [{ pointer: "/defaults/limits/maxRounds" }],
    });
  });

  it("refuses runsDir in project scope only", () => {
    const value = { schemaVersion: 1, defaults: { runsDir: "/runs" } };
    expect(validateSettingsFile(value, file)).toMatchObject({
      ok: false,
      reason: "setting_scope_invalid",
    });
    expect(validateSettingsFile(value, { ...file, scope: "user" })).toMatchObject({
      ok: true,
      defaults: { runsDir: "/runs" },
    });
  });

  it("refuses engine-owned launch flags and malformed roles", () => {
    const role = { path: "/p/.woof/roles/builder.json" };
    for (const args of [["--model", "opus"], ["--model=opus"], ["--add-dir", "/x"]]) {
      expect(
        validateRoleFile({ schemaVersion: 1, kind: "claude", model: null, args }, role),
      ).toMatchObject({ ok: false, reason: "role_invalid" });
    }
    expect(validateRoleFile({ schemaVersion: 1, kind: "claude" }, role)).toMatchObject({
      reason: "config_invalid",
      details: [{ pointer: "/model" }],
    });
    expect(validateRoleFile({ schemaVersion: 1, kind: "", model: null }, role)).toMatchObject({
      reason: "config_invalid",
      details: [{ pointer: "/kind" }],
    });
    expect(
      validateRoleFile({ schemaVersion: 1, kind: "claude", model: null, extra: 1 }, role),
    ).toMatchObject({ reason: "config_invalid", details: [{ pointer: "/extra" }] });
    expect(
      validateRoleFile(
        { schemaVersion: 1, kind: "claude", model: "sonnet", args: ["--permission-mode", "auto"] },
        role,
      ),
    ).toEqual({
      ok: true,
      role: { kind: "claude", model: "sonnet", args: ["--permission-mode", "auto"] },
    });
  });
});
