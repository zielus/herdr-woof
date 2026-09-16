import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { repoRoot } from "./helpers/process.js";

// `bun run release:notes` (phase 7 D4, T8) as a real process against this repository's CHANGELOG.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function notes(...args: string[]) {
  return spawnSync("bun", [join(repoRoot, "scripts", "release", "notes.ts"), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

/** The [0.1.0] body as the CHANGELOG holds it: after its heading, up to the next `## `. */
function body010(): string {
  const text = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
  const start = text.indexOf("\n", text.indexOf("## [0.1.0] - "));
  const next = text.indexOf("\n## ", start);
  return text.slice(start, next === -1 ? undefined : next).trim();
}

describe("release:notes", () => {
  it("prints a version's section body without its heading", () => {
    const result = notes("0.1.0");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${body010()}\n`);
    expect(result.stdout).not.toContain("## [0.1.0]");
    expect(body010().length).toBeGreaterThan(100);
  });

  it("writes the body to --out instead of stdout", () => {
    const dir = mkdtempSync(join(tmpdir(), "woof-notes-"));
    dirs.push(dir);
    const out = join(dir, "notes.md");
    const result = notes("0.1.0", "--out", out);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(readFileSync(out, "utf8")).toBe(`${body010()}\n`);
  });

  it("refuses a version with no section and bad arguments with exit 2, writing no --out file", () => {
    for (const args of [
      ["9.9.9"],
      ["Unreleased", "--bogus"],
      ["not-a-version"],
      ["0.1.0", "0.1.1"],
    ]) {
      const result = notes(...args);
      expect(result.status, JSON.stringify(args) + result.stdout + result.stderr).toBe(2);
      expect(result.stdout, JSON.stringify(args)).toBe("");
    }
    expect(notes("9.9.9").stderr).toContain("CHANGELOG.md has no `## [9.9.9]` section");
    const dir = mkdtempSync(join(tmpdir(), "woof-notes-"));
    dirs.push(dir);
    const missing = notes("9.9.9", "--out", join(dir, "notes.md"));
    expect(missing.status).toBe(2);
    expect(existsSync(join(dir, "notes.md"))).toBe(false);
  });
});
