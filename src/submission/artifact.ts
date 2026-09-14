import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";

import { sha256Hex } from "../contracts/canonical-json.js";
import { writeAll } from "../journal/write-all.js";
import { ensureRealDirectory, symlinkComponentProblem } from "./containment.js";

const { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_WRONLY } = constants;

export type ResolveArtifactResult =
  | { ok: true; realPath: string; bytes: Buffer }
  | {
      ok: false;
      reason: "artifact_out_of_scope" | "artifact_missing" | "artifact_empty";
      message: string;
    };

/**
 * Resolves an envelope artifact path and reads it once. The attempt directory
 * must be a real directory strictly inside the run directory, and the path,
 * after following symlinks, must lie strictly inside that attempt directory;
 * the artifact must be a regular file with non-whitespace content. Returning the
 * bytes that were checked lets the caller hash and publish exactly those bytes.
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

  if (!statSync(probeReal).isFile()) {
    return missing(`${relPath} is not a regular file`);
  }
  const bytes = readFileSync(probeReal);
  if (bytes.toString("utf8").trim() === "") {
    return {
      ok: false,
      reason: "artifact_empty",
      message: `${relPath} has no non-whitespace content`,
    };
  }
  return { ok: true, realPath: probeReal, bytes };
}

/** Reads a regular file without following a symlink at its final component. */
function readRegularFile(path: string): Buffer {
  const fd = openSync(path, O_RDONLY | O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function hashFile(path: string): string {
  return sha256Hex(readRegularFile(path));
}

/**
 * Publishes accepted bytes at `<runDir>/<acceptedPath>`. The destination
 * directory `accepted/<stage>/visit-<n>/attempt-<m>` must consist of real
 * directories inside the run, checked before and after creation. The bytes go to
 * an unpredictable temporary file created with O_EXCL | O_NOFOLLOW, which is
 * fsynced, marked read-only and renamed into place; the published file is then
 * re-hashed without following symlinks. The temporary file is removed on every
 * failure. Returns the published sha256; throws on a refused destination or an
 * I/O failure, naming the offending path component.
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
    renameSync(tmp, dest);
  } finally {
    // After a successful rename the temporary name no longer exists.
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
 * run and matches its journal record. Returns a description of the problem, or
 * undefined when the copy is intact.
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
