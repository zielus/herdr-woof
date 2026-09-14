import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";

import { sha256Hex } from "../contracts/canonical-json.js";
import { describeEntryKind } from "../journal/journal.js";
import { writeAll } from "../journal/write-all.js";
import { ensureRealDirectory, symlinkComponentProblem } from "./containment.js";

const { O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_RDONLY, O_WRONLY } = constants;

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

export type ResolveArtifactResult =
  | { ok: true; realPath: string; bytes: Buffer }
  | {
      ok: false;
      reason:
        | "artifact_out_of_scope"
        | "artifact_missing"
        | "artifact_empty"
        | "artifact_too_large"
        | "artifact_hash_mismatch";
      message: string;
    };

class FileTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly size: number,
  ) {
    super(`${path} is ${size} bytes; the limit is ${MAX_ARTIFACT_BYTES}`);
  }
}

class FileChangedError extends Error {}

/**
 * Resolves an envelope artifact path and reads it once. The attempt directory
 * must be a real directory strictly inside the run directory, and the path,
 * after following symlinks, must lie strictly inside that attempt directory.
 * The artifact must be a regular file (inspected with lstat; a FIFO, socket or
 * device is `artifact_missing` and never opened), at most MAX_ARTIFACT_BYTES
 * (`artifact_too_large`, decided from its size without reading it), with
 * non-whitespace content (`artifact_empty`). A file whose size changes while it
 * is read is not stable and is `artifact_hash_mismatch`. Returning the bytes
 * that were checked lets the caller hash and publish exactly those bytes.
 */
export function resolveArtifact(
  runDir: string,
  artifactDir: string,
  relPath: string,
): ResolveArtifactResult {
  const runReal = realpathSync(runDir);
  const scope = resolve(runReal, artifactDir);
  const target = resolve(runReal, relPath);
  if (!isInside(target, scope)) {
    return outOfScope(`${relPath} is outside the attempt directory ${artifactDir}`);
  }

  let scopeReal: string;
  try {
    scopeReal = realpathSync(scope);
  } catch {
    return missing(`attempt directory ${artifactDir} does not exist`);
  }
  // A symlinked attempt directory or ancestor would let files outside the run
  // (or another attempt's files) satisfy the target check below.
  if (scopeReal !== scope || !isInside(scopeReal, runReal)) {
    return outOfScope(
      `attempt directory ${artifactDir} resolves to ${scopeReal}, not a real directory inside the run directory`,
    );
  }

  // Resolve the deepest existing ancestor so a symlinked parent cannot escape
  // the scope even when the file itself does not exist.
  let probe = target;
  let probeReal: string | undefined;
  while (probeReal === undefined) {
    try {
      probeReal = realpathSync(probe);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return missing(`${relPath} cannot be resolved: ${(error as Error).message}`);
      }
      probe = dirname(probe);
    }
  }

  if (probe === target) {
    if (!isInside(probeReal, scopeReal)) {
      return outOfScope(`${relPath} resolves to ${probeReal}, outside ${artifactDir}`);
    }
  } else {
    if (probeReal !== scopeReal && !isInside(probeReal, scopeReal)) {
      return outOfScope(`${relPath} resolves outside ${artifactDir}`);
    }
    return missing(`${relPath} does not exist`);
  }

  let bytes: Buffer;
  try {
    bytes = readRegularFile(probeReal);
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      return {
        ok: false,
        reason: "artifact_too_large",
        message: `${relPath} is ${error.size} bytes; the limit is ${MAX_ARTIFACT_BYTES}`,
      };
    }
    if (error instanceof FileChangedError) {
      return { ok: false, reason: "artifact_hash_mismatch", message: error.message };
    }
    return missing(`${relPath} cannot be read: ${(error as Error).message}`);
  }
  if (bytes.toString("utf8").trim() === "") {
    return {
      ok: false,
      reason: "artifact_empty",
      message: `${relPath} has no non-whitespace content`,
    };
  }
  return { ok: true, realPath: probeReal, bytes };
}

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
 * Publishes accepted bytes at `<runDir>/<acceptedPath>` without ever replacing
 * an existing destination. The destination directory
 * `accepted/<stage>/visit-<n>/attempt-<m>` must consist of real directories
 * inside the run, checked before and after creation. The bytes go to an
 * unpredictable temporary file created with O_EXCL | O_NOFOLLOW, which is
 * fsynced and marked read-only, then hard-linked to the destination (a link,
 * unlike a rename, fails when the destination exists). If a destination exists
 * with identical content it is reused; any other existing entry is a conflict
 * and is left untouched. The temporary name is removed on every path. Returns
 * the published sha256; throws on a refused destination, a conflict or an I/O
 * failure, naming the offending path.
 *
 * Publication is provisional: a copy is accepted only once a
 * `submission.accepted` record references it.
 */
export function publishAccepted(runDir: string, acceptedPath: string, bytes: Uint8Array): string {
  const runReal = realpathSync(runDir);
  const relDir = posix.dirname(acceptedPath);
  const refused = ensureRealDirectory(runReal, relDir);
  if (refused !== undefined) throw new Error(`refused accepted destination: ${refused}`);

  const dest = join(runReal, acceptedPath);
  const tmp = join(runReal, relDir, `${posix.basename(acceptedPath)}.tmp-${randomUUID()}`);
  try {
    const fd = openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    try {
      writeAll(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o444);
    try {
      linkSync(tmp, dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: string;
      try {
        existing = hashFile(dest);
      } catch (inspectError) {
        throw new Error(
          `accepted destination ${acceptedPath} already exists and was not replaced: ${(inspectError as Error).message}`,
          { cause: inspectError },
        );
      }
      if (existing !== sha256Hex(bytes)) {
        throw new Error(
          `accepted destination ${acceptedPath} already exists with different content and was not replaced`,
          { cause: error },
        );
      }
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  return hashFile(dest);
}

/**
 * Removes a provisionally published copy that was never journaled, but only
 * while its directory is still a real in-run directory and its content still
 * hashes to what this submission published.
 */
export function removePublished(runDir: string, acceptedPath: string, publishedSha: string): void {
  try {
    const runReal = realpathSync(runDir);
    if (symlinkComponentProblem(runReal, posix.dirname(acceptedPath)) !== undefined) return;
    const dest = join(runReal, acceptedPath);
    if (hashFile(dest) === publishedSha) rmSync(dest, { force: true });
  } catch {
    // Already gone or unreadable: nothing this submission can safely remove.
  }
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

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

function outOfScope(message: string): ResolveArtifactResult {
  return { ok: false, reason: "artifact_out_of_scope", message };
}

function missing(message: string): ResolveArtifactResult {
  return { ok: false, reason: "artifact_missing", message };
}
