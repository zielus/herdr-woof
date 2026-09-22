import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

type Revision = { head: string | null; tree: string };
type Check = {
  kind: "check";
  checkId: string;
  command(
    input: unknown,
    ctx?: { subject: unknown; start: Revision | null },
  ): { argv: string[]; timeoutMs: number };
};

let changed: Check;
const dirs: string[] = [];

beforeAll(async () => {
  const { planWorkflow } = await loadDist<{ planWorkflow: { stages: Array<{ kind: string }> } }>(
    "workflows/plan.js",
  );
  changed = planWorkflow.stages.find(
    (stage) => stage.kind === "check" && (stage as Check).checkId === "changed",
  ) as Check;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): { dir: string; git: (...args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "woof-plan-publish-"));
  dirs.push(dir);
  const git = (...args: string[]) => {
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
      { cwd: dir, encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "-q");
  return { dir, git };
}

function commit(dir: string, git: (...args: string[]) => string, text: string, message: string) {
  writeFileSync(join(dir, "plan.md"), text);
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

function passes(dir: string, start: Revision): boolean {
  const { argv } = changed.command({ publish: { path: "plan.md" } }, { subject: {}, start });
  const [cmd, ...args] = argv as [string, ...string[]];
  return spawnSync(cmd, args, { cwd: dir }).status === 0;
}

describe("plan publish check `changed`", () => {
  it("fails when no commit since the start touches the path, even with HEAD moved", () => {
    const { dir, git } = repo();
    commit(dir, git, "# plan\n", "plan");
    const start = { head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
    expect(passes(dir, start)).toBe(false);
    git("commit", "-q", "--allow-empty", "-m", "unrelated");
    expect(passes(dir, start)).toBe(false);
  });

  it("passes when the run committed the path and a later commit restored the start bytes", () => {
    const { dir, git } = repo();
    commit(dir, git, "# plan\n", "plan");
    const start = { head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
    commit(dir, git, "# another plan\n", "visit 1");
    commit(dir, git, "# plan\n", "visit 2");
    expect(passes(dir, start)).toBe(true);
  });

  it("passes on a run started on an unborn branch once the path is committed", () => {
    const { dir, git } = repo();
    const start = { head: null, tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" };
    commit(dir, git, "# plan\n", "plan");
    expect(passes(dir, start)).toBe(true);
  });
});
