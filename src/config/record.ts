import { claudeTrustStatus } from "../runtime/claude/trust.js";
import type { AdmissionConfiguration, AdmissionProvenance } from "../scheduler/admission.js";
import type { WorkflowDefinition } from "../scheduler/definition.js";
import { buildReviewWorkflow } from "../workflows/build-review.js";
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
  return name === buildReviewWorkflow.name
    ? (buildReviewWorkflow as unknown as WorkflowDefinition<unknown>)
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
 * advisory Claude trust warning when a planned agent is `claude`.
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
    const value: RoleValue = { kind: agent.kind, model: agent.model, args: [...agent.args] };
    const role = configuration.roles[agent.role];
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
    if (!configuresPermissionBypass(agent.args)) continue;
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
  if (admitted.plan.agents.some((agent) => agent.kind === "claude")) {
    const trust = claudeTrustStatus(
      admitted.repository,
      options.homeDir !== undefined ? { homeDir: options.homeDir } : {},
    );
    if (trust.status === "untrusted") {
      warnings.push({
        code: "claude_trust_untrusted",
        message: `Claude Code has no accepted folder trust for ${trust.dir}: the operator must open claude there once and accept its trust question (Woof never answers it)`,
        path: trust.path,
      });
    } else if (trust.status === "unknown") {
      warnings.push({
        code: "claude_trust_unknown",
        message: `Claude Code folder trust for ${trust.dir} could not be read from ${trust.path}; an untrusted folder blocks the agent at startup`,
        path: trust.path,
      });
    }
  }
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
