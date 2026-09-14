import { randomUUID } from "node:crypto";
import { closeSync, constants, openSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { writeAll } from "./write-all.js";

/**
 * Journal lock: `<runDir>/journal.lock`, created with O_CREAT | O_EXCL |
 * O_NOFOLLOW and holding `{pid, host, ts, token}`. Any existing entry at the
 * path, including a symlink (dangling or not), counts as held; the lock is never
 * created or read through a symlink.
 *
 * There is no automatic stale-lock recovery. A lock left behind by a crashed
 * process makes every writer report `journal_busy` after the timeout, naming the
 * lock path and its recorded holder, until a person removes the file. Breaking
 * locks by pid liveness cannot be made atomic with O_EXCL files alone: two
 * breakers racing on one dead lock can remove each other's fresh lock.
 *
 * A writer releases only the lock it created: the file is unlinked only while it
 * still holds that writer's random token.
 */
export const LOCK_FILE = "journal.lock";

const { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_WRONLY } = constants;

export interface LockOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export type LockResult<T> =
  { ok: true; value: T } | { ok: false; reason: "journal_busy"; message: string };

interface Holder {
  pid: number;
  host: string;
  ts?: string;
  token?: string;
}

/**
 * Runs `fn` while holding the journal lock. Acquisition polls until the
 * timeout and then reports `journal_busy`.
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
    release(lockPath, acquired.value);
  }
}

async function acquire(
  lockPath: string,
  { timeoutMs = 5000, pollMs = 25 }: LockOptions,
): Promise<LockResult<string>> {
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  const metadata = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    ts: new Date().toISOString(),
    token,
  });

  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (fd !== undefined) {
      try {
        writeAll(fd, metadata);
      } catch (error) {
        closeSync(fd);
        // Created exclusively by this call, so the file is ours to remove.
        rmSync(lockPath, { force: true });
        throw error;
      }
      closeSync(fd);
      return { ok: true, value: token };
    }

    if (Date.now() >= deadline) {
      return {
        ok: false,
        reason: "journal_busy",
        message:
          `journal lock ${lockPath} is held by ${describeHolder(lockPath)}; gave up after ${timeoutMs} ms. ` +
          `Woof does not remove stale locks: if that process is gone, delete ${lockPath} by hand.`,
      };
    }
    // Polling is sequential by design: each wait precedes the next attempt.
    // oxlint-disable-next-line no-await-in-loop
    await delay(pollMs);
  }
}

function release(lockPath: string, token: string): void {
  if (parseHolder(readLock(lockPath))?.token !== token) return;
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function readLock(lockPath: string): string | undefined {
  try {
    const fd = openSync(lockPath, O_RDONLY | O_NOFOLLOW);
    try {
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function parseHolder(content: string | undefined): Holder | undefined {
  if (content === undefined) return undefined;
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    const { pid, host, ts, token } = value;
    if (typeof pid === "number" && Number.isInteger(pid) && typeof host === "string") {
      return {
        pid,
        host,
        ...(typeof ts === "string" ? { ts } : {}),
        ...(typeof token === "string" ? { token } : {}),
      };
    }
  } catch {
    // Partially written or foreign content.
  }
  return undefined;
}

function describeHolder(lockPath: string): string {
  const holder = parseHolder(readLock(lockPath));
  if (holder === undefined) return "an unknown holder (lock content unreadable)";
  return `pid ${holder.pid} on ${holder.host}${holder.ts !== undefined ? ` since ${holder.ts}` : ""}`;
}
