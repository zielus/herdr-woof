import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

type Json = Record<string, unknown>;
type Detail = { field: string; message: string };
type Validate = (
  value: unknown,
) => { ok: true; definition: Json } | { ok: false; details: Detail[] };
type TransitionProblem = (definition: Json, from: string, transition: unknown) => Json | undefined;

let validateWorkflowDefinition: Validate;
let transitionProblem: TransitionProblem;

beforeAll(async () => {
  ({ validateWorkflowDefinition, transitionProblem } = await loadDist<{
    validateWorkflowDefinition: Validate;
    transitionProblem: TransitionProblem;
  }>("scheduler/definition.js"));
});

const noop = () => ({ decision: "pass", reason: "ok", outcome: "completed" });

/** A minimal valid definition: draft (agent) → lint (check) → critique (agent). */
function definition(overrides: Json = {}): Json {
  return {
    schemaVersion: 1,
    name: "draft-critique",
    version: "1",
    validateInput: (value: unknown) => ({ ok: true, input: value }),
    resolveAgents: () => ({}),
    resolveLimits: () => ({}),
    repository: () => "/repo",
    agents: [
      { agentId: "writer", role: "writer" },
      { agentId: "critic", role: "critic" },
    ],
    start: "draft",
    roundStage: "critique",
    stages: [
      stage("draft", "writer"),
      {
        kind: "check",
        checkId: "lint",
        command: () => ({ argv: ["true"], timeoutMs: 1 }),
        next: noop,
      },
      stage("critique", "critic", ["accept", "revise"]),
    ],
    edges: {
      draft: ["lint"],
      lint: ["critique", "draft"],
      critique: ["completed", "draft", "failed"],
    },
    ...overrides,
  };
}

function stage(
  stageId: string,
  agentId: string,
  verdicts: string[] = [],
  overrides: Json = {},
): Json {
  return {
    kind: "agent",
    stageId,
    agentId,
    verdicts,
    artifactFile: `${stageId}.md`,
    onFailedStatus: "fail",
    bindsRevision: false,
    request: () => ({ goal: "g", instructions: "i", inputs: [] }),
    next: noop,
    ...overrides,
  };
}

function fields(value: unknown): string[] {
  const result = validateWorkflowDefinition(value);
  return result.ok ? [] : result.details.map((detail) => detail.field);
}

describe("validateWorkflowDefinition", () => {
  it("accepts a valid definition and returns it", () => {
    const value = definition();
    const result = validateWorkflowDefinition(value);
    expect(result.ok).toBe(true);
    expect(result.ok && result.definition).toBe(value);
  });

  it("rejects non-objects and a wrong schema version, names and function members", () => {
    expect(fields(null)).toEqual(["definition"]);
    expect(fields([])).toEqual(["definition"]);
    expect(
      fields(
        definition({
          schemaVersion: 2,
          name: "../x",
          version: "",
          validateInput: 1,
          repository: undefined,
        }),
      ),
    ).toEqual(["schemaVersion", "name", "version", "validateInput", "repository"]);
  });

  it("rejects an unknown edge target and a stage without edges", () => {
    expect(
      fields(
        definition({
          edges: { draft: ["lint", "deploy"], lint: ["critique"], critique: ["completed"] },
        }),
      ),
    ).toEqual(["edges.draft[1]"]);
    expect(
      fields(definition({ edges: { draft: ["lint"], lint: ["critique"], critique: [] } })),
    ).toEqual(["edges.critique"]);
    expect(fields(definition({ edges: { draft: ["lint"], lint: ["critique"] } }))).toEqual([
      "edges.critique",
    ]);
    expect(
      fields(
        definition({
          edges: { draft: ["lint"], lint: ["critique"], critique: ["completed"], ghost: ["draft"] },
        }),
      ),
    ).toEqual(["edges.ghost"]);
  });

  it("rejects a cycle made only of checks", () => {
    const check = (checkId: string) => ({ kind: "check", checkId, command: noop, next: noop });
    const result = validateWorkflowDefinition(
      definition({
        stages: [
          stage("draft", "writer"),
          check("lint"),
          check("format"),
          stage("critique", "critic", ["accept"]),
        ],
        edges: {
          draft: ["lint"],
          lint: ["format", "critique"],
          format: ["lint"],
          critique: ["completed"],
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.details).toEqual([
      {
        field: "edges",
        message: "checks lint → format → lint form a cycle without an agent stage",
      },
    ]);
    // A cycle through an agent stage is bounded by visits and is allowed.
    expect(fields(definition())).toEqual([]);
  });

  it("rejects duplicate ids across stages and checks, undeclared agents and bad stage fields", () => {
    expect(
      fields(
        definition({
          stages: [
            stage("draft", "writer"),
            { kind: "check", checkId: "draft", command: noop, next: noop },
            stage("critique", "ghost", ["accept", "accept"], {
              artifactFile: "../x",
              onFailedStatus: "maybe",
              bindsRevision: "yes",
              request: null,
            }),
            { kind: "vote" },
          ],
          edges: { draft: ["critique"], critique: ["completed"] },
        }),
      ),
    ).toEqual([
      "stages[1].checkId",
      "stages[2].agentId",
      "stages[2].verdicts[1]",
      "stages[2].artifactFile",
      "stages[2].onFailedStatus",
      "stages[2].bindsRevision",
      "stages[2].request",
      "stages[3].kind",
    ]);
    for (const bad of ["", ".", "..", "a/b", "../x", ".hidden"]) {
      expect(
        fields(
          definition({
            stages: [
              stage("draft", "writer", [], { artifactFile: bad }),
              ...(definition()["stages"] as Json[]).slice(1),
            ],
          }),
        ),
        bad,
      ).toEqual(["stages[0].artifactFile"]);
    }
  });

  it("requires start to be an agent stage and roundStage to be null or an agent stage", () => {
    expect(fields(definition({ start: "lint", roundStage: "lint" }))).toEqual([
      "start",
      "roundStage",
    ]);
    expect(fields(definition({ roundStage: null }))).toEqual([]);
    expect(fields(definition({ agents: [] }))).toContain("agents");
  });
});

describe("transitionProblem", () => {
  const def = definition();

  it("accepts declared transitions", () => {
    expect(
      transitionProblem(def, "draft", { decision: "pass", reason: "drafted", to: "lint" }),
    ).toBeUndefined();
    expect(
      transitionProblem(def, "critique", {
        decision: "reject",
        reason: "again",
        to: "draft",
        requires: "round",
      }),
    ).toBeUndefined();
    expect(
      transitionProblem(def, "critique", { decision: "pass", reason: "ok", outcome: "completed" }),
    ).toBeUndefined();
    expect(
      transitionProblem(def, "critique", { decision: "reject", reason: "no", outcome: "failed" }),
    ).toBeUndefined();
  });

  it("reports a target outside edges as transition_undeclared", () => {
    expect(
      transitionProblem(def, "draft", { decision: "pass", reason: "x", to: "critique" }),
    ).toMatchObject({
      reason: "transition_undeclared",
    });
    expect(
      transitionProblem(def, "draft", { decision: "pass", reason: "x", outcome: "completed" }),
    ).toMatchObject({
      reason: "transition_undeclared",
    });
  });

  it("reports requires round in a definition without a roundStage as a contract violation", () => {
    const noRounds = { ...(def as Json), roundStage: null };
    expect(
      transitionProblem(noRounds, "critique", {
        decision: "reject",
        reason: "again",
        to: "draft",
        requires: "round",
      }),
    ).toMatchObject({
      reason: "definition_contract_violated",
      message: expect.stringContaining("roundStage"),
    });
    // Without requires the same transition is fine.
    expect(
      transitionProblem(noRounds, "critique", {
        decision: "reject",
        reason: "again",
        to: "draft",
      }),
    ).toBeUndefined();
  });

  it("reports contract violations", () => {
    for (const bad of [
      undefined,
      { decision: "maybe", reason: "x", to: "lint" },
      { decision: "pass", reason: "", to: "lint" },
      { decision: "pass", reason: "x".repeat(201), to: "lint" },
      { decision: "pass", reason: "x" },
      { decision: "pass", reason: "x", to: "lint", outcome: "completed" },
      { decision: "reject", reason: "x", outcome: "completed" },
      { decision: "pass", reason: "x", outcome: "failed" },
      { decision: "pass", reason: "x", outcome: "cancelled" },
      { decision: "pass", reason: "x", to: "lint", requires: "visit" },
    ]) {
      const from = bad !== undefined && "outcome" in bad ? "critique" : "draft";
      expect(transitionProblem(def, from, bad), JSON.stringify(bad)).toMatchObject({
        reason: "definition_contract_violated",
      });
    }
  });
});
