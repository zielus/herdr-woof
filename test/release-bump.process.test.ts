import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { repoRoot } from "./helpers/process.js";
import { GIT_ENV, copyRepository, git } from "./helpers/repo-copy.js";

// `bun run release:bump` (phase 7 D3, T8) as real `bun scripts/release/bump.ts` processes in a
// throwaway copy of the repository.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

const MANIFESTS = ["package.json", "herdr-plugin.toml", "plugin/claude/.claude-plugin/plugin.json"];

function copy(): string {
  const root = copyRepository();
  dirs.push(root);
  return root;
}

function bump(root: string, ...args: string[]) {
  return spawnSync(bun, [join(root, "scripts", "release", "bump.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });
}

/** Every file the bump may touch, keyed by path, for an untouched-tree comparison. */
function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(
    [...MANIFESTS, "CHANGELOG.md"].map((rel) => [rel, readFileSync(join(root, rel), "utf8")]),
  );
}

function currentVersion(root: string): string {
  return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string })
    .version;
}

/** A copy whose CHANGELOG has [Unreleased] entries, committed, so the tree is clean. */
function withUnreleased(root: string): void {
  const path = join(root, "CHANGELOG.md");
  const text = readFileSync(path, "utf8");
  const start = text.indexOf("## [Unreleased]");
  const next = text.indexOf("\n## [", start + 1);
  writeFileSync(
    path,
    `${text.slice(0, start)}## [Unreleased]\n\n### Fixed\n\n- A bump fixture entry.\n${text.slice(next)}`,
  );
  git(root, "commit", "-q", "-am", "unreleased entry");
}

describe("release:bump", () => {
  it("edits the three manifest versions and dates the Unreleased entries, prints the diff, and commits nothing", () => {
    const root = copy();
    withUnreleased(root);
    const before = snapshot(root);
    const head = git(root, "rev-parse", "HEAD");
    const next = "0.9.1";
    expect(currentVersion(root) < next).toBe(true);

    const result = bump(root, next, "--date", "2026-01-02");
    expect(result.status, result.stdout + result.stderr).toBe(0);

    for (const rel of MANIFESTS) {
      const text = readFileSync(join(root, rel), "utf8");
      const old = before[rel] as string;
      // Only the version value changed: same bytes otherwise (no JSON re-serialization).
      expect(text, rel).toBe(old.replace(/(version"?\s*[:=]\s*")[^"]*"/, `$1${next}"`));
      expect(text, rel).not.toBe(old);
    }
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain(
      "## [Unreleased]\n\n## [0.9.1] - 2026-01-02\n\n### Fixed\n\n- A bump fixture entry.\n",
    );
    expect(changelog.replace("## [0.9.1] - 2026-01-02\n\n", "")).toBe(before["CHANGELOG.md"]);

    // The repository's own Prettier accepts every edited file.
    const prettier = spawnSync(
      join(repoRoot, "node_modules", ".bin", "prettier"),
      [
        "--config",
        join(root, ".prettierrc"),
        "--check",
        ...MANIFESTS.filter((rel) => rel.endsWith(".json")),
        "CHANGELOG.md",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(prettier.status, prettier.stdout + prettier.stderr).toBe(0);

    expect(result.stdout).toContain("4 files changed");
    expect(result.stdout).toContain(`+version = "${next}"`);
    expect(result.stdout).toContain("+## [0.9.1] - 2026-01-02");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "tag", "--list")).toBe("");

    // The bumped tree passes the shared version check.
    const checked = spawnSync(bun, [join(root, "scripts", "check-version.ts")], {
      cwd: root,
      encoding: "utf8",
    });
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stdout).toContain(`version ok: ${next}`);
  }, 60_000);

  it("refuses with exit 2 and an untouched tree: dirty, untracked, not greater, not semver, existing section, empty Unreleased", () => {
    const root = copy();
    withUnreleased(root);
    const current = currentVersion(root);
    const refusals: Array<[string, () => void, string[], string]> = [
      ["not semver", () => {}, ["1.2"], "is not a semver version"],
      ["same version", () => {}, [current], "is not greater than"],
      ["older version", () => {}, ["0.0.9"], "is not greater than"],
      ["prerelease below", () => {}, [`${current}-rc.1`], "is not greater than"],
      [
        "dirty tree",
        () =>
          writeFileSync(
            join(root, "README.md"),
            `${readFileSync(join(root, "README.md"), "utf8")}x\n`,
          ),
        ["9.0.0"],
        "working tree is not clean",
      ],
      [
        "untracked file",
        () => writeFileSync(join(root, "stray.txt"), "x\n"),
        ["9.0.0"],
        "working tree is not clean",
      ],
      [
        "existing section",
        () => {
          const path = join(root, "CHANGELOG.md");
          writeFileSync(path, `${readFileSync(path, "utf8")}\n## [9.0.0] - 2020-01-01\n\n- old\n`);
          git(root, "commit", "-q", "-am", "section");
        },
        ["9.0.0"],
        "already has a `## [9.0.0]` section",
      ],
      [
        "empty Unreleased",
        () => {
          const path = join(root, "CHANGELOG.md");
          const text = readFileSync(path, "utf8");
          const start = text.indexOf("## [Unreleased]");
          const next = text.indexOf("\n## [", start + 1);
          writeFileSync(path, `${text.slice(0, start)}## [Unreleased]\n${text.slice(next)}`);
          git(root, "commit", "-q", "-am", "released");
        },
        ["9.1.0"],
        "[Unreleased] has no entries",
      ],
      ["no version", () => {}, [], "Usage: bun run release:bump"],
      ["bad date", () => {}, ["9.2.0", "--date", "2026-1-2"], "--date must be YYYY-MM-DD"],
    ];
    for (const [label, arrange, args, message] of refusals) {
      git(root, "checkout", "-q", "--", ".");
      git(root, "clean", "-q", "-f");
      arrange();
      const before = snapshot(root);
      const status = git(root, "status", "--porcelain");
      const result = bump(root, ...args);
      expect(result.status, `${label}: ${result.stdout}${result.stderr}`).toBe(2);
      expect(result.stderr, label).toContain(message);
      expect(snapshot(root), label).toEqual(before);
      expect(git(root, "status", "--porcelain"), label).toBe(status);
    }
  }, 60_000);
});
