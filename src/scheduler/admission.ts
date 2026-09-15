import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import type { RejectionDetail } from "../contracts/envelope.js";
import type { AdmissionReason } from "../contracts/reasons.js";
import { validateRunPlan } from "../domain/plan.js";
import {
  LIMIT_KEYS,
  type AgentSpec,
  type Limits,
  type Revision,
  type RunPlan,
} from "../domain/types.js";
import type { LockOptions } from "../journal/lock.js";
import { openRun } from "../state/store.js";
import type { WorkflowDefinition } from "./definition.js";
import { launchArgs } from "./launch.js";
import { MAX_RUN_DIR_BYTES } from "./request.js";
import { revisionOf, type RevisionResult } from "./revision.js";

/**
 * Workflow admission (p3, extended in p4): everything checked before a run
 * directory or pane exists. Validates the caller input with the definition,
 * requires the repository to be a git work tree that neither contains nor lies
 * inside the run directory (and, with configuration, to be the configured
 * project), resolves each agent's kind, model and launch arguments from the
 * input or the configured role, composes limits per key (input, configuration,
 * the definition's defaults), and builds the run plan. Every definition
 * callback is guarded: a throw or a malformed return is a `definition_invalid`
 * rejection, never an exception. Admission never reads configuration files:
 * the caller passes what it resolved.
 */

export type { AdmissionReason } from "../contracts/reasons.js";

export type AdmissionSourceName = "flag" | "input" | "project" | "user" | "builtin";

export interface AdmissionSource {
  source: AdmissionSourceName;
  /** File that supplied the value; null for input and built-in values. */
  path: string | null;
}

/** Resolved configuration as admission consumes it (structural; no file access). */
export interface AdmissionConfiguration {
  /**
   * The resolved project root. When the key is present the repository must be
   * this directory after symlink resolution (`project_mismatch`); null means
   * no project was resolved.
   */
  projectRoot?: string | null;
  /** Effective role per role name. */
  roles: Record<string, { kind: string; model: string | null; args: string[] } & AdmissionSource>;
  /** Limit values set by configuration layers above the definition's defaults. */
  limits: Partial<Record<keyof Limits, { value: number } & AdmissionSource>>;
  /** Directories that were searched for role files, named in `role_unresolved`. */
  roleDirs?: string[];
}

export interface AdmissionProvenance {
  agents: Record<
    string,
    { role: string; kind: string; model: string | null; args: string[] } & AdmissionSource
  >;
  limits: Partial<Record<keyof Limits, { value: number } & AdmissionSource>>;
}

export type AdmissionResult<Input> =
  | {
      ok: true;
      input: Input;
      plan: RunPlan;
      repository: string;
      revision: Revision;
      provenance: AdmissionProvenance;
    }
  | { ok: false; reason: AdmissionReason; message: string; details: RejectionDetail[] };

type Called<T> = { ok: true; value: T } | { ok: false; message: string };

export async function admitWorkflow<Input>(options: {
  definition: WorkflowDefinition<Input>;
  input: unknown;
  /** Absolute run directory; agents get write access to it. */
  runDir: string;
  configuration?: AdmissionConfiguration;
}): Promise<AdmissionResult<Input>> {
  const { definition, configuration } = options;
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

  // Configuration from one work tree is never applied to a run in another.
  if (configuration !== undefined && configuration.projectRoot !== undefined) {
    const projectRoot = configuration.projectRoot;
    if (projectRoot === null || realpathOrSelf(projectRoot) !== realpathOrSelf(repository)) {
      const project =
        projectRoot === null
          ? "no project (the project directory is not in a git work tree)"
          : `the project ${projectRoot}`;
      const message = `the run repository ${repository} is not the configured project: configuration was resolved for ${project}; pass --project ${repository}`;
      return reject("project_mismatch", message, [
        { field: "repository", message: repository },
        { field: "project", message: projectRoot ?? "null" },
      ]);
    }
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
  const provenance: AdmissionProvenance = { agents: {}, limits: {} };
  for (const { agentId, role } of definition.agents) {
    let agent: unknown = Object.hasOwn(resolved, agentId) ? resolved[agentId] : undefined;
    let source: AdmissionSource = { source: "input", path: null };
    if (agent === undefined) {
      const configured =
        configuration !== undefined && Object.hasOwn(configuration.roles, role)
          ? configuration.roles[role]
          : undefined;
      if (configured === undefined) {
        const searched = [
          `the workflow input (agent ${agentId})`,
          ...(configuration?.roleDirs ?? []).map((dir) => join(dir, `${role}.json`)),
          "built-in roles",
        ];
        const message = `no agent is resolved for ${agentId} (role ${role}); searched ${searched.join(", ")}`;
        return reject("role_unresolved", message, [{ field: `agents.${agentId}`, message }]);
      }
      source = { source: configured.source, path: configured.path };
      agent = { kind: configured.kind, model: configured.model, args: configured.args };
      if (!isAgentChoice(agent)) {
        const message = `role ${role} from ${describe(source)} is not { kind: string, model: string | null, args: string[] }`;
        return reject("role_invalid", message, [{ field: `roles.${role}`, message }]);
      }
    } else if (!isAgentChoice(agent)) {
      return invalidDefinition(
        "resolveAgents",
        `agent ${agentId} is not { kind: string, model: string | null, args?: string[] }`,
      );
    }
    const choice = agent as { kind: string; model: string | null; args?: string[] };
    const launch = launchArgs({
      kind: choice.kind,
      model: choice.model,
      args: choice.args ?? [],
      runDir: options.runDir,
    });
    if (!launch.ok) {
      const configured = source.source !== "input";
      const message = configured
        ? `${launch.message} (role ${role} from ${describe(source)})`
        : launch.message;
      return reject(launch.reason, message, [
        { field: configured ? `roles.${role}.kind` : `agents.${agentId}.kind`, message },
      ]);
    }
    agents.push({ agentId, role, kind: choice.kind, model: choice.model, args: launch.args });
    provenance.agents[agentId] = {
      role,
      kind: choice.kind,
      model: choice.model,
      args: [...(choice.args ?? [])],
      ...source,
    };
  }

  const limits = call("resolveLimits", () => definition.resolveLimits(input));
  if (!limits.ok) return invalidDefinition("resolveLimits", limits.message);
  if (!isObject(limits.value))
    return invalidDefinition("resolveLimits", "returned no limits object");
  const composed = composeLimits(limits.value, configuration, definition.limitDefaults, provenance);
  const plan = {
    workflow: { name: definition.name, version: definition.version },
    agents,
    stages: definition.stages.flatMap((stage) =>
      stage.kind === "agent"
        ? [{ stageId: stage.stageId, agentId: stage.agentId, verdicts: [...stage.verdicts] }]
        : [],
    ),
    limits: composed,
    checks: definition.stages.flatMap((stage) => (stage.kind === "check" ? [stage.checkId] : [])),
  };
  const checked = validateRunPlan(plan);
  if (!checked.ok) {
    const details = checked.details.map((detail) => {
      const key = /^limits\.([A-Za-z]+)$/.exec(detail.field)?.[1] as keyof Limits | undefined;
      const set = key === undefined ? undefined : provenance.limits[key];
      return set === undefined
        ? detail
        : { field: detail.field, message: `${detail.message} (set by ${describe(set)})` };
    });
    return reject("plan_invalid", "the resolved run plan is invalid", details);
  }
  return {
    ok: true,
    input,
    plan: checked.plan,
    repository,
    revision: revision.revision,
    provenance,
  };
}

/**
 * Per-key limits: the definition's `resolveLimits(input)` value, then the
 * configured value, then `limitDefaults`. A definition without defaults keeps
 * its p3 key order and configuration fills only the keys it lacks.
 */
function composeLimits(
  base: Record<string, unknown>,
  configuration: AdmissionConfiguration | undefined,
  defaults: Partial<Limits> | undefined,
  provenance: AdmissionProvenance,
): Record<string, unknown> {
  const order =
    defaults === undefined
      ? [...Object.keys(base), ...LIMIT_KEYS.filter((key) => !Object.hasOwn(base, key))]
      : [
          ...LIMIT_KEYS,
          ...Object.keys(base).filter((key) => !(LIMIT_KEYS as readonly string[]).includes(key)),
        ];
  const composed: Record<string, unknown> = {};
  for (const key of order) {
    const limitKey = key as keyof Limits;
    const known = (LIMIT_KEYS as readonly string[]).includes(key);
    if (Object.hasOwn(base, key) && base[key] !== undefined) {
      composed[key] = base[key];
      if (known && typeof base[key] === "number")
        provenance.limits[limitKey] = { value: base[key], source: "input", path: null };
      continue;
    }
    if (!known) continue;
    const configured =
      configuration !== undefined && Object.hasOwn(configuration.limits, key)
        ? configuration.limits[limitKey]
        : undefined;
    if (configured !== undefined) {
      composed[key] = configured.value;
      provenance.limits[limitKey] = {
        value: configured.value,
        source: configured.source,
        path: configured.path,
      };
      continue;
    }
    const fallback =
      defaults !== undefined && Object.hasOwn(defaults, key) ? defaults[limitKey] : undefined;
    if (fallback !== undefined) {
      composed[key] = fallback;
      provenance.limits[limitKey] = { value: fallback, source: "builtin", path: null };
    }
  }
  return composed;
}

function describe(source: AdmissionSource): string {
  return source.path === null ? source.source : `${source.source} ${source.path}`;
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
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

/**
 * Opens the run for an admitted workflow. The plan and the validated input the
 * scheduler runs with (`admitted.input`, never the caller's raw value) are what
 * the journal and `input.json` record.
 */
export function openAdmittedRun<Input>(
  admitted: Extract<AdmissionResult<Input>, { ok: true }>,
  options: { runDir: string; runId: string; lock?: LockOptions },
): ReturnType<typeof openRun> {
  return openRun({
    runDir: options.runDir,
    runId: options.runId,
    plan: admitted.plan,
    input: admitted.input,
    ...(options.lock !== undefined ? { lock: options.lock } : {}),
  });
}

function reject<Input>(
  reason: AdmissionReason,
  message: string,
  details: RejectionDetail[] = [],
): AdmissionResult<Input> {
  return { ok: false, reason, message, details };
}
