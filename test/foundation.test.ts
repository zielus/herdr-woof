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
  it("exports the foundation marker and the p1 result-handoff prototype from the built entry", () => {
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
    // Module namespace keys are ordered by name, not by declaration.
    expect(Object.keys(entry.types)).toEqual([
      "MAX_ARTIFACT_BYTES",
      "REJECTION_REASONS",
      "SDK_FOUNDATION",
      "openAttempt",
      "readJournal",
      "submitResult",
    ]);
    expect(entry.types).toEqual({
      MAX_ARTIFACT_BYTES: "number",
      REJECTION_REASONS: "object",
      SDK_FOUNDATION: "boolean",
      openAttempt: "function",
      readJournal: "function",
      submitResult: "function",
    });
    expect(readFileSync(entryPath, "utf8")).not.toContain("cli.js");
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

  it("lists the prototype result-handoff commands in help", () => {
    const result = runCli("--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("attempt open");
    expect(result.stdout).toContain("submit");
    expect(result.stdout).toContain("Workflow orchestration is not implemented yet.");
  });

  it("rejects workflow commands that are not implemented", () => {
    const result = runCli("runs");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not implemented");
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
