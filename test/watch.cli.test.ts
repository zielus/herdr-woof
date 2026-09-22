import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupRunDirs,
  cliPath,
  makeRunDir,
  openAttemptOk,
  openPlannedRun,
  repoRoot,
  woof,
  woofAsync,
} from "./helpers/process.js";

// `woof watch` (the human run view by default, `--plain` for the event lines) and `woof events
// --pretty` (the event lines) as real processes on journals copied from earlier live runs, and on
// runs written through the compiled store.
const dirs: string[] = [];
afterEach(() => {
  cleanupRunDirs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const EXHAUSTED = join(repoRoot, "test", "fixtures", "watch-exhausted-journal.jsonl");
const LATE_REJECTION = join(
  repoRoot,
  "test",
  "fixtures",
  "watch-rejected-after-cancel-journal.jsonl",
);
// Fixed zone, a UTF-8 locale and no NO_COLOR inherited from the caller: times, marks and escapes
// are what the tests pin.
const ENV = {
  TZ: "UTC",
  NO_COLOR: undefined,
  LANG: "en_US.UTF-8",
  LC_ALL: undefined,
  LC_CTYPE: undefined,
};
const EVENT_LINE = /^\d{2}:\d{2}:\d{2} #(\d+) /;
// oxlint-disable-next-line no-control-regex
const ESCAPE = /\u001B/;
const RULE = "─".repeat(80);

function fixtureRun(journal: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "woof-watch-")));
  dirs.push(dir);
  copyFileSync(journal, join(dir, "journal.jsonl"));
  return dir;
}

function outputLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line !== "");
}

function eventLines(stdout: string): string[] {
  return outputLines(stdout).filter((line) => EVENT_LINE.test(line));
}

function seqs(stdout: string): number[] {
  return eventLines(stdout).map((line) => Number(EVENT_LINE.exec(line)?.[1]));
}

/** The human view of the exhausted fixture: opening block, history rows, summary. */
function exhaustedView(runDir: string): string[] {
  return [
    "woof / build-review",
    "run br-20260915-163210-23d435 · workflow v1",
    `dir ${runDir}`,
    "",
    "AGENTS",
    "builder    claude   sonnet   build, repair",
    "reviewer   claude   sonnet   review",
    "",
    "STEPS & GATES",
    "build → verify → review → completed",
    "        reject ↘ repair → verify",
    "                 reject ↘ repair → verify → review",
    "review: verdict + matching revision",
    "limits: 3 review rounds · 2 attempts/visit · 3 visits/stage · 2h run",
    "",
    "INPUT",
    "input: 1144 bytes · full input: input.json (not readable here)",
    "",
    RULE,
    "16:32:12 · run              Started",
    "16:32:17 + builder          Agent started · claude / sonnet",
    "16:32:18 → builder  build   Task dispatched",
    "16:33:00 ✓ builder  build   Completion report accepted",
    "16:33:00 ✓ gate     build   Passed → verify",
    "16:33:00 ✓ gate     verify  Checks passed → review",
    "",
    "16:33:06 + reviewer         Agent started · claude / sonnet",
    "16:33:07 → reviewer review  Task dispatched",
    "16:34:16 ↓ reviewer review  Review received · approval recommended",
    "16:34:16 ↻ gate     review  Revision changed → review again",
    "",
    "16:34:23 → reviewer review  Task dispatched · visit 2",
    "16:35:24 ↓ reviewer review  Review received · approval recommended",
    "16:35:25 ↻ gate     review  Revision changed → review again",
    "",
    "16:35:29 → reviewer review  Task dispatched · visit 3",
    "16:36:10 ↓ reviewer review  Review received · approval recommended",
    "16:36:10 ↻ gate     review  Revision changed → review again",
    "",
    RULE,
    "! Exhausted · maxRounds (3)",
    "gate review requires another round beyond maxRounds (3)",
    "3m 58s · 3 reviews · 0 repairs · last at review visit 3",
    "",
    "ARTIFACTS · relative to run directory",
    "changes  accepted/build/visit-1/attempt-1/completion.md",
    "checks   checks/verify/build-v1-a1/output.log",
  ];
}

describe("woof watch", () => {
  it("W1: a finished run prints the opening block, one row per meaningful fact and the outcome summary", () => {
    const runDir = fixtureRun(EXHAUSTED);
    const watched = woof(["watch", runDir], { env: ENV });
    expect(watched.status, watched.stdout + watched.stderr).toBe(0);
    expect(watched.stdout.split("\n")).toEqual([...exhaustedView(runDir), ""]);
    // A pipe gets no escape sequences, and every line fits 80 columns.
    expect(watched.stdout).not.toMatch(ESCAPE);
    for (const line of watched.stdout.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
    // --ascii keeps the same rows with + -> v ~ ! . marks and -> arrows.
    const ascii = woof(["watch", runDir, "--ascii"], { env: ENV });
    expect(ascii.status).toBe(0);
    const asciiLines = ascii.stdout.split("\n");
    expect(asciiLines[9]).toBe("build -> verify -> review -> completed");
    expect(asciiLines[21]).toBe("16:32:18 -> builder  build   Task dispatched");
    expect(asciiLines[22]).toBe("16:33:00 v  builder  build   Completion report accepted");
    expect(asciiLines[29]).toBe("16:34:16 ~  gate     review  Revision changed -> review again");
    expect(ascii.stdout).toMatch(/^[\x20-\x7E\n]*$/u);
    // A locale without UTF-8 gets the ASCII marks without asking.
    const posix = woof(["watch", runDir], { env: { ...ENV, LANG: "C" } });
    expect(posix.stdout).toBe(ascii.stdout);
  });

  it("W1b: --plain keeps the technical view: the status header and every event as one line, in seq order", () => {
    const runDir = fixtureRun(EXHAUSTED);
    const watched = woof(["watch", runDir, "--plain"], { env: ENV });
    expect(watched.status, watched.stdout + watched.stderr).toBe(0);
    const lines = outputLines(watched.stdout);
    expect(lines.slice(0, 7)).toEqual([
      "run      br-20260915-163210-23d435  build-review@1  exhausted",
      `dir      ${runDir}`,
      "now      -",
      "owner    unhosted",
      "agent    builder  role builder kind claude model sonnet pane w8S:p7",
      "agent    reviewer  role reviewer kind claude model sonnet pane w8S:p8",
      "outcome  exhausted: gate review requires another round beyond maxRounds (3) (limit maxRounds)",
    ]);
    expect(seqs(watched.stdout)).toEqual(Array.from({ length: 21 }, (_, index) => index + 1));
    const events = eventLines(watched.stdout);
    expect(events[5]).toBe(
      "16:33:00 #6 gate.recorded        build v1 a1  stage build pass (built) round 0 -> verify",
    );
    expect(events[6]).toBe(
      "16:33:00 #7 gate.recorded        build v1 a1  check verify pass (checks_passed) round 0 -> review",
    );
    expect(events[11]).toBe(
      "16:34:16 #12 gate.recorded        review v1 a1  stage review reject (revision_moved) round 1 -> review",
    );
    expect(events[20]).toBe(
      "16:36:10 #21 run.terminated       -  exhausted: gate review requires another round beyond maxRounds (3) (limit maxRounds)",
    );
    // Header, a blank line, 21 events and the end line: nothing else.
    expect(watched.stdout.split("\n")).toHaveLength(7 + 1 + 21 + 1 + 1);
    expect(lines.at(-1)).toMatch(/^-- end \(end\) cursor v1\.21\.[0-9a-f]+$/);
    expect(watched.stdout).not.toMatch(ESCAPE);
  });

  it("W2: woof events --pretty prints exactly what woof watch --plain prints; plain woof events stays NDJSON", () => {
    const runDir = fixtureRun(EXHAUSTED);
    for (const extra of [[], ["--follow", "--poll-ms", "20", "--timeout-ms", "10000"]]) {
      const watched = woof(["watch", runDir, "--plain", ...extra], { env: ENV });
      const pretty = woof(["events", runDir, "--pretty", ...extra], { env: ENV });
      expect(watched.status, watched.stdout + watched.stderr).toBe(0);
      expect(pretty.status, pretty.stdout + pretty.stderr).toBe(0);
      expect(pretty.stdout).toBe(watched.stdout);
    }
    const json = woof(["events", runDir], { env: ENV });
    expect(json.status).toBe(0);
    const parsed = outputLines(json.stdout).map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(parsed).toHaveLength(22);
    expect(parsed.at(-1)).toMatchObject({ kind: "woof.events.end", reason: "end", terminal: true });
  });

  it("W3: --follow stops at the terminal record like events --follow; a static read shows the late rejection", () => {
    const runDir = fixtureRun(LATE_REJECTION);
    const all = woof(["watch", runDir, "--plain"], { env: ENV });
    expect(all.status, all.stdout + all.stderr).toBe(0);
    expect(seqs(all.stdout)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(eventLines(all.stdout)[5]).toMatch(
      /^18:33:19 #6 submission\.rejected  builder build v1 a1  run_closed: run l7-probe-r3 terminated as cancelled/,
    );
    // The human view tells the same story: the late rejection is a row, the outcome the summary.
    const human = woof(["watch", runDir], { env: ENV });
    expect(human.status).toBe(0);
    expect(outputLines(human.stdout).slice(-8)).toEqual([
      "18:32:48 → builder  build   Task dispatched",
      "18:33:19 ! builder  build   Result rejected: run closed · run l7-probe-r3",
      "                            terminated as cancelled; no further submissions are",
      "                            accepted",
      RULE,
      "· Cancelled · cancelled via woof run cancel",
      "31s · 0 reviews · 0 repairs · last at build",
      "ARTIFACTS · none accepted",
    ]);

    const follow = ["--follow", "--poll-ms", "20", "--timeout-ms", "10000"];
    const followed = woof(["watch", runDir, "--plain", ...follow], { env: ENV, timeoutMs: 20_000 });
    expect(followed.status, followed.stdout + followed.stderr).toBe(0);
    expect(seqs(followed.stdout)).toEqual([1, 2, 3, 4, 5]);
    expect(eventLines(followed.stdout)[4]).toBe(
      "18:33:13 #5 run.terminated       -  cancelled: cancelled via woof run cancel",
    );
    expect(outputLines(followed.stdout).at(-1)).toMatch(/^-- end \(terminated\) cursor v1\.5\./);
    const pretty = woof(["events", runDir, "--pretty", ...follow], { env: ENV, timeoutMs: 20_000 });
    expect(pretty.stdout).toBe(followed.stdout);
    const json = woof(["events", runDir, ...follow], { env: ENV, timeoutMs: 20_000 });
    expect(outputLines(json.stdout).at(-2)).toContain('"seq":5');
  });

  it("W4: --follow on a live run prints each new event and ends with the terminal record; a timeout exits 7", async () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    const following = woofAsync(
      ["watch", runDir, "--plain", "--follow", "--poll-ms", "20", "--timeout-ms", "20000"],
      { env: ENV, timeoutMs: 30_000 },
    );
    const human = woofAsync(
      ["watch", runDir, "--follow", "--poll-ms", "20", "--timeout-ms", "20000"],
      { env: ENV, timeoutMs: 30_000 },
    );
    await delay(300);
    openAttemptOk(runDir);
    await delay(100);
    expect(woof(["run", "cancel", runDir]).status).toBe(0);
    const result = await following;
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const events = eventLines(result.stdout);
    expect(events.map((line) => line.split(/\s+/)[2])).toEqual([
      "run.opened",
      "attempt.opened",
      "run.cancel_requested",
      "run.terminated",
    ]);
    expect(events.at(-2)).toMatch(/ -  by cli: cancelled via woof run cancel$/);
    expect(events.at(-1)).toMatch(/ -  cancelled: cancelled via woof run cancel$/);
    expect(outputLines(result.stdout).at(-1)).toMatch(/^-- end \(terminated\) cursor v1\.4\./);

    // The human follower saw the same run: its plan has no built-in graph, so the map is the
    // plan's stage list; the rows come live and the cancellation ends in the summary.
    const watched = await human;
    expect(watched.status, watched.stdout + watched.stderr).toBe(0);
    const lines = outputLines(watched.stdout);
    expect(lines.slice(0, 2)).toEqual(["woof / report-review", "run run-1 · workflow v1"]);
    expect(lines).toContain("stages report, review");
    expect(lines).toContain("worker     claude   provider default   report   role writer");
    expect(lines.filter((line) => /^\d{2}:\d{2}:\d{2} /.test(line))).toEqual([
      expect.stringMatching(/^\d{2}:\d{2}:\d{2} · run              Started$/),
      expect.stringMatching(
        /^\d{2}:\d{2}:\d{2} · run              Cancel requested · cli: cancelled via woof run$/,
      ),
    ]);
    expect(lines.slice(-3)).toEqual([
      "· Cancelled · cancelled via woof run cancel",
      expect.stringMatching(/^\d+s · 0 reviews · 0 repairs · last at report$/),
      "ARTIFACTS · none accepted",
    ]);

    const open = makeRunDir();
    openPlannedRun(open);
    const waited = woof(["watch", open, "--follow", "--poll-ms", "20", "--timeout-ms", "300"], {
      env: ENV,
      timeoutMs: 20_000,
    });
    expect(waited.status, waited.stdout + waited.stderr).toBe(7);
    expect(outputLines(waited.stdout).at(-1)).toBe(
      "-- observer stopped (timeout); the run continues",
    );
    const waitedPlain = woof(
      ["watch", open, "--plain", "--follow", "--poll-ms", "20", "--timeout-ms", "300"],
      { env: ENV, timeoutMs: 20_000 },
    );
    expect(waitedPlain.status).toBe(7);
    expect(outputLines(waitedPlain.stdout).at(-1)).toMatch(/^-- end \(timeout\) cursor v1\.1\./);
  });

  it("W5: colors appear on a terminal only, and never with NO_COLOR", () => {
    const runDir = fixtureRun(EXHAUSTED);
    const underTerminal = (env: Record<string, string>, ...extra: string[]) => {
      const command = [process.execPath, cliPath, "watch", runDir, ...extra];
      // script(1) gives the child a pseudo-terminal; BSD (macOS) and util-linux take different arguments.
      const args =
        process.platform === "darwin"
          ? ["-q", "/dev/null", ...command]
          : [
              "-qec",
              command.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(" "),
              "/dev/null",
            ];
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        TZ: "UTC",
        LANG: "en_US.UTF-8",
        ...env,
      };
      if (env["NO_COLOR"] === undefined) Reflect.deleteProperty(childEnv, "NO_COLOR");
      const result = spawnSync("script", args, {
        encoding: "utf8",
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
      });
      expect(result.error, "script(1) must be available").toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result.stdout;
    };
    const colored = underTerminal({});
    expect(colored).toContain("\u001B[");
    // The mark and the message carry the color; the participant stays plain.
    expect(colored).toContain("\u001B[31m! Exhausted · maxRounds (3)\u001B[0m");
    expect(colored).toContain("\u001B[32m✓\u001B[0m builder");
    const noColor = underTerminal({ NO_COLOR: "1" });
    expect(noColor).toContain("! Exhausted · maxRounds (3)");
    expect(noColor).not.toMatch(ESCAPE);
    const plain = underTerminal({}, "--plain");
    expect(plain).toContain("\u001B[");
    expect(plain).toContain("run.terminated");
    const piped = woof(["watch", runDir], { env: { ...ENV, NO_COLOR: "1" } });
    expect(piped.stdout).not.toMatch(ESCAPE);
  });

  it("W6: the run directory defaults to WOOF_RUN_DIR; without either watch is a usage error", () => {
    const runDir = fixtureRun(EXHAUSTED);
    const byPath = woof(["watch", runDir, "--follow"], { env: ENV });
    const byEnv = woof(["watch", "--follow"], { env: { ...ENV, WOOF_RUN_DIR: runDir } });
    expect(byEnv.status, byEnv.stdout + byEnv.stderr).toBe(0);
    expect(byEnv.stdout).toBe(byPath.stdout);
    const missing = woof(["watch"], { env: ENV });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("Usage: woof watch");
    expect(woof(["watch", "--help"]).stdout).toContain("NO_COLOR");
    const badInput = woof(["watch", runDir, "--input", "yaml"], { env: ENV });
    expect(badInput.status).toBe(1);
    expect(badInput.stderr).toContain("--input must be summary or json");
  });

  it("W7: a directory without a journal exits 3 and a foreign cursor exits 2, each with a readable problem line", () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), "woof-watch-empty-")));
    dirs.push(empty);
    for (const extra of [[], ["--plain"]]) {
      const invalid = woof(["watch", empty, ...extra], { env: ENV });
      expect(invalid.status, invalid.stdout).toBe(3);
      expect(outputLines(invalid.stdout)).toEqual([
        `run      ${empty}: run_dir_invalid`,
        expect.stringMatching(/^!! error run_dir_invalid: /),
        "-- end (error) cursor -",
      ]);
    }

    const exhausted = fixtureRun(EXHAUSTED);
    const foreign = /cursor (\S+)$/.exec(
      outputLines(woof(["watch", exhausted, "--plain"]).stdout).at(-1) ?? "",
    )?.[1];
    const runDir = fixtureRun(LATE_REJECTION);
    const resync = woof(["watch", runDir, "--after", foreign ?? "missing"], { env: ENV });
    expect(resync.status, resync.stdout).toBe(2);
    expect(outputLines(resync.stdout).slice(-2)).toEqual([
      expect.stringMatching(/^!! resync_required cursor_foreign: /),
      `-- end (resync_required) cursor ${foreign}`,
    ]);
  });

  it("W8: a reader that closes early (woof watch --follow | head -1) ends the follow with exit 0 and no stack trace", async () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    const child = spawn(
      "node",
      [cliPath, "watch", runDir, "--follow", "--poll-ms", "20", "--timeout-ms", "20000"],
      {
        cwd: repoRoot,
        env: { ...process.env, ...ENV, NO_COLOR: "" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const exited = new Promise<number | null>((resolveExit) => child.on("close", resolveExit));
    // Like head -1: read the first line, then close the pipe while the follow still waits.
    await new Promise<void>((firstChunk) => child.stdout.once("data", () => firstChunk()));
    child.stdout.destroy();
    await delay(100);
    // The next event is written into the closed pipe.
    openAttemptOk(runDir);
    const started = Date.now();
    const status = await exited;
    expect(status, stderr).toBe(0);
    expect(stderr).toBe("");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("W9: the input preview reads input.json: a title and criteria count by default, indented JSON cut honestly with --input json", () => {
    const runDir = fixtureRun(EXHAUSTED);
    const input = {
      schemaVersion: 1,
      repo: "/var/woof/fixture-repo",
      task: {
        title: "Fix empty-state rendering",
        description: "The list shows nothing when it is empty.",
        acceptanceCriteria: Array.from({ length: 20 }, (_, index) => `criterion ${index + 1}`),
      },
      verify: { command: ["bun", "test"], timeoutMs: 60_000 },
    };
    writeFileSync(join(runDir, "input.json"), JSON.stringify(input, null, 2));
    const summary = woof(["watch", runDir], { env: ENV });
    expect(summary.status).toBe(0);
    const summaryLines = summary.stdout.split("\n");
    expect(summaryLines.slice(12, 18)).toEqual([
      "verify: bun test · review: verdict + matching revision",
      "limits: 3 review rounds · 2 attempts/visit · 3 visits/stage · 2h run",
      "",
      "INPUT",
      "Fix empty-state rendering",
      "20 acceptance criteria · full input: input.json",
    ]);

    const json = woof(["watch", runDir, "--input", "json"], { env: ENV });
    expect(json.status).toBe(0);
    const jsonLines = json.stdout.split("\n");
    const start = jsonLines.indexOf("INPUT") + 1;
    const serialized = JSON.stringify(input, null, 2).split("\n");
    expect(jsonLines.slice(start, start + 24)).toEqual(serialized.slice(0, 24));
    expect(jsonLines[start + 24]).toBe(
      `… (${serialized.length - 24} more lines, full input: input.json)`,
    );
    expect(jsonLines[start + 25]).toBe("");
    expect(jsonLines[start + 26]).toBe(RULE);
    // The rows and the summary are the same in both modes.
    expect(jsonLines.slice(start + 27)).toEqual(summaryLines.slice(20));
  });
});
