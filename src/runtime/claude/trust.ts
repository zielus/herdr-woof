import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Operator-trust pre-flight (p4 D10): reads Claude Code's `~/.claude.json`
 * read-only and reports whether the operator accepted the folder-trust
 * question for exactly this directory. Advisory only: it never rejects a run,
 * never writes, and an ancestor's trust does not count.
 */

export type ClaudeTrustStatus = "trusted" | "untrusted" | "unknown";

export interface ClaudeTrust {
  dir: string;
  status: ClaudeTrustStatus;
  /** The file that was read. */
  path: string;
}

const MAX_CLAUDE_JSON_BYTES = 16 * 1024 * 1024;

/** Trust status from the text of `.claude.json` for any of the given directory keys (pure). */
export function trustStatusFromJson(text: string, dirs: readonly string[]): ClaudeTrustStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "unknown";
  }
  if (!isObject(parsed)) return "unknown";
  const projects = parsed["projects"];
  if (!isObject(projects)) return "unknown";
  for (const dir of dirs) {
    const entry = Object.hasOwn(projects, dir) ? projects[dir] : undefined;
    if (isObject(entry) && entry["hasTrustDialogAccepted"] === true) return "trusted";
  }
  return "untrusted";
}

export function claudeTrustStatus(dir: string, options: { homeDir?: string } = {}): ClaudeTrust {
  const absolute = resolve(dir);
  const path = join(options.homeDir ?? homedir(), ".claude.json");
  const dirs = [absolute];
  try {
    const real = realpathSync(absolute);
    if (real !== absolute) dirs.push(real);
  } catch {
    // An unresolvable directory is looked up by its given path only.
  }
  const text = readSmallRegularFile(path);
  return {
    dir: absolute,
    path,
    status: text === undefined ? "unknown" : trustStatusFromJson(text, dirs),
  };
}

function readSmallRegularFile(path: string): string | undefined {
  try {
    const named = statSync(path);
    if (!named.isFile() || named.size > MAX_CLAUDE_JSON_BYTES) return undefined;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_CLAUDE_JSON_BYTES) return undefined;
      const buffer = Buffer.alloc(opened.size);
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, null);
        if (read === 0) break;
        length += read;
      }
      return buffer.subarray(0, length).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
