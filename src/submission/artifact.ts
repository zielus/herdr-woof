import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  openSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";

import { sha256Hex } from "../contracts/canonical-json.js";
import {
  FileChangedError,
  FileTooLargeError,
  MAX_ARTIFACT_BYTES,
  hashFile,
  readRegularFile,
  symlinkComponentProblem,
} from "../journal/accepted-copy.js";
import { writeAll } from "../journal/write-all.js";
import { ensureRealDirectory } from "./containment.js";

// The regular-file reader and accepted-copy check live in journal/accepted-copy
// so snapshots can use them without importing the submission layer.
export {
  MAX_ARTIFACT_BYTES,
  acceptedCopyProblem,
  artifactReadHooks,
  hashFile,
  readRegularFile,
  type BeforeRead,
} from "../journal/accepted-copy.js";

const { O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY } = constants;

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
