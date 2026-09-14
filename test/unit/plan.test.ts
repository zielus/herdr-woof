import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

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
});
