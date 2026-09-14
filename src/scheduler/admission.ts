import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import type { RejectionDetail } from "../contracts/envelope.js";
import { validateRunPlan } from "../domain/plan.js";
import type { AgentSpec, Revision, RunPlan } from "../domain/types.js";
import type { WorkflowDefinition } from "./definition.js";
import { launchArgs } from "./launch.js";
import { MAX_RUN_DIR_BYTES } from "./request.js";
import { revisionOf, type RevisionResult } from "./revision.js";

/**
 * Workflow admission (p3): everything checked before a run directory or pane
 * exists. Validates the caller input with the definition, requires the
 * repository to be a git work tree that neither contains nor lies inside the
 * run directory, resolves each agent's kind, model and launch arguments through
 * the kind table, and builds the run plan (agent stages, planned checks,
 * limits). Every definition callback is guarded: a throw or a malformed return
 * is a `definition_invalid` rejection, never an exception.
 */

export type AdmissionReason =
  | "input_invalid"
  | "repo_invalid"
  | "agent_kind_unsupported"
  | "plan_invalid"
  | "definition_invalid";

export type AdmissionResult<Input> =
  | { ok: true; input: Input; plan: RunPlan; repository: string; revision: Revision }
  | { ok: false; reason: AdmissionReason; message: string; details: RejectionDetail[] };

type Called<T> = { ok: true; value: T } | { ok: false; message: string };

export async function admitWorkflow<Input>(options: {
  definition: WorkflowDefinition<Input>;
  input: unknown;
  /** Absolute run directory; agents get write access to it. */
  runDir: string;
}): Promise<AdmissionResult<Input>> {
  const { definition } = options;
  // The run directory is used verbatim in launch arguments and requests: absolute and bounded.
  if (typeof options.runDir !== "string" || !isAbsolute(options.runDir)) {
    const message = `the run directory ${String(options.runDir)} must be an absolute path`;
    return reject("input_invalid", message, [{ field: "runDir", message }]);
  }
  if (Buffer.byteLength(options.runDir, "utf8") > MAX_RUN_DIR_BYTES) {
    const message = `the run directory path is longer than ${MAX_RUN_DIR_BYTES} bytes`;
    return reject("input_invalid", message, [{ field: "runDir", message }]);
  }
  const validated = call("validateInput", () => definition.validateInput(options.input));
  if (!validated.ok) return invalidDefinition("validateInput", validated.message);
  const verdict: unknown = validated.value;
  if (!isObject(verdict) || typeof verdict["ok"] !== "boolean") {
    return invalidDefinition("validateInput", "returned no { ok } result");
  }
  if (verdict["ok"] !== true) {
    const details = verdict["details"];
    if (
      !Array.isArray(details) ||
      !details.every(
        (detail) =>
          isObject(detail) &&
          typeof detail["field"] === "string" &&
          typeof detail["message"] === "string",
      )
    ) {
      return invalidDefinition(
        "validateInput",
        "returned ok: false without details of { field: string, message: string } entries",
      );
    }
    return reject(
      "input_invalid",
      "workflow input is invalid",
      (details as RejectionDetail[]).map(({ field, message }) => ({ field, message })),
    );
  }
  if (!("input" in verdict))
    return invalidDefinition("validateInput", "returned ok: true without input");
  const input = verdict["input"] as Input;

  const located = call("repository", () => definition.repository(input));
  if (!located.ok) return invalidDefinition("repository", located.message);
  const repository: unknown = located.value;
  if (typeof repository !== "string") {
    return invalidDefinition("repository", "returned a value that is not a path string");
  }
  if (!isAbsolute(repository)) {
    return reject("repo_invalid", "the repository must be an absolute path");
  }
  let revision: RevisionResult;
  try {
    revision = await revisionOf(repository);
  } catch (error) {
    // For example a path with a NUL byte, which git's argv refuses before spawning.
    return reject(
      "repo_invalid",
      `cannot inspect the repository ${JSON.stringify(repository)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!revision.ok) return reject("repo_invalid", revision.message);
  // The repository is the whole work tree: a directory inside it is refused, so
  // overlap checks and fingerprints always use the same top level.
  let sameRoot = false;
  try {
    sameRoot = realpathSync(repository) === realpathSync(revision.root);
  } catch {
    sameRoot = false;
  }
  if (!sameRoot) {
    const message = `the repository ${repository} is not the top level of its git work tree ${revision.root}`;
    return reject("repo_invalid", message, [{ field: "repository", message }]);
  }

  const overlap = runDirOverlap(repository, options.runDir);
  if (overlap !== undefined) {
    return reject("input_invalid", overlap, [{ field: "runDir", message: overlap }]);
  }

  const resolvedAgents = call("resolveAgents", () => definition.resolveAgents(input));
  if (!resolvedAgents.ok) return invalidDefinition("resolveAgents", resolvedAgents.message);
  const resolved: unknown = resolvedAgents.value;
  if (!isObject(resolved)) return invalidDefinition("resolveAgents", "returned no agent map");
  const agents: AgentSpec[] = [];
  for (const { agentId, role } of definition.agents) {
    const agent = Object.hasOwn(resolved, agentId) ? resolved[agentId] : undefined;
    if (agent === undefined) {
      return reject("plan_invalid", `no kind or model resolved for agent ${agentId}`, [
        { field: `agents.${agentId}`, message: "is not resolved" },
      ]);
    }
    if (!isAgentChoice(agent)) {
      return invalidDefinition(
        "resolveAgents",
        `agent ${agentId} is not { kind: string, model: string | null, args?: string[] }`,
      );
    }
    const launch = launchArgs({
      kind: agent.kind,
      model: agent.model,
      args: agent.args ?? [],
      runDir: options.runDir,
    });
    if (!launch.ok) {
      return reject(launch.reason, launch.message, [
        { field: `agents.${agentId}.kind`, message: launch.message },
      ]);
    }
    agents.push({ agentId, role, kind: agent.kind, model: agent.model, args: launch.args });
  }

  const limits = call("resolveLimits", () => definition.resolveLimits(input));
  if (!limits.ok) return invalidDefinition("resolveLimits", limits.message);
  if (!isObject(limits.value))
    return invalidDefinition("resolveLimits", "returned no limits object");
  const plan = {
    workflow: { name: definition.name, version: definition.version },
    agents,
    stages: definition.stages.flatMap((stage) =>
      stage.kind === "agent"
        ? [{ stageId: stage.stageId, agentId: stage.agentId, verdicts: [...stage.verdicts] }]
        : [],
    ),
    limits: limits.value,
    checks: definition.stages.flatMap((stage) => (stage.kind === "check" ? [stage.checkId] : [])),
  };
  const checked = validateRunPlan(plan);
  if (!checked.ok)
    return reject("plan_invalid", "the resolved run plan is invalid", checked.details);
  return { ok: true, input, plan: checked.plan, repository, revision: revision.revision };
}

/**
 * A run directory equal to, inside, or containing the repository would make
 * every journal and artifact write change the revision fingerprint (or put the
 * repository under agent-writable run files). Both paths are compared after
 * symlink resolution; a run directory that does not exist yet resolves through
 * its nearest existing ancestor.
 */
function runDirOverlap(repository: string, runDir: string): string | undefined {
  let repoReal: string;
  let runReal: string;
  try {
    repoReal = realpathSync(repository);
    runReal = canonical(runDir);
  } catch (error) {
    return `cannot resolve the run directory ${runDir}: ${(error as Error).message}`;
  }
  const names = `run directory ${runDir} (${runReal}) and repository ${repository} (${repoReal})`;
  if (runReal === repoReal) return `the ${names} are the same directory`;
  if (inside(runReal, repoReal))
    return `the ${names} overlap: the run directory is inside the repository`;
  if (inside(repoReal, runReal))
    return `the ${names} overlap: the repository is inside the run directory`;
  return undefined;
}

function canonical(path: string): string {
  const missing: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...missing);
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

function call<T>(name: string, fn: () => T): Called<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return {
      ok: false,
      message: `${name} threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentChoice(
  value: unknown,
): value is { kind: string; model: string | null; args?: string[] } {
  return (
    isObject(value) &&
    typeof value["kind"] === "string" &&
    (value["model"] === null || typeof value["model"] === "string") &&
    (value["args"] === undefined ||
      (Array.isArray(value["args"]) && value["args"].every((item) => typeof item === "string")))
  );
}

function invalidDefinition<Input>(callback: string, message: string): AdmissionResult<Input> {
  const text = `workflow definition ${callback}: ${message}`.slice(0, 2000);
  return reject("definition_invalid", text, [{ field: callback, message: text }]);
}

function reject<Input>(
  reason: AdmissionReason,
  message: string,
  details: RejectionDetail[] = [],
): AdmissionResult<Input> {
  return { ok: false, reason, message, details };
}
