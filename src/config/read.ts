import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { extname, join } from "node:path";

import { sha256Hex } from "../contracts/canonical-json.js";
import { isId } from "../contracts/envelope.js";
import {
  MAX_CONFIG_FILE_BYTES,
  validateRoleFile,
  validateSettingsFile,
  type ConfigFailure,
  type ConfigScope,
  type RoleFile,
  type SettingsDefaults,
} from "./schema.js";

/**
 * Reads one configuration scope (`<dir>/woof.json`, `<dir>/roles/*.json`,
 * `<dir>/workflows/*.{mjs,js,ts}`) without executing anything. Symlinks are
 * followed; FIFOs and other non-regular entries are refused without blocking.
 */

/** Largest workflow module hashed for provenance, in bytes. */
export const MAX_WORKFLOW_FILE_BYTES = 1024 * 1024;
export const WORKFLOW_EXTENSIONS = [".mjs", ".js", ".ts"];

export interface FileRef {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ScopeContent {
  scope: ConfigScope;
  dir: string;
  exists: boolean;
  settings: (FileRef & { defaults: SettingsDefaults }) | null;
  roles: Record<string, FileRef & { role: RoleFile }>;
  workflows: Record<string, FileRef>;
}

export type ReadFileResult =
  { ok: true; bytes: Buffer; sha256: string } | { ok: false; missing: boolean; message: string };

export function readConfigFile(path: string, maxBytes: number): ReadFileResult {
  try {
    lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      missing: code === "ENOENT",
      message: `${path}: ${(error as Error).message}`,
    };
  }
  let named;
  try {
    named = statSync(path);
  } catch (error) {
    return { ok: false, missing: false, message: `${path}: ${(error as Error).message}` };
  }
  if (!named.isFile())
    return { ok: false, missing: false, message: `${path} is not a regular file` };
  if (named.size > maxBytes)
    return { ok: false, missing: false, message: `${path} is larger than ${maxBytes} bytes` };
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    return { ok: false, missing: false, message: `${path}: ${(error as Error).message}` };
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile())
      return { ok: false, missing: false, message: `${path} is not a regular file` };
    const buffer = Buffer.alloc(Math.min(opened.size, maxBytes) + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > maxBytes)
      return { ok: false, missing: false, message: `${path} is larger than ${maxBytes} bytes` };
    const bytes = buffer.subarray(0, length);
    return { ok: true, bytes, sha256: sha256Hex(bytes) };
  } catch (error) {
    return { ok: false, missing: false, message: `${path}: ${(error as Error).message}` };
  } finally {
    closeSync(fd);
  }
}

export function loadScope(
  dir: string,
  scope: ConfigScope,
): { ok: true; content: ScopeContent } | ConfigFailure {
  const content: ScopeContent = {
    scope,
    dir,
    exists: false,
    settings: null,
    roles: Object.create(null) as ScopeContent["roles"],
    workflows: Object.create(null) as ScopeContent["workflows"],
  };
  const kind = entryKind(dir);
  if (kind === "missing") return { ok: true, content };
  if (kind !== "directory") return failure(dir, `${dir} is not a directory`);
  content.exists = true;

  const settingsPath = join(dir, "woof.json");
  const settings = readJson(settingsPath);
  if (settings.kind === "failure") return settings.failure;
  if (settings.kind === "read") {
    const validated = validateSettingsFile(settings.value, { path: settingsPath, scope });
    if (!validated.ok) return validated;
    content.settings = { ...settings.ref, defaults: validated.defaults };
  }

  const roleNames = listDir(join(dir, "roles"), (name) => name.endsWith(".json"));
  if (!roleNames.ok) return roleNames.failure;
  for (const name of roleNames.names) {
    const path = join(dir, "roles", name);
    const stem = name.slice(0, -".json".length);
    if (!isId(stem))
      return failure(path, `${path}: the role name ${JSON.stringify(stem)} is not a valid id`);
    const role = readJson(path);
    if (role.kind === "failure") return role.failure;
    if (role.kind === "missing") continue;
    const validated = validateRoleFile(role.value, { path });
    if (!validated.ok) return validated;
    content.roles[stem] = { ...role.ref, role: validated.role };
  }

  const workflowNames = listDir(join(dir, "workflows"), (name) =>
    WORKFLOW_EXTENSIONS.includes(extname(name)),
  );
  if (!workflowNames.ok) return workflowNames.failure;
  const byStem = new Map<string, string[]>();
  for (const name of workflowNames.names) {
    const stem = name.slice(0, -extname(name).length);
    byStem.set(stem, [...(byStem.get(stem) ?? []), join(dir, "workflows", name)]);
  }
  for (const [stem, paths] of byStem) {
    if (paths.length > 1) {
      return {
        ok: false,
        reason: "config_conflict",
        message: `${scope} scope defines workflow ${stem} more than once: ${paths.join(", ")}`,
        details: paths.map((path) => ({ field: path, message: `defines workflow ${stem}`, path })),
      };
    }
    const path = paths[0] as string;
    if (!isId(stem))
      return failure(path, `${path}: the workflow name ${JSON.stringify(stem)} is not a valid id`);
    const read = readConfigFile(path, MAX_WORKFLOW_FILE_BYTES);
    if (!read.ok) {
      if (read.missing) continue;
      return failure(path, read.message);
    }
    content.workflows[stem] = { path, sha256: read.sha256, bytes: read.bytes.byteLength };
  }
  return { ok: true, content };
}

type JsonRead =
  | { kind: "read"; value: unknown; ref: FileRef }
  | { kind: "missing" }
  | { kind: "failure"; failure: ConfigFailure };

function readJson(path: string): JsonRead {
  const read = readConfigFile(path, MAX_CONFIG_FILE_BYTES);
  if (!read.ok)
    return read.missing
      ? { kind: "missing" }
      : { kind: "failure", failure: failure(path, read.message) };
  let value: unknown;
  try {
    value = JSON.parse(read.bytes.toString("utf8"));
  } catch (error) {
    return {
      kind: "failure",
      failure: failure(path, `${path} is not valid JSON: ${(error as Error).message}`),
    };
  }
  return { kind: "read", value, ref: { path, sha256: read.sha256, bytes: read.bytes.byteLength } };
}

function listDir(
  dir: string,
  keep: (name: string) => boolean,
): { ok: true; names: string[] } | { ok: false; failure: ConfigFailure } {
  const kind = entryKind(dir);
  if (kind === "missing") return { ok: true, names: [] };
  if (kind !== "directory")
    return { ok: false, failure: failure(dir, `${dir} is not a directory`) };
  try {
    const names = readdirSync(dir)
      .filter((name) => !name.startsWith(".") && keep(name))
      .toSorted();
    return { ok: true, names };
  } catch (error) {
    return { ok: false, failure: failure(dir, `${dir}: ${(error as Error).message}`) };
  }
}

function entryKind(path: string): "missing" | "directory" | "other" {
  try {
    return statSync(path).isDirectory() ? "directory" : "other";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "other";
  }
}

function failure(path: string, message: string): ConfigFailure {
  return {
    ok: false,
    reason: "config_invalid",
    message,
    details: [{ field: `${path}#`, message, path, pointer: "" }],
  };
}
