import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * Run host probe (p4 D2): reads `<runDir>/host.json`, the claim a run host
 * creates exclusively, writes once and keeps fresh by touching its mtime every
 * `heartbeatMs`, and `<runDir>/host-exit.json`, the exclusive marker of a clean
 * exit, which wins over the claim's own state. Pure file inspection with no
 * journal access, so the snapshot reader can report whether a run still has a
 * live owner.
 *
 * No claim file reads as unhosted. A claim path that exists but is not a
 * readable, valid claim (a torn write by a killed host, a FIFO, a symlink) is
 * read again after a short delay and then fails closed: the owner is `lost`
 * with `host: null` and the problem, never `unhosted`.
 */

export const HOST_FILE = "host.json";
export const HOST_EXIT_FILE = "host-exit.json";
/** A heartbeat older than this many intervals means the host is lost. */
export const LOST_AFTER_HEARTBEATS = 5;
const MAX_HOST_FILE_BYTES = 64 * 1024;
/** Re-reads of an invalid claim (or exit marker), each after a short delay, before it counts. */
const INVALID_RETRIES = 3;
const INVALID_RETRY_MS = 50;

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

/** What a run directory's claim path holds. */
export type HostClaim =
  { kind: "none" } | { kind: "invalid"; problem: string } | { kind: "valid"; host: HostInfo };

export interface HostProbe {
  owner: HostOwner;
  host: HostInfo | null;
  /** Set when a claim path exists but holds no valid claim (the owner is then `lost`). */
  problem?: string;
}

/** Reads the claim with the exit marker applied, re-reading an invalid one after short delays. */
export function readHostClaim(runDir: string): HostClaim {
  let read = readClaimOnce(runDir);
  for (let retry = 0; read.retry && retry < INVALID_RETRIES; retry += 1) {
    sleepSync(INVALID_RETRY_MS);
    read = readClaimOnce(runDir);
  }
  return read.claim;
}

/** The valid claim of a run directory, or undefined (no claim, or an invalid one). */
export function readHostInfo(runDir: string): HostInfo | undefined {
  const claim = readHostClaim(runDir);
  return claim.kind === "valid" ? claim.host : undefined;
}

function readClaimOnce(runDir: string): { claim: HostClaim; retry: boolean } {
  const file = readRegularFile(join(runDir, HOST_FILE));
  if (file.kind === "absent") return { claim: { kind: "none" }, retry: false };
  if (file.kind === "problem")
    return { claim: { kind: "invalid", problem: `${HOST_FILE} ${file.problem}` }, retry: true };
  const host = parseHostInfo(file.text, file.mtime);
  if (host === undefined) {
    return {
      claim: { kind: "invalid", problem: `${HOST_FILE} exists but is not a valid run host claim` },
      retry: true,
    };
  }
  if (host.state !== "hosting") return { claim: { kind: "valid", host }, retry: false };
  const marker = readRegularFile(join(runDir, HOST_EXIT_FILE));
  if (marker.kind === "absent") return { claim: { kind: "valid", host }, retry: false };
  const exit = marker.kind === "text" ? parseHostExit(marker.text) : undefined;
  // A marker still being written is read again; one that never parses leaves the claim as is.
  if (exit === undefined) return { claim: { kind: "valid", host }, retry: true };
  return {
    claim: {
      kind: "valid",
      host: { ...host, state: "exited", exitedAt: exit.exitedAt, exitCode: exit.exitCode },
    },
    retry: false,
  };
}

type FileRead =
  | { kind: "absent" }
  | { kind: "problem"; problem: string }
  | { kind: "text"; text: string; mtime: Date };

/** Reads a small regular file without following symlinks or blocking on a FIFO. */
function readRegularFile(path: string): FileRead {
  let named;
  try {
    named = lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "problem", problem: `cannot be read: ${(error as Error).message}` };
  }
  if (!named.isFile()) return { kind: "problem", problem: "is not a regular file" };
  if (named.size > MAX_HOST_FILE_BYTES)
    return { kind: "problem", problem: `is larger than ${MAX_HOST_FILE_BYTES} bytes` };
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return { kind: "problem", problem: `cannot be opened: ${(error as Error).message}` };
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== named.ino || opened.size > MAX_HOST_FILE_BYTES)
      return { kind: "problem", problem: "changed while it was read" };
    const buffer = Buffer.alloc(opened.size);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return { kind: "text", text: buffer.subarray(0, length).toString("utf8"), mtime: opened.mtime };
  } catch (error) {
    return { kind: "problem", problem: `cannot be read: ${(error as Error).message}` };
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

/** Parses host-exit.json text (pure). */
export function parseHostExit(text: string): { exitedAt: string; exitCode: number } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(value) || value["schemaVersion"] !== 1 || value["kind"] !== "woof.host.exit")
    return undefined;
  const { exitedAt, exitCode } = value;
  if (
    typeof exitedAt !== "string" ||
    typeof exitCode !== "number" ||
    !Number.isSafeInteger(exitCode)
  )
    return undefined;
  return { exitedAt, exitCode };
}

export function probeHost(runDir: string, options: ProbeOptions = {}): HostProbe {
  const claim = readHostClaim(runDir);
  if (claim.kind === "none") return { owner: "unhosted", host: null };
  if (claim.kind === "invalid") return { owner: "lost", host: null, problem: claim.problem };
  return { owner: ownerOf(claim.host, options), host: claim.host };
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
  // A host process that is gone without recording its exit was lost, even on a terminated run.
  if (dead) return "lost";
  if (!stale) return "alive";
  return options.terminal === true ? "exited" : "lost";
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
