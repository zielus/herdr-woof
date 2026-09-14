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
});
