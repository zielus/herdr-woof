// A throwaway copy of this repository for release-script process tests: the
// tracked and untracked-but-not-ignored files of the working tree, committed
// once in a fresh git repository with a throwaway identity. The copy shares
// the repository's node_modules through a symlink (excluded from git) and has
// minimal fake dist/ entry files, so `npm pack --dry-run` can list them.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { repoRoot } from "./process.js";

export const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/** Runs git in `cwd` with a throwaway identity and no global configuration; throws on failure. */
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Woof Release Test",
      "-c",
      "user.email=release-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      // `git commit` otherwise spawns a detached `git maintenance run --auto` that outlives the
      // call and writes under .git/ while a test removes the copy (ENOTEMPTY). maintenance.auto=false
      // prevents that subprocess directly; `gc.auto=0` did not on git 2.51.2 (git 2.55 consults
      // gc.auto only when maintenance.auto is unset).
      "-c",
      "maintenance.auto=false",
      ...args,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** Copies the repository into a new temporary directory and returns its path. */
export function copyRepository(prefix = "woof-release-"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const listed = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ...GIT_ENV },
    },
  );
  if (listed.status !== 0) throw new Error(`git ls-files: ${listed.stderr}`);
  for (const rel of listed.stdout.split("\0")) {
    if (rel === "") continue;
    const from = join(repoRoot, rel);
    // A tracked file deleted in the working tree is not part of the copy.
    if (!existsSync(from) || !lstatSync(from).isFile()) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    copyFileSync(from, join(root, rel));
  }
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"));
  git(root, "init", "-q");
  appendFileSync(join(root, ".git", "info", "exclude"), "node_modules\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "copy");
  mkdirSync(join(root, "dist"));
  for (const name of ["index.js", "cli.js", "testing.js"])
    writeFileSync(join(root, "dist", name), "export {};\n");
  return root;
}
