import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

type WithStartTimeout = (args: string[], timeoutMs: number) => string[];

let withStartTimeout: WithStartTimeout;

beforeAll(async () => {
  ({ withStartTimeout } = await loadDist<{ withStartTimeout: WithStartTimeout }>(
    "runtime/herdr/adapter.js",
  ));
});

describe("withStartTimeout", () => {
  it("replaces only the value after --timeout", () => {
    const args = ["agent", "start", "w-x", "--timeout", "30000", "--", "--timeout", "9"];
    expect(withStartTimeout(args, 4000)).toEqual([
      "agent",
      "start",
      "w-x",
      "--timeout",
      "4000",
      "--",
      "--timeout",
      "9",
    ]);
    expect(args[4]).toBe("30000");
  });

  it("throws a TypeError for argv without a --timeout value instead of rewriting another element", () => {
    // The message proves the guard threw, not a missing export.
    const guard = /agent start argv has no "--timeout <ms>" pair/;
    for (const args of [
      ["agent", "start", "w-x"],
      ["agent", "start", "w-x", "--timeout"],
    ]) {
      expect(() => withStartTimeout(args, 4000)).toThrow(TypeError);
      expect(() => withStartTimeout(args, 4000)).toThrow(guard);
    }
  });
});
