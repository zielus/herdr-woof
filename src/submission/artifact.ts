import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { sha256Hex } from "../contracts/canonical-json.js";

export type ResolveArtifactResult =
  | { ok: true; realPath: string; bytes: Buffer }
  | {
      ok: false;
      reason: "artifact_out_of_scope" | "artifact_missing" | "artifact_empty";
      message: string;
    };

/**
 * Resolves an envelope artifact path and reads it once. The path, after
 * following symlinks, must lie strictly inside the attempt's output directory;
 * it must be a regular file with non-whitespace content. Returning the bytes
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

export function hashFile(path: string): string {
  return sha256Hex(readFileSync(path));
}

/**
 * Publishes accepted bytes immutably at `<runDir>/<acceptedPath>`: write a
 * temporary file, fsync, mark read-only, rename into place, then re-hash the
 * published file. Returns the published sha256; throws on I/O failure.
 */
export function publishAccepted(runDir: string, acceptedPath: string, bytes: Uint8Array): string {
  const dest = join(runDir, acceptedPath);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o444);
  renameSync(tmp, dest);
  return hashFile(dest);
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
