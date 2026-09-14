import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, posix } from "node:path";

import { sha256Hex } from "../contracts/canonical-json.js";
import { describeEntryKind } from "./journal.js";

/**
 * Accepted-copy integrity shared by the submission path and snapshots: the
 * lstat-first regular-file reader, the symlink-component walk and the check
 * that an accepted copy still matches its journal record. It lives beside the
 * journal so that `state/` and `submission/` both reach it without importing
 * each other.
 */

const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = constants;

/**
 * Largest artifact `submitResult` accepts: 32 MiB. The size is checked from
 * lstat before the artifact is opened, and reads never go past this cap.
 */
export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

export type BeforeRead = (fd: number, path: string) => void;

/**
 * Test seam for the read path, not exposed through the SDK entry point or the
 * CLI. `beforeRead` runs after a file is opened and validated and before its
 * bytes are read; the default does nothing.
 */
export const artifactReadHooks: { beforeRead: BeforeRead } = {
  beforeRead: () => undefined,
};

export class FileTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly size: number,
  ) {
    super(`${path} is ${size} bytes; the limit is ${MAX_ARTIFACT_BYTES}`);
  }
}

export class FileChangedError extends Error {}

/**
 * Reads a regular file of at most MAX_ARTIFACT_BYTES. The entry is inspected
 * with lstat first, so a FIFO, socket, device, directory or symlink is refused
 * without being opened; the open uses O_NOFOLLOW | O_NONBLOCK and the descriptor
 * must still be the same regular file. After reading, the descriptor is
 * fstat-ed again: any size change (growth or shrinkage) throws, because the
 * bytes read are not a stable version of the file. Throws FileTooLargeError
 * above the cap.
 */
export function readRegularFile(
  path: string,
  beforeRead: BeforeRead = artifactReadHooks.beforeRead,
): Buffer {
  const named = lstatSync(path);
  if (!named.isFile()) {
    throw new Error(`${path} is not a regular file (${describeEntryKind(named)})`);
  }
  if (named.size > MAX_ARTIFACT_BYTES) throw new FileTooLargeError(path, named.size);

  const fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== named.ino || opened.dev !== named.dev) {
      throw new Error(`${path} changed while it was opened`);
    }
    beforeRead(fd, path);
    // One byte past the expected size (capped) detects growth during the read.
    const buffer = Buffer.alloc(Math.min(opened.size, MAX_ARTIFACT_BYTES) + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    const final = fstatSync(fd);
    if (final.size !== opened.size || length !== opened.size) {
      throw new FileChangedError(
        `${path} changed size while it was read (${opened.size} → ${final.size} bytes); the artifact is not stable`,
      );
    }
    if (final.size > MAX_ARTIFACT_BYTES) throw new FileTooLargeError(path, final.size);
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

export function hashFile(path: string): string {
  return sha256Hex(readRegularFile(path));
}

/**
 * Walks `relDir` (POSIX, relative) below the run directory's real path and
 * describes the first existing component that is a symlink. A symlinked
 * engine directory could place attempt artifacts or accepted copies outside the
 * run, or alias another attempt. The walk stops at the first missing component;
 * the caller creates the rest as real directories.
 */
export function symlinkComponentProblem(runReal: string, relDir: string): string | undefined {
  let current = runReal;
  let rel = "";
  for (const segment of relDir.split("/")) {
    current = join(current, segment);
    rel = rel === "" ? segment : `${rel}/${segment}`;
    let isSymlink: boolean;
    try {
      isSymlink = lstatSync(current).isSymbolicLink();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      return `cannot inspect ${rel}: ${(error as Error).message}`;
    }
    if (isSymlink) {
      return `${rel} is a symlink; engine directories under the run directory must be real directories`;
    }
  }
  return undefined;
}

/**
 * Checks that an accepted copy is still a regular file at its place inside the
 * run and matches its journal record. A non-regular entry (FIFO, socket,
 * directory, symlink) is reported without being opened. Returns a description
 * of the problem, or undefined when the copy is intact.
 */
export function acceptedCopyProblem(
  runDir: string,
  artifact: { acceptedPath: string; sha256: string; bytes: number },
): string | undefined {
  let bytes: Buffer;
  try {
    const runReal = realpathSync(runDir);
    const component = symlinkComponentProblem(runReal, posix.dirname(artifact.acceptedPath));
    if (component !== undefined) {
      return `accepted copy ${artifact.acceptedPath} is not inside the run directory: ${component}`;
    }
    bytes = readRegularFile(join(runReal, artifact.acceptedPath));
  } catch (error) {
    return `accepted copy ${artifact.acceptedPath} is unreadable: ${(error as Error).message}`;
  }
  if (bytes.byteLength !== artifact.bytes || sha256Hex(bytes) !== artifact.sha256) {
    return `accepted copy ${artifact.acceptedPath} no longer matches its journal record`;
  }
  return undefined;
}
