import { spawn } from "node:child_process";

export interface ExecOptions {
  bin: string;
  env: NodeJS.ProcessEnv;
  /** The command's own timeout; the child is killed after timeoutMs + graceMs. */
  timeoutMs: number;
  graceMs: number;
}

export interface ExecResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started (for example ENOENT or EACCES). */
  spawnErrorCode: string | null;
  spawnErrorMessage: string | null;
  /** The adapter killed the child after its deadline. */
  killed: boolean;
}

/**
 * Runs the Herdr CLI with an argv array (never a shell), collecting stdout and
 * stderr. The child is killed with SIGKILL once `timeoutMs + graceMs` elapse.
 * Never rejects: spawn failures are reported in the result.
 */
export function execHerdr(args: readonly string[], options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    const finish = (result: Omit<ExecResult, "stdout" | "stderr" | "killed">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, killed });
    };
    const child = spawn(options.bin, [...args], {
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, options.timeoutMs + options.graceMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish({
        exitCode: null,
        signal: null,
        spawnErrorCode: error.code ?? "UNKNOWN",
        spawnErrorMessage: error.message,
      }),
    );
    child.on("close", (exitCode, signal) =>
      finish({ exitCode, signal, spawnErrorCode: null, spawnErrorMessage: null }),
    );
  });
}
