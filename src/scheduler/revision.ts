import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Revision } from "../domain/types.js";

/**
 * Engine-owned repository fingerprint (D4): `head` is `HEAD` (null before the
 * first commit) and `tree` is the git tree id of every tracked and untracked,
 * non-ignored file of the whole work tree (computed from `--show-toplevel`,
 * whatever directory inside it is given), written from a temporary index seeded with HEAD. The real
 * index and the working tree are never modified; `git add` into the temporary
 * index does write unreferenced blob objects into the repository object store.
 */

export type RevisionResult =
  | {
      ok: true;
      revision: Revision;
      /** `git rev-parse --show-toplevel`: the work tree the fingerprint covers. */
      root: string;
    }
  | { ok: false; reason: "repo_invalid"; message: string };

const GIT_TIMEOUT_MS = 120_000;

export async function revisionOf(
  repo: string,
  options: { git?: string; signal?: AbortSignal } = {},
): Promise<RevisionResult> {
  const git = options.git ?? "git";
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"])
    Reflect.deleteProperty(env, key);

  const inside = await run(
    git,
    ["-C", repo, "rev-parse", "--is-inside-work-tree"],
    env,
    options.signal,
  );
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return invalid(
      `${repo} is not a git work tree: ${inside.ok ? inside.stdout.trim() : inside.message}`,
    );
  }
  // The fingerprint covers the whole work tree: every step runs from its top level.
  const top = await run(git, ["-C", repo, "rev-parse", "--show-toplevel"], env, options.signal);
  const root = top.ok ? top.stdout.trim() : "";
  if (!top.ok || root === "") {
    return invalid(`cannot resolve the top level of ${repo}: ${top.ok ? "empty" : top.message}`);
  }
  const headRead = await run(
    git,
    ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    env,
    options.signal,
  );
  const head = headRead.ok ? headRead.stdout.trim() : null;

  const scratch = mkdtempSync(join(tmpdir(), "woof-revision-"));
  try {
    const indexEnv = { ...env, GIT_INDEX_FILE: join(scratch, "index") };
    const steps: string[][] = [
      head === null ? ["read-tree", "--empty"] : ["read-tree", head],
      ["add", "--all", "--", "."],
      ["write-tree"],
    ];
    let tree = "";
    for (const step of steps) {
      // Each git step needs the previous one's index.
      // oxlint-disable-next-line no-await-in-loop
      const result = await run(git, ["-C", root, ...step], indexEnv, options.signal);
      if (!result.ok) return invalid(`git ${step[0]} failed in ${root}: ${result.message}`);
      tree = result.stdout.trim();
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree)) {
      return invalid(`git write-tree printed ${JSON.stringify(tree)} in ${repo}`);
    }
    if (head !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) {
      return invalid(`git rev-parse HEAD printed ${JSON.stringify(head)} in ${repo}`);
    }
    return { ok: true, revision: { head, tree }, root };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function invalid(message: string): RevisionResult {
  return { ok: false, reason: "repo_invalid", message };
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<{ ok: true; stdout: string } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        env,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        ...(signal !== undefined ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error === null) resolve({ ok: true, stdout });
        else resolve({ ok: false, message: (stderr.trim() || error.message).split("\n")[0] ?? "" });
      },
    );
  });
}
