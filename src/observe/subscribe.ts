import { lstatSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  JOURNAL_FILE,
  readJournal,
  readJournalContinuation,
  readJournalPrefix,
  type JournalFile,
} from "../journal/journal.js";
import { withJournalLock } from "../journal/lock.js";
import type { JournalRecord } from "../journal/records.js";
import { replay } from "../state/reducer.js";
import { checkCursor, type CursorProblem } from "./cursor.js";
import { projectEvents, type RunEvent } from "./events.js";

export type SubscriptionItem =
  | RunEvent
  | { type: "resync_required"; reason: CursorProblem; message: string }
  | { type: "error"; reason: "journal_corrupt" | "run_dir_invalid"; message: string };

export interface SubscribeOptions {
  /** Resume after this cursor; omitted means from the beginning. */
  after?: string;
  pollMs?: number;
  /** How long an unchanged partial final line may persist before one locked read decides it. */
  tornTailGraceMs?: number;
  /**
   * Never take the journal lock. A partial final line unchanged for `tornTailGraceMs` then ends the
   * subscription with `error`/`journal_corrupt` instead of the one locked read that would decide it
   * (a writer stalled that long mid-line reads as corruption). Default false.
   */
  lockFree?: boolean;
  signal?: AbortSignal;
}

/**
 * Polls the journal and yields each event once, in seq order, within one
 * subscription. It keeps a byte offset in memory and checks that the next line
 * there has the expected seq, falling back to a full read otherwise. A journal
 * that does not exist yet (no journal file in an existing directory, or no run
 * directory yet) is waited for.
 *
 * It ends with `resync_required` when the stored cursor cannot resume (another
 * run at the path, a truncated or replaced journal, a malformed cursor), with
 * `error`/`journal_corrupt` when the journal is corrupt or not a regular file,
 * and with `error`/`run_dir_invalid` when the run directory can never hold a
 * readable journal (the path is not a directory, or it cannot be searched or
 * inspected, for example EACCES, EPERM or ENOTDIR). A partial final line is normally a
 * write in flight; if the same partial line persists for `tornTailGraceMs`, one
 * `readJournal` under the journal lock decides: no append is in flight under
 * the lock, so a line still torn there is persisted corruption. With `lockFree`
 * the lock is never taken: the persisting partial line ends the subscription
 * with `error`/`journal_corrupt` after the same grace period.
 */
export async function* subscribeEvents(
  runDir: string,
  options: SubscribeOptions = {},
): AsyncGenerator<SubscriptionItem> {
  const pollMs = options.pollMs ?? 250;
  const graceMs = options.tornTailGraceMs ?? 2000;
  const signal = options.signal;
  let records: JournalRecord[] = [];
  let anchor: string | undefined;
  let file: JournalFile | undefined;
  let offset = 0;
  let yielded: number | undefined;
  let tail: { offset: number; size: number; since: number } | undefined;

  /**
   * Tracks a partial final line at byte offset `at`. Once the same partial line
   * has persisted for the grace period, one `readJournal` under the journal lock
   * decides: no append is in flight under the lock, so a line still torn there
   * is persisted corruption (its message is returned).
   */
  const tornTail = async (at: number): Promise<string | undefined> => {
    const size = fileSize(runDir);
    if (tail === undefined || tail.offset !== at || tail.size !== size) {
      tail = { offset: at, size, since: Date.now() };
      return undefined;
    }
    if (Date.now() - tail.since < graceMs) return undefined;
    if (options.lockFree === true) {
      return `the journal's final line at byte ${at} stayed partial and unchanged for ${graceMs} ms; a lock-free subscription does not decide it under the journal lock`;
    }
    const locked = await withJournalLock(runDir, () => readJournal(runDir), { timeoutMs: pollMs });
    if (!locked.ok) return undefined; // a writer holds the lock: its append is still in flight
    if (!locked.value.ok) return locked.value.message;
    tail = undefined;
    return undefined;
  };

  for (let first = true; ; first = false) {
    if (signal?.aborted === true) return;
    if (!first) {
      try {
        // Polling is sequential by design: each wait precedes the next read.
        // oxlint-disable-next-line no-await-in-loop
        await delay(pollMs, undefined, signal === undefined ? {} : { signal });
      } catch {
        return;
      }
    }

    let tailPending = false;
    if (anchor === undefined) {
      const read = readJournalPrefix(runDir);
      if (!read.ok) {
        if (read.reason === "journal_replaced") {
          yield {
            type: "resync_required",
            reason: "cursor_foreign",
            message: `the journal at this path was replaced while it was read: ${read.message}`,
          };
          return;
        }
        if (read.reason === "journal_corrupt") {
          yield { type: "error", reason: "journal_corrupt", message: read.message };
          return;
        }
        const permanent = permanentRunDirProblem(runDir);
        if (permanent !== undefined) {
          yield { type: "error", reason: "run_dir_invalid", message: permanent };
          return;
        }
        continue; // not created yet
      }
      if (read.anchor === null || read.file === null) {
        // No complete run.opened line yet: a first line being written, or torn for good.
        if (!read.tailPending) {
          tail = undefined;
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop
        const torn = await tornTail(0);
        if (torn !== undefined) {
          yield { type: "error", reason: "journal_corrupt", message: torn };
          return;
        }
        continue;
      }
      file = read.file;
      anchor = read.anchor;
      records = read.records;
      offset = read.endOffset;
      tailPending = read.tailPending;
      if (options.after === undefined) {
        yielded = 0;
      } else {
        const checked = checkCursor(options.after, { revision: records.length, anchor });
        if (!checked.ok) {
          yield { type: "resync_required", reason: checked.reason, message: checked.message };
          return;
        }
        yielded = checked.seq;
      }
    } else {
      // Every incremental read first checks, on the descriptor it reads from,
      // that the file and its line 1 are still the ones this subscription began on.
      const next = readJournalContinuation(runDir, {
        fromOffset: offset,
        expectSeq: records.length + 1,
        file: file as JournalFile,
      });
      if (!next.ok && next.reason === "journal_replaced") {
        yield {
          type: "resync_required",
          reason: "cursor_foreign",
          message: `the journal at this path now belongs to another run: ${next.message}`,
        };
        return;
      }
      if (next.ok) {
        records = [...records, ...next.records];
        offset = next.endOffset;
        tailPending = next.tailPending;
      } else {
        // The line at the offset did not continue the journal: re-read it whole.
        const full = readJournalPrefix(runDir);
        if (!full.ok) {
          if (full.reason === "journal_replaced") {
            yield { type: "resync_required", reason: "cursor_foreign", message: full.message };
          } else if (full.reason === "journal_corrupt") {
            yield { type: "error", reason: "journal_corrupt", message: full.message };
          } else {
            yield { type: "resync_required", reason: "cursor_ahead", message: full.message };
          }
          return;
        }
        // The path may name another file by now: adopt nothing unless it is still
        // the same inode with the same line 1 this subscription began on.
        const started = file as JournalFile;
        if (
          full.file === null ||
          full.file.dev !== started.dev ||
          full.file.ino !== started.ino ||
          full.file.anchor !== started.anchor
        ) {
          yield {
            type: "resync_required",
            reason: "cursor_foreign",
            message: "the journal at this path now belongs to another run",
          };
          return;
        }
        if (full.records.length < records.length) {
          yield {
            type: "resync_required",
            reason: "cursor_ahead",
            message: `the journal shrank from ${records.length} to ${full.records.length} records`,
          };
          return;
        }
        records = full.records;
        offset = full.endOffset;
        tailPending = full.tailPending;
      }
      if (next.ok && next.records.length > 0) {
        const replayed = replay(records);
        if (!replayed.ok) {
          yield {
            type: "error",
            reason: "journal_corrupt",
            message: `line ${replayed.line}: ${replayed.message}`,
          };
          return;
        }
      }
    }

    for (const event of projectEvents(records, anchor).slice(yielded ?? 0)) {
      yield event;
      yielded = event.seq;
    }

    if (!tailPending) {
      tail = undefined;
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop
    const torn = await tornTail(offset);
    if (torn !== undefined) {
      yield { type: "error", reason: "journal_corrupt", message: torn };
      return;
    }
  }
}

/**
 * Why a journal read that failed with `run_dir_invalid` can never succeed at
 * this path, or undefined when the journal may still be created: the run
 * directory does not exist yet, or it is a searchable directory in which the
 * journal is missing or (just created) a regular file.
 */
function permanentRunDirProblem(runDir: string): string | undefined {
  let stats: Stats;
  try {
    stats = statSync(runDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return `cannot inspect run directory ${runDir}: ${(error as Error).message}`;
  }
  if (!stats.isDirectory()) return `${runDir} is not a directory`;
  const journalPath = join(runDir, JOURNAL_FILE);
  try {
    lstatSync(journalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return `cannot inspect ${journalPath}: ${(error as Error).message}`;
  }
  return undefined;
}

function fileSize(runDir: string): number {
  try {
    return statSync(join(runDir, JOURNAL_FILE)).size;
  } catch {
    return -1;
  }
}
