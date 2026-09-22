import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  artifactRel,
  cliPath,
  envelopeFor,
  openAttemptOk,
  openPlannedRun,
  repoRoot,
  submit,
  terminateRunOk,
  writeArtifact,
} from "./helpers/process.js";

// `woof tui` as a real process: the `--frames` text mode driven by a stdin script, and the
// interactive mode in a real pseudo-terminal. Every child runs with its cwd in a temporary
// directory outside any git repository and without --project, so the list is not scoped to a
// project and runs without a recorded configuration (the fixtures, the helper-built runs) appear;
// --runs-dir keeps the user configuration and run index out of it.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // Already gone.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const EXHAUSTED = join(repoRoot, "test", "fixtures", "watch-exhausted-journal.jsonl");
const LATE_REJECTION = join(
  repoRoot,
  "test",
  "fixtures",
  "watch-rejected-after-cancel-journal.jsonl",
);
const EXHAUSTED_TITLE = "build-review · br-20260915-163210-23d435";
const KILL_MS = 15_000;
// oxlint-disable-next-line no-control-regex
const ESCAPE = /\u001B/;

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** A base directory (the child's cwd and HOME, outside any git repository) holding `runs/`. */
function workspace(): { base: string; runs: string } {
  const base = tempDir("woof-tui-");
  const runs = join(base, "runs");
  mkdirSync(runs);
  return { base, runs };
}

function fixtureRun(runs: string, name: string, journal: string): string {
  const runDir = join(runs, name);
  mkdirSync(runDir);
  copyFileSync(journal, join(runDir, "journal.jsonl"));
  return runDir;
}

function childEnv(base: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: base,
    TZ: "UTC",
    LANG: "en_US.UTF-8",
    ...extra,
  };
  for (const key of [
    "NO_COLOR",
    "LC_ALL",
    "LC_CTYPE",
    "HERDR_PANE_ID",
    "HERDR_WORKSPACE_ID",
    "WOOF_RUN_DIR",
    "WOOF_INDEX_DIR",
  ]) {
    if (!(key in extra)) Reflect.deleteProperty(env, key);
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) Reflect.deleteProperty(env, key);
  }
  return env;
}

interface Frame {
  label: string;
  lines: string[];
}

interface FramesResult {
  status: number | null;
  stdout: string;
  stderr: string;
  frames: Frame[];
}

function parseFrames(stdout: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of stdout.split("\n")) {
    const header = /^--- (.*) ---$/.exec(line);
    if (header !== null) frames.push({ label: header[1] ?? "", lines: [] });
    else frames.at(-1)?.lines.push(line);
  }
  // The output ends with a newline: the last frame's trailing empty string is not a row.
  const last = frames.at(-1);
  if (last !== undefined && last.lines.at(-1) === "") last.lines.pop();
  return frames;
}

interface TuiRun {
  base: string;
  runs: string;
  args?: string[];
  env?: Record<string, string | undefined>;
}

function tuiArgs(run: TuiRun): string[] {
  return [cliPath, "tui", "--runs-dir", run.runs, ...(run.args ?? [])];
}

/** `woof tui --frames` with `script` on stdin, synchronously. */
function frames(run: TuiRun, script: string[]): FramesResult {
  const result = spawnSync("node", [...tuiArgs(run), "--frames"], {
    cwd: run.base,
    env: childEnv(run.base, run.env),
    input: `${script.join("\n")}\n`,
    encoding: "utf8",
    timeout: KILL_MS,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    frames: parseFrames(result.stdout),
  };
}

/**
 * `woof tui --frames` without blocking: each trigger runs its `action` once the streamed
 * output contains its `text` (the child printed that frame and is working through the rest of the
 * script, typically a `wait`).
 */
function framesAsync(
  run: TuiRun,
  script: string[],
  triggers: Array<{ text: string; action: () => void }>,
): Promise<FramesResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [...tuiArgs(run), "--frames"], {
      cwd: run.base,
      env: childEnv(run.base, run.env),
    });
    const killer = setTimeout(() => child.kill("SIGKILL"), KILL_MS);
    let stdout = "";
    let stderr = "";
    const pending = [...triggers];
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      while (pending.length > 0 && stdout.includes(pending[0]!.text)) {
        try {
          pending.shift()!.action();
        } catch (error) {
          child.kill("SIGKILL");
          reject(error as Error);
        }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr, frames: parseFrames(stdout) });
    });
    child.stdin.end(`${script.join("\n")}\n`);
  });
}

function frameOf(result: FramesResult, label: string, nth = 0): Frame {
  const found = result.frames.filter((frame) => frame.label === label)[nth];
  if (found === undefined)
    throw new Error(`no frame ${label}#${nth} in:\n${result.stdout}\n${result.stderr}`);
  return found;
}

function text(frame: Frame): string {
  return frame.lines.join("\n");
}

/** The line holding the selection cursor. */
function cursorLine(frame: Frame): string | undefined {
  return frame.lines.find((line) => line.includes("›"));
}

/** A run opened through the compiled store with an accepted report artifact holding `content`. */
function acceptedRun(runs: string, content: string): string {
  const runDir = join(runs, "r1");
  mkdirSync(runDir);
  openPlannedRun(runDir);
  openAttemptOk(runDir);
  const sha = writeArtifact(runDir, artifactRel(), content);
  const submitted = submit(runDir, envelopeFor({ artifact: { path: artifactRel(), sha256: sha } }));
  if (submitted.json?.outcome !== "accepted")
    throw new Error(`submit: ${submitted.stdout}${submitted.stderr}`);
  return runDir;
}

describe("woof tui --frames", () => {
  it("T1: empty, missing and unreadable runs directories get distinct messages", () => {
    const { base, runs } = workspace();
    const wide = ["--cols", "200"];

    const missing = join(base, "nope");
    const absent = frames({ base, runs: missing, args: wide }, ["q"]);
    expect(absent.status, absent.stderr).toBe(0);
    expect(text(frameOf(absent, "start"))).toContain(`No runs yet: ${missing} does not exist.`);

    const empty = frames({ base, runs, args: wide }, ["q"]);
    expect(empty.status, empty.stderr).toBe(0);
    expect(text(frameOf(empty, "start"))).toContain(`No runs for all projects in ${runs}.`);
    expect(text(frameOf(empty, "start"))).not.toContain("does not exist");

    const file = join(base, "file");
    writeFileSync(file, "not a directory\n");
    const notDir = frames({ base, runs: file, args: wide }, ["q"]);
    expect(notDir.status, notDir.stderr).toBe(0);
    expect(text(frameOf(notDir, "start"))).toContain(
      `Cannot read the runs directory: ${file} is not a directory`,
    );

    if (process.getuid?.() !== 0) {
      const locked = join(base, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      const unreadable = frames({ base, runs: locked, args: wide }, ["q"]);
      chmodSync(locked, 0o755);
      expect(unreadable.status, unreadable.stderr).toBe(0);
      expect(text(frameOf(unreadable, "start"))).toContain("Cannot read the runs directory: ");
    }
  });

  it("T2: a finished run opens into steps, activity and config, and esc returns to the same row", () => {
    const { base, runs } = workspace();
    fixtureRun(runs, "exhausted", EXHAUSTED);
    fixtureRun(runs, "late", LATE_REJECTION);
    const start = frames({ base, runs }, ["q"]);
    const rows = frameOf(start, "start").lines.filter((line) => /^[›\s] \S/.test(line));
    const exhaustedIndex = rows.findIndex((line) => line.includes(EXHAUSTED_TITLE));
    expect(exhaustedIndex, text(frameOf(start, "start"))).toBeGreaterThanOrEqual(0);
    expect(rows[exhaustedIndex]).toMatch(/^[›\s] exhausted\s/);
    const moves = Array.from({ length: exhaustedIndex }, () => "down");

    const result = frames({ base, runs }, [...moves, "enter", "right", "2", "3", "esc", "q"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toMatch(ESCAPE);

    const opened = frameOf(result, "enter");
    expect(opened.lines[0]).toMatch(/^woof {2}build-review · br-20260915-163210-23d435\s+history$/);
    expect(opened.lines[1]).toBe("build-review  exhausted · review 3  3m 58s");
    expect(opened.lines[3]).toContain("1 steps");
    expect(opened.lines[3]).toContain("2 activity");
    expect(opened.lines[3]).toContain("3 config");
    expect(cursorLine(opened)).toMatch(/^› ▸ ✓ build\s+builder\s+accepted\s+42s 1 output$/);
    for (const step of ["verify", "review", "review 2", "review 3"])
      expect(text(opened)).toMatch(new RegExp(`▸ . ${step}\\s`));

    const expanded = frameOf(result, "right");
    expect(cursorLine(expanded)).toMatch(/^› ▾ ✓ build\s/);
    expect(text(expanded)).toContain("│ attempt 1  dispatched 16:32:18 → accepted 16:33:00");
    expect(text(expanded)).toContain("│ gate       passed → verify");
    expect(text(expanded)).toContain("├ artifact    completion.md");

    const activity = text(frameOf(result, "2"));
    expect(activity).toContain("16:33:07 → reviewer review  Task dispatched");
    expect(activity).toContain(
      "16:34:16 ↓ reviewer review  Review received · approval recommended",
    );
    expect(activity).toContain("16:36:10 ↻ gate     review  Revision changed → review again");
    // Raw event names stay out of the narrative.
    expect(activity).not.toMatch(/attempt_opened|result_accepted|run_terminated/);

    const config = frameOf(result, "3").lines;
    expect(config).toContain("agents");
    expect(config.some((line) => /^builder\s+claude\s+sonnet\s+build, repair$/.test(line))).toBe(
      true,
    );
    expect(config.some((line) => line.startsWith("input"))).toBe(true);
    expect(config).toContain("context");
    expect(config.some((line) => /^run\s+br-20260915-163210-23d435$/.test(line))).toBe(true);

    const back = frameOf(result, "esc");
    expect(back.lines[0]).toMatch(/^woof {2}runs \/ all projects/);
    expect(cursorLine(back)).toMatch(/^› exhausted\s+build-review · br-20260915-163210-23d435/);
  });

  it("T3: an artifact opens in a pager with its path, control bytes shown as carets, esc back to the entry", () => {
    const { base, runs } = workspace();
    const runDir = acceptedRun(runs, "# Report\n\nred \x1b[31mALERT\x1b[0m done\n");
    const accepted = join(runDir, "accepted", "report", "visit-1", "attempt-1", "report.md");
    const script = ["enter", "right", "right", "right", "esc", "q"];

    const result = frames({ base, runs, args: ["--cols", "200"] }, script);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toMatch(ESCAPE);
    const onArtifact = frameOf(result, "right", 1);
    expect(cursorLine(onArtifact)).toMatch(/└ artifact\s+›report\.md/);

    const pager = frameOf(result, "right", 2).lines;
    expect(pager[0]).toMatch(/^woof {2}report-review · run-1\s/);
    expect(pager).toContain(" artifact pager");
    expect(
      pager.some((line) =>
        line.startsWith("report.md · report · accepted report / visit 1 / attempt 1"),
      ),
    ).toBe(true);
    expect(pager).toContain(accepted);
    expect(pager).toContain("# Report");
    expect(pager).toContain("red ^[[31mALERT^[[0m done");
    expect(pager.some((line) => line.startsWith("(END) lines 1-3 of 3"))).toBe(true);

    const back = frameOf(result, "esc");
    expect(back.lines).not.toContain(" artifact pager");
    expect(cursorLine(back)).toMatch(/└ artifact\s+›report\.md/);

    // The accepted copy is gone: the pager says so and keeps the recorded reference.
    rmSync(accepted);
    const gone = frames({ base, runs, args: ["--cols", "200"] }, script);
    expect(gone.status, gone.stderr).toBe(0);
    const missing = frameOf(gone, "right", 2).lines;
    expect(missing).toContain(accepted);
    expect(missing).toContain(`missing: ${accepted} does not exist`);
    expect(cursorLine(frameOf(gone, "esc"))).toMatch(/└ artifact\s+›report\.md/);
  });

  it("T4: a followed run shows new activity once, as it is appended", async () => {
    const { base, runs } = workspace();
    const runDir = join(runs, "r1");
    mkdirSync(runDir);
    openPlannedRun(runDir);
    openAttemptOk(runDir);
    const sha = writeArtifact(runDir, artifactRel(), "# Report\n");
    const envelope = envelopeFor({ artifact: { path: artifactRel(), sha256: sha } });

    const result = await framesAsync(
      { base, runs },
      ["enter", "2", "wait 5000", "frame", "q"],
      [
        {
          text: "--- 2 ---",
          action: () => {
            const submitted = submit(runDir, envelope);
            if (submitted.json?.outcome !== "accepted")
              throw new Error(`submit: ${submitted.stdout}${submitted.stderr}`);
            terminateRunOk(runDir);
          },
        },
      ],
    );
    expect(result.status, result.stderr).toBe(0);
    const before = text(frameOf(result, "2"));
    expect(before).toContain("run              Started");
    expect(before).not.toContain("Review received");
    const after = frameOf(result, "frame");
    const count = (pattern: RegExp) => after.lines.filter((line) => pattern.test(line)).length;
    expect(count(/ Started$/), text(after)).toBe(1);
    expect(count(/worker\s+report\s+Review received/), text(after)).toBe(1);
    expect(text(after)).toMatch(/cancelled/);
  });

  it("T5: scrolling back pauses following; appended rows do not move the viewport", async () => {
    const { base, runs } = workspace();
    const runDir = acceptedRun(runs, "# Report\n");
    openAttemptOk(runDir, { agent: "reviewer", stage: "review", verdicts: "approve,reject" });
    const reviewRel = artifactRel("review", 1, 1, "review.md");
    const sha = writeArtifact(runDir, reviewRel, "# Review\n\nLooks good.\n");
    const review = envelopeFor({
      agentId: "reviewer",
      stageId: "review",
      verdict: "approve",
      artifact: { path: reviewRel, sha256: sha },
    });

    // 10 rows leave two activity rows on screen: "Started" and the report row overflow them.
    const result = await framesAsync(
      { base, runs, args: ["--rows", "10"] },
      ["enter", "2", "k", "wait 5000", "frame", "end", "q"],
      [
        {
          text: "--- k ---",
          action: () => {
            const reviewed = submit(runDir, review);
            if (reviewed.json?.outcome !== "accepted")
              throw new Error(`submit: ${reviewed.stdout}${reviewed.stderr}`);
          },
        },
      ],
    );
    expect(result.status, result.stderr).toBe(0);
    const paused = frameOf(result, "k");
    const later = frameOf(result, "frame");
    const body = (frame: Frame) => frame.lines.slice(5, -3);
    const status = (frame: Frame) => frame.lines.at(-3) ?? "";
    expect(status(paused), text(paused)).toMatch(/^paused · lines 1-2 of \d+ · end returns/);
    expect(body(paused).join("\n")).toContain("Started");
    // Same rows on screen after the run moved on; the status line counts what arrived.
    expect(body(later)).toEqual(body(paused));
    expect(text(later)).not.toContain("reviewer review");
    expect(status(later), text(later)).toMatch(
      /^paused · lines 1-2 of \d+ · \d+ new · end returns to latest$/,
    );
    const latest = frameOf(result, "end");
    expect(status(latest)).not.toMatch(/^paused/);
    const reviewRows = latest.lines.filter((line) =>
      /reviewer review\s+Review received/.test(line),
    );
    expect(reviewRows, text(latest)).toHaveLength(1);
  });

  it("T6: resize re-renders at the new size, and below 40x10 says so", () => {
    const { base, runs } = workspace();
    fixtureRun(runs, "exhausted", EXHAUSTED);
    const result = frames({ base, runs }, [
      "enter",
      "resize 100x30",
      "resize 39x20",
      "resize 60x9",
      "resize 80x24",
      "q",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(frameOf(result, "enter").lines).toHaveLength(24);
    const wide = frameOf(result, "resize 100x30").lines;
    expect(wide).toHaveLength(30);
    expect(wide).toContain("─".repeat(100));
    expect(wide.every((line) => [...line].length <= 100)).toBe(true);
    expect(wide.some((line) => line.includes(EXHAUSTED_TITLE))).toBe(true);
    for (const label of ["resize 39x20", "resize 60x9"])
      expect(text(frameOf(result, label))).toContain("woof tui needs at least 40x10");
    const restored = frameOf(result, "resize 80x24").lines;
    expect(restored).toHaveLength(24);
    expect(restored).toContain("─".repeat(80));
    expect(cursorLine(frameOf(result, "resize 80x24"))).toMatch(/^› ▸ ✓ build\s/);
  });

  it("T7: frames carry no escape bytes, with or without NO_COLOR", () => {
    const { base, runs } = workspace();
    fixtureRun(runs, "exhausted", EXHAUSTED);
    const script = ["enter", "right", "2", "3", "esc", "q"];
    for (const env of [{}, { NO_COLOR: "1" }]) {
      const result = frames({ base, runs, env }, script);
      expect(result.status, result.stderr).toBe(0);
      expect(result.frames.length).toBe(script.length + 1);
      expect(result.stdout).not.toMatch(ESCAPE);
    }
  });

  it("T8: usage errors exit 1", () => {
    const { base, runs } = workspace();
    const run = (args: string[], stdin = "") =>
      spawnSync("node", [cliPath, "tui", "--runs-dir", runs, ...args], {
        cwd: base,
        env: childEnv(base),
        input: stdin,
        encoding: "utf8",
        timeout: KILL_MS,
      });
    const cols = run(["--cols", "100"]);
    expect(cols.status).toBe(1);
    expect(cols.stderr).toContain("--cols and --rows need --frames");
    const rows = run(["--rows", "30"]);
    expect(rows.status).toBe(1);
    expect(rows.stderr).toContain("--cols and --rows need --frames");
    const positional = run(["extra"]);
    expect(positional.status).toBe(1);
    expect(positional.stderr).toContain("woof tui takes no arguments");
    const noTty = run([], "q\n");
    expect(noTty.status).toBe(1);
    expect(noTty.stderr).toContain("woof tui needs an interactive terminal on stdin and stdout");
    expect(noTty.stdout).not.toMatch(ESCAPE);
    const badCols = run(["--frames", "--cols", "0"]);
    expect(badCols.status).toBe(1);
    expect(badCols.stderr).toContain("--cols must be an integer between 1 and 9999");
  });
});

// A pseudo-terminal driver: forks `argv` on a pty sized 80x24, then plays `steps` — each writes
// bytes (base64), optionally resizes the window (TIOCSWINSZ + SIGWINCH), and reads until the
// output since the step began contains `until` (or `max` seconds pass). Prints the whole output
// (base64) and the exit status as JSON; kills the child after `kill` seconds.
const PTY_DRIVER = String.raw`
import base64, fcntl, json, os, select, signal, struct, sys, termios, time

argv = json.loads(sys.argv[1])
steps = json.loads(sys.argv[2])
kill_after = float(sys.argv[3])

def winsize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

# The parent keeps its own slave descriptor open: some kernels (macOS) discard output that is
# still buffered when the last slave descriptor closes, which would lose the child's final bytes.
fd, slave = os.openpty()
winsize(slave, 80, 24)
pid = os.fork()
if pid == 0:
    os.close(fd)
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    for target in (0, 1, 2):
        os.dup2(slave, target)
    if slave > 2:
        os.close(slave)
    os.execvp(argv[0], argv)

started = time.time()
out = bytearray()
eof = False

def pump(timeout):
    global eof
    if eof:
        return False
    ready, _, _ = select.select([fd], [], [], timeout)
    if not ready:
        return False
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        chunk = b""
    if chunk:
        out.extend(chunk)
        return True
    eof = True
    return False

marks = []
for step in steps:
    mark = len(out)
    if "resize" in step:
        cols, rows = step["resize"]
        winsize(slave, cols, rows)
        os.kill(pid, signal.SIGWINCH)
    if "write" in step:
        os.write(fd, base64.b64decode(step["write"]))
    until = step.get("until")
    deadline = time.time() + step.get("max", 5)
    while time.time() < deadline and not eof:
        pump(0.05)
        if until is not None and until.encode() in bytes(out[mark:]):
            break
    marks.append(mark)

status = None
while time.time() - started < kill_after:
    pump(0.05)
    done, code = os.waitpid(pid, os.WNOHANG)
    if done:
        # Drain what the child wrote before it exited, until the pty stays quiet.
        while pump(0.3):
            pass
        status = os.waitstatus_to_exitcode(code)
        break
else:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)

print(json.dumps({"status": status, "output": base64.b64encode(bytes(out)).decode(), "marks": marks}))
`;

const hasPython =
  spawnSync("python3", ["-c", "import termios, fcntl"], { encoding: "utf8" }).status === 0;

interface PtySession {
  status: number | null;
  output: Buffer;
  /** Byte offset in `output` where each step began. */
  marks: number[];
  runDir: string;
  journalBefore: Buffer;
  filesBefore: string[];
}

/**
 * `woof tui` on the exhausted fixture in a pty: down, enter, right, 2, esc, a resize to 100x30,
 * then q. Each step waits for the text it should produce, so a slow start is not a failure.
 */
function ptySession(): PtySession {
  const { base, runs } = workspace();
  const runDir = fixtureRun(runs, "exhausted", EXHAUSTED);
  const journalBefore = readFileSync(join(runDir, "journal.jsonl"));
  const filesBefore = readdirSync(runDir).toSorted();
  const driver = join(base, "pty-driver.py");
  writeFileSync(driver, PTY_DRIVER);
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
  const steps = [
    { until: "q quit", max: 8 },
    { write: b64("\x1b[B"), max: 0.4 },
    { write: b64("\r"), until: "1 steps", max: 5 },
    { write: b64("\x1b[C"), until: "completion.md", max: 5 },
    { write: b64("2"), until: "Task dispatched", max: 5 },
    // A lone ESC is only a key after the decoder's short flush window: nothing follows it here.
    { write: b64("\x1b"), until: "all projects", max: 5 },
    { resize: [100, 30], until: "─".repeat(100), max: 5 },
    { write: b64("q"), max: 0.2 },
  ];
  const argv = ["node", cliPath, "tui", "--runs-dir", runs];
  const result = spawnSync(
    "python3",
    [driver, JSON.stringify(argv), JSON.stringify(steps), String(KILL_MS / 1000)],
    {
      cwd: base,
      env: childEnv(base, { TERM: "xterm-256color" }),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (result.status !== 0) throw new Error(`pty driver failed: ${result.stdout}${result.stderr}`);
  const report = JSON.parse(result.stdout) as {
    status: number | null;
    output: string;
    marks: number[];
  };
  return {
    status: report.status,
    output: Buffer.from(report.output, "base64"),
    marks: report.marks,
    runDir,
    journalBefore,
    filesBefore,
  };
}

/** The text of `output[from, to)` without escape sequences. */
function plain(output: Buffer, from: number, to?: number): string {
  return (
    output
      .subarray(from, to)
      .toString("utf8")
      // oxlint-disable-next-line no-control-regex
      .replace(/\u001B\[[0-9;?]*[A-Za-z]|\u001B[>=]/g, "")
  );
}

const ENTER_ALT = "\x1b[?1049h";
const LEAVE_ALT = "\x1b[?1049l";
const SHOW_CURSOR = "\x1b[?25h";

describe("woof tui in a pseudo-terminal", () => {
  it.skipIf(!hasPython)(
    "T9: enters and leaves the alternate screen, follows keys and resize, and never writes the run",
    { timeout: 40_000 },
    () => {
      const session = ptySession();
      const { output, marks } = session;
      const raw = output.toString("utf8");

      expect(session.status, plain(output, 0)).toBe(0);
      expect(raw.startsWith(ENTER_ALT)).toBe(true);
      expect(raw).toContain("\x1b[?25l");
      // Quitting shows the cursor again and leaves the alternate screen, once.
      expect(raw.split(`${SHOW_CURSOR}${LEAVE_ALT}`)).toHaveLength(2);
      expect(output.indexOf(LEAVE_ALT)).toBeGreaterThan(marks[7]!);
      // The list, then the opened run with its steps, the expansion, the activity, the list again.
      const list = plain(output, 0, marks[1]);
      expect(list).toContain(EXHAUSTED_TITLE);
      expect(list).toContain("exhausted");
      expect(list).toContain("─".repeat(80));
      expect(list).not.toContain("─".repeat(81));
      const opened = plain(output, marks[2]!, marks[3]);
      expect(opened).toContain("1 steps");
      expect(opened).toMatch(/▸ ✓ build/);
      expect(opened).toContain("review 3");
      expect(plain(output, marks[3]!, marks[4])).toContain("completion.md");
      expect(plain(output, marks[4]!, marks[5])).toContain("Task dispatched");
      expect(plain(output, marks[5]!, marks[6])).toContain("runs / all projects");
      // After the resize a 100-column frame is drawn.
      expect(plain(output, marks[6]!, marks[7])).toContain("─".repeat(100));
      // Observation only: the run directory is untouched.
      expect(
        readFileSync(join(session.runDir, "journal.jsonl")).equals(session.journalBefore),
      ).toBe(true);
      expect(readdirSync(session.runDir).toSorted()).toEqual(session.filesBefore);
    },
  );

  // A redraw scheduled by the quitting key must not paint the restored normal screen.
  it("T10: nothing is drawn after quitting restores the terminal", { timeout: 40_000 }, () => {
    const { output } = ptySession();
    expect(output.toString("utf8").endsWith(`${SHOW_CURSOR}${LEAVE_ALT}`)).toBe(true);
  });
});
