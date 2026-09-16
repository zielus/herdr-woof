import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { SUPPORTED_AGENT_KINDS } from "../scheduler/launch.js";
import { BUILT_IN_WORKFLOWS } from "../workflows/catalog.js";
import { discoverRoots, type ConfigWarning, type DiscoverOptions } from "./discover.js";
import { loadScope, type ScopeContent } from "./read.js";
import {
  CONFIG_LIMIT_KEYS,
  configuresPermissionBypass,
  type ConfigFailure,
  type ConfigScope,
  type ConfigSource,
  type LimitKey,
  type RoleValue,
} from "./schema.js";

/**
 * Configuration resolution (p4 D5): project → user → built-in, with flags
 * above all and the per-run input override applied at admission. Named
 * definitions (roles, workflows) are replaced whole; settings follow a
 * declared per-field table. Every effective value carries its source, the file
 * that supplied it and the values it shadowed.
 */

export interface Provenance<T> {
  value: T;
  source: ConfigSource;
  /** File that supplied the value; null for flag, input and built-in values. */
  path: string | null;
  sha256: string | null;
  shadowed: Array<{ source: ConfigSource; path: string | null; value: T }>;
}

export interface ConfigFlags {
  workflow?: string;
  pollMs?: number;
  keepPanes?: boolean;
  hostStartTimeoutMs?: number;
  runsDir?: string;
}

export interface ResolvedConfiguration {
  schemaVersion: 1;
  kind: "woof.config.resolved";
  resolvedAt: string;
  roots: {
    project: { root: string; dir: string; exists: boolean } | null;
    user: { dir: string; exists: boolean } | null;
  };
  files: Array<{ scope: ConfigScope; path: string; sha256: string; bytes: number }>;
  workflow: Provenance<{ name: string; version: string | null }> | null;
  roles: Record<string, Provenance<RoleValue>>;
  /** Per plan agent, filled at admission; empty in `config show`. */
  agents: Record<string, { role: string } & Provenance<RoleValue>>;
  settings: {
    workflow: Provenance<string>;
    /** Keys set by configuration or the built-in definition; input values are added at admission. */
    limits: Partial<Record<LimitKey, Provenance<number>>>;
    pollMs: Provenance<number>;
    keepPanes: Provenance<boolean>;
    hostStartTimeoutMs: Provenance<number>;
    runsDir: Provenance<string>;
  };
  /** The admitted repository; null in `config show`. */
  repository: string | null;
  warnings: ConfigWarning[];
}

export interface BuiltinCatalog {
  workflows: Record<string, { version: string; limitDefaults?: Partial<Record<LimitKey, number>> }>;
  roles: Record<string, RoleValue>;
}

export type ResolveConfigurationResult =
  | { ok: true; configuration: ResolvedConfiguration }
  | (ConfigFailure & { configuration?: ResolvedConfiguration });

export const DEFAULT_WORKFLOW = "build-review";
export const DEFAULT_POLL_MS = 1000;
export const DEFAULT_HOST_START_TIMEOUT_MS = 30_000;

/** Built-in roles: claude with no model and no arguments; the engine never adds a permission flag. */
export function builtinCatalog(): BuiltinCatalog {
  // Workflow names are user-controlled ids too: no prototype for `constructor` to come from.
  // Every entry comes from the built-in catalog (p5 D2); nothing here names a workflow.
  const workflows = Object.create(null) as BuiltinCatalog["workflows"];
  for (const definition of Object.values(BUILT_IN_WORKFLOWS)) {
    workflows[definition.name] = {
      version: definition.version,
      ...(definition.limitDefaults !== undefined
        ? { limitDefaults: { ...definition.limitDefaults } }
        : {}),
    };
  }
  return {
    workflows,
    // Role names are user-controlled ids: the dictionary has no prototype to inherit `constructor` from.
    roles: Object.assign(Object.create(null) as BuiltinCatalog["roles"], {
      builder: { kind: "claude", model: null, args: [] },
      planner: { kind: "claude", model: null, args: [] },
      reviewer: { kind: "claude", model: null, args: [] },
    }),
  };
}

export interface ComposeInput {
  roots: {
    project: { root: string; dir: string; exists: boolean } | null;
    user: { dir: string; exists: boolean } | null;
  };
  /** Null when there is no project scope, or when it is the user scope. */
  project: ScopeContent | null;
  user: ScopeContent | null;
  flags: ConfigFlags;
  builtin: BuiltinCatalog;
  /** Default run store (`~/.woof/runs`). */
  defaultRunsDir: string;
  warnings: ConfigWarning[];
  resolvedAt: string;
  supportedKinds?: readonly string[];
}

interface Layer<T> {
  source: ConfigSource;
  path: string | null;
  sha256: string | null;
  value: T;
}

function flagLayer<T>(value: T | undefined): Layer<T>[] {
  return value === undefined ? [] : [{ source: "flag", path: null, sha256: null, value }];
}

function builtinLayer<T>(value: T): Layer<T> {
  return { source: "builtin", path: null, sha256: null, value };
}

/** Composes scopes into a resolved configuration (pure). */
export function composeConfiguration(input: ComposeInput): ResolveConfigurationResult {
  const scopes = [input.project, input.user].filter(
    (scope): scope is ScopeContent => scope !== null,
  );
  const settingsLayer = <T>(
    pick: (defaults: NonNullable<ScopeContent["settings"]>["defaults"]) => T | undefined,
  ): Layer<T>[] =>
    scopes.flatMap((scope) => {
      const value = scope.settings === null ? undefined : pick(scope.settings.defaults);
      return value === undefined || scope.settings === null
        ? []
        : [
            {
              source: scope.scope,
              path: scope.settings.path,
              sha256: scope.settings.sha256,
              value,
            },
          ];
    });

  const warnings = [...input.warnings];
  const roles: Record<string, Provenance<RoleValue>> = {};
  const roleNames = new Set([
    ...scopes.flatMap((scope) => Object.keys(scope.roles)),
    ...Object.keys(input.builtin.roles),
  ]);
  const supported = input.supportedKinds ?? SUPPORTED_AGENT_KINDS;
  for (const name of [...roleNames].toSorted()) {
    const layers: Layer<RoleValue>[] = scopes.flatMap((scope) => {
      const entry = Object.hasOwn(scope.roles, name) ? scope.roles[name] : undefined;
      return entry === undefined
        ? []
        : [
            {
              source: scope.scope,
              path: entry.path,
              sha256: entry.sha256,
              value: roleValue(entry.role),
            },
          ];
    });
    // Only an own entry is a built-in role; an inherited key such as `constructor` is none.
    const builtin = Object.hasOwn(input.builtin.roles, name)
      ? input.builtin.roles[name]
      : undefined;
    if (builtin !== undefined) layers.push(builtinLayer(roleValue(builtin)));
    const resolved = provenance(layers) as Provenance<RoleValue>;
    roles[name] = resolved;
    if (!supported.includes(resolved.value.kind)) {
      warnings.push({
        code: "role_kind_unsupported",
        message: `role ${name} uses kind ${JSON.stringify(resolved.value.kind)}, which is not supported (supported: ${supported.join(", ")}); a run that uses it is rejected`,
        ...(resolved.path !== null ? { path: resolved.path } : {}),
      });
    }
    if (configuresPermissionBypass(resolved.value.args)) {
      warnings.push({
        code: "permission_bypass_configured",
        message: `role ${name} configures a permission bypass in its args; Woof never adds one`,
        ...(resolved.path !== null ? { path: resolved.path } : {}),
      });
    }
  }

  const workflowName = provenance([
    ...flagLayer(input.flags.workflow),
    ...settingsLayer((defaults) => defaults.workflow),
    builtinLayer(DEFAULT_WORKFLOW),
  ]) as Provenance<string>;
  const home = input.defaultRunsDir;
  const settingsBase = {
    workflow: workflowName,
    pollMs: provenance([
      ...flagLayer(input.flags.pollMs),
      ...settingsLayer((defaults) => defaults.pollMs),
      builtinLayer(DEFAULT_POLL_MS),
    ]) as Provenance<number>,
    keepPanes: provenance([
      ...flagLayer(input.flags.keepPanes),
      ...settingsLayer((defaults) => defaults.keepPanes),
      builtinLayer(false),
    ]) as Provenance<boolean>,
    hostStartTimeoutMs: provenance([
      ...flagLayer(input.flags.hostStartTimeoutMs),
      ...settingsLayer((defaults) => defaults.hostStartTimeoutMs),
      builtinLayer(DEFAULT_HOST_START_TIMEOUT_MS),
    ]) as Provenance<number>,
    // A project-scope runsDir never reaches this point (setting_scope_invalid).
    runsDir: provenance([
      ...flagLayer(input.flags.runsDir),
      ...settingsLayer((defaults) => defaults.runsDir),
      builtinLayer(home),
    ]) as Provenance<string>,
  };

  const name = workflowName.value;
  const workflowLayers: Layer<{ name: string; version: string | null }>[] = scopes.flatMap(
    (scope) => {
      const entry = Object.hasOwn(scope.workflows, name) ? scope.workflows[name] : undefined;
      return entry === undefined
        ? []
        : [
            {
              source: scope.scope,
              path: entry.path,
              sha256: entry.sha256,
              value: { name, version: null },
            },
          ];
    },
  );
  // Only an own entry is a built-in workflow; `constructor` is workflow_not_found, not a broken built-in.
  const builtinWorkflow = Object.hasOwn(input.builtin.workflows, name)
    ? input.builtin.workflows[name]
    : undefined;
  if (builtinWorkflow !== undefined)
    workflowLayers.push(builtinLayer({ name, version: builtinWorkflow.version }));
  const workflow =
    workflowLayers.length === 0
      ? null
      : (provenance(workflowLayers) as Provenance<{ name: string; version: string | null }>);

  const limits: Partial<Record<LimitKey, Provenance<number>>> = {};
  for (const key of CONFIG_LIMIT_KEYS) {
    const layers = settingsLayer((defaults) => defaults.limits?.[key]);
    const fallback =
      workflow?.source === "builtin" ? builtinWorkflow?.limitDefaults?.[key] : undefined;
    if (fallback !== undefined) layers.push(builtinLayer(fallback));
    if (layers.length > 0) limits[key] = provenance(layers) as Provenance<number>;
  }

  const files: ResolvedConfiguration["files"] = [];
  for (const scope of scopes) {
    const refs = [
      ...(scope.settings === null ? [] : [scope.settings]),
      ...Object.values(scope.roles),
      ...Object.values(scope.workflows),
    ];
    for (const ref of refs.toSorted((a, b) => a.path.localeCompare(b.path)))
      files.push({ scope: scope.scope, path: ref.path, sha256: ref.sha256, bytes: ref.bytes });
  }

  const configuration: ResolvedConfiguration = {
    schemaVersion: 1,
    kind: "woof.config.resolved",
    resolvedAt: input.resolvedAt,
    roots: input.roots,
    files,
    workflow,
    roles,
    agents: {},
    settings: { ...settingsBase, limits },
    repository: null,
    warnings,
  };
  if (workflow === null) {
    const searched = [
      ...scopes.map((scope) => join(scope.dir, "workflows", `${name}.{mjs,js,ts}`)),
      `built-in: ${Object.keys(input.builtin.workflows).join(", ")}`,
    ];
    return {
      ok: false,
      reason: "workflow_not_found",
      message: `workflow ${name} is not defined (searched ${searched.join("; ")})`,
      details: [
        {
          field: "workflow",
          message: `${name} (set by ${describeSource(workflowName)}) is not defined`,
        },
      ],
      configuration,
    };
  }
  return { ok: true, configuration };
}

/**
 * Discovers the roots, reads every applicable scope and composes them. A
 * malformed or unreadable file in any applicable scope fails resolution even
 * when nothing uses it.
 */
export async function resolveConfiguration(
  options: DiscoverOptions & {
    flags?: ConfigFlags;
    now?: () => Date;
    builtin?: BuiltinCatalog;
  } = {},
): Promise<ResolveConfigurationResult> {
  const discovered = await discoverRoots(options);
  if (!discovered.ok) return discovered;
  const { roots } = discovered;
  const user = roots.user === null ? null : loadScope(roots.user.dir, "user");
  if (user !== null && !user.ok) return user;
  const project =
    roots.project === null || roots.project.sameAsUser
      ? null
      : loadScope(roots.project.dir, "project");
  if (project !== null && !project.ok) return project;
  const home = options.homeDir === undefined ? homedir() : options.homeDir;
  return composeConfiguration({
    roots: {
      project:
        roots.project === null
          ? null
          : {
              root: roots.project.root,
              dir: roots.project.dir,
              exists: roots.project.sameAsUser
                ? (user?.content.exists ?? false)
                : (project?.content.exists ?? false),
            },
      user:
        roots.user === null ? null : { dir: roots.user.dir, exists: user?.content.exists ?? false },
    },
    project: project === null ? null : project.content,
    user: user === null ? null : user.content,
    flags: options.flags ?? {},
    builtin: options.builtin ?? builtinCatalog(),
    defaultRunsDir: join(resolve(home ?? "/"), ".woof", "runs"),
    warnings: discovered.warnings,
    resolvedAt: (options.now?.() ?? new Date()).toISOString(),
  });
}

/** `project /abs/.woof/roles/builder.json`, `flag`, `builtin`. */
export function describeSource(value: { source: ConfigSource; path: string | null }): string {
  return value.path === null ? value.source : `${value.source} ${value.path}`;
}

function roleValue(role: RoleValue): RoleValue {
  return { kind: role.kind, model: role.model, args: [...role.args] };
}

function provenance<T>(layers: Layer<T>[]): Provenance<T> | null {
  const [winner, ...rest] = layers;
  if (winner === undefined) return null;
  return {
    value: winner.value,
    source: winner.source,
    path: winner.path,
    sha256: winner.sha256,
    shadowed: rest.map(({ source, path, value }) => ({ source, path, value })),
  };
}
