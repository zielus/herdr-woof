import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { distUrl, runNode } from "./helpers/process.js";

// Revision fingerprinting runs real git in child processes against temporary repositories.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RevisionOut {
  ok: boolean;
  revision?: { head: string | null; tree: string };
  root?: string;
  reason?: string;
  message?: string;
}

function git(repo: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Woof Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: repo, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function makeRepo(commit = true): string {
  const repo = mkdtempSync(join(tmpdir(), "woof-repo-"));
  dirs.push(repo);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "alpha\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
  if (commit) {
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
  }
  return repo;
}

function revision(repo: string): RevisionOut {
  const result = runNode(
    `const { revisionOf } = await import(${JSON.stringify(distUrl("scheduler/revision.js"))});
console.log(JSON.stringify(await revisionOf(process.argv[1])));`,
    [repo],
  );
  expect(result.status, result.stderr).toBe(0);
  return result.json as unknown as RevisionOut;
}

function treeOf(repo: string): string {
  const out = revision(repo);
  expect(out.ok, out.message).toBe(true);
  return out.revision?.tree as string;
}

describe("revisionOf", () => {
  it("is stable for an unchanged tree and names HEAD", () => {
    const repo = makeRepo();
    const first = revision(repo);
    expect(first).toMatchObject({
      ok: true,
      revision: { head: git(repo, "rev-parse", "HEAD").trim() },
    });
    expect(first.revision?.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(revision(repo)).toEqual(first);
    // A clean tree fingerprints to HEAD's own tree.
    expect(first.revision?.tree).toBe(git(repo, "rev-parse", "HEAD^{tree}").trim());
  });

  it("changes for a tracked edit and an untracked file, not for an ignored file", () => {
    const repo = makeRepo();
    const clean = treeOf(repo);
    writeFileSync(join(repo, "ignored.log"), "noise\n");
    expect(treeOf(repo)).toBe(clean);
    writeFileSync(join(repo, "a.txt"), "alpha changed\n");
    const edited = treeOf(repo);
    expect(edited).not.toBe(clean);
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "new.mjs"), "export {};\n");
    const untracked = treeOf(repo);
    expect(untracked).not.toBe(edited);
    writeFileSync(join(repo, "src", "new.mjs"), "export const x = 1;\n");
    expect(treeOf(repo)).not.toBe(untracked);
  });

  it("leaves the real index and git status untouched", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "alpha changed\n");
    writeFileSync(join(repo, "b.txt"), "untracked\n");
    const index = readFileSync(join(repo, ".git", "index"));
    const status = git(repo, "status", "--porcelain");
    treeOf(repo);
    expect(readFileSync(join(repo, ".git", "index")).equals(index)).toBe(true);
    expect(git(repo, "status", "--porcelain")).toBe(status);
    expect(status).toBe(" M a.txt\n?? b.txt\n");
  });

  it("treats a commit that keeps the tree as the same tree with a new HEAD", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "alpha changed\n");
    const before = revision(repo);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "change");
    const after = revision(repo);
    expect(after.revision?.tree).toBe(before.revision?.tree);
    expect(after.revision?.head).not.toBe(before.revision?.head);
  });

  it("reports head null in a repository without commits", () => {
    const repo = makeRepo(false);
    const out = revision(repo);
    expect(out).toMatchObject({ ok: true, revision: { head: null } });
    expect(out.revision?.tree).toMatch(/^[0-9a-f]{40}$/);
  });

  it("fingerprints the whole work tree from a nested directory, including sibling changes", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "inner.txt"), "inner\n");
    const nested = revision(join(repo, "src")) as RevisionOut & { root?: string };
    expect(nested.ok, nested.message).toBe(true);
    expect(nested.revision?.tree).toBe(treeOf(repo));
    expect(nested.root).toBe(revision(repo).root);
    // A change outside the nested directory still changes the nested fingerprint.
    writeFileSync(join(repo, "sibling.txt"), "outside src\n");
    expect(revision(join(repo, "src")).revision?.tree).not.toBe(nested.revision?.tree);
    expect(revision(join(repo, "src")).revision?.tree).toBe(treeOf(repo));
  });

  it("refuses a directory that is not a git work tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "woof-norepo-"));
    dirs.push(dir);
    expect(revision(dir)).toMatchObject({ ok: false, reason: "repo_invalid" });
    expect(revision(join(dir, "missing"))).toMatchObject({ ok: false, reason: "repo_invalid" });
  });
});
