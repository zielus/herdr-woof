import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  futimesSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { HOST_EXIT_FILE, HOST_FILE, readHostInfo, type HostInfo } from "./probe.js";

/**
 * Run host claim (p4 D2): the process that hosts a run creates
 * `<runDir>/host.json` exclusively, writes it once and never rewrites it, keeps
 * the descriptor open and touches its mtime every `heartbeatMs`. A clean exit
 * is recorded in a second exclusively created file, `host-exit.json`, which the
 * probe reads first; no file is ever rewritten in place, so a reader never sees
 * a claim change under it. A launcher whose host never started claims the file
 * itself as `abandoned` (one exclusive write), so a late host cannot start an
 * unobserved run. The claim is correlation between same-user processes, not
 * authentication.
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
  const created = createExclusive(runDir, path, 0o644);
  if (!created.ok) return created;
  const fd = created.fd;
  try {
    writeOnce(fd, {
      schemaVersion: 1,
      kind: "woof.host",
      state: "hosting",
      pid: process.pid,
      hostname: hostname(),
      paneId: options.paneId ?? null,
      workspaceId: options.workspaceId ?? null,
      startedAt: new Date().toISOString(),
      heartbeatMs,
    });
  } catch (error) {
    closeSync(fd);
    // This process created the file exclusively and never produced a valid claim in it, so removing it
    // is safe: a partial host.json left behind would read as lost and refuse every later host.
    let removed = true;
    try {
      unlinkSync(path);
    } catch {
      removed = false;
    }
    return {
      ok: false,
      reason: "host_claim_failed",
      message: `cannot write ${path}: ${(error as Error).message}${removed ? "" : "; the partial claim could not be removed"}`,
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
        const marker = createExclusive(runDir, join(runDir, HOST_EXIT_FILE), 0o444);
        if (marker.ok) {
          try {
            writeOnce(marker.fd, {
              schemaVersion: 1,
              kind: "woof.host.exit",
              pid: process.pid,
              exitedAt: new Date().toISOString(),
              exitCode,
            });
          } finally {
            closeSync(marker.fd);
          }
        }
      } catch {
        // Without the marker the claim reads as lost once this process is gone.
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
  const created = createExclusive(runDir, path, 0o644);
  if (!created.ok) return { ok: false, host: created.host, message: created.message };
  const now = new Date().toISOString();
  try {
    writeOnce(created.fd, {
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
  mode: number,
):
  | { ok: true; fd: number }
  | { ok: false; reason: "run_host_claimed"; message: string; host: HostInfo | null }
  | { ok: false; reason: "host_claim_failed"; message: string; host: null } {
  const { O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY } = constants;
  try {
    mkdirSync(runDir, { recursive: true });
    const fd = openSync(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
    try {
      // The create mode is masked by the umask; the descriptor's mode is set exactly.
      fchmodSync(fd, mode);
    } catch (error) {
      // The descriptor is never handed out on failure: close it before reporting.
      closeSync(fd);
      throw error;
    }
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

/** Writes the whole body into a freshly created, empty file; the file is never written again. */
function writeOnce(fd: number, body: Record<string, unknown>): void {
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  let offset = 0;
  while (offset < bytes.byteLength)
    offset += writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
  fsyncSync(fd);
}
