import { closeSync, constants, fstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

import { sanitize } from "../observe/format.js";

/**
 * The run host's technical log: every `log()` line of the host (scheduler actions, warnings,
 * metadata-report failures) goes to `<runDir>/host.log`, one timestamped line per entry, appended
 * as it happens. With `echo` the same lines also go to stdout (`woof run host --plain`), in place
 * of the human view. Logging never fails the host: a line that cannot be written is dropped.
 *
 * The log must never block the scheduler. Agents working for the run can write into the run
 * directory, so `host.log` is opened ONCE, on the first line, without following a symlink and
 * without blocking (a FIFO with no reader is refused at open rather than waited on), and is kept
 * only when it is a regular file; the descriptor stays on that inode whatever replaces the name
 * later. A refused log says so once on stderr and then drops its lines. Every line is sanitized
 * (control characters become spaces) before it reaches the file or stdout, so a check argv or a
 * message carrying ESC, CR or LF cannot drive the host's terminal.
 */

export const HOST_LOG_FILE = "host.log";

export interface HostLogOptions {
  /** Also write each line to stdout (`--plain`). */
  echo: boolean;
  /** The stdout writer; defaults to `process.stdout.write`. */
  write?: (line: string) => void;
  /** Where the one refusal notice goes; defaults to stderr as `woof: <message>`. */
  warn?: (message: string) => void;
}

export function createHostLog(runDir: string, options: HostLogOptions): (line: string) => void {
  const path = join(runDir, HOST_LOG_FILE);
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const warn =
    options.warn ??
    ((message: string) => {
      try {
        process.stderr.write(`woof: ${message}\n`);
      } catch {
        // stderr is gone too; nothing else can be told.
      }
    });
  /** undefined: not opened yet; null: refused or failed (lines are dropped); a number: the fd. */
  let fd: number | null | undefined;
  return (line: string) => {
    const entry = `${new Date().toISOString()} ${sanitize(line)}`;
    if (options.echo) {
      try {
        write(entry);
      } catch {
        // stdout is gone; the file still has the line.
      }
    }
    if (fd === undefined) fd = open();
    if (fd === null) return;
    try {
      writeSync(fd, `${entry}\n`);
    } catch {
      // EAGAIN, EPIPE, ENOSPC or anything else: the log is diagnostics, the line is dropped.
    }
  };

  function open(): number | null {
    const { O_APPEND, O_CREAT, O_NOFOLLOW, O_NONBLOCK, O_WRONLY } = constants;
    let opened: number;
    try {
      // A foreground host logs before the run directory exists (the run's own open creates it).
      mkdirSync(runDir, { recursive: true });
      opened = openSync(path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o644);
    } catch (error) {
      warn(`${path} cannot be opened (${describe(error)}); the technical log is dropped`);
      return null;
    }
    try {
      if (fstatSync(opened).isFile()) return opened;
    } catch (error) {
      close(opened);
      warn(`${path} cannot be inspected (${describe(error)}); the technical log is dropped`);
      return null;
    }
    close(opened);
    warn(`${path} is not a regular file; the technical log is dropped`);
    return null;
  }
}

function describe(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : sanitize(String((error as Error).message));
}

function close(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Already closed or never valid: nothing to release.
  }
}
