import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { readJsonFile } from "../host/files.js";
import type { ReadRunStatusResult } from "../inspect/status.js";
import { builtInWorkflow } from "../workflows/catalog.js";
import { createRunRenderer, type RunRenderer } from "./render.js";
import { graphOf, type WorkflowGraph } from "./workflow-graph.js";

/**
 * The human view of one run directory, wired from the files a run leaves behind: `woof watch` and
 * the run host both build their renderer here, from the same `readRunStatus` read, the run's
 * `input.json` and `config.json`, so the two presentations agree by construction.
 */

/** How the human view presents the run's input and marks. */
export interface RunViewOptions {
  color: boolean;
  ascii: boolean;
  input: "summary" | "json";
  width: number;
}

export function rendererFor(
  runDir: string,
  read: Extract<ReadRunStatusResult, { ok: true }>,
  options: RunViewOptions,
): RunRenderer {
  const { snapshot, status } = read;
  const input =
    snapshot.input === null ? undefined : readJsonFile(join(runDir, snapshot.input.path));
  const config =
    snapshot.config === null ? undefined : readJsonFile(join(runDir, snapshot.config.path));
  return createRunRenderer({
    snapshot,
    status,
    input,
    repository: repositoryOf(config),
    graph: graphFor(snapshot, config, input),
    options: { ...options, home: homedir() },
  });
}

/** The repository the recorded configuration names, with its checked-out branch when readable. */
function repositoryOf(config: unknown): { path: string; branch: string | null } | null {
  if (!isObject(config) || typeof config["repository"] !== "string") return null;
  const path = config["repository"];
  return { path, branch: branchOf(path) };
}

/** The branch `<repo>/.git/HEAD` names (through a worktree's `gitdir:` pointer); null when detached or unreadable. */
function branchOf(repository: string): string | null {
  try {
    let gitDir = join(repository, ".git");
    const pointer = readFileSync(gitDir, "utf8");
    // A worktree's .git is a file naming the real directory; a repository's .git is a directory
    // and the read above throws EISDIR.
    const match = /^gitdir:\s*(.+)\s*$/m.exec(pointer);
    if (match === null) return null;
    const target = match[1]!.trim();
    gitDir = isAbsolute(target) ? target : resolve(dirname(gitDir), target);
    return headBranch(gitDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EISDIR") return null;
    return headBranch(join(repository, ".git"));
  }
}

function headBranch(gitDir: string): string | null {
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return match === null ? null : match[1]!;
  } catch {
    return null;
  }
}

/**
 * The stage graph of a built-in workflow, when the run's plan names one (the recorded
 * configuration says the workflow is built in, or is absent) and its stages agree with the plan.
 */
function graphFor(
  snapshot: Extract<ReadRunStatusResult, { ok: true }>["snapshot"],
  config: unknown,
  input: unknown,
): WorkflowGraph | null {
  if (snapshot.workflow === null) return null;
  if (isObject(config)) {
    const workflow = config["workflow"];
    if (isObject(workflow) && workflow["source"] !== "builtin") return null;
  }
  const definition = builtInWorkflow(snapshot.workflow.name);
  if (definition === undefined || definition.version !== snapshot.workflow.version) return null;
  return graphOf(definition, { stages: snapshot.stages, checks: snapshot.checks }, input);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
