import { closeSync, openSync, readFileSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const LOCK_FILE = "journal.lock";

export interface LockOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export type LockResult<T> =
  { ok: true; value: T } | { ok: false; reason: "journal_busy"; message: string };

/**
 * Runs `fn` while holding `<runDir>/journal.lock`, created with O_EXCL and
 * holding `{pid, host, ts}`. A lock left by a dead process on this host is
 * broken once per acquisition; otherwise acquisition polls until the timeout
 * and reports `journal_busy`. The lock is always released after `fn`.
 */
export async function withJournalLock<T>(
  runDir: string,
  fn: () => T | Promise<T>,
  options: LockOptions = {},
): Promise<LockResult<T>> {
  const lockPath = join(runDir, LOCK_FILE);
  const acquired = await acquire(lockPath, options);
  if (!acquired.ok) return acquired;
  try {
    return { ok: true, value: await fn() };
  } finally {
    rmSync(lockPath, { force: true });
  }
}

async function acquire(
  lockPath: string,
  { timeoutMs = 5000, pollMs = 25 }: LockOptions,
): Promise<LockResult<undefined>> {
  const deadline = Date.now() + timeoutMs;
  let brokeStale = false;

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(
          fd,
          JSON.stringify({ pid: process.pid, host: hostname(), ts: new Date().toISOString() }),
        );
      } finally {
        closeSync(fd);
      }
      return { ok: true, value: undefined };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    if (!brokeStale && breakStaleLock(lockPath)) {
      brokeStale = true;
      continue;
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        reason: "journal_busy",
        message: `journal lock ${lockPath} is held (${describeHolder(lockPath)}); gave up after ${timeoutMs} ms`,
      };
    }
    // Polling is sequential by design: each wait precedes the next attempt.
    // oxlint-disable-next-line no-await-in-loop
    await delay(pollMs);
  }
}

/**
 * Removes the lock when it names a process on this host that no longer exists.
 * A lock that is unreadable or still being written is treated as held.
 */
function breakStaleLock(lockPath: string): boolean {
  const content = readLock(lockPath);
  const holder = parseHolder(content);
  if (holder === undefined || holder.host !== hostname() || isAlive(holder.pid)) {
    return false;
  }
  // Narrow the window in which another process replaced the stale lock.
  if (readLock(lockPath) !== content) return false;
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return true;
}

function readLock(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, "utf8");
  } catch {
    return undefined;
  }
}

function parseHolder(content: string | undefined): { pid: number; host: string } | undefined {
  if (content === undefined) return undefined;
  try {
    const value = JSON.parse(content) as { pid?: unknown; host?: unknown };
    if (Number.isInteger(value.pid) && typeof value.host === "string") {
      return { pid: value.pid as number, host: value.host };
    }
  } catch {
    // Partially written or foreign content: not provably stale.
  }
  return undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function describeHolder(lockPath: string): string {
  const holder = parseHolder(readLock(lockPath));
  return holder === undefined ? "holder unknown" : `pid ${holder.pid} on ${holder.host}`;
}
