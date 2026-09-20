import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

/**
 * The per-kind launch table (p8a). `claude` owns --model and --add-dir; `pi`
 * owns --model only and never receives a run-directory grant. These load the
 * compiled table from dist/, so they fail if the shipped build disagrees.
 */

type Launch = (agent: {
  kind: string;
  model: string | null;
  args: readonly string[];
  runDir: string | null;
}) => { ok: true; args: string[] } | { ok: false; reason: string; message: string };

let launchArgs: Launch;
let engineOwnedFlags: (kind: string) => readonly string[];
let engineOwnedArgIndexes: (kind: string, args: readonly string[]) => number[];
let supportedKinds: readonly string[];

beforeAll(async () => {
  ({
    launchArgs,
    engineOwnedFlags,
    engineOwnedArgIndexes,
    SUPPORTED_AGENT_KINDS: supportedKinds,
  } = await loadDist<{
    launchArgs: Launch;
    engineOwnedFlags: typeof engineOwnedFlags;
    engineOwnedArgIndexes: typeof engineOwnedArgIndexes;
    SUPPORTED_AGENT_KINDS: readonly string[];
  }>("scheduler/launch.js"));
});

describe("the supported kind table", () => {
  it("lists exactly claude and pi, in that order", () => {
    // Pinned: a reordered or extended list changes the agent_kind_unsupported message.
    expect([...supportedKinds]).toEqual(["claude", "pi"]);
  });

  it("names the supported kinds when it refuses an unlisted one", () => {
    const result = launchArgs({ kind: "codex", model: null, args: [], runDir: "/r" });
    expect(result).toMatchObject({ ok: false, reason: "agent_kind_unsupported" });
    expect(result.ok === false && result.message).toContain("supported kinds: claude, pi");
  });

  it("refuses an unlisted kind, including inherited object keys", () => {
    for (const kind of ["codex", "gemini", "Claude", "PI", "", "constructor", "__proto__"]) {
      expect(launchArgs({ kind, model: null, args: [], runDir: "/r" })).toMatchObject({
        ok: false,
        reason: "agent_kind_unsupported",
      });
    }
  });
});

describe("launchArgs for pi", () => {
  it("adds the model before the caller's arguments", () => {
    expect(
      launchArgs({
        kind: "pi",
        model: "openai-codex/gpt-5.6-sol",
        args: [],
        runDir: null,
      }),
    ).toEqual({ ok: true, args: ["--model", "openai-codex/gpt-5.6-sol"] });
  });

  it("never adds a run-directory grant, even inside a run", () => {
    // pi has no directory sandbox, so --add-dir would be an unknown flag.
    expect(
      launchArgs({
        kind: "pi",
        model: "openai-codex/gpt-5.6-sol",
        args: [],
        runDir: "/runs/r",
      }),
    ).toEqual({ ok: true, args: ["--model", "openai-codex/gpt-5.6-sol"] });
    expect(launchArgs({ kind: "pi", model: null, args: [], runDir: "/runs/r" })).toEqual({
      ok: true,
      args: [],
    });
  });

  it("appends the caller's arguments after the model", () => {
    expect(
      launchArgs({
        kind: "pi",
        model: "github-copilot/kimi-k3",
        args: ["--models", "a,b"],
        runDir: "/runs/r",
      }),
    ).toEqual({ ok: true, args: ["--model", "github-copilot/kimi-k3", "--models", "a,b"] });
  });
});

describe("engine-owned flags per kind", () => {
  it("reports the flags each kind's engine sets", () => {
    expect([...engineOwnedFlags("claude")]).toEqual(["--model", "--add-dir"]);
    expect([...engineOwnedFlags("pi")]).toEqual(["--model"]);
  });

  it("owns nothing for a kind the table does not list", () => {
    for (const kind of ["codex", "constructor", ""]) {
      expect([...engineOwnedFlags(kind)]).toEqual([]);
      expect(engineOwnedArgIndexes(kind, ["--model", "x", "--add-dir", "/x"])).toEqual([]);
    }
  });

  it("matches --add-dir for claude but not for pi", () => {
    expect(engineOwnedArgIndexes("claude", ["--add-dir", "/x"])).toEqual([0]);
    expect(engineOwnedArgIndexes("claude", ["--add-dir=/x"])).toEqual([0]);
    // Woof stops owning --add-dir for pi: the flag is passed through and pi rejects it.
    expect(engineOwnedArgIndexes("pi", ["--add-dir", "/x"])).toEqual([]);
    expect(engineOwnedArgIndexes("pi", ["--add-dir=/x"])).toEqual([]);
  });

  it("matches --model in split and --model=value form for both kinds", () => {
    for (const kind of ["claude", "pi"]) {
      expect(engineOwnedArgIndexes(kind, ["--model", "x"])).toEqual([0]);
      expect(engineOwnedArgIndexes(kind, ["--model=x"])).toEqual([0]);
      expect(engineOwnedArgIndexes(kind, ["--verbose", "--model=x"])).toEqual([1]);
    }
  });

  it("does not match pi's --models cycling flag", () => {
    // --models takes a list for Ctrl+P cycling; it is a different flag the caller may set.
    expect(engineOwnedArgIndexes("pi", ["--models", "a,b"])).toEqual([]);
    expect(engineOwnedArgIndexes("pi", ["--models=a,b"])).toEqual([]);
    expect(engineOwnedArgIndexes("claude", ["--models", "a,b"])).toEqual([]);
  });

  it("reports every index when the caller sets an owned flag more than once", () => {
    expect(engineOwnedArgIndexes("claude", ["--model", "a", "--add-dir", "/x"])).toEqual([0, 2]);
    expect(engineOwnedArgIndexes("pi", ["--model", "a", "--add-dir", "/x"])).toEqual([0]);
  });
});
