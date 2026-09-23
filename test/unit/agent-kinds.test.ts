import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

type Json = Record<string, unknown>;
interface Launch {
  SUPPORTED_AGENT_KINDS: readonly string[];
  launchArgs(
    agent: Json,
  ): { ok: true; args: string[] } | { ok: false; reason: string; message: string };
  engineOwnedArgIndexes(kind: string, args: string[]): number[];
  engineOwnedFlags(kind: string): readonly string[];
  refusedArgs(kind: string, args: string[]): Array<{ index: number; message: string }>;
  permissionBypassArgs(kind: string, args: string[]): string[];
  providerRefusal(kind: string, provider: string | null): string | undefined;
  submitNoteOf(kind: string): string | null;
  trustWarnings(
    kinds: string[],
    dir: string,
    options: { homeDir?: string },
  ): Array<{ code: string; message: string; path: string }>;
}

let launch: Launch;
beforeAll(async () => {
  launch = await loadDist<Launch>("scheduler/launch.js");
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "woof-kinds-")));
  dirs.push(dir);
  return dir;
}

describe("agent kind specs: shared lookup", () => {
  it("admits only listed kinds; an Object.prototype key is no kind", () => {
    expect(launch.SUPPORTED_AGENT_KINDS).toContain("claude");
    expect(launch.SUPPORTED_AGENT_KINDS).toContain("pi");
    for (const kind of ["gemini", "copilot", "Claude", "constructor", "toString", ""]) {
      expect(launch.launchArgs({ kind, model: null, args: [], runDir: "/r" })).toMatchObject({
        ok: false,
        reason: "agent_kind_unsupported",
      });
    }
  });

  it("keeps refusing --model and --add-dir for a kind without a spec", () => {
    expect(launch.engineOwnedArgIndexes("gemini", ["--model", "x", "--add-dir=/r", "-m"])).toEqual([
      0, 2,
    ]);
  });

  it("refuses a provider, never dropping it, for a kind that takes none", () => {
    expect(
      launch.launchArgs({ kind: "claude", model: null, provider: "x", args: [], runDir: null }),
    ).toMatchObject({ ok: false, reason: "role_invalid", message: expect.stringContaining("x") });
    expect(launch.providerRefusal("claude", null)).toBeUndefined();
    expect(launch.providerRefusal("gemini", "x")).toBeUndefined();
  });
});

describe("agent kind specs: pi", () => {
  it("maps provider and model to --provider and --model, with no run-directory grant", () => {
    expect(
      launch.launchArgs({
        kind: "pi",
        model: "gpt-5-mini",
        provider: "github-copilot",
        args: ["--thinking", "low"],
        runDir: "/runs/r",
      }),
    ).toEqual({
      ok: true,
      args: ["--provider", "github-copilot", "--model", "gpt-5-mini", "--thinking", "low"],
    });
    expect(launch.launchArgs({ kind: "pi", model: null, args: [], runDir: "/runs/r" })).toEqual({
      ok: true,
      args: [],
    });
  });

  it("owns --model and --provider, not --models", () => {
    expect(launch.engineOwnedFlags("pi")).toEqual(["--model", "--provider"]);
    expect(
      launch.engineOwnedArgIndexes("pi", [
        "--models",
        "a,b",
        "--model=x",
        "--provider",
        "p",
        "--add-dir",
      ]),
    ).toEqual([2, 3]);
  });

  it("refuses --add-dir, which pi does not have", () => {
    expect(launch.refusedArgs("pi", ["--thinking", "low", "--add-dir=/r"])).toEqual([
      { index: 2, message: expect.stringContaining("--add-dir") },
    ]);
    expect(launch.refusedArgs("claude", ["--add-dir=/r"])).toEqual([]);
  });

  it("reports --approve and -a as a bypass, not --no-approve, -na or claude's flags", () => {
    expect(launch.permissionBypassArgs("pi", ["--approve", "-a", "--no-approve", "-na"])).toEqual([
      "--approve",
      "-a",
    ]);
    expect(launch.permissionBypassArgs("pi", ["--dangerously-skip-permissions"])).toEqual([]);
    expect(launch.permissionBypassArgs("claude", ["--approve"])).toEqual([]);
    expect(launch.submitNoteOf("pi")).toBeNull();
    expect(launch.submitNoteOf("claude")).toBeNull();
  });

  it("warns about pi's trust question only for trust-requiring resources with no saved decision", () => {
    const root = temp();
    const home = join(root, "home");
    const repo = join(root, "repo");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(repo);
    const warn = () => launch.trustWarnings(["pi", "pi"], repo, { homeDir: home });

    // A bare repository has nothing pi asks about.
    expect(warn()).toEqual([]);
    // A bare .pi directory does not count either (pi docs/security.md).
    mkdirSync(join(repo, ".pi"));
    expect(warn()).toEqual([]);

    writeFileSync(join(repo, ".pi", "settings.json"), "{}");
    const trustPath = join(home, ".pi", "agent", "trust.json");
    expect(warn()).toEqual([
      {
        code: "pi_trust_untrusted",
        message: expect.stringContaining(".pi/settings.json"),
        path: trustPath,
      },
    ]);

    // A saved decision on the directory or an ancestor, either way, means no question.
    writeFileSync(trustPath, JSON.stringify({ [root]: false }));
    expect(warn()).toEqual([]);
    writeFileSync(trustPath, JSON.stringify({ "/elsewhere": true }));
    expect(warn()).toMatchObject([{ code: "pi_trust_untrusted" }]);

    // defaultProjectTrust other than "ask" never asks.
    writeFileSync(
      join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ defaultProjectTrust: "never" }),
    );
    expect(warn()).toEqual([]);
    writeFileSync(join(home, ".pi", "agent", "settings.json"), "{}");

    // An unreadable decision file is unknown, not untrusted.
    writeFileSync(trustPath, "{");
    expect(warn()).toMatchObject([{ code: "pi_trust_unknown" }]);
  });

  it("counts a project .agents/skills in an ancestor, but not the user's own ~/.agents/skills", () => {
    const root = temp();
    const home = join(root, "home");
    const repo = join(home, "repo");
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    mkdirSync(repo);
    expect(launch.trustWarnings(["pi"], repo, { homeDir: home })).toEqual([]);
    mkdirSync(join(repo, ".agents", "skills"), { recursive: true });
    expect(launch.trustWarnings(["pi"], repo, { homeDir: home })).toMatchObject([
      { code: "pi_trust_untrusted" },
    ]);
  });
});

describe("agent kind specs: codex", () => {
  it("maps the model to --model and grants the run directory with --add-dir", () => {
    expect(
      launch.launchArgs({
        kind: "codex",
        model: "gpt-5.6-terra",
        args: ["-c", "model_reasoning_effort=low"],
        runDir: "/runs/r",
      }),
    ).toEqual({
      ok: true,
      args: [
        "--model",
        "gpt-5.6-terra",
        "--add-dir",
        "/runs/r",
        "-c",
        "model_reasoning_effort=low",
      ],
    });
    expect(launch.launchArgs({ kind: "codex", model: null, args: [], runDir: null })).toEqual({
      ok: true,
      args: [],
    });
    expect(
      launch.launchArgs({ kind: "codex", model: null, provider: "openai", args: [], runDir: null }),
    ).toMatchObject({ ok: false, reason: "role_invalid" });
  });

  it("owns --model, -m in every form, --add-dir and a -c model= override, not other -c keys", () => {
    expect(
      launch.engineOwnedArgIndexes("codex", [
        "-m",
        "x",
        "-mx",
        "-m=x",
        "--config",
        "model=x",
        "-c",
        'model="x"',
        "-c",
        "model_reasoning_effort=high",
        "--add-dir=/r",
        "--model=x",
      ]),
    ).toEqual([0, 2, 3, 4, 6, 10, 11]);
  });

  it("refuses a read-only sandbox and arguments that move codex off the checkout", () => {
    expect(
      launch
        .refusedArgs("codex", [
          "-s",
          "read-only",
          "--sandbox=workspace-write",
          "-c",
          'sandbox_mode="read-only"',
          "-C",
          "/elsewhere",
          "--cd=/x",
          "--worktree",
        ])
        .map((item) => item.index),
    ).toEqual([0, 3, 5, 7, 8]);
    expect(launch.refusedArgs("codex", ["--sandbox", "workspace-write"])).toEqual([]);
    // clap's `-x=value` short spelling is matched too (review finding, verified).
    expect(launch.refusedArgs("codex", ["-s=read-only"]).map((item) => item.index)).toEqual([0]);
    expect(launch.engineOwnedArgIndexes("codex", ['-c=model="x"', "-c=model_provider=y"])).toEqual([
      0,
    ]);
    expect(launch.permissionBypassArgs("codex", ["-s=danger-full-access"])).toEqual([
      "--sandbox danger-full-access",
    ]);
  });

  it("reports codex's bypasses, never claude's or pi's", () => {
    expect(
      launch.permissionBypassArgs("codex", [
        "--dangerously-bypass-approvals-and-sandbox",
        "--yolo",
        "--approve-for-me",
        "--dangerously-bypass-hook-trust",
        "-s",
        "danger-full-access",
        "--sandbox",
        "workspace-write",
        "-a",
        "--dangerously-skip-permissions",
      ]),
    ).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "--yolo",
      "--approve-for-me",
      "--dangerously-bypass-hook-trust",
      "--sandbox danger-full-access",
    ]);
    expect(launch.submitNoteOf("codex")).toContain("--add-dir");
  });
});

describe("agent kind specs: grok", () => {
  it("maps the model to --model with no run-directory grant and no provider", () => {
    expect(
      launch.launchArgs({
        kind: "grok",
        model: "grok-4.7",
        args: ["--effort", "low"],
        runDir: "/r",
      }),
    ).toEqual({ ok: true, args: ["--model", "grok-4.7", "--effort", "low"] });
    expect(
      launch.launchArgs({ kind: "grok", model: null, provider: "xai", args: [], runDir: "/r" }),
    ).toMatchObject({ ok: false, reason: "role_invalid" });
    expect(launch.engineOwnedArgIndexes("grok", ["-m", "x", "--model=x", "-s", "id"])).toEqual([
      0, 2,
    ]);
  });

  it("refuses read-only, strict and workspace sandboxes and arguments that move grok off the checkout", () => {
    expect(
      launch
        .refusedArgs("grok", [
          "--sandbox",
          "read-only",
          "--sandbox=strict",
          "--sandbox",
          "off",
          "--sandbox=workspace",
          "-w",
          "--worktree=feat",
          "--cwd",
          "/x",
        ])
        .map((item) => item.index),
    ).toEqual([0, 2, 5, 6, 7, 8]);
  });

  it("reports grok's bypasses and its folder-trust grant", () => {
    expect(
      launch.permissionBypassArgs("grok", [
        "--always-approve",
        "--dangerously-skip-permissions",
        "--trust",
        "--permission-mode=bypassPermissions",
        "--permission-mode",
        "acceptEdits",
        "--yolo",
      ]),
    ).toEqual([
      "--always-approve",
      "--dangerously-skip-permissions",
      "--trust",
      "--permission-mode bypassPermissions",
    ]);
    expect(launch.submitNoteOf("grok")).toContain("never write the artifact");
    expect(launch.trustWarnings(["grok", "codex"], "/tmp", {})).toEqual([]);
  });
});
