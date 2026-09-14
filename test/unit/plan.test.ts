import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

type Json = Record<string, unknown>;

interface Detail {
  field: string;
  message: string;
}
type Result = { ok: true; plan: Record<string, unknown> } | { ok: false; details: Detail[] };

let validateRunPlan: (value: unknown) => Result;

beforeAll(async () => {
  ({ validateRunPlan } = await loadDist<{ validateRunPlan: typeof validateRunPlan }>(
    "domain/plan.js",
  ));
});

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workflow: { name: "build-review", version: "1" },
    agents: [
      { agentId: "builder", role: "builder", kind: "claude", model: null },
      { agentId: "reviewer", role: "reviewer", kind: "codex", model: "gpt-5" },
    ],
    stages: [
      { stageId: "build", agentId: "builder", verdicts: [] },
      { stageId: "review", agentId: "reviewer", verdicts: ["approve", "reject"] },
    ],
    limits: {
      maxAttemptsPerVisit: 3,
      maxVisitsPerStage: 6,
      maxRounds: 3,
      runTimeoutMs: 3_600_000,
      readinessWaitMs: 60_000,
      blockedWaitMs: 600_000,
      deliveryTimeoutMs: 30_000,
    },
    ...overrides,
  };
}

function fieldsOf(value: unknown): string[] {
  const result = validateRunPlan(value);
  if (result.ok) return [];
  return result.details.map((detail) => detail.field);
}

/** Deep copy whose objects all have a null prototype. */
function nullPrototype(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => nullPrototype(item));
  if (typeof value !== "object" || value === null) return value;
  const copy: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(value)) copy[key] = nullPrototype(item);
  return copy;
}

describe("validateRunPlan", () => {
  it("accepts a valid plan and returns a copy", () => {
    const input = plan();
    const result = validateRunPlan(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toEqual(input);
    expect(result.plan).not.toBe(input);
    expect(result.plan["stages"]).not.toBe(input["stages"]);
  });

  it("accepts a minimal plan with one agent, one stage and null model", () => {
    const result = validateRunPlan(
      plan({
        agents: [{ agentId: "a", role: "r", kind: "claude", model: null }],
        stages: [{ stageId: "s", agentId: "a", verdicts: [] }],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("never throws on non-object input", () => {
    for (const value of [null, undefined, 1, "plan", [], true]) {
      expect(fieldsOf(value)).toEqual(["plan"]);
    }
  });

  it("rejects unknown and missing keys at every level", () => {
    const input = plan({ extra: 1 });
    (input["workflow"] as Record<string, unknown>)["owner"] = "x";
    (input["agents"] as Array<Record<string, unknown>>)[0]!["color"] = "blue";
    Reflect.deleteProperty((input["stages"] as Array<Record<string, unknown>>)[1]!, "verdicts");
    (input["limits"] as Record<string, unknown>)["maxGates"] = 1;
    expect(fieldsOf(input).toSorted()).toEqual(
      [
        "extra",
        "workflow.owner",
        "agents[0].color",
        "stages[1].verdicts",
        "limits.maxGates",
      ].toSorted(),
    );
    expect(fieldsOf({})).toEqual(["workflow", "agents", "stages", "limits"]);
  });

  it("rejects duplicate agent and stage ids", () => {
    const fields = fieldsOf(
      plan({
        agents: [
          { agentId: "a", role: "r", kind: "claude", model: null },
          { agentId: "a", role: "r", kind: "claude", model: null },
        ],
        stages: [
          { stageId: "s", agentId: "a", verdicts: [] },
          { stageId: "s", agentId: "a", verdicts: [] },
        ],
      }),
    );
    expect(fields).toEqual(["agents[1].agentId", "stages[1].stageId"]);
  });

  it("rejects a stage naming a missing agent", () => {
    const fields = fieldsOf(plan({ stages: [{ stageId: "s", agentId: "ghost", verdicts: [] }] }));
    expect(fields).toEqual(["stages[0].agentId"]);
  });

  it("rejects empty agent and stage lists", () => {
    expect(fieldsOf(plan({ agents: [], stages: [] }))).toEqual(["agents", "stages"]);
  });

  it("rejects invalid ids, including . and ..", () => {
    const fields = fieldsOf(
      plan({
        workflow: { name: ".", version: "" },
        agents: [{ agentId: "..", role: "has space", kind: "", model: "" }],
        stages: [{ stageId: "-bad", agentId: "..", verdicts: [] }],
      }),
    );
    expect(fields).toEqual([
      "workflow.name",
      "workflow.version",
      "agents[0].agentId",
      "agents[0].role",
      "agents[0].kind",
      "agents[0].model",
      "stages[0].stageId",
      "stages[0].agentId",
    ]);
  });

  it("rejects empty and duplicate verdicts and non-array verdicts", () => {
    expect(
      fieldsOf(plan({ stages: [{ stageId: "s", agentId: "builder", verdicts: ["ok", ""] }] })),
    ).toEqual(["stages[0].verdicts[1]"]);
    expect(
      fieldsOf(plan({ stages: [{ stageId: "s", agentId: "builder", verdicts: ["ok", "ok"] }] })),
    ).toEqual(["stages[0].verdicts[1]"]);
    expect(
      fieldsOf(plan({ stages: [{ stageId: "s", agentId: "builder", verdicts: "ok" }] })),
    ).toEqual(["stages[0].verdicts"]);
  });

  const limitKeys = [
    ["maxAttemptsPerVisit", 1000],
    ["maxVisitsPerStage", 1000],
    ["maxRounds", 1000],
    ["runTimeoutMs", 604_800_000],
    ["readinessWaitMs", 604_800_000],
    ["blockedWaitMs", 604_800_000],
    ["deliveryTimeoutMs", 604_800_000],
  ] as const;

  for (const [key, cap] of limitKeys) {
    it(`bounds limits.${key}`, () => {
      const base = plan();
      const withLimit = (value: unknown) => {
        const limits = { ...(base["limits"] as Record<string, unknown>) };
        if (value === undefined) Reflect.deleteProperty(limits, key);
        else limits[key] = value;
        return plan({ limits });
      };
      for (const bad of [0, -1, 1.5, Infinity, -Infinity, NaN, 1e21, cap + 1, "3", null]) {
        expect(fieldsOf(withLimit(bad)), String(bad)).toEqual([`limits.${key}`]);
      }
      expect(fieldsOf(withLimit(undefined))).toEqual([`limits.${key}`]);
      expect(validateRunPlan(withLimit(1)).ok).toBe(true);
      expect(validateRunPlan(withLimit(cap)).ok).toBe(true);
    });
  }

  it("reads only own enumerable properties, never inherited ones", () => {
    const valid = plan();
    const inheritedRoot = validateRunPlan(Object.create(valid));
    expect(inheritedRoot.ok).toBe(false);
    if (!inheritedRoot.ok) {
      expect(inheritedRoot.details.map((detail) => detail.field)).toEqual(
        expect.arrayContaining(["workflow", "agents", "stages", "limits"]),
      );
    }

    const nested = validateRunPlan(
      plan({ workflow: Object.create({ name: "build-review", version: "1" }) }),
    );
    expect(nested).toMatchObject({
      ok: false,
      details: [{ field: "workflow.name" }, { field: "workflow.version" }],
    });

    const inheritedAgent = plan({
      agents: [
        Object.create({ agentId: "builder", role: "builder", kind: "claude", model: null }),
        { agentId: "reviewer", role: "reviewer", kind: "codex", model: "gpt-5" },
      ],
    });
    expect(validateRunPlan(inheritedAgent).ok).toBe(false);

    // A field supplied only by Object.prototype is still missing.
    const { limits, ...withoutLimits } = valid;
    // Deliberate, removed in finally: proves no field is read from Object.prototype.
    // oxlint-disable-next-line no-extend-native
    Object.defineProperty(Object.prototype, "limits", {
      value: limits,
      configurable: true,
      writable: true,
    });
    let polluted: Result;
    try {
      polluted = validateRunPlan(withoutLimits);
    } finally {
      delete (Object.prototype as Record<string, unknown>)["limits"];
    }
    expect(polluted).toMatchObject({ ok: false, details: [{ field: "limits" }] });
  });

  it("accepts a valid plan built from null-prototype objects and returns plain data", () => {
    const result = validateRunPlan(nullPrototype(plan()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(JSON.stringify(result.plan))).toEqual(plan());
  });

  it("never throws on a cyclic plan", () => {
    const cyclic = plan();
    cyclic["workflow"] = cyclic;
    const agents = cyclic["agents"] as unknown[];
    agents.push(agents);
    expect(() => validateRunPlan(cyclic)).not.toThrow();
    expect(validateRunPlan(cyclic).ok).toBe(false);
  });

  it("treats a record field inherited from a prototype as missing", async () => {
    const { exactKeysProblem } = await loadDist<{
      exactKeysProblem: (
        value: Record<string, unknown>,
        required: string[],
        optional: string[],
        prefix: string,
      ) => string | undefined;
    }>("journal/record-fields.js");
    expect(exactKeysProblem(Object.create({ runId: "run-1" }), ["runId"], [], "")).toBe(
      "missing field runId",
    );
    expect(exactKeysProblem({ runId: "run-1" }, ["runId"], [], "")).toBeUndefined();
  });

  it("treats an envelope verdict supplied only by Object.prototype as missing", async () => {
    const { parseEnvelope } = await loadDist<{
      parseEnvelope: (raw: string) => { ok: boolean; reason?: string; details?: Detail[] };
    }>("contracts/envelope.js");
    const envelope = JSON.stringify({
      schemaVersion: 1,
      runId: "run-1",
      agentId: "worker",
      stageId: "report",
      visit: 1,
      attempt: 1,
      status: "completed",
      artifact: { path: "artifacts/report/visit-1/attempt-1/report.md", sha256: "a".repeat(64) },
    });
    // Deliberate, removed in finally: proves the envelope check reads own properties only.
    // oxlint-disable-next-line no-extend-native
    Object.defineProperty(Object.prototype, "verdict", {
      value: null,
      configurable: true,
      writable: true,
    });
    let parsed: ReturnType<typeof parseEnvelope>;
    try {
      parsed = parseEnvelope(envelope);
    } finally {
      delete (Object.prototype as Record<string, unknown>)["verdict"];
    }
    expect(parsed).toMatchObject({ ok: false, reason: "envelope_invalid" });
    expect(parsed.details?.map((detail) => detail.field)).toEqual(["verdict"]);
  });

  it("reports every offending field at once", () => {
    const fields = fieldsOf(
      plan({
        workflow: null,
        limits: {
          ...(plan()["limits"] as Record<string, unknown>),
          maxRounds: 0,
          runTimeoutMs: NaN,
        },
      }),
    );
    expect(fields).toEqual(["workflow", "limits.maxRounds", "limits.runTimeoutMs"]);
  });

  it("accepts a plan without p3 fields and copies none into it", () => {
    const result = validateRunPlan(plan());
    expect(result.ok && Object.keys(result.plan)).toEqual([
      "workflow",
      "agents",
      "stages",
      "limits",
    ]);
    expect(result.ok && Object.keys(result.plan["limits"] as object)).not.toContain(
      "maxFormatRepairs",
    );
  });

  it("bounds the optional limits.maxFormatRepairs between 0 and 1000", () => {
    const base = plan();
    const withRepairs = (value: unknown) =>
      plan({ limits: { ...(base["limits"] as Record<string, unknown>), maxFormatRepairs: value } });
    for (const good of [0, 1, 1000]) {
      const result = validateRunPlan(withRepairs(good));
      expect(result.ok, String(good)).toBe(true);
      expect(
        result.ok && (result.plan["limits"] as Record<string, unknown>)["maxFormatRepairs"],
      ).toBe(good);
    }
    for (const bad of [1001, -1, 1.5, "2", null, NaN]) {
      expect(fieldsOf(withRepairs(bad)), String(bad)).toEqual(["limits.maxFormatRepairs"]);
    }
  });

  it("accepts string agent args, copies them, and rejects anything else", () => {
    const agents = (args: unknown) =>
      plan({
        agents: [
          { agentId: "builder", role: "builder", kind: "claude", model: null, args },
          { agentId: "reviewer", role: "reviewer", kind: "claude", model: null },
        ],
      });
    const input = agents(["--model", "sonnet", ""]);
    const result = validateRunPlan(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const copied = (result.plan["agents"] as Array<Record<string, unknown>>)[0]?.["args"];
      expect(copied).toEqual(["--model", "sonnet", ""]);
      expect(copied).not.toBe(((input["agents"] as Json[])[0] as Json)["args"]);
      expect(Object.keys((result.plan["agents"] as Json[])[1] as Json)).not.toContain("args");
    }
    for (const bad of ["--model", [1], [null], {}]) {
      expect(fieldsOf(agents(bad)), JSON.stringify(bad)).toEqual(["agents[0].args"]);
    }
  });

  it("accepts unique check ids disjoint from stage ids", () => {
    const result = validateRunPlan(plan({ checks: ["verify", "lint"] }));
    expect(result.ok && result.plan["checks"]).toEqual(["verify", "lint"]);
    expect(validateRunPlan(plan({ checks: [] })).ok).toBe(true);
    expect(fieldsOf(plan({ checks: "verify" }))).toEqual(["checks"]);
    expect(fieldsOf(plan({ checks: ["verify", "verify"] }))).toEqual(["checks[1]"]);
    expect(fieldsOf(plan({ checks: ["build"] }))).toEqual(["checks[0]"]);
    expect(fieldsOf(plan({ checks: ["../x"] }))).toEqual(["checks[0]"]);
  });
});
