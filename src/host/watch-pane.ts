import { execHerdr, type ExecResult } from "../runtime/herdr/exec.js";
import { shellQuote } from "./files.js";
import { paneIdOf } from "./launch.js";

/**
 * `woof run start --watch`: once the run host has opened the run, split a pane below the host pane
 * and type `woof watch <run-dir> --follow` into it. With `closeOnEnd` the typed command closes the
 * pane after watch exits 0 (the run reached its terminal record); otherwise the pane stays, so the
 * final lines remain readable. A failure here never fails the started run: it is reported as a
 * problem next to the launch output.
 */

const PANE_COMMAND_TIMEOUT_MS = 10_000;

export interface WatchPaneOptions {
  runDir: string;
  hostPaneId: string;
  cwd: string;
  closeOnEnd: boolean;
  herdrBin: string;
  env: NodeJS.ProcessEnv;
  nodePath: string;
  cliPath: string;
}

export type WatchPaneResult = { paneId: string; command: string[] } | { problem: string };

export async function openWatchPane(options: WatchPaneOptions): Promise<WatchPaneResult> {
  const exec = (args: string[]) =>
    execHerdr(args, {
      bin: options.herdrBin,
      env: options.env,
      timeoutMs: PANE_COMMAND_TIMEOUT_MS,
      graceMs: 2000,
    });
  const split = await exec([
    "pane",
    "split",
    options.hostPaneId,
    "--direction",
    "down",
    "--cwd",
    options.cwd,
    "--no-focus",
  ]);
  const paneId = split.exitCode === 0 ? paneIdOf(split.stdout) : undefined;
  if (paneId === undefined)
    return { problem: `herdr pane split ${options.hostPaneId} failed: ${failure(split)}` };

  const command = [options.nodePath, options.cliPath, "watch", options.runDir, "--follow"];
  // `&&` is typed as a shell operator, never quoted: the pane closes only after watch exits 0.
  const close = options.closeOnEnd ? ["&&", options.herdrBin, "pane", "close", paneId] : [];
  const typed = await exec([
    "pane",
    "run",
    paneId,
    ...command.map(shellQuote),
    ...(options.closeOnEnd ? ["&&", ...close.slice(1).map(shellQuote)] : []),
  ]);
  if (typed.exitCode !== 0) {
    const closed = await exec(["pane", "close", paneId]);
    return {
      problem: `herdr pane run ${paneId} failed: ${failure(typed)}; ${
        closed.exitCode === 0
          ? `the pane ${paneId} was closed`
          : `the pane ${paneId} could not be closed (${failure(closed)})`
      }`,
    };
  }
  return { paneId, command: [...command, ...close] };
}

function failure(result: ExecResult): string {
  return (
    result.spawnErrorMessage ??
    (result.stderr.trim().split("\n")[0] || `exit ${result.exitCode ?? result.signal ?? "unknown"}`)
  );
}
