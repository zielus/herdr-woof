import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { readJsonFile } from "../host/files.js";
import { createRunRenderer, type RunRenderer } from "../observe/render.js";
import type { WorkflowGraph } from "../observe/workflow-graph.js";
import type { WorkflowDefinition } from "../scheduler/definition.js";
import type { ReadRunStatusResult } from "./status.js";
import { graphOf } from "./workflow-graph.js";

/**
 * The human view of one run directory, wired from the files a run leaves behind: `woof watch` and
 * the run host both build their renderer here, from the same `readRunStatus` read, the run's
 * `input.json` and `config.json`, so the two presentations agree by construction. The renderer
 * itself (`src/observe/render.ts`) is pure; this module reads the files and derives the stage
 * graph, from a definition the caller resolves, since only the layers above may reach the
 * workflow catalog.
 */

/** How the human view presents the run's input and marks. */
export interface RunViewOptions {
  color: boolean;
  ascii: boolean;
  input: "summary" | "json";
  width: number;
}

/**
 * Resolves the definition of a run's recorded workflow: `name` and `version` from the plan,
 * `source` from the recorded configuration (null when the record is absent). Undefined when the
 * caller knows no definition to trust; the view then lists the plan's stages without routes.
 */
export type DefinitionResolver = (
  workflow: { name: string; version: string },
  source: string | null,
) => WorkflowDefinition<unknown> | undefined;

export function rendererFor(
  runDir: string,
  read: Extract<ReadRunStatusResult, { ok: true }>,
  options: RunViewOptions,
  definitionFor?: DefinitionResolver,
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
    graph: graphFor(snapshot, config, input, definitionFor),
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
 * The stage graph of the run's workflow, when the caller resolves a definition for the recorded
 * workflow (name, version and source) and its stages agree with the plan.
 */
function graphFor(
  snapshot: Extract<ReadRunStatusResult, { ok: true }>["snapshot"],
  config: unknown,
  input: unknown,
  definitionFor: DefinitionResolver | undefined,
): WorkflowGraph | null {
  if (snapshot.workflow === null || definitionFor === undefined) return null;
  const recorded = isObject(config) ? config["workflow"] : undefined;
  const source =
    isObject(recorded) && typeof recorded["source"] === "string" ? recorded["source"] : null;
  const definition = definitionFor(snapshot.workflow, source);
  if (definition === undefined) return null;
  return graphOf(definition, { stages: snapshot.stages, checks: snapshot.checks }, input);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
