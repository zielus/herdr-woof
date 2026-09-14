import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONTENT,
  cleanupRunDirs,
  journal,
  makeRunDir,
  ofType,
  openAttempt,
  readyAttempt,
  submit,
  woofAsync,
  writeEnvelope,
  type ProcessResult,
} from "./helpers/process.js";

afterEach(() => cleanupRunDirs());

// Every directory level of accepted/<stage>/visit-<n>/attempt-<m> for report/1/1.
const ACCEPTED_LEVELS = [
  "accepted",
  "accepted/report",
  "accepted/report/visit-1",
  "accepted/report/visit-1/attempt-1",
];

function expectRejected(result: ProcessResult, reason: string, exit: number, text: string): void {
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(exit);
  expect(result.json).toMatchObject({ outcome: "rejected", reason });
  expect(result.json?.message).toContain(text);
}

/** Every file below `dir` with its content, for before/after comparison. */
function snapshot(dir: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const path = join(dir, name);
    if (lstatSync(path).isFile()) entries[name] = readFileSync(path, "utf8");
  }
  return entries;
}

describe("accepted destination containment", () => {
  for (const level of ACCEPTED_LEVELS) {
    it(`refuses to publish through a symlink at ${level}`, () => {
      const { runDir, envelope } = readyAttempt();
      const outside = makeRunDir();
      mkdirSync(dirname(join(runDir, level)), { recursive: true });
      symlinkSync(outside, join(runDir, level));

      const result = submit(runDir, envelope);

      expectRejected(result, "journal_write_failed", 3, level);
      expect(readdirSync(outside)).toEqual([]);
      expect(ofType(journal(runDir), "submission.accepted")).toHaveLength(0);
    });

    it(`refuses a duplicate whose accepted copy sits behind a symlink at ${level}`, () => {
      const { runDir, envelope } = readyAttempt();
      const first = submit(runDir, envelope);
      expect(first.json?.outcome, `${first.stdout}${first.stderr}`).toBe("accepted");
      // Move the real subtree out of the run and link it back in place.
      const moved = join(makeRunDir(), "moved");
      cpSync(join(runDir, level), moved, { recursive: true });
      rmSync(join(runDir, level), { recursive: true, force: true });
      symlinkSync(moved, join(runDir, level));
      const before = snapshot(moved);

      const retry = submit(runDir, envelope);

      expectRejected(retry, "journal_corrupt", 3, level);
      expect(ofType(journal(runDir), "submission.duplicate")).toHaveLength(0);
      expect(snapshot(moved)).toEqual(before);
      expect(Object.values(before)).toContain(CONTENT);
    });
  }
});

describe("journal file containment", () => {
  it("refuses to open an attempt through a symlinked journal", () => {
    for (const dangling of [false, true]) {
      const runDir = makeRunDir();
      const external = join(makeRunDir(), "journal.jsonl");
      if (!dangling) writeFileSync(external, "");
      symlinkSync(external, join(runDir, "journal.jsonl"));

      const result = openAttempt(runDir);

      expectRejected(result, "journal_corrupt", 3, "journal.jsonl is a symlink");
      if (dangling) {
        expect(existsSync(external)).toBe(false);
      } else {
        expect(readFileSync(external, "utf8")).toBe("");
      }
    }
  });

  it("refuses to submit through a symlinked journal without touching its target", () => {
    const { runDir, envelope } = readyAttempt();
    const journalPath = join(runDir, "journal.jsonl");
    const external = join(makeRunDir(), "journal.jsonl");
    copyFileSync(journalPath, external);
    rmSync(journalPath);
    symlinkSync(external, journalPath);
    const before = readFileSync(external);

    const result = submit(runDir, envelope);

    expectRejected(result, "journal_corrupt", 3, `${journalPath} is a symlink`);
    expect(readFileSync(external).equals(before)).toBe(true);
    expect(existsSync(join(runDir, "accepted"))).toBe(false);
  });

  it("rejects a journal swapped for a symlink while the submitter waits for the lock", async () => {
    const { runDir, envelope } = readyAttempt();
    const journalPath = join(runDir, "journal.jsonl");
    const lockPath = join(runDir, "journal.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), ts: new Date().toISOString() }),
    );
    const envelopePath = writeEnvelope(runDir, envelope);

    // The submitter passes its preliminary journal check, then polls the lock.
    const pending = woofAsync(["submit", "--run-dir", runDir, "--envelope", envelopePath]);
    await delay(1000);
    const external = join(makeRunDir(), "journal.jsonl");
    copyFileSync(journalPath, external);
    const before = readFileSync(external);
    rmSync(journalPath);
    symlinkSync(external, journalPath);
    rmSync(lockPath);
    const result = await pending;

    expectRejected(result, "journal_corrupt", 3, `${journalPath} is a symlink`);
    expect(readFileSync(external).equals(before)).toBe(true);
    expect(existsSync(join(runDir, "accepted"))).toBe(false);
  });

  it("treats a dangling symlink at journal.lock as held and never creates its target", () => {
    const { runDir, envelope } = readyAttempt();
    const lockPath = join(runDir, "journal.lock");
    const target = join(makeRunDir(), "lock-target");
    symlinkSync(target, lockPath);

    const result = submit(runDir, envelope);

    expectRejected(result, "journal_busy", 3, lockPath);
    expect(existsSync(target)).toBe(false);
    expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
  });
});
