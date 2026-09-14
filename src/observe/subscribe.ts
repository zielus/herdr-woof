import { statSync } from "node:fs";
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
  | { type: "error"; reason: "journal_corrupt"; message: string };

export interface SubscribeOptions {
  /** Resume after this cursor; omitted means from the beginning. */
  after?: string;
  pollMs?: number;
  /** How long an unchanged partial final line may persist before one locked read decides it. */
  tornTailGraceMs?: number;
  signal?: AbortSignal;
}

/**
 * Polls the journal and yields each event once, in seq order, within one
 * subscription. It keeps a byte offset in memory and checks that the next line
 * there has the expected seq, falling back to a full read otherwise. A journal
 * that does not exist yet is waited for.
 *
 * It ends with `resync_required` when the stored cursor cannot resume (another
 * run at the path, a truncated or replaced journal, a malformed cursor), and
 * with `error` when the journal is corrupt. A partial final line is normally a
 * write in flight; if the same partial line persists for `tornTailGraceMs`, one
 * `readJournal` under the journal lock decides: no append is in flight under
 * the lock, so a line still torn there is persisted corruption.
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
        if (read.reason === "journal_corrupt") {
          yield { type: "error", reason: "journal_corrupt", message: read.message };
          return;
        }
        continue; // not created yet
      }
      if (read.anchor === null || read.file === null) continue; // no complete run.opened line yet
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
          if (full.reason === "journal_corrupt") {
            yield { type: "error", reason: "journal_corrupt", message: full.message };
          } else {
            yield { type: "resync_required", reason: "cursor_ahead", message: full.message };
          }
          return;
        }
        if (full.anchor !== anchor) {
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
    const size = fileSize(runDir);
    if (tail === undefined || tail.offset !== offset || tail.size !== size) {
      tail = { offset, size, since: Date.now() };
      continue;
    }
    if (Date.now() - tail.since < graceMs) continue;
    // oxlint-disable-next-line no-await-in-loop
    const locked = await withJournalLock(runDir, () => readJournal(runDir), { timeoutMs: pollMs });
    if (!locked.ok) continue; // a writer holds the lock: its append is still in flight
    if (!locked.value.ok) {
      yield { type: "error", reason: "journal_corrupt", message: locked.value.message };
      return;
    }
    tail = undefined;
  }
}

function fileSize(runDir: string): number {
  try {
    return statSync(join(runDir, JOURNAL_FILE)).size;
  } catch {
    return -1;
  }
}
