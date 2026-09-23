import { trustWarnings } from "../scheduler/launch.js";
import type { AdmissionConfiguration, AdmissionProvenance } from "../scheduler/admission.js";
import type { WorkflowDefinition } from "../scheduler/definition.js";
import { builtInWorkflow } from "../workflows/catalog.js";
import type { ConfigWarning } from "./discover.js";
import type { Provenance, ResolvedConfiguration } from "./resolve.js";
import { configuresPermissionBypass, type LimitKey, type RoleValue } from "./schema.js";

/**
 * Bridges resolved configuration and admission (p4 §3.5): what admission
 * consumes, and the configuration recorded with the run once admission has
 * resolved agents, per-key limits and the repository.
 */

/** The compiled built-in workflow definition of that name, if any. */
export function builtinWorkflowDefinition(name: string): WorkflowDefinition<unknown> | undefined {
  return builtInWorkflow(name);
}

/**
 * The definition behind a run's recorded workflow, for readers of the record (the human run
 * view's stage map): the built-in one, only when the recorded `workflow.source` says the run used
 * it (or no record exists) and the compiled version is the recorded version — a project's own
 * module is never re-loaded to read a run, and a view never draws routes the run did not follow.
 */
export function recordedWorkflowDefinition(
  workflow: { name: string; version: string },
  source: string | null,
): WorkflowDefinition<unknown> | undefined {
  if (source !== null && source !== "builtin") return undefined;
  const definition = builtInWorkflow(workflow.name);
  return definition !== undefined && definition.version === workflow.version
    ? definition
    : undefined;
}

export function admissionConfiguration(
  configuration: ResolvedConfiguration,
): AdmissionConfiguration {
  const roles: AdmissionConfiguration["roles"] = {};
  for (const [name, role] of Object.entries(configuration.roles)) {
    roles[name] = {
      kind: role.value.kind,
      model: role.value.model,
      ...(role.value.provider !== undefined ? { provider: role.value.provider } : {}),
      args: [...role.value.args],
      source: role.source,
      path: role.path,
    };
  }
  const limits: AdmissionConfiguration["limits"] = {};
  for (const [key, limit] of Object.entries(configuration.settings.limits)) {
    // Built-in values are the definition's own defaults; admission applies them itself.
    if (limit === undefined || limit.source === "builtin") continue;
    limits[key as LimitKey] = { value: limit.value, source: limit.source, path: limit.path };
  }
  const roleDirs = new Set<string>();
  if (configuration.roots.project !== null)
    roleDirs.add(`${configuration.roots.project.dir}/roles`);
  if (configuration.roots.user !== null) roleDirs.add(`${configuration.roots.user.dir}/roles`);
  return {
    projectRoot: configuration.roots.project?.root ?? null,
    roles,
    limits,
    roleDirs: [...roleDirs],
  };
}

/**
 * The configuration recorded in `config.json`: agents with their sources (an
 * input override shadows the configured role), limits including input
 * overrides, the admitted repository, the loaded definition's version, and the
 * advisory folder-trust warning of each planned kind whose spec can read one.
 */
export function recordConfiguration(
  configuration: ResolvedConfiguration,
  admitted: {
    provenance: AdmissionProvenance;
    repository: string;
    plan: { agents: Array<{ kind: string }> };
  },
  options: { definitionVersion?: string; homeDir?: string } = {},
): ResolvedConfiguration {
  const agents: ResolvedConfiguration["agents"] = {};
  for (const [agentId, agent] of Object.entries(admitted.provenance.agents)) {
    const value: RoleValue = {
      kind: agent.kind,
      model: agent.model,
      ...(agent.provider !== undefined ? { provider: agent.provider } : {}),
      args: [...agent.args],
    };
    // Own entries only: an unconfigured role named `constructor` must not find Object.prototype's.
    const role = Object.hasOwn(configuration.roles, agent.role)
      ? configuration.roles[agent.role]
      : undefined;
    agents[agentId] =
      agent.source === "input"
        ? {
            role: agent.role,
            value,
            source: "input",
            path: null,
            sha256: null,
            shadowed: role === undefined ? [] : [layer(role), ...role.shadowed],
          }
        : {
            role: agent.role,
            value,
            source: agent.source,
            path: agent.path,
            sha256: role?.sha256 ?? null,
            shadowed: role?.shadowed ?? [],
          };
  }
  const limits: ResolvedConfiguration["settings"]["limits"] = { ...configuration.settings.limits };
  for (const [key, limit] of Object.entries(admitted.provenance.limits)) {
    if (limit === undefined) continue;
    const existing = configuration.settings.limits[key as LimitKey];
    if (limit.source === "input") {
      limits[key as LimitKey] = {
        value: limit.value,
        source: "input",
        path: null,
        sha256: null,
        shadowed: existing === undefined ? [] : [layer(existing), ...existing.shadowed],
      };
    } else if (existing === undefined) {
      limits[key as LimitKey] = {
        value: limit.value,
        source: limit.source,
        path: limit.path,
        sha256: null,
        shadowed: [],
      };
    }
  }
  // A run reports a bypass only for the agents that actually run: a role's own warning is dropped
  // (the role may be unused, or replaced by an input agent), and each role file is reported once.
  const warnings: ConfigWarning[] = configuration.warnings.filter(
    (warning) => warning.code !== "permission_bypass_configured",
  );
  const reported = new Set<string>();
  for (const [agentId, agent] of Object.entries(admitted.provenance.agents)) {
    if (!configuresPermissionBypass(agent.kind, agent.args)) continue;
    const path = agent.source === "input" ? null : agent.path;
    if (path !== null) {
      if (reported.has(path)) continue;
      reported.add(path);
    }
    const setBy =
      agent.source === "input"
        ? "the workflow input"
        : `${agent.source} ${path ?? "configuration"}`;
    warnings.push({
      code: "permission_bypass_configured",
      message: `agent ${agentId} (role ${agent.role}) configures a permission bypass in its args, set by ${setBy}; Woof never adds one`,
      ...(path !== null ? { path } : {}),
    });
  }
  // Each admitted kind whose spec can read its own folder-trust state adds an advisory warning.
  warnings.push(
    ...trustWarnings(
      admitted.plan.agents.map((agent) => agent.kind),
      admitted.repository,
      options.homeDir !== undefined ? { homeDir: options.homeDir } : {},
    ),
  );
  const workflow =
    configuration.workflow === null
      ? null
      : {
          ...configuration.workflow,
          value: {
            name: configuration.workflow.value.name,
            version: options.definitionVersion ?? configuration.workflow.value.version,
          },
        };
  return {
    ...configuration,
    workflow,
    agents,
    settings: { ...configuration.settings, limits },
    repository: admitted.repository,
    warnings,
  };
}

function layer<T>(value: Provenance<T>): Provenance<T>["shadowed"][number] {
  return { source: value.source, path: value.path, value: value.value };
}
