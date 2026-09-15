import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * Run host probe (p4 D2): reads `<runDir>/host.json`, the claim a run host
 * creates exclusively and keeps fresh by touching its mtime every
 * `heartbeatMs`. Pure file inspection with no journal access, so the snapshot
 * reader can report whether a run still has a live owner. A missing, invalid,
 * symlinked or non-regular claim file reads as unhosted without blocking.
 */

export const HOST_FILE = "host.json";
/** A heartbeat older than this many intervals means the host is lost. */
export const LOST_AFTER_HEARTBEATS = 5;
const MAX_HOST_FILE_BYTES = 64 * 1024;

export type HostState = "hosting" | "exited" | "abandoned";
export type HostOwner = "unhosted" | "alive" | "lost" | "exited";

export interface HostInfo {
  state: HostState;
  pid: number | null;
  hostname: string | null;
  paneId: string | null;
  workspaceId: string | null;
  startedAt: string | null;
  heartbeatMs: number | null;
  /** The claim file's mtime: the last heartbeat. */
  heartbeatAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
}

export interface ProbeOptions {
  /** Milliseconds since the epoch (default Date.now()). */
  now?: number;
  /** The run is terminated: a stale `hosting` claim reports exited, never lost. */
  terminal?: boolean;
}

/** Reads the host claim of a run directory; undefined when there is no valid one. */
export function readHostInfo(runDir: string): HostInfo | undefined {
  const path = join(runDir, HOST_FILE);
  let named;
  try {
    named = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!named.isFile() || named.size > MAX_HOST_FILE_BYTES) return undefined;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== named.ino || opened.size > MAX_HOST_FILE_BYTES)
      return undefined;
    const buffer = Buffer.alloc(opened.size);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return parseHostInfo(buffer.subarray(0, length).toString("utf8"), opened.mtime);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Parses host.json text; `mtime` becomes `heartbeatAt`. Undefined for anything invalid (pure). */
export function parseHostInfo(text: string, mtime: Date): HostInfo | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(value) || value["schemaVersion"] !== 1 || value["kind"] !== "woof.host")
    return undefined;
  const state = value["state"];
  if (state !== "hosting" && state !== "exited" && state !== "abandoned") return undefined;
  const heartbeatMs = positiveInteger(value["heartbeatMs"]);
  if (state === "hosting" && heartbeatMs === null) return undefined;
  return {
    state,
    pid: positiveInteger(value["pid"]),
    hostname: stringOrNull(value["hostname"]),
    paneId: stringOrNull(value["paneId"]),
    workspaceId: stringOrNull(value["workspaceId"]),
    startedAt: stringOrNull(value["startedAt"]),
    heartbeatMs,
    heartbeatAt: Number.isFinite(mtime.getTime()) ? mtime.toISOString() : null,
    exitedAt: stringOrNull(value["exitedAt"]),
    exitCode:
      typeof value["exitCode"] === "number" && Number.isSafeInteger(value["exitCode"])
        ? value["exitCode"]
        : null,
  };
}

export function probeHost(
  runDir: string,
  options: ProbeOptions = {},
): { owner: HostOwner; host: HostInfo | null } {
  const host = readHostInfo(runDir);
  if (host === undefined) return { owner: "unhosted", host: null };
  return { owner: ownerOf(host, options), host };
}

/** The owner state of a parsed claim (pure except for the same-host pid check). */
export function ownerOf(host: HostInfo, options: ProbeOptions = {}): HostOwner {
  if (host.state === "abandoned") return "unhosted";
  if (host.state === "exited") return "exited";
  const now = options.now ?? Date.now();
  const beat = host.heartbeatAt === null ? Number.NaN : Date.parse(host.heartbeatAt);
  const stale =
    !Number.isFinite(beat) || now - beat > LOST_AFTER_HEARTBEATS * (host.heartbeatMs ?? 0);
  const dead = host.hostname === hostname() && host.pid !== null && !processExists(host.pid);
  if (!stale && !dead) return "alive";
  return options.terminal === true ? "exited" : "lost";
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
