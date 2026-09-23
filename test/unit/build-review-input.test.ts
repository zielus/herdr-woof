import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

type Json = Record<string, unknown>;
type Detail = { field: string; message: string };
type Validate = (value: unknown) => { ok: true; input: Json } | { ok: false; details: Detail[] };

let validateInput: Validate;

beforeAll(async () => {
  const loaded = await loadDist<{ buildReviewWorkflow: { validateInput: Validate } }>(
    "workflows/build-review.js",
  );
  validateInput = (value) => loaded.buildReviewWorkflow.validateInput(value);
});

const agent = { kind: "claude", model: null, args: [] };

function inputWith(task: Json): Json {
  return {
    schemaVersion: 1,
    repo: "/repo",
    task: { title: "Title", description: "Describe.", acceptanceCriteria: ["holds"], ...task },
    agents: { builder: agent, reviewer: agent },
  };
}

function fieldsOf(value: unknown): Detail[] {
  const result = validateInput(value);
  return result.ok ? [] : result.details;
}

describe("build-review input: task.context is a JSON value", () => {
  it("accepts nested JSON context", () => {
    expect(fieldsOf(inputWith({ context: { a: [1, "two", null, true, { b: 2.5 }] } }))).toEqual([]);
  });

  it("rejects undefined, functions, bigint, non-finite numbers, cycles, holes and non-plain objects anywhere", () => {
    const cyclic: Json = { a: 1 };
    cyclic["self"] = cyclic;
    const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
    for (const [context, field] of [
      [{ nested: undefined }, "task.context.nested"],
      [{ run: () => 1 }, "task.context.run"],
      [{ big: 10n }, "task.context.big"],
      [[1, Number.NaN], "task.context[1]"],
      [cyclic, "task.context.self"],
      [sparse, "task.context[1]"],
      [{ when: new Date(0) }, "task.context.when"],
    ] as const) {
      expect(
        fieldsOf(inputWith({ context })).map((detail) => detail.field),
        field,
      ).toEqual([field]);
    }
  });
});

describe("build-review input: the rendered request fits at admission", () => {
  it("rejects a context that is small compact but too large once pretty-printed into the request", () => {
    let deep: unknown = "leaf";
    for (let level = 0; level < 180; level += 1) deep = [deep];
    const details = fieldsOf(inputWith({ context: deep }));
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ field: "task" });
    expect(details[0]?.message).toMatch(
      /largest rendered request for this input would be \d+ bytes/,
    );
  });

  it("accepts an ordinary task with a sizeable context", () => {
    const context = {
      notes: Array.from({ length: 40 }, (_, index) => `note ${index} `.repeat(10)),
    };
    expect(fieldsOf(inputWith({ context }))).toEqual([]);
  });

  it("computes the same bound after the helper moved to workflows/request-bound.ts (p5 T2)", () => {
    // Pinned against the inline computation this extraction replaced, re-measured
    // whenever the repair request text changes: the repair is the binding case for
    // this bound, so LV-102's canonical-review sentence (276 bytes) moved it from
    // 22 932 to 22 656, and the longest per-kind submit note (the codex note, 170
    // bytes and its newline) moved it to 22 485. A blob of 22 485 bytes is the
    // largest this input shape admits; 22 486 renders 32 769 bytes and is refused
    // by one byte.
    const blob = (size: number): Json => ({
      schemaVersion: 1,
      repo: "/repo",
      task: {
        title: "t",
        description: "d",
        acceptanceCriteria: ["a"],
        context: { blob: "x".repeat(size) },
      },
    });
    expect(fieldsOf(blob(22_485))).toEqual([]);
    const refused = fieldsOf(blob(22_486));
    expect(refused).toEqual([
      {
        field: "task",
        message:
          "the largest rendered request for this input would be 32769 bytes; the limit is 32768",
      },
    ]);
  });
});

describe("build-review input: agents and limits are per-run overrides (p4)", () => {
  type Workflow = {
    resolveAgents: (input: Json) => Json;
    resolveLimits: (input: Json) => Json;
    limitDefaults: Json;
  };
  let workflow: Workflow;
  let defaults: Json;
  beforeAll(async () => {
    const loaded = await loadDist<{
      buildReviewWorkflow: Workflow;
      BUILD_REVIEW_DEFAULT_LIMITS: Json;
    }>("workflows/build-review.js");
    workflow = loaded.buildReviewWorkflow;
    defaults = loaded.BUILD_REVIEW_DEFAULT_LIMITS;
  });

  const base = (agents?: unknown): Json => {
    const input = inputWith({});
    if (agents === undefined) Reflect.deleteProperty(input, "agents");
    else input["agents"] = agents;
    return input;
  };

  it("accepts no agents, or any single role", () => {
    expect(fieldsOf(base())).toEqual([]);
    expect(fieldsOf(base({}))).toEqual([]);
    expect(fieldsOf(base({ builder: agent }))).toEqual([]);
    expect(fieldsOf(base({ reviewer: agent }))).toEqual([]);
  });

  it("still refuses an invalid role entry, an unknown role and a non-object", () => {
    expect(fieldsOf(base({ builder: { kind: "", model: null, args: [] } }))).toEqual([
      { field: "agents.builder.kind", message: "must be a non-empty string" },
    ]);
    expect(fieldsOf(base({ planner: agent })).map((detail) => detail.field)).toEqual([
      "agents.planner",
    ]);
    expect(fieldsOf(base([])).map((detail) => detail.field)).toEqual(["agents"]);
  });

  it("resolves only the roles the input names and returns only limit overrides", () => {
    const only = validateInput(
      base({ reviewer: { kind: "claude", model: "sonnet", args: ["-x"] } }),
    );
    expect(only.ok).toBe(true);
    const input = (only as { input: Json }).input;
    expect(workflow.resolveAgents(input)).toEqual({
      reviewer: { kind: "claude", model: "sonnet", args: ["-x"] },
    });
    expect(workflow.resolveLimits(input)).toEqual({});
    expect(workflow.resolveLimits({ ...input, limits: { maxRounds: 1 } })).toEqual({
      maxRounds: 1,
    });
    expect(workflow.limitDefaults).toEqual(defaults);
  });
});
