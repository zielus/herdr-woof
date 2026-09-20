import { isId, isPlainObject } from "../contracts/envelope.js";
import { engineOwnedArgIndexes, engineOwnedFlags } from "../scheduler/launch.js";
import {
  COUNT_LIMIT_KEYS,
  DURATION_LIMIT_KEYS,
  MAX_COUNT_LIMIT,
  MAX_DURATION_LIMIT_MS,
  OPTIONAL_COUNT_LIMIT_KEYS,
  type Limits,
} from "../domain/types.js";

/**
 * Configuration file schemas (p4, unstable until v1). Every file is a JSON
 * object with `schemaVersion: 1`; unknown keys are refused. Validation is pure
 * and reports the file path plus a JSON pointer for each problem.
 */

export type ConfigScope = "project" | "user";
export type ConfigSource = "flag" | "input" | ConfigScope | "builtin";

export type ConfigReason =
  | "config_invalid"
  | "config_conflict"
  | "setting_scope_invalid"
  | "role_invalid"
  | "workflow_not_found";

export interface ConfigDetail {
  field: string;
  message: string;
  path?: string;
  pointer?: string;
}

export interface ConfigFailure {
  ok: false;
  reason: ConfigReason;
  message: string;
  details: ConfigDetail[];
}

export type LimitKey = keyof Limits;

export interface SettingsDefaults {
  workflow?: string;
  limits?: Partial<Record<LimitKey, number>>;
  pollMs?: number;
  keepPanes?: boolean;
  hostStartTimeoutMs?: number;
  runsDir?: string;
}

export interface RoleValue {
  kind: string;
  model: string | null;
  args: string[];
}

export interface RoleFile extends RoleValue {
  description?: string;
}

/** Largest settings or role file read, in bytes. */
export const MAX_CONFIG_FILE_BYTES = 64 * 1024;
export const MIN_HOST_START_TIMEOUT_MS = 1000;
export const MAX_HOST_START_TIMEOUT_MS = 600_000;
export const MAX_POLL_MS = 3_600_000;
const MAX_DESCRIPTION = 500;

const BYPASS_FLAGS: ReadonlySet<string> = new Set([
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
]);

const SETTINGS_KEYS = ["schemaVersion", "defaults"];
const DEFAULTS_KEYS = [
  "workflow",
  "limits",
  "pollMs",
  "keepPanes",
  "hostStartTimeoutMs",
  "runsDir",
];
const ROLE_KEYS = ["schemaVersion", "kind", "model", "args", "description"];
export const CONFIG_LIMIT_KEYS: readonly LimitKey[] = [
  ...COUNT_LIMIT_KEYS,
  ...OPTIONAL_COUNT_LIMIT_KEYS,
  ...DURATION_LIMIT_KEYS,
];

export function limitBounds(key: LimitKey): [number, number] {
  if ((OPTIONAL_COUNT_LIMIT_KEYS as readonly string[]).includes(key)) return [0, MAX_COUNT_LIMIT];
  if ((DURATION_LIMIT_KEYS as readonly string[]).includes(key)) return [1, MAX_DURATION_LIMIT_MS];
  return [1, MAX_COUNT_LIMIT];
}

export function validateSettingsFile(
  value: unknown,
  file: { path: string; scope: ConfigScope },
): { ok: true; defaults: SettingsDefaults } | ConfigFailure {
  const details: ConfigDetail[] = [];
  const fail = (pointer: string, message: string) =>
    details.push({ field: `${file.path}#${pointer}`, message, path: file.path, pointer });
  if (!isPlainObject(value)) {
    fail("", "must be a JSON object");
    return invalid(file.path, details);
  }
  unknownKeys(value, SETTINGS_KEYS, "", fail);
  if (value["schemaVersion"] !== 1) fail("/schemaVersion", "must be 1");
  const defaults: SettingsDefaults = {};
  const raw = value["defaults"];
  if (raw !== undefined) {
    if (!isPlainObject(raw)) {
      fail("/defaults", "must be an object");
    } else {
      unknownKeys(raw, DEFAULTS_KEYS, "/defaults", fail);
      if (raw["workflow"] !== undefined) {
        if (isId(raw["workflow"])) defaults.workflow = raw["workflow"];
        else fail("/defaults/workflow", "must be a workflow id");
      }
      const limits = raw["limits"];
      if (limits !== undefined) {
        if (!isPlainObject(limits)) {
          fail("/defaults/limits", "must be an object");
        } else {
          unknownKeys(limits, CONFIG_LIMIT_KEYS, "/defaults/limits", fail);
          const parsed: Partial<Record<LimitKey, number>> = {};
          for (const key of CONFIG_LIMIT_KEYS) {
            if (limits[key] === undefined) continue;
            const [min, max] = limitBounds(key);
            if (integerIn(limits[key], min, max)) parsed[key] = limits[key];
            else fail(`/defaults/limits/${key}`, `must be an integer between ${min} and ${max}`);
          }
          defaults.limits = parsed;
        }
      }
      if (raw["pollMs"] !== undefined) {
        if (integerIn(raw["pollMs"], 1, MAX_POLL_MS)) defaults.pollMs = raw["pollMs"];
        else fail("/defaults/pollMs", `must be an integer between 1 and ${MAX_POLL_MS}`);
      }
      if (raw["keepPanes"] !== undefined) {
        if (typeof raw["keepPanes"] === "boolean") defaults.keepPanes = raw["keepPanes"];
        else fail("/defaults/keepPanes", "must be a boolean");
      }
      if (raw["hostStartTimeoutMs"] !== undefined) {
        if (
          integerIn(raw["hostStartTimeoutMs"], MIN_HOST_START_TIMEOUT_MS, MAX_HOST_START_TIMEOUT_MS)
        )
          defaults.hostStartTimeoutMs = raw["hostStartTimeoutMs"];
        else
          fail(
            "/defaults/hostStartTimeoutMs",
            `must be an integer between ${MIN_HOST_START_TIMEOUT_MS} and ${MAX_HOST_START_TIMEOUT_MS}`,
          );
      }
      if (raw["runsDir"] !== undefined) {
        if (typeof raw["runsDir"] === "string" && raw["runsDir"].startsWith("/"))
          defaults.runsDir = raw["runsDir"];
        else fail("/defaults/runsDir", "must be an absolute path");
      }
    }
  }
  if (details.length > 0) return invalid(file.path, details);
  if (file.scope === "project" && defaults.runsDir !== undefined) {
    const message = `${file.path}: defaults.runsDir is a user setting; set it in ~/.woof/woof.json or pass --runs-dir`;
    return {
      ok: false,
      reason: "setting_scope_invalid",
      message,
      details: [
        {
          field: `${file.path}#/defaults/runsDir`,
          message: "is not allowed in project scope",
          path: file.path,
          pointer: "/defaults/runsDir",
        },
      ],
    };
  }
  return { ok: true, defaults };
}

export function validateRoleFile(
  value: unknown,
  file: { path: string },
): { ok: true; role: RoleFile } | ConfigFailure {
  const details: ConfigDetail[] = [];
  const fail = (pointer: string, message: string) =>
    details.push({ field: `${file.path}#${pointer}`, message, path: file.path, pointer });
  if (!isPlainObject(value)) {
    fail("", "must be a JSON object");
    return invalid(file.path, details);
  }
  unknownKeys(value, ROLE_KEYS, "", fail);
  if (value["schemaVersion"] !== 1) fail("/schemaVersion", "must be 1");
  const kind = value["kind"];
  if (typeof kind !== "string" || kind.trim() === "") fail("/kind", "must be a non-empty string");
  const model = value["model"];
  if (!Object.hasOwn(value, "model")) fail("/model", "is required (a model name or null)");
  else if (model !== null && (typeof model !== "string" || model.trim() === ""))
    fail("/model", "must be a non-empty string or null");
  const args = value["args"];
  if (
    args !== undefined &&
    (!Array.isArray(args) || !args.every((item) => typeof item === "string"))
  )
    fail("/args", "must be an array of strings");
  const description = value["description"];
  if (
    description !== undefined &&
    (typeof description !== "string" || description.length > MAX_DESCRIPTION)
  )
    fail("/description", `must be a string of at most ${MAX_DESCRIPTION} characters`);
  if (details.length > 0) return invalid(file.path, details);

  const argv = (args as string[] | undefined) ?? [];
  // A role that sets an engine-owned flag would silently override the resolved values.
  const engineOwned = engineOwnedArgIndexes(kind as string, argv);
  if (engineOwned.length > 0) {
    return {
      ok: false,
      reason: "role_invalid",
      message: `${file.path}: args must not set ${engineOwnedFlags(kind as string).join(" or ")}; the engine sets them (use the model field)`,
      details: engineOwned.map((index) => ({
        field: `${file.path}#/args/${index}`,
        message: `${argv[index]} is set by the engine`,
        path: file.path,
        pointer: `/args/${index}`,
      })),
    };
  }
  return {
    ok: true,
    role: {
      kind: kind as string,
      model: model as string | null,
      args: [...argv],
      ...(description !== undefined ? { description: description as string } : {}),
    },
  };
}

/** Whether launch arguments explicitly configure a permission bypass (reported, never added). */
export function configuresPermissionBypass(args: readonly string[]): boolean {
  return args.some(
    (arg, index) =>
      BYPASS_FLAGS.has(arg) ||
      arg === "--permission-mode=bypassPermissions" ||
      (arg === "--permission-mode" && args[index + 1] === "bypassPermissions"),
  );
}

function invalid(path: string, details: ConfigDetail[]): ConfigFailure {
  return {
    ok: false,
    reason: "config_invalid",
    message: `${path} is not a valid configuration file`,
    details,
  };
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  fail: (pointer: string, message: string) => void,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${prefix}/${key}`, "unknown key");
  }
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
