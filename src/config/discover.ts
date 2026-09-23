import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { ConfigFailure } from "./schema.js";

/**
 * Configuration roots (D4). The project root is the git top level of the
 * project directory (worktrees resolve their own `.git` file); only
 * `<root>/.woof` is read. A `.woof` between the start directory and the root
 * is ignored with a warning. A project `.woof` that is the user's `~/.woof` is
 * read once, as user scope.
 */

export interface ConfigWarning {
  code:
    | "nested_config_ignored"
    | "permission_bypass_configured"
    | "role_kind_unsupported"
    // An agent kind's advisory folder-trust pre-flight, e.g. claude_trust_untrusted.
    | `${string}_trust_untrusted`
    | `${string}_trust_unknown`;
  message: string;
  path?: string;
}

export interface ConfigRoots {
  project: { root: string; dir: string; sameAsUser: boolean } | null;
  user: { dir: string } | null;
}

export interface DiscoverOptions {
  /** Default process.cwd(); null disables the project scope. */
  projectDir?: string | null;
  /** Default os.homedir(); null disables the user scope. */
  homeDir?: string | null;
  git?: string;
}

const GIT_TIMEOUT_MS = 30_000;

export async function discoverRoots(
  options: DiscoverOptions = {},
): Promise<{ ok: true; roots: ConfigRoots; warnings: ConfigWarning[] } | ConfigFailure> {
  const warnings: ConfigWarning[] = [];
  const home = options.homeDir === undefined ? homedir() : options.homeDir;
  const user = home === null || home === "" ? null : { dir: join(resolve(home), ".woof") };
  const start = options.projectDir === undefined ? process.cwd() : options.projectDir;
  if (start === null) return { ok: true, roots: { project: null, user }, warnings };

  const startDir = resolve(start);
  try {
    if (!statSync(startDir).isDirectory()) return notADirectory(startDir);
  } catch {
    return notADirectory(startDir);
  }
  const top = await gitTopLevel(startDir, options.git ?? "git");
  if (top === undefined) return { ok: true, roots: { project: null, user }, warnings };

  const root = safeRealpath(top) ?? top;
  const dir = join(root, ".woof");
  for (let current = safeRealpath(startDir) ?? startDir; current !== root;) {
    const nested = join(current, ".woof");
    if (isDirectory(nested)) {
      warnings.push({
        code: "nested_config_ignored",
        message: `${nested} is ignored: only ${dir} is read for the project at ${root}`,
        path: nested,
      });
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const sameAsUser =
    user !== null &&
    ((safeRealpath(dir) !== undefined && safeRealpath(dir) === safeRealpath(user.dir)) ||
      (home !== null && safeRealpath(root) === safeRealpath(resolve(home))));
  return { ok: true, roots: { project: { root, dir, sameAsUser }, user }, warnings };
}

function notADirectory(path: string): ConfigFailure {
  const message = `the project directory ${path} is not a directory`;
  return {
    ok: false,
    reason: "config_invalid",
    message,
    details: [{ field: "project", message, path }],
  };
}

/** `git rev-parse --show-toplevel` for `dir`, or undefined outside a work tree (or on any failure). */
export function gitTopLevel(dir: string, git = "git"): Promise<string | undefined> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"])
    Reflect.deleteProperty(env, key);
  return new Promise((done) => {
    execFile(
      git,
      ["-C", dir, "rev-parse", "--show-toplevel"],
      { env, timeout: GIT_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout) => {
        const top = stdout.trim();
        done(error === null && top !== "" ? top : undefined);
      },
    );
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}
