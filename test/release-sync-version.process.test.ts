import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { copyRepository } from "./helpers/repo-copy.js";

// `scripts/release/sync-version.ts` (the `bun run version` step after `changeset version`) as real
// `bun` processes in a throwaway copy of the repository.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const bun = (process.env["PATH"] ?? "")
  .split(delimiter)
  .map((dir) => join(dir, "bun"))
  .find((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) as string;

const HERDR = "herdr-plugin.toml";
const CLAUDE = "plugin/claude/.claude-plugin/plugin.json";

function copy(): string {
  const root = copyRepository();
  dirs.push(root);
  return root;
}

function sync(root: string) {
  return spawnSync(bun, [join(root, "scripts", "release", "sync-version.ts")], {
    cwd: root,
    encoding: "utf8",
  });
}

/** Sets package.json's version as `changeset version` does: a text edit of the version line. */
function setPackageVersion(root: string, version: string): void {
  const path = join(root, "package.json");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`),
  );
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("release sync-version", () => {
  it("copies package.json's version into herdr-plugin.toml and plugin.json, and a second run changes nothing", () => {
    const root = copy();
    const before = { herdr: read(root, HERDR), claude: read(root, CLAUDE) };
    const current = (JSON.parse(read(root, "package.json")) as { version: string }).version;
    setPackageVersion(root, "9.8.7");

    const first = sync(root);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toBe(`${HERDR}: ${current} -> 9.8.7\n${CLAUDE}: ${current} -> 9.8.7\n`);
    expect(read(root, HERDR)).toBe(
      before.herdr.replace(`version = "${current}"`, 'version = "9.8.7"'),
    );
    expect(read(root, CLAUDE)).toBe(
      before.claude.replace(`"version": "${current}"`, '"version": "9.8.7"'),
    );
    expect(read(root, HERDR).match(/^version = "9\.8\.7"$/gm)).toHaveLength(1);

    const after = { herdr: read(root, HERDR), claude: read(root, CLAUDE) };
    const second = sync(root);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toBe(`${HERDR}: 9.8.7 (no change)\n${CLAUDE}: 9.8.7 (no change)\n`);
    expect({ herdr: read(root, HERDR), claude: read(root, CLAUDE) }).toEqual(after);

    const checked = spawnSync(bun, [join(root, "scripts", "check-version.ts")], {
      cwd: root,
      encoding: "utf8",
    });
    expect(checked.stderr).not.toContain("differs from package.json");
  }, 60_000);

  it("exits 1 and writes nothing when package.json's version is not semver", () => {
    const root = copy();
    const before = { herdr: read(root, HERDR), claude: read(root, CLAUDE) };
    setPackageVersion(root, "1.2");
    const run = sync(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('sync-version: package.json version is not semver: "1.2"');
    expect({ herdr: read(root, HERDR), claude: read(root, CLAUDE) }).toEqual(before);
  }, 60_000);
});
