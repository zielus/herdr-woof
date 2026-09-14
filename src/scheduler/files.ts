import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { join, posix } from "node:path";

import { sha256Hex } from "../contracts/canonical-json.js";
import { symlinkComponentProblem } from "../journal/accepted-copy.js";

/**
 * Engine-owned files under the run directory (request texts, check evidence):
 * created exclusively as read-only regular files inside real directories, never
 * through a symlink. Rewriting identical bytes is allowed so a retried write is
 * not an error; other content is refused.
 */

export interface WrittenFile {
  /** Absolute path. */
  path: string;
  sha256: string;
  bytes: number;
}

export function writeEngineFile(runDir: string, relPath: string, bytes: Uint8Array): WrittenFile {
  const runReal = realpathSync(runDir);
  const relDir = posix.dirname(relPath);
  const before = symlinkComponentProblem(runReal, relDir);
  if (before !== undefined) throw new Error(`refused engine file ${relPath}: ${before}`);
  const dir = join(runReal, relDir);
  mkdirSync(dir, { recursive: true });
  const after = symlinkComponentProblem(runReal, relDir);
  if (after !== undefined || realpathSync(dir) !== dir) {
    throw new Error(
      `refused engine file ${relPath}: ${after ?? "directory moved outside the run"}`,
    );
  }
  const path = join(runReal, relPath);
  const { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_WRONLY } = constants;
  let fd: number;
  try {
    fd = openSync(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const readFd = openSync(path, O_RDONLY | O_NOFOLLOW);
    let existing: Buffer;
    try {
      existing = readFileSync(readFd);
    } finally {
      closeSync(readFd);
    }
    if (!existing.equals(bytes)) {
      throw new Error(`engine file ${relPath} already exists with other content`, {
        cause: error,
      });
    }
    return { path, sha256: sha256Hex(existing), bytes: existing.byteLength };
  }
  try {
    let offset = 0;
    while (offset < bytes.byteLength)
      offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
    fsyncSync(fd);
    // The mode is set on the open descriptor, never by path: a replaced path cannot redirect it.
    fchmodSync(fd, 0o444);
  } finally {
    closeSync(fd);
  }
  return { path, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
}
