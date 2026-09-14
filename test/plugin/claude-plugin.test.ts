import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const pluginRoot = join(repoRoot, "plugin", "claude");

describe("plugin/claude/.claude-plugin/plugin.json", () => {
  it("names the plugin woof", async () => {
    const raw = await readFile(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8");
    const manifest = JSON.parse(raw) as { name: string; version: string };
    expect(manifest.name).toBe("woof");
    expect(manifest.version).toBe("0.0.0");
  });
});

describe("plugin/claude/.mcp.json", () => {
  it("registers the woof server against the woof-mcp launcher", async () => {
    const raw = await readFile(join(pluginRoot, ".mcp.json"), "utf8");
    const config = JSON.parse(raw) as { mcpServers: Record<string, { command: string }> };
    expect(config.mcpServers["woof"]?.command).toBe("${CLAUDE_PLUGIN_ROOT}/bin/woof-mcp");
  });
});

describe("plugin/claude skills and commands", () => {
  it("ships the woof skill", async () => {
    const raw = await readFile(join(pluginRoot, "skills", "woof", "SKILL.md"), "utf8");
    expect(raw).toMatch(/^---\nname: woof\n/);
  });

  it("ships the run command stub", async () => {
    const raw = await readFile(join(pluginRoot, "commands", "run.md"), "utf8");
    expect(raw).toMatch(/^---\n/);
  });

  it("ships no hooks", async () => {
    await expect(readFile(join(pluginRoot, "hooks", "hooks.json"), "utf8")).rejects.toThrow();
  });
});
