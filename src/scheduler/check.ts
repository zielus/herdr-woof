import { spawn } from "node:child_process";

/**
 * Engine-run check execution (D3): runs an argv (no shell) in the repository
 * with a bounded timeout. The combined stdout and stderr tail, at most 1 MiB,
 * is the evidence. A timeout kills the whole process group (SIGTERM, then
 * SIGKILL after a grace period). A command that cannot be started is a failed
 * check whose evidence names the error.
 */

export const MAX_CHECK_OUTPUT_BYTES = 1024 * 1024;

export interface CheckRun {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  /** Evidence bytes: a header line, then the output tail. */
  output: Buffer;
}

export async function runCheck(options: {
  argv: readonly string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  graceMs?: number;
}): Promise<CheckRun> {
  const [command, ...args] = options.argv;
  const graceMs = options.graceMs ?? 2000;
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  const keep = (chunk: Buffer) => {
    chunks.push(chunk);
    size += chunk.byteLength;
    while (size > MAX_CHECK_OUTPUT_BYTES && chunks.length > 0) {
      const first = chunks[0] as Buffer;
      const excess = size - MAX_CHECK_OUTPUT_BYTES;
      truncated = true;
      if (first.byteLength <= excess) {
        chunks.shift();
        size -= first.byteLength;
      } else {
        chunks[0] = first.subarray(excess);
        size -= excess;
      }
    }
  };

  return new Promise((resolve) => {
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const child = spawn(command ?? "", args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // Already exited.
      }
    };
    const stop = () => {
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), graceMs).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const finish = (exitCode: number | null, signal: string | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const header = [
        `$ ${options.argv.join(" ")}`,
        `# cwd ${options.cwd}`,
        error !== undefined
          ? `# failed to start: ${error.message}`
          : `# exit ${exitCode ?? "none"} signal ${signal ?? "none"}${timedOut ? ` timed out after ${options.timeoutMs} ms` : ""}`,
        ...(truncated ? [`# output truncated to the last ${MAX_CHECK_OUTPUT_BYTES} bytes`] : []),
        "",
      ].join("\n");
      resolve({
        exitCode,
        signal,
        timedOut,
        aborted,
        output: Buffer.concat([Buffer.from(header, "utf8"), ...chunks]),
      });
    };
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, signal) => finish(code, signal));
    if (options.signal?.aborted === true) onAbort();
  });
}
