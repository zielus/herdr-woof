import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { parse } from "smol-toml";
import { afterAll, describe, expect, it } from "vitest";

import { cliPath, distUrl, repoRoot, runNode } from "./helpers/process.js";

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

  /** The text of a `## ` section of run.md, up to the next `## ` heading. */
  function section(text: string, heading: string): string {
    const start = text.indexOf(`\n${heading}\n`);
    expect(start, heading).not.toBe(-1);
    const rest = text.slice(start + heading.length + 2);
    const end = rest.search(/\n## /);
    return end === -1 ? rest : rest.slice(0, end);
  }

  it("PI-005, LV-001, LV-002: run.md always applies the trust gate, states the verify shape and stops after a second rejection", () => {
    const text = readFileSync(join(claudeRoot, "commands", "run.md"), "utf8");
    const trust = section(text, "## 3. Folder trust");
    expect(trust).toContain("Always apply this gate");
    expect(trust).not.toMatch(/^If `repo` differs/m);
    expect(trust).toContain(
      "trust.status` from the pre-flight JSON when `repo` is the working directory",
    );
    expect(trust).toContain("`untrusted` or `unknown`");
    const input = section(text, "## 2. Build the workflow input");
    expect(input).toContain("`command`, a non-empty array of strings");
    expect(input).toContain("`timeoutMs`, a required integer number of milliseconds");
    const start = section(text, "## 4. Start the run");
    expect(start).toContain("fix every field the");
    expect(start).not.toContain("fix only what");
    expect(start).toContain("If the retry is");
    expect(start).toContain("report that rejection and stop");
    expect(start).toContain("interactive menu");
  });

  it("LV-001: the example input in run.md passes the built-in workflow's validateInput", () => {
    const text = readFileSync(join(claudeRoot, "commands", "run.md"), "utf8");
    const block = /```json\n([\s\S]*?)\n```/.exec(text)?.[1];
    expect(block).toBeDefined();
    const example = JSON.parse(block ?? "null") as Record<string, unknown>;
    expect(example["verify"]).toEqual({ command: ["node", "--test"], timeoutMs: 600000 });
    const result = runNode(
      `const { buildReviewWorkflow } = await import(${JSON.stringify(distUrl("workflows/build-review.js"))});
console.log(JSON.stringify(buildReviewWorkflow.validateInput(JSON.parse(process.argv[1]))));`,
      [JSON.stringify(example)],
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({ ok: true });
  });

  it("PI-010: the pre-flight runs doctor --json through dist/cli.js, else through woof on PATH", () => {
    const text = readFileSync(join(claudeRoot, "commands", "run.md"), "utf8");
    const command = /^!`(.+)`$/m.exec(text)?.[1] ?? "";
    // allowed-tools grants Bash(node:*): the expansion must start with node.
    expect(command.startsWith("node ")).toBe(true);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "woof-preflight-")));
    try {
      const [bin, home, repo, woofDir] = ["bin", "home", "repo", "woof-bin"].map((name) =>
        join(root, name),
      );
      for (const dir of [bin, home, repo, woofDir] as string[]) mkdirSync(dir);
      // PATH holds node and a fake Herdr only; the preflight never reaches the real herdr or claude.
      symlinkSync(process.execPath, join(bin as string, "node"));
      writeFileSync(join(bin as string, "fake-herdr"), "#!/bin/sh\necho herdr 0.0.0-fake\n", {
        mode: 0o755,
      });
      writeFileSync(
        join(woofDir as string, "woof"),
        `#!/bin/sh\nexec node ${JSON.stringify(cliPath)} "$@"\n`,
        { mode: 0o755 },
      );
      const preflight = (pluginRoot: string, extraPath: string) =>
        spawnSync("/bin/sh", ["-c", command], {
          cwd: repo,
          encoding: "utf8",
          env: {
            HOME: home,
            PATH: `${bin}:${extraPath}/usr/bin:/bin`,
            CLAUDE_PLUGIN_ROOT: pluginRoot,
            WOOF_HERDR_BIN: join(bin as string, "fake-herdr"),
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
          timeout: 30_000,
        });
      const doctorJson = { woof: { cli: cliPath }, trust: { dir: repo } };
      // In a checkout or the installed package: dist/cli.js sits next to the plugin.
      const fromDist = preflight(claudeRoot, "");
      expect(JSON.parse(fromDist.stdout), fromDist.stderr).toMatchObject(doctorJson);
      // A copied plugin directory without dist: woof on PATH answers with the same schema.
      const copied = join(root, "cache", "plugin", "claude");
      mkdirSync(copied, { recursive: true });
      const fromPath = preflight(copied, `${woofDir}:`);
      expect(JSON.parse(fromPath.stdout), fromPath.stderr).toMatchObject(doctorJson);
      // Neither: a plain sentence, no JSON.
      const neither = preflight(copied, "");
      expect(neither.stdout).toContain("Woof is not built or installed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
