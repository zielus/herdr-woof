import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  ftruncateSync,
  futimesSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { HOST_FILE, readHostInfo, type HostInfo } from "./probe.js";

/**
 * Run host claim (p4 D2): the process that hosts a run creates
 * `<runDir>/host.json` exclusively, keeps the descriptor open and touches its
 * mtime every `heartbeatMs`. A clean exit rewrites the claim through the same
 * descriptor as `exited`. A launcher whose host never started claims the file
 * itself as `abandoned`, so a late host cannot start an unobserved run. The
 * claim is correlation between same-user processes, not authentication.
 */

export const DEFAULT_HEARTBEAT_MS = 2000;
/** Unstable test seam: heartbeat interval in milliseconds (100–60 000). */
export const HEARTBEAT_ENV = "WOOF_HOST_HEARTBEAT_MS";

export type ClaimHostResult =
  | { ok: true; path: string; heartbeatMs: number; release(exitCode: number): void }
  | { ok: false; reason: "run_host_claimed"; message: string; host: HostInfo | null }
  | { ok: false; reason: "host_claim_failed"; message: string; host: null };

export function heartbeatFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[HEARTBEAT_ENV];
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return DEFAULT_HEARTBEAT_MS;
  const value = Number(raw);
  return value >= 100 && value <= 60_000 ? value : DEFAULT_HEARTBEAT_MS;
}

export function claimHost(
  runDir: string,
  options: { heartbeatMs?: number; paneId?: string | null; workspaceId?: string | null } = {},
): ClaimHostResult {
  const heartbeatMs = options.heartbeatMs ?? heartbeatFromEnv();
  const path = join(runDir, HOST_FILE);
  const base = {
    schemaVersion: 1,
    kind: "woof.host",
    pid: process.pid,
    hostname: hostname(),
    paneId: options.paneId ?? null,
    workspaceId: options.workspaceId ?? null,
    startedAt: new Date().toISOString(),
    heartbeatMs,
  };
  const created = createExclusive(runDir, path);
  if (!created.ok) return created;
  const fd = created.fd;
  try {
    rewrite(fd, { ...base, state: "hosting" });
  } catch (error) {
    closeSync(fd);
    return {
      ok: false,
      reason: "host_claim_failed",
      message: `cannot write ${path}: ${(error as Error).message}`,
      host: null,
    };
  }
  const timer = setInterval(() => {
    try {
      const now = new Date();
      futimesSync(fd, now, now);
    } catch {
      // A failed heartbeat shows up as staleness to observers; it never stops the run.
    }
  }, heartbeatMs);
  timer.unref();
  let released = false;
  return {
    ok: true,
    path,
    heartbeatMs,
    release(exitCode: number) {
      if (released) return;
      released = true;
      clearInterval(timer);
      try {
        rewrite(fd, { ...base, state: "exited", exitedAt: new Date().toISOString(), exitCode });
      } catch {
        // The stale claim of a terminated run still reads as exited.
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** Claims an unclaimed run directory as abandoned; refuses when a host already claimed it. */
export function abandonHost(
  runDir: string,
  by: string,
): { ok: true } | { ok: false; host: HostInfo | null; message: string } {
  const path = join(runDir, HOST_FILE);
  const created = createExclusive(runDir, path);
  if (!created.ok) return { ok: false, host: created.host, message: created.message };
  const now = new Date().toISOString();
  try {
    rewrite(created.fd, {
      schemaVersion: 1,
      kind: "woof.host",
      state: "abandoned",
      pid: null,
      hostname: hostname(),
      paneId: null,
      workspaceId: null,
      startedAt: now,
      heartbeatMs: null,
      abandonedAt: now,
      abandonedBy: by,
    });
  } finally {
    closeSync(created.fd);
  }
  return { ok: true };
}

function createExclusive(
  runDir: string,
  path: string,
):
  | { ok: true; fd: number }
  | { ok: false; reason: "run_host_claimed"; message: string; host: HostInfo | null }
  | { ok: false; reason: "host_claim_failed"; message: string; host: null } {
  const { O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY } = constants;
  try {
    mkdirSync(runDir, { recursive: true });
    const fd = openSync(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
    // The create mode is masked by the umask; the descriptor's mode is set exactly.
    fchmodSync(fd, 0o644);
    return { ok: true, fd };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const host = readHostInfo(runDir) ?? null;
      const owner =
        host === null ? "" : ` (${host.state}${host.pid !== null ? ` by pid ${host.pid}` : ""})`;
      return {
        ok: false,
        reason: "run_host_claimed",
        message: `${runDir} is already claimed by a run host${owner}`,
        host,
      };
    }
    return {
      ok: false,
      reason: "host_claim_failed",
      message: `cannot claim ${path}: ${(error as Error).message}`,
      host: null,
    };
  }
}

/**
 * Replaces the claim's content through its descriptor (never by path). The new
 * bytes are written over the old ones before the file is cut to their length,
 * so a concurrent reader never sees an empty claim; a torn read fails to parse
 * and `readHostInfo` reads again.
 */
function rewrite(fd: number, body: Record<string, unknown>): void {
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  let offset = 0;
  while (offset < bytes.byteLength)
    offset += writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
  ftruncateSync(fd, bytes.byteLength);
  fsyncSync(fd);
}
