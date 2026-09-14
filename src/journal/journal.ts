import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

import {
  parseRecordLine,
  type AttemptOpenedRecord,
  type JournalRecord,
  type NewJournalRecord,
  type SubmissionAcceptedRecord,
} from "./records.js";
import { writeAll } from "./write-all.js";

export const JOURNAL_FILE = "journal.jsonl";

const { O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_RDONLY, O_WRONLY } = constants;

/** A short name for a filesystem entry type, for error messages. */
export function describeEntryKind(stats: Stats): string {
  if (stats.isFile()) return "regular file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isFIFO()) return "FIFO";
  if (stats.isSocket()) return "socket";
  if (stats.isBlockDevice() || stats.isCharacterDevice()) return "device";
  return "special file";
}

/**
 * `journal.jsonl` is not a regular, non-symlink file directly inside the run
 * directory. Callers report it as `journal_corrupt`; a symlink's target is never
 * read or written.
 */
export class JournalFileError extends Error {}

export type ReadJournalResult =
  | { ok: true; records: JournalRecord[] }
  | { ok: false; reason: "run_dir_invalid" | "journal_corrupt"; message: string; line?: number };

/**
 * Opens the journal without following a symlink at its path and checks that the
 * descriptor is a regular file that the path still names.
 */
function openJournalFile(journalPath: string, flags: number, mode?: number): number {
  // Inspect before opening: a FIFO, socket or device at the path would block an
  // open or read, and is never a valid journal.
  const entry = inspectJournalPath(journalPath);
  if (entry instanceof JournalFileError) throw entry;

  let fd: number;
  try {
    // O_NONBLOCK keeps an entry swapped in after the lstat from blocking the open.
    fd = openSync(journalPath, flags | O_NOFOLLOW | O_NONBLOCK, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new JournalFileError(
        `${journalPath} is a symlink; the journal must be a regular file inside the run directory`,
      );
    }
    if (code === "ENXIO") {
      throw new JournalFileError(`${journalPath} is not a regular file inside the run directory`);
    }
    throw error;
  }
  try {
    const opened = fstatSync(fd);
    const named = lstatSync(journalPath);
    if (
      !opened.isFile() ||
      named.isSymbolicLink() ||
      opened.ino !== named.ino ||
      opened.dev !== named.dev
    ) {
      throw new JournalFileError(`${journalPath} is not a regular file inside the run directory`);
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

/**
 * Inspects the journal path with lstat only, never opening it. Returns
 * "missing", "regular", or a JournalFileError describing any other entry
 * (symlink, directory, FIFO, socket, device). Throws on other lstat failures.
 */
export function inspectJournalPath(journalPath: string): "missing" | "regular" | JournalFileError {
  let stats: Stats;
  try {
    stats = lstatSync(journalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (stats.isFile()) return "regular";
  if (stats.isSymbolicLink()) {
    return new JournalFileError(
      `${journalPath} is a symlink; the journal must be a regular file inside the run directory`,
    );
  }
  return new JournalFileError(
    `${journalPath} is not a regular file (${describeEntryKind(stats)}); the journal must be a regular file inside the run directory`,
  );
}

/** Whether anything (file, directory or symlink) exists at the journal path. */
export function journalExists(runDir: string): boolean {
  try {
    lstatSync(join(runDir, JOURNAL_FILE));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Creates an empty journal exclusively, never through an existing path. Call under the lock. */
export function createJournal(runDir: string): void {
  closeSync(openJournalFile(join(runDir, JOURNAL_FILE), O_WRONLY | O_CREAT | O_EXCL, 0o644));
}

/**
 * Reads `<runDir>/journal.jsonl`. The journal fails closed with
 * `journal_corrupt` (with a line number where one applies) when the path is a
 * symlink or not a regular file, a line is not a valid record, the final line
 * has no trailing newline, `seq` has a gap, the first record is not
 * `run.opened`, or `replay` finds an impossible transition.
 */
export function readJournal(runDir: string): ReadJournalResult {
  const journalPath = join(runDir, JOURNAL_FILE);
  let content: string;
  try {
    const fd = openJournalFile(journalPath, O_RDONLY);
    try {
      content = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof JournalFileError) {
      return { ok: false, reason: "journal_corrupt", message: error.message };
    }
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: "run_dir_invalid",
      message:
        code === "ENOENT"
          ? `${journalPath} does not exist; open an attempt first`
          : `cannot read ${journalPath}: ${(error as Error).message}`,
    };
  }
  if (content === "") return { ok: true, records: [] };

  const lines = content.split("\n");
  const records: JournalRecord[] = [];
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const isLast = index === lines.length - 1;
    if (isLast && line === "") break;
    if (isLast) {
      return corrupt(journalPath, lineNumber, "final line has no trailing newline (torn write)");
    }
    const record = parseRecordLine(line);
    if (typeof record === "string") return corrupt(journalPath, lineNumber, record);
    if (record.seq !== records.length + 1) {
      return corrupt(
        journalPath,
        lineNumber,
        `seq ${record.seq} does not follow ${records.length}`,
      );
    }
    if ((index === 0) !== (record.type === "run.opened")) {
      return corrupt(journalPath, lineNumber, "run.opened must be the first and only run record");
    }
    records.push(record);
  }

  const replayed = replay(records);
  if (!replayed.ok) return corrupt(journalPath, replayed.line, replayed.message);
  return { ok: true, records };
}

/**
 * Appends one record with the next `seq`, writing the whole line and fsyncing
 * it before returning. The journal must already exist as a regular file; a
 * symlink throws `JournalFileError`. On a write failure the journal is truncated
 * back to its previous length when possible and the error is rethrown. Callers
 * must hold the journal lock and pass the records they just read under it.
 */
export function appendRecord(
  runDir: string,
  records: readonly JournalRecord[],
  record: NewJournalRecord,
): JournalRecord {
  const full = {
    schemaVersion: 1,
    seq: (records.at(-1)?.seq ?? 0) + 1,
    ts: new Date().toISOString(),
    ...record,
  } as JournalRecord;
  const line = Buffer.from(`${JSON.stringify(full)}\n`, "utf8");
  const fd = openJournalFile(join(runDir, JOURNAL_FILE), O_WRONLY | O_APPEND);
  try {
    const sizeBefore = fstatSync(fd).size;
    try {
      writeAll(fd, line);
      fsyncSync(fd);
    } catch (error) {
      truncateQuietly(fd, sizeBefore);
      throw error;
    }
  } finally {
    closeSync(fd);
  }
  return full;
}

function truncateQuietly(fd: number, size: number): void {
  try {
    ftruncateSync(fd, size);
    fsyncSync(fd);
  } catch {
    // The caller reports journal_write_failed; a torn line that survives makes
    // the next read fail closed.
  }
}

export type AttemptStatus = "open" | "superseded" | "accepted";

export interface AttemptState {
  opened: AttemptOpenedRecord;
  status: AttemptStatus;
  accepted?: SubmissionAcceptedRecord;
}

export interface RunState {
  runId: string | undefined;
  attempts: Map<string, AttemptState>;
  /** Highest opened (visit, attempt) per stage. */
  latestByStage: Map<string, { visit: number; attempt: number }>;
}

export type ReplayResult =
  { ok: true; state: RunState } | { ok: false; line: number; message: string };

export function attemptKey(stageId: string, visit: number, attempt: number): string {
  return `${stageId}/${visit}/${attempt}`;
}

/** Orders (visit, attempt) pairs lexicographically. */
export function compareAttempts(
  a: { visit: number; attempt: number },
  b: { visit: number; attempt: number },
): number {
  return a.visit === b.visit ? a.attempt - b.attempt : a.visit - b.visit;
}

/** An empty verdict list requires null; otherwise the verdict must be listed. */
export function verdictAllowed(allowed: readonly string[], verdict: string | null): boolean {
  return allowed.length === 0 ? verdict === null : verdict !== null && allowed.includes(verdict);
}

/**
 * Derives attempt state from the journal and rejects impossible transitions:
 * attempts for another run or not newer than the stage's latest, acceptance of
 * an attempt that was never opened, is not open, disagrees with the opened
 * identity or pane, or carries a disallowed verdict, and duplicates that do not
 * match the accepted record they name. Opening a newer attempt supersedes the
 * stage's still-open attempts; accepted attempts stay accepted.
 */
export function replay(records: readonly JournalRecord[]): ReplayResult {
  const state: RunState = { runId: undefined, attempts: new Map(), latestByStage: new Map() };
  const acceptedBySeq = new Map<number, SubmissionAcceptedRecord>();
  for (const record of records) {
    const problem = applyRecord(state, acceptedBySeq, record);
    if (problem !== undefined) return { ok: false, line: record.seq, message: problem };
  }
  return { ok: true, state };
}

function applyRecord(
  state: RunState,
  acceptedBySeq: Map<number, SubmissionAcceptedRecord>,
  record: JournalRecord,
): string | undefined {
  switch (record.type) {
    case "run.opened":
      state.runId = record.runId;
      return undefined;
    case "attempt.opened": {
      if (record.runId !== state.runId) {
        return `attempt.opened belongs to run ${record.runId}, not ${String(state.runId)}`;
      }
      const latest = state.latestByStage.get(record.stageId);
      if (latest !== undefined && compareAttempts(record, latest) <= 0) {
        return `attempt.opened visit ${record.visit} attempt ${record.attempt} is not newer than visit ${latest.visit} attempt ${latest.attempt}`;
      }
      for (const existing of state.attempts.values()) {
        if (existing.opened.stageId === record.stageId && existing.status === "open") {
          existing.status = "superseded";
        }
      }
      state.attempts.set(attemptKey(record.stageId, record.visit, record.attempt), {
        opened: record,
        status: "open",
      });
      state.latestByStage.set(record.stageId, { visit: record.visit, attempt: record.attempt });
      return undefined;
    }
    case "submission.accepted": {
      const attempt = state.attempts.get(attemptKey(record.stageId, record.visit, record.attempt));
      if (attempt === undefined) {
        return "submission.accepted for an attempt that was never opened";
      }
      const opened = attempt.opened;
      if (record.runId !== opened.runId || record.agentId !== opened.agentId) {
        return "submission.accepted identity disagrees with the opened attempt";
      }
      if (
        opened.paneId !== undefined &&
        record.paneId !== undefined &&
        record.paneId !== opened.paneId
      ) {
        return "submission.accepted pane disagrees with the opened attempt";
      }
      if (attempt.status !== "open") {
        return `submission.accepted for an attempt that is already ${attempt.status}`;
      }
      if (!verdictAllowed(opened.verdicts, record.verdict)) {
        return "submission.accepted verdict is not allowed by the opened attempt";
      }
      attempt.status = "accepted";
      attempt.accepted = record;
      acceptedBySeq.set(record.seq, record);
      return undefined;
    }
    case "submission.duplicate": {
      const accepted = acceptedBySeq.get(record.acceptedSeq);
      if (
        accepted === undefined ||
        accepted.receiptId !== record.receiptId ||
        accepted.envelopeDigest !== record.envelopeDigest
      ) {
        return "submission.duplicate does not match the accepted record it names";
      }
      return undefined;
    }
    case "submission.rejected":
      return undefined;
  }
}

function corrupt(journalPath: string, line: number, detail: string): ReadJournalResult {
  return {
    ok: false,
    reason: "journal_corrupt",
    message: `${journalPath} line ${line}: ${detail}`,
    line,
  };
}
