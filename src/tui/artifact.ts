import { closeSync, lstatSync, openSync, readSync, statSync } from "node:fs";

import { caretSafe } from "./text.js";

/**
 * Read-only loader for the artifact pager (docs/design/tui.md "Artifact
 * pager"). Reads at most `maxBytes` of a regular file, classifies binary
 * content and reports missing/unreadable/non-regular files as honest states
 * instead of throwing. Every returned line has passed through `caretSafe`, so
 * embedded control sequences are displayed, never executed by the terminal.
 */

/** Default cap on bytes read from a single artifact: 1 MiB. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 1_048_576;

export type ArtifactText =
  | { ok: true; lines: string[]; bytes: number; truncated: boolean }
  | {
      ok: false;
      state: "missing" | "unreadable" | "not_file" | "binary";
      message: string;
      bytes: number | null;
    };

/** Bytes sniffed at the head of the file for a NUL byte before decoding. */
const SNIFF_BYTES = 8192;
/** Window at the tail of a truncated read in which a newline cut is preferred. */
const NEWLINE_WINDOW = 4096;

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Reads `path` for the artifact pager; never throws. */
export function readArtifact(path: string, options?: { maxBytes?: number }): ArtifactText {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;

  let kind: "file" | "not_file";
  let isDirectory: boolean;
  let sizeAtStat: number;
  try {
    const named = lstatSync(path);
    if (named.isSymbolicLink()) {
      // Follow exactly one level so a symlink to a directory is refused
      // (never followed into) rather than opened as if it were a file.
      const target = statSync(path);
      kind = target.isFile() ? "file" : "not_file";
      isDirectory = target.isDirectory();
      sizeAtStat = target.size;
    } else {
      kind = named.isFile() ? "file" : "not_file";
      isDirectory = named.isDirectory();
      sizeAtStat = named.size;
    }
  } catch (error) {
    return statError(path, error);
  }

  if (kind === "not_file") {
    const message = isDirectory ? `${path} is a directory` : `${path} is not a regular file`;
    return { ok: false, state: "not_file", message, bytes: null };
  }

  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    return openError(path, error, sizeAtStat);
  }

  try {
    // Read one byte past maxBytes so a larger file is detected without ever
    // reading the whole of it.
    const capacity = maxBytes + 1;
    const buffer = Buffer.alloc(capacity);
    let length = 0;
    while (length < capacity) {
      const read = readSync(fd, buffer, length, capacity - length, null);
      if (read === 0) break;
      length += read;
    }

    const truncated = length > maxBytes;
    const raw = buffer.subarray(0, truncated ? maxBytes : length);

    const sniffLength = Math.min(SNIFF_BYTES, raw.length);
    for (let i = 0; i < sniffLength; i++) {
      if (raw[i] === 0) {
        return {
          ok: false,
          state: "binary",
          message: `${path} is not text (binary content)`,
          bytes: raw.length,
        };
      }
    }

    const content = truncated ? trimToBoundary(raw) : raw;

    let text: string;
    try {
      text = STRICT_UTF8.decode(content);
    } catch {
      return {
        ok: false,
        state: "binary",
        message: `${path} is not text (invalid UTF-8)`,
        bytes: content.length,
      };
    }

    const lines = text.length === 0 ? [] : splitLines(text);
    return { ok: true, lines: lines.map(caretSafe), bytes: content.length, truncated };
  } finally {
    closeQuietly(fd);
  }
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Cuts `buf` back to the last complete UTF-8 sequence, preferring the last newline within the final window. */
function trimToBoundary(buf: Buffer): Buffer {
  const safeEnd = utf8SafeEnd(buf, buf.length);
  const windowStart = Math.max(0, safeEnd - NEWLINE_WINDOW);
  const newline = buf.lastIndexOf(0x0a, safeEnd - 1);
  const end = newline >= windowStart ? newline + 1 : safeEnd;
  return buf.subarray(0, end);
}

/** Steps `end` back over an incomplete trailing UTF-8 sequence, if any. */
function utf8SafeEnd(buf: Buffer, end: number): number {
  let i = end - 1;
  let back = 0;
  while (i >= 0 && back < 4 && (buf[i]! & 0xc0) === 0x80) {
    i--;
    back++;
  }
  if (i < 0) return end;
  const lead = buf[i]!;
  let seqLen: number;
  if ((lead & 0x80) === 0x00) seqLen = 1;
  else if ((lead & 0xe0) === 0xc0) seqLen = 2;
  else if ((lead & 0xf0) === 0xe0) seqLen = 3;
  else if ((lead & 0xf8) === 0xf0) seqLen = 4;
  else return end; // not a valid leader byte; leave to the decoder to reject.
  const have = end - i;
  return have >= seqLen ? end : i;
}

function statError(path: string, error: unknown): ArtifactText {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return { ok: false, state: "missing", message: `${path} does not exist`, bytes: null };
  }
  return {
    ok: false,
    state: "unreadable",
    message: `${path} could not be read: ${(error as Error).message}`,
    bytes: null,
  };
}

function openError(path: string, error: unknown, sizeAtStat: number): ArtifactText {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return { ok: false, state: "missing", message: `${path} does not exist`, bytes: null };
  }
  if (code === "EISDIR") {
    return { ok: false, state: "not_file", message: `${path} is a directory`, bytes: null };
  }
  return {
    ok: false,
    state: "unreadable",
    message: `${path} could not be read: ${(error as Error).message}`,
    bytes: sizeAtStat,
  };
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Closing a descriptor we just successfully read from is not expected to
    // fail; ignore it rather than mask the read's own result.
  }
}
