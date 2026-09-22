import { execHerdr, type ExecResult } from "../runtime/herdr/exec.js";
import { shellQuote } from "./files.js";
import { paneIdOf } from "./launch.js";

/**
 * The live watch of a pane-hosted run (on by default; `woof run start --no-watch` opts out): once
 * the run host has opened the run, split a pane below the host pane — the root pane of the host's
 * own tab, so the watch lives inside that tab — and type `woof watch <run-dir> --follow` into it. With `closeOnEnd` the typed command closes the
 * pane once watch exits, whatever the run's outcome (watch exits non-zero for a failed, exhausted
 * or cancelled run); otherwise the pane stays, so the final lines remain readable. A failure here never fails the started run: it is reported as a
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

  const watch = [options.nodePath, options.cliPath, "watch", options.runDir, "--follow"];
  // `herdr pane run` types its words, joined by spaces, into the pane's shell. `watch --follow`
  // exits non-zero for a failed, exhausted or cancelled run, so the close is unconditional and the
  // watch status is what the typed command exits with. The script runs under `sh -c` as one quoted
  // word: `$?` and `exit` then mean the same whatever shell the pane runs, and `exit` ends that
  // `sh`, never the pane's own shell.
  const command = options.closeOnEnd
    ? [
        "sh",
        "-c",
        `${watch.map(shellQuote).join(" ")}; s=$?; ${[options.herdrBin, "pane", "close", paneId]
          .map(shellQuote)
          .join(" ")}; exit $s`,
      ]
    : watch;
  const typed = await exec(["pane", "run", paneId, ...command.map(shellQuote)]);
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
  return { paneId, command };
}

function failure(result: ExecResult): string {
  return (
    result.spawnErrorMessage ??
    (result.stderr.trim().split("\n")[0] || `exit ${result.exitCode ?? result.signal ?? "unknown"}`)
  );
}
