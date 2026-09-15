import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";

/**
 * Run-directory files the host and launcher own (`launch.json`,
 * `outcome.json`): created exclusively as regular files, never through a
 * symlink, and read back only when they are regular files.
 */

export function writeExclusiveFile(path: string, bytes: Uint8Array, mode: number): void {
  const { O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY } = constants;
  const fd = openSync(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
  try {
    let offset = 0;
    while (offset < bytes.byteLength)
      offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
    fsyncSync(fd);
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

/** Parsed JSON of a regular file of at most `maxBytes`; undefined when absent, irregular, oversized or invalid. */
export function readJsonFile(path: string, maxBytes = 1024 * 1024 * 2): unknown {
  try {
    const named = lstatSync(path);
    if (!named.isFile() || named.size > maxBytes) return undefined;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > maxBytes) return undefined;
      const buffer = Buffer.alloc(opened.size);
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, null);
        if (read === 0) break;
        length += read;
      }
      return JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** Whether any directory entry (including a symlink or FIFO) exists at the path. */
export function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A POSIX shell word for `herdr pane run` text. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}
