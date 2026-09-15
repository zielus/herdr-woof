import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { parse } from "smol-toml";
import { afterAll, describe, expect, it } from "vitest";

import { cliPath, repoRoot } from "./helpers/process.js";

// Done criterion (d): the Herdr and Claude Code plugin manifests name only what
// the checkout and the npm tarball actually provide (plan T8).
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  version: string;
  os: string[];
};
const claudeRoot = join(repoRoot, "plugin", "claude");
const npmCache = mkdtempSync(join(tmpdir(), "woof-manifest-npm-"));
afterAll(() => rmSync(npmCache, { recursive: true, force: true }));

function cliHelp(): string {
  const result = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function escape(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** Whether `woof --help` lists this command path as a command line. */
function listed(help: string, path: string): boolean {
  return new RegExp(`^  ${escape(path)} {2,}\\S`, "m").test(help);
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** The `woof <command>` references in plugin text whose command `woof --help` does not list. */
function unknownCommands(text: string, help: string): string[] {
  const unknown: string[] = [];
  for (const match of text.matchAll(/\bwoof ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)) {
    const [, first = "", second] = match;
    if (second !== undefined && listed(help, `${first} ${second}`)) continue;
    if (listed(help, first)) continue;
    unknown.push(match[0]);
  }
  return unknown;
}

describe("herdr-plugin.toml", () => {
  const manifest = parse(readFileSync(join(repoRoot, "herdr-plugin.toml"), "utf8")) as Record<
    string,
    any // oxlint-disable-line no-explicit-any
  >;

  it("builds from the checkout and declares the four actions", () => {
    expect(manifest).toMatchObject({
      id: "herdr-woof",
      name: "Woof",
      version: pkg.version,
      min_herdr_version: "0.9.0",
      platforms: ["linux", "macos"],
      build: [
        { command: ["bun", "install", "--frozen-lockfile"] },
        { command: ["bun", "run", "build"] },
      ],
    });
    // npm names macOS "darwin"; the package must not claim platforms Herdr lacks.
    expect(pkg.os).toEqual(["darwin", "linux"]);
    expect(manifest["actions"].map((action: { id: string }) => action.id)).toEqual([
      "doctor",
      "status",
      "start",
      "cancel",
    ]);
    expect(manifest["panes"]).toBeUndefined();
    expect(manifest["events"]).toBeUndefined();
  });

  it("runs every action through bin/woof with a command the CLI lists", () => {
    accessSync(join(repoRoot, "bin", "woof"), constants.X_OK);
    const help = cliHelp();
    for (const action of manifest["actions"] as Array<{ command: string[] }>) {
      const [bin, ...path] = action.command;
      expect(bin).toBe("bin/woof");
      expect(listed(help, path.join(" ")), path.join(" ")).toBe(true);
    }
  });
});

describe("Claude Code plugin", () => {
  it("has a manifest without MCP servers, hooks, agents or scripts", () => {
    const manifest = JSON.parse(
      readFileSync(join(claudeRoot, ".claude-plugin", "plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: "woof",
      version: pkg.version,
      description: "Start and inspect Woof workflow runs in Herdr",
    });
    expect(manifest).not.toHaveProperty("mcpServers");
    expect(manifest).not.toHaveProperty("hooks");
    for (const name of [".mcp.json", "hooks", "agents", "scripts", "bin"]) {
      expect(existsSync(join(claudeRoot, name)), name).toBe(false);
    }
    expect(
      filesUnder(claudeRoot)
        .map((path) => relative(claudeRoot, path))
        .toSorted(),
    ).toEqual([".claude-plugin/plugin.json", "commands/run.md", "skills/woof/SKILL.md"]);
  });

  it("ships every plugin file in the npm tarball, and the tarball names no missing command or skill", () => {
    const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--cache", npmCache], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(packed.status, packed.stderr).toBe(0);
    const [info] = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
    const shipped = info?.files.map((file) => file.path) ?? [];
    for (const path of filesUnder(claudeRoot)) {
      expect(shipped).toContain(relative(repoRoot, path));
    }
    const components = shipped.filter((path) =>
      /^plugin\/claude\/(commands\/[^/]+\.md|skills\/[^/]+\/SKILL\.md)$/.test(path),
    );
    expect(components.toSorted()).toEqual([
      "plugin/claude/commands/run.md",
      "plugin/claude/skills/woof/SKILL.md",
    ]);
    for (const path of components) expect(existsSync(join(repoRoot, path))).toBe(true);
    expect(
      shipped.filter((path) => path.startsWith("bin/") || path === "herdr-plugin.toml"),
    ).toEqual([]);
  });

  it("run.md declares its tools and drives only real CLI commands", () => {
    const text = readFileSync(join(claudeRoot, "commands", "run.md"), "utf8");
    const [, frontmatter = "", body = ""] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? [];
    const fields = Object.fromEntries(
      frontmatter.split("\n").map((line) => {
        const index = line.indexOf(":");
        return [line.slice(0, index), line.slice(index + 1).trim()];
      }),
    );
    expect(fields).toEqual({
      description: "Start a Woof build-review run in Herdr and report its structured outcome",
      "argument-hint": '"<task description>"',
      "allowed-tools": "Bash(node:*), Bash(woof:*), Read",
    });
    expect(body).not.toContain("bin/woof");
    expect(body).not.toMatch(/mcp/i);
    const [instructions = "", never = ""] = body.split("\n## Never\n");
    expect(never).not.toBe("");
    expect(instructions).not.toContain("--dangerously-skip-permissions");
    expect(instructions).not.toContain("claude -p");
    expect(never).toContain("--dangerously-skip-permissions");
    for (const step of ["run start", "status", "doctor --json"])
      expect(body).toContain(`WOOF ${step}`);

    const help = cliHelp();
    expect(unknownCommands(text, help)).toEqual([]);
    const skill = readFileSync(join(claudeRoot, "skills", "woof", "SKILL.md"), "utf8");
    expect(unknownCommands(skill, help)).toEqual([]);
    expect(skill).toMatch(/^---\nname: woof\ndescription: .+\n---\n/);
    expect(skill).not.toContain("not implemented");
  });
});
