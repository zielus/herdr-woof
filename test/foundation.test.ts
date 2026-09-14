import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repoRoot, "bin", "woof");

function runCli(...args: string[]) {
  return spawnSync(cliPath, args, { encoding: "utf8" });
}

describe("SDK foundation", () => {
  it("provides a plugin-free SDK foundation marker without orchestration APIs", async () => {
    const entry = await import("../src/index.js");

    expect(entry.SDK_FOUNDATION).toBe(true);
    expect(Object.keys(entry)).toEqual(["SDK_FOUNDATION"]);
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
});

describe("plugin placeholders", () => {
  it("keeps only the Herdr diagnostic action", () => {
    const manifest = readFileSync(join(repoRoot, "herdr-plugin.toml"), "utf8");

    expect(manifest).toContain('id = "herdr-woof"');
    expect(manifest).toContain('id = "doctor"');
    expect(manifest).not.toContain('id = "runs"');
    expect(manifest).not.toContain("[[panes]]");
  });

  it("keeps the Herdr manifest version in sync with package.json", () => {
    const manifest = readFileSync(join(repoRoot, "herdr-plugin.toml"), "utf8");
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };

    expect(manifest).toMatch(
      new RegExp(`^version = "${pkg.version.replaceAll(".", "\\.")}"$`, "m"),
    );
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
