import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

type Json = Record<string, unknown>;

interface CheckoutModule {
  peelCheckout(
    raw: unknown,
  ): { ok: true; input: unknown; spec: unknown } | { ok: false; details: Json[] };
  checkoutSpecProblems(value: unknown): Array<{ field: string; message: string }>;
  resolvedCheckoutProblem(value: unknown): string | undefined;
}
interface ParseModule {
  parseWorktreeCreated(result: Json): Json;
}

let checkout: CheckoutModule;
let parse: ParseModule;
beforeAll(async () => {
  checkout = await loadDist<CheckoutModule>("contracts/checkout.js");
  parse = await loadDist<ParseModule>("runtime/herdr/parse.js");
});

/** herdr 0.9.1's `worktree create` result (docs/design/composition.md), trimmed. */
const created = (overrides: Json = {}): Json => ({
  type: "worktree_created",
  root_pane: { pane_id: "w9K:p1", tab_id: "w9K:t1", workspace_id: "w9K" },
  tab: { tab_id: "w9K:t1", workspace_id: "w9K" },
  workspace: { workspace_id: "w9K", label: "woof-probe" },
  worktree: {
    branch: "probe/one",
    path: "/work/.herdr/worktrees/probe-repo/probe-one",
    open_workspace_id: "w9K",
  },
  ...overrides,
});

describe("checkout contract", () => {
  it("peels the reserved key off the input and validates it once", () => {
    const peeled = checkout.peelCheckout({ repo: "/r", checkout: { mode: "current" } });
    expect(peeled).toEqual({ ok: true, input: { repo: "/r" }, spec: { mode: "current" } });
    expect(checkout.peelCheckout({ repo: "/r" })).toEqual({
      ok: true,
      input: { repo: "/r" },
      spec: undefined,
    });
    // A non-object input is the definition's to refuse.
    expect(checkout.peelCheckout("text")).toEqual({ ok: true, input: "text", spec: undefined });
    expect(checkout.peelCheckout({ checkout: { mode: "path", path: "rel" } })).toEqual({
      ok: false,
      details: [{ field: "checkout.path", message: "must be an absolute path" }],
    });
  });

  it("accepts branch names git takes and refuses the rest", () => {
    for (const branch of ["woof/run-1", "feat/x.y", "a_b"])
      expect(checkout.checkoutSpecProblems({ mode: "worktree", branch }), branch).toEqual([]);
    for (const branch of ["-x", "a..b", "a/", "x.lock", "a b", "a@{1}", "/a", ""])
      expect(checkout.checkoutSpecProblems({ mode: "worktree", branch }), branch).toHaveLength(1);
    expect(checkout.checkoutSpecProblems({ mode: "current", keep: false })).toEqual([
      { field: "checkout.keep", message: "unknown field for mode current" },
    ]);
  });

  it("checks a recorded checkout's exact shape", () => {
    const valid = {
      mode: "worktree",
      path: "/w",
      source: "/r",
      branch: "b",
      base: null,
      workspaceId: "w1",
      created: true,
      keep: true,
      inherited: false,
    };
    expect(checkout.resolvedCheckoutProblem(valid)).toBeUndefined();
    expect(checkout.resolvedCheckoutProblem({ ...valid, mode: "current" })).toBe(
      "checkout.created is only true for mode worktree",
    );
    expect(checkout.resolvedCheckoutProblem({ ...valid, extra: 1 })).toBe(
      "unexpected field checkout.extra",
    );
    const { keep: _keep, ...missing } = valid;
    expect(checkout.resolvedCheckoutProblem(missing)).toBe("missing field checkout.keep");
  });
});

describe("herdr worktree create result", () => {
  it("reads the path, branch, workspace, root pane and tab", () => {
    expect(parse.parseWorktreeCreated(created())).toEqual({
      ok: true,
      path: "/work/.herdr/worktrees/probe-repo/probe-one",
      branch: "probe/one",
      workspaceId: "w9K",
      rootPaneId: "w9K:p1",
      tabId: "w9K:t1",
    });
  });

  it("refuses a reply whose ids disagree, and names the workspace to remove", () => {
    expect(
      parse.parseWorktreeCreated(
        created({ root_pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" } }),
      ),
    ).toEqual({
      ok: false,
      message: "worktree create returned workspace w9K with a root pane of workspace w1",
      workspaceId: "w9K",
    });
    expect(parse.parseWorktreeCreated(created({ worktree: { branch: "b", path: "rel" } }))).toEqual(
      {
        ok: false,
        message: "worktree create returned no absolute worktree path",
        workspaceId: "w9K",
      },
    );
    expect(parse.parseWorktreeCreated({ type: "tab_created" })).toMatchObject({
      ok: false,
      workspaceId: undefined,
    });
  });
});
