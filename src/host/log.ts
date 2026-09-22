import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The run host's technical log: every `log()` line of the host (scheduler actions, warnings,
 * metadata-report failures) goes to `<runDir>/host.log`, one timestamped line per entry, appended
 * as it happens. With `echo` the same lines also go to stdout (`woof run host --plain`), in place
 * of the human view. Logging never fails the host: a line that cannot be written is dropped.
 */

export const HOST_LOG_FILE = "host.log";

export function createHostLog(
  runDir: string,
  options: { echo: boolean; write?: (line: string) => void },
): (line: string) => void {
  const path = join(runDir, HOST_LOG_FILE);
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  let created = false;
  return (line: string) => {
    const entry = `${new Date().toISOString()} ${line}`;
    if (options.echo) {
      try {
        write(entry);
      } catch {
        // stdout is gone; the file still has the line.
      }
    }
    try {
      if (!created) {
        // A foreground host logs before the run directory exists (the run's own open creates it).
        mkdirSync(runDir, { recursive: true });
        created = true;
      }
      appendFileSync(path, `${entry}\n`);
    } catch {
      // The log is diagnostics: a directory that cannot be written never fails the host.
    }
  };
}
