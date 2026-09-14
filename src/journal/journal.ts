import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "../contracts/canonical-json.js";
import { replay } from "../state/reducer.js";
import { parseRecordLine, type JournalRecord, type NewJournalRecord } from "./records.js";
import { writeAll } from "./write-all.js";

export const JOURNAL_FILE = "journal.jsonl";

const { O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_RDONLY, O_WRONLY } = constants;

/** Strict decoder: invalid UTF-8 throws; a byte-order mark is kept (and then fails JSON parsing). */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Splits on newline bytes like String.prototype.split("\n"), keeping a trailing empty piece. */
function splitLines(content: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let end = content.indexOf(0x0a); end !== -1; end = content.indexOf(0x0a, start)) {
    lines.push(content.subarray(start, end));
    start = end + 1;
  }
  lines.push(content.subarray(start));
  return lines;
}

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
 * `run.opened`, or `replay` finds an impossible transition. Callers that write
 * hold the journal lock, so a torn final line is persisted corruption.
 */
export function readJournal(runDir: string): ReadJournalResult {
  const read = readJournalBytes(runDir, 0);
  if (!read.ok) return read;
  const parsed = parseLines(read.journalPath, read.content, 1, false);
  if (!parsed.ok) return parsed;
  const replayed = replay(parsed.records);
  if (!replayed.ok) return corrupt(read.journalPath, replayed.line, replayed.message);
  return { ok: true, records: parsed.records };
}

export type ReadJournalPrefixResult =
  | {
      ok: true;
      records: JournalRecord[];
      /** A final segment without a trailing newline was excluded. */
      tailPending: boolean;
      /** Byte offset just past the last complete line read. */
      endOffset: number;
      /** journalAnchor of line 1, when this read started at offset 0 and line 1 is complete. */
      anchor: string | null;
      /** The file read and its line 1, under the same condition as `anchor`. */
      file: JournalFile | null;
    }
  | { ok: false; reason: "run_dir_invalid" | "journal_corrupt"; message: string; line?: number };

/**
 * Tolerant, lock-free read for observers. Every newline-terminated line gets
 * the same validation as `readJournal`; a final segment without a trailing
 * newline is reported as `tailPending` and excluded, because a writer may be
 * appending it. A read from offset 0 replays the records; a read from a later
 * `fromOffset` checks only record fields and `seq` continuity from `expectSeq`,
 * and the caller replays the records it accumulated. It never takes the lock.
 */
export function readJournalPrefix(
  runDir: string,
  { fromOffset = 0, expectSeq = 1 }: { fromOffset?: number; expectSeq?: number } = {},
): ReadJournalPrefixResult {
  const read = readJournalBytes(runDir, fromOffset);
  if (!read.ok) return read;
  const parsed = parseLines(read.journalPath, read.content, expectSeq, true);
  if (!parsed.ok) return parsed;
  if (fromOffset === 0) {
    const replayed = replay(parsed.records);
    if (!replayed.ok) return corrupt(read.journalPath, replayed.line, replayed.message);
  }
  const file =
    fromOffset === 0 && parsed.firstLine !== undefined
      ? {
          dev: read.dev,
          ino: read.ino,
          anchor: journalAnchor(parsed.firstLine),
          firstLineBytes: parsed.firstLine.byteLength + 1,
        }
      : null;
  return {
    ok: true,
    records: parsed.records,
    tailPending: parsed.tailPending,
    endOffset: fromOffset + parsed.consumed,
    anchor: file?.anchor ?? null,
    file,
  };
}

/** The journal file a subscription started on: its identity and its line 1. */
export interface JournalFile {
  dev: number;
  ino: number;
  anchor: string;
  /** Byte length of line 1 including its newline. */
  firstLineBytes: number;
}

export type ReadJournalContinuationResult =
  | { ok: true; records: JournalRecord[]; tailPending: boolean; endOffset: number }
  | {
      ok: false;
      reason: "run_dir_invalid" | "journal_corrupt" | "journal_replaced";
      message: string;
      line?: number;
    };

class JournalReplacedError extends Error {}

/**
 * `readJournalPrefix` from `fromOffset`, first checking on the same opened
 * descriptor that the file is still the one in `file`: same device and inode,
 * and the same line 1 bytes. A journal replaced at the path, by rename or by
 * rewriting it in place, is `journal_replaced` even when its length matches.
 */
export function readJournalContinuation(
  runDir: string,
  { fromOffset, expectSeq, file }: { fromOffset: number; expectSeq: number; file: JournalFile },
): ReadJournalContinuationResult {
  let read: BytesResult;
  try {
    read = readJournalBytes(runDir, fromOffset, (fd) => {
      const stats = fstatSync(fd);
      if (stats.dev !== file.dev || stats.ino !== file.ino) {
        throw new JournalReplacedError("the journal at this path is a different file");
      }
      const first = Buffer.alloc(file.firstLineBytes);
      let length = 0;
      while (length < first.length) {
        const got = readSync(fd, first, length, first.length - length, length);
        if (got === 0) break;
        length += got;
      }
      if (
        length !== file.firstLineBytes ||
        first[length - 1] !== 0x0a ||
        journalAnchor(first.subarray(0, length - 1)) !== file.anchor
      ) {
        throw new JournalReplacedError("journal line 1 changed; the journal was replaced");
      }
    });
  } catch (error) {
    if (error instanceof JournalReplacedError) {
      return { ok: false, reason: "journal_replaced", message: error.message };
    }
    throw error;
  }
  if (!read.ok) return read;
  const parsed = parseLines(read.journalPath, read.content, expectSeq, true);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    records: parsed.records,
    tailPending: parsed.tailPending,
    endOffset: fromOffset + parsed.consumed,
  };
}

/** Run anchor: the first 12 hex characters of sha256 over journal line 1, without its newline. */
export function journalAnchor(firstLine: Uint8Array): string {
  return sha256Hex(firstLine).slice(0, 12);
}

type BytesResult =
  | { ok: true; journalPath: string; content: Buffer; dev: number; ino: number }
  | { ok: false; reason: "run_dir_invalid" | "journal_corrupt"; message: string };

/** `verify` runs on the opened descriptor before any read and may throw JournalReplacedError. */
function readJournalBytes(
  runDir: string,
  fromOffset: number,
  verify?: (fd: number) => void,
): BytesResult {
  const journalPath = join(runDir, JOURNAL_FILE);
  let content: Buffer;
  let dev: number;
  let ino: number;
  try {
    const fd = openJournalFile(journalPath, O_RDONLY);
    try {
      verify?.(fd);
      ({ dev, ino } = fstatSync(fd));
      if (fromOffset === 0) {
        content = readFileSync(fd);
      } else {
        const size = fstatSync(fd).size;
        if (size < fromOffset) {
          return {
            ok: false,
            reason: "journal_corrupt",
            message: `${journalPath} is ${size} bytes, shorter than the ${fromOffset} bytes already read`,
          };
        }
        content = Buffer.alloc(size - fromOffset);
        let length = 0;
        while (length < content.length) {
          const got = readSync(fd, content, length, content.length - length, fromOffset + length);
          if (got === 0) break;
          length += got;
        }
        content = content.subarray(0, length);
      }
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof JournalFileError) {
      return { ok: false, reason: "journal_corrupt", message: error.message };
    }
    if (error instanceof JournalReplacedError) throw error;
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
  return { ok: true, journalPath, content, dev, ino };
}

type ParsedLines =
  | {
      ok: true;
      records: JournalRecord[];
      tailPending: boolean;
      consumed: number;
      firstLine: Buffer | undefined;
    }
  | { ok: false; reason: "journal_corrupt"; message: string; line: number };

/**
 * Parses newline-terminated lines. Valid lines carry `seq` equal to their line
 * number, so the first line here is line `expectSeq`. With `tolerateTail`, a
 * final segment without a newline is excluded instead of failing closed.
 */
function parseLines(
  journalPath: string,
  content: Buffer,
  expectSeq: number,
  tolerateTail: boolean,
): ParsedLines {
  const records: JournalRecord[] = [];
  let consumed = 0;
  let firstLine: Buffer | undefined;
  let tailPending = false;
  if (content.byteLength === 0) {
    return { ok: true, records, tailPending, consumed, firstLine };
  }

  // Lines are split on raw newline bytes (never part of a multi-byte UTF-8
  // sequence) and decoded strictly, so invalid bytes fail closed with their line
  // number instead of being replaced with U+FFFD.
  const lines = splitLines(content);
  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = expectSeq + index;
    const isLast = index === lines.length - 1;
    if (isLast && rawLine.byteLength === 0) break;
    if (isLast) {
      if (tolerateTail) {
        tailPending = true;
        break;
      }
      return corrupt(journalPath, lineNumber, "final line has no trailing newline (torn write)");
    }
    let line: string;
    try {
      line = STRICT_UTF8.decode(rawLine);
    } catch {
      return corrupt(journalPath, lineNumber, "line is not valid UTF-8");
    }
    const record = parseRecordLine(line);
    if (typeof record === "string") return corrupt(journalPath, lineNumber, record);
    if (record.seq !== lineNumber) {
      return corrupt(
        journalPath,
        lineNumber,
        `seq ${record.seq} does not follow ${lineNumber - 1}`,
      );
    }
    if ((lineNumber === 1) !== (record.type === "run.opened")) {
      return corrupt(journalPath, lineNumber, "run.opened must be the first and only run record");
    }
    if (lineNumber === 1) firstLine = rawLine;
    records.push(record);
    consumed += rawLine.byteLength + 1;
  }
  return { ok: true, records, tailPending, consumed, firstLine };
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

function corrupt(
  journalPath: string,
  line: number,
  detail: string,
): { ok: false; reason: "journal_corrupt"; message: string; line: number } {
  return {
    ok: false,
    reason: "journal_corrupt",
    message: `${journalPath} line ${line}: ${detail}`,
    line,
  };
}
