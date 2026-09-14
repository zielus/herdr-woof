import { spawnSync } from "node:child_process";
import { constants, realpathSync, statSync } from "node:fs";
import { readFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const LAUNCHERS = ["woof", "woof-mcp", "woof-agent-mcp"];

describe("bin/ launchers", () => {
  it.each(LAUNCHERS)("%s is executable", async (name) => {
    const path = join(repoRoot, "bin", name);
    await expect(access(path, constants.X_OK)).resolves.toBeUndefined();
    expect(statSync(path).mode & 0o111).not.toBe(0);
  });

  it("woof --version prints the package.json version", async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };
    const result = spawnSync(join(repoRoot, "bin", "woof"), ["--version"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });
});

describe("plugin/claude/bin/ symlinks", () => {
  it.each(LAUNCHERS)("%s resolves to the repo-root launcher", (name) => {
    const linked = join(repoRoot, "plugin", "claude", "bin", name);
    const target = join(repoRoot, "bin", name);
    expect(realpathSync(linked)).toBe(realpathSync(target));
  });
});
