import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";

import { gitTopLevel } from "../config/discover.js";
import { recordedWorkflowDefinition } from "../config/record.js";
import { resolveConfiguration } from "../config/resolve.js";
import { defaultIndexDir } from "../inspect/locator.js";
import { colorEnabled } from "../observe/format.js";
import { unicodeEnabled } from "../observe/render-text.js";
import { runFrames, runTui, type TuiOptions } from "../tui/app.js";
import { openTerminal } from "../tui/terminal.js";
import { UsageError, milliseconds, parse, readStdin } from "./common.js";

export const TUI_USAGE = `Usage: woof tui [--project <dir>] [--runs-dir <dir>] [--ascii] [--poll-ms <n>]
       woof tui --frames [--cols <n>] [--rows <n>] [--project <dir>] [--runs-dir <dir>]

An interactive, read-only run browser for the terminal. It lists the runs of the
current project (the git top level of --project, default the working directory;
every project outside a git repository) — active runs and recent history, with
runs needing attention — and opens one into a run view with a compact header and
three tabs: 1 steps (stage visits and checks, expandable to attempts, gate
decisions, routes and their readable files), 2 activity (the run's history in
plain English, followed live until you scroll back) and 3 config (agents and
models, the saved input and the run's context). Accepted artifacts, verification
evidence and dispatched requests open in a pager; esc returns to the entry.
Press ? for keys, q to quit. Quitting ends observation; it never stops a run.

Runs come from the same places woof runs lists (--runs-dir, else the user setting
defaults.runsDir, else ~/.woof/runs, plus the run index without --runs-dir).
Everything shown is read from the run journals, saved inputs and recorded
configuration: no journal lock, no Herdr, no control actions. Colors only when
NO_COLOR is unset or empty; --ascii (or a non-UTF-8 locale) uses ASCII marks.
--poll-ms is how often a followed journal is read (default 250).

--frames is a non-interactive text mode for tests and terminals without raw
input: it reads one command per stdin line (a key name such as down, enter, esc,
tab, shift-tab, left, right, home, end, pgup, pgdn, o, 1, q; "wait <ms>";
"resize <cols>x<rows>") and prints each frame as plain text (default 80x24).
Exits 0 when you quit, 1 on usage (including no terminal without --frames),
2 when the user configuration is invalid.`;

export async function tuiCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(
    () =>
      parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: {
          project: { type: "string" },
          "runs-dir": { type: "string" },
          ascii: { type: "boolean" },
          "poll-ms": { type: "string" },
          frames: { type: "boolean" },
          cols: { type: "string" },
          rows: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      }),
    TUI_USAGE,
  );
  if (values.help === true) {
    console.log(TUI_USAGE);
    return 0;
  }
  if (positionals.length > 0) throw new UsageError(`woof tui takes no arguments\n\n${TUI_USAGE}`);
  if ((values.cols !== undefined || values.rows !== undefined) && values.frames !== true)
    throw new UsageError(`--cols and --rows need --frames\n\n${TUI_USAGE}`);
  const pollMs =
    values["poll-ms"] === undefined
      ? 250
      : milliseconds(values["poll-ms"], "--poll-ms", 20, 60_000);
  const columns = values.cols === undefined ? 80 : size(values.cols, "--cols");
  const rows = values.rows === undefined ? 24 : size(values.rows, "--rows");
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (values.frames !== true && !interactive) {
    throw new UsageError(
      `woof tui needs an interactive terminal on stdin and stdout; use woof watch or woof runs, or --frames\n\n${TUI_USAGE}`,
    );
  }

  let runsDir: string;
  let indexDir: string | null = null;
  if (values["runs-dir"] !== undefined) {
    runsDir = resolve(values["runs-dir"]);
  } else {
    indexDir = defaultIndexDir();
    // The runs directory is a user setting, exactly as woof runs resolves it.
    const resolved = await resolveConfiguration({ projectDir: null });
    if (!resolved.ok) {
      console.error(`woof tui: ${resolved.reason}: ${resolved.message}`);
      return 2;
    }
    runsDir = resolved.configuration.settings.runsDir.value;
  }
  // The project is the git top level, as the run's recorded configuration names it.
  const start = resolve(values.project ?? process.cwd());
  const project = (await gitTopLevel(start)) ?? (values.project === undefined ? null : start);

  const options: TuiOptions = {
    runsDir,
    indexDir,
    project,
    projectLabel: project === null ? "all projects" : basename(project),
    definitionFor: recordedWorkflowDefinition,
    pollMs,
    refreshMs: 1000,
    ascii: values.ascii === true || !unicodeEnabled(process.env),
    color: colorEnabled({ isTTY: process.stdout.isTTY, env: process.env }),
  };
  if (values.frames === true) {
    const script = new TextDecoder().decode(await readStdin()).split("\n");
    return runFrames(options, script, { columns, rows }, (text) => process.stdout.write(text));
  }
  return runTui(options, openTerminal(process.stdin, process.stdout));
}

function size(value: string, flag: string): number {
  if (!/^[1-9][0-9]{0,3}$/.test(value))
    throw new UsageError(`${flag} must be an integer between 1 and 9999\n\n${TUI_USAGE}`);
  return Number(value);
}
