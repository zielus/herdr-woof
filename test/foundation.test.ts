import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repoRoot, "bin", "woof");

function runCli(...args: string[]) {
  return spawnSync(cliPath, args, { encoding: "utf8" });
}

describe("SDK foundation", () => {
  it("exports the foundation marker, the p2 SDK contracts and the p3 workflow engine from the built entry", () => {
    const entryPath = join(repoRoot, "dist", "index.js");
    const script = `const entry = await import(${JSON.stringify(pathToFileURL(entryPath).href)});
console.log(JSON.stringify({
  marker: entry.SDK_FOUNDATION,
  types: Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, typeof value])),
}));`;

    const result = spawnSync("node", ["--input-type=module", "--eval", script], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    const entry = JSON.parse(result.stdout) as { marker: unknown; types: Record<string, string> };
    expect(entry.marker).toBe(true);
    // Module namespace keys are ordered by code unit, not by declaration.
    const expected: Record<string, string> = {
      DISPATCH_REASONS: "object",
      MAX_ARTIFACT_BYTES: "number",
      ObservationTracker: "function",
      REJECTION_REASONS: "object",
      SDK_FOUNDATION: "boolean",
      admitWorkflow: "function",
      assignAgent: "function",
      blockRun: "function",
      buildReviewWorkflow: "object",
      createHerdrCliRuntime: "function",
      deriveRunResult: "function",
      deriveSnapshot: "function",
      foldEvents: "function",
      herdrRuntimeName: "function",
      loadWorkflowDefinition: "function",
      openAttempt: "function",
      openRun: "function",
      overlayRuntime: "function",
      readEvents: "function",
      readJournal: "function",
      readSnapshot: "function",
      reconcileDelivery: "function",
      recordDispatch: "function",
      recordGate: "function",
      runWorkflow: "function",
      submitResult: "function",
      subscribeEvents: "function",
      terminateRun: "function",
      unblockRun: "function",
      validateRunPlan: "function",
      validateWorkflowDefinition: "function",
      watchAgent: "function",
    };
    expect(Object.keys(entry.types)).toEqual(Object.keys(expected).toSorted());
    expect(entry.types).toEqual(expected);
    expect(readFileSync(entryPath, "utf8")).not.toContain("cli.js");
  });
});

describe("herdr-woof/testing", () => {
  it("exports only the scripted runtime, and the main entry does not", () => {
    const script = `const testing = await import(${JSON.stringify(pathToFileURL(join(repoRoot, "dist", "testing.js")).href)});
const entry = await import(${JSON.stringify(pathToFileURL(join(repoRoot, "dist", "index.js")).href)});
console.log(JSON.stringify({ testing: Object.fromEntries(Object.entries(testing).map(([key, value]) => [key, typeof value])), inEntry: "createScriptedRuntime" in entry }));`;

    const result = spawnSync("node", ["--input-type=module", "--eval", script], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      testing: { createScriptedRuntime: "function" },
      inEntry: false,
    });
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./testing": { types: "./dist/testing.d.ts", import: "./dist/testing.js" },
      "./package.json": "./package.json",
    });
  });
});

describe("woof CLI", () => {
  it("prints the package version", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };

    const result = runCli("--version");

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("lists the result-handoff and workflow commands in help", () => {
    const result = runCli("--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("attempt open");
    expect(result.stdout).toContain("submit");
    expect(result.stdout).toContain("run show");
    expect(result.stdout).toContain("run build-review");
    expect(result.stdout).toContain("run cancel");
    expect(result.stdout).not.toContain("not implemented");
  });

  it("rejects commands that do not exist", () => {
    const result = runCli("frobnicate");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not implemented");
  });

  it("lists runs from a runs directory (an absent one lists nothing)", () => {
    const runsDir = join(mkdtempSync(join(tmpdir(), "woof-runs-")), "absent");
    const result = runCli("runs", "--runs-dir", runsDir);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      outcome: "runs",
      runsDir,
      exists: false,
      runs: [],
      skipped: [],
    });
  });

  it("runs the diagnostic command without requiring Herdr or Claude", () => {
    const result = runCli("doctor");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("woof");
    expect(result.stdout).toContain("herdr");
    expect(result.stdout).toContain("claude");
  });

  it("reports a probe that exists but cannot be started", () => {
    const binDir = mkdtempSync(join(tmpdir(), "woof-doctor-"));
    try {
      for (const name of ["herdr", "claude"]) {
        writeFileSync(join(binDir, name), "not executable\n", { mode: 0o644 });
      }

      const result = spawnSync(process.execPath, [join(repoRoot, "dist", "cli.js"), "doctor"], {
        encoding: "utf8",
        env: { PATH: binDir },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("herdr status: failed");
      expect(result.stdout).toContain("claude --version: failed");
    } finally {
      rmSync(binDir, { force: true, recursive: true });
    }
  });
});

describe("plugin placeholders", () => {
  function readHerdrManifest(): Record<string, unknown> {
    return parse(readFileSync(join(repoRoot, "herdr-plugin.toml"), "utf8"));
  }

  it("wires the Herdr build and only the diagnostic action", () => {
    const manifest = readHerdrManifest();

    expect(manifest["id"]).toBe("herdr-woof");
    expect(manifest["platforms"]).toEqual(["linux", "macos"]);
    expect(manifest["build"]).toEqual([
      { command: ["bun", "install", "--frozen-lockfile"] },
      { command: ["bun", "run", "build"] },
    ]);
    expect(manifest["actions"]).toEqual([
      {
        id: "doctor",
        title: "Woof: doctor",
        description: "Check Herdr and Claude Code availability.",
        command: ["bin/woof", "doctor"],
      },
    ]);
    expect(manifest["panes"]).toBeUndefined();
    expect(manifest["events"]).toBeUndefined();
  });

  it("keeps the Herdr manifest version in sync with package.json", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
      os: string[];
    };
    const manifest = readHerdrManifest();

    expect(manifest["version"]).toBe(pkg.version);
    // npm names macOS "darwin"; the package must not claim platforms Herdr lacks.
    expect(pkg.os).toEqual(["darwin", "linux"]);
  });

  it("contains no MCP registration or launcher", () => {
    const claudeRoot = join(repoRoot, "plugin", "claude");

    expect(existsSync(join(claudeRoot, ".mcp.json"))).toBe(false);
    expect(existsSync(join(claudeRoot, "bin", "woof-mcp"))).toBe(false);
    expect(readFileSync(join(claudeRoot, "commands", "run.md"), "utf8")).not.toMatch(/mcp/i);
  });

  it("uses a Claude plugin manifest without tool transport wiring", () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "plugin", "claude", ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name: string; version: string };
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };

    expect(manifest.name).toBe("woof");
    expect(manifest.version).toBe(pkg.version);
  });
});
