import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  artifactRel,
  cleanupRunDirs,
  envelopeFor,
  journal,
  makeRunDir,
  ofType,
  openAttempt,
  openAttemptOk,
  readyAttempt,
  submit,
  woofAsync,
  writeArtifact,
  writeEnvelope,
  type JournalLine,
} from "./helpers/process.js";

afterEach(() => cleanupRunDirs());

function expectContiguousSeq(lines: readonly JournalLine[]): void {
  expect(lines.map((line) => line.seq)).toEqual(lines.map((_, index) => index + 1));
}

describe("run journal under concurrent submitters", () => {
  it("accepts exactly one of eight identical concurrent submissions", async () => {
    const { runDir, envelope } = readyAttempt();
    const envelopePath = writeEnvelope(runDir, envelope);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        woofAsync(["submit", "--run-dir", runDir, "--envelope", envelopePath]),
      ),
    );

    expect(results.map((result) => result.json?.outcome).toSorted()).toEqual([
      "accepted",
      ...Array.from({ length: 7 }, () => "duplicate"),
    ]);
    expect(results.map((result) => result.status)).toEqual(Array.from({ length: 8 }, () => 0));
    expect(new Set(results.map((result) => result.json?.receipt?.receiptId)).size).toBe(1);
    const lines = journal(runDir);
    expect(ofType(lines, "submission.accepted")).toHaveLength(1);
    expect(ofType(lines, "submission.duplicate")).toHaveLength(7);
    expectContiguousSeq(lines);
    expect(existsSync(join(runDir, "journal.lock"))).toBe(false);
  });

  it("accepts exactly one of eight conflicting concurrent submissions", async () => {
    const runDir = makeRunDir();
    openAttemptOk(runDir);
    const envelopePaths = Array.from({ length: 8 }, (_, index) => {
      const rel = artifactRel("report", 1, 1, `report-${index}.md`);
      const sha = writeArtifact(runDir, rel, `# Report ${index}\n\nDistinct content ${index}.\n`);
      return writeEnvelope(
        runDir,
        envelopeFor({
          verdict: index % 2 === 0 ? "pass" : "fail",
          artifact: { path: rel, sha256: sha },
        }),
      );
    });

    const results = await Promise.all(
      envelopePaths.map((path) => woofAsync(["submit", "--run-dir", runDir, "--envelope", path])),
    );

    const accepted = results.filter((result) => result.json?.outcome === "accepted");
    const rejected = results.filter((result) => result.json?.outcome === "rejected");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.status).toBe(0);
    expect(rejected).toHaveLength(7);
    for (const result of rejected) {
      expect(result.json?.reason).toBe("attempt_closed_conflict");
      expect(result.status).toBe(2);
    }
    const lines = journal(runDir);
    expect(ofType(lines, "submission.accepted")).toHaveLength(1);
    expect(ofType(lines, "submission.rejected")).toHaveLength(7);
    expectContiguousSeq(lines);
  });
});

describe("run journal failure boundaries", () => {
  it("fails closed on a torn final line without modifying the journal", () => {
    const { runDir, envelope } = readyAttempt();
    const journalPath = join(runDir, "journal.jsonl");
    appendFileSync(journalPath, '{"schemaVersion":1,"se');
    const before = readFileSync(journalPath);

    const valid = submit(runDir, envelope);
    const malformed = submit(runDir, "not json");

    for (const result of [valid, malformed]) {
      expect(result.status).toBe(3);
      expect(result.json).toMatchObject({ outcome: "rejected", reason: "journal_corrupt" });
    }
    expect(readFileSync(journalPath).equals(before)).toBe(true);
  });

  it("breaks a lock left by a dead process on this host", () => {
    const { runDir, envelope } = readyAttempt();
    const dead = spawnSync("node", ["-e", "0"]);
    expect(dead.status).toBe(0);
    writeFileSync(
      join(runDir, "journal.lock"),
      JSON.stringify({ pid: dead.pid, host: hostname(), ts: new Date().toISOString() }),
    );

    const result = submit(runDir, envelope);

    expect(result.status, result.stdout).toBe(0);
    expect(result.json?.outcome).toBe("accepted");
    expect(existsSync(join(runDir, "journal.lock"))).toBe(false);
  });

  it("reports journal_busy when a live process holds the lock", () => {
    const { runDir, envelope } = readyAttempt();
    const lockPath = join(runDir, "journal.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), ts: new Date().toISOString() }),
    );
    const journalBefore = readFileSync(join(runDir, "journal.jsonl"));

    const started = Date.now();
    const result = submit(runDir, envelope);
    const elapsed = Date.now() - started;

    expect(result.status).toBe(3);
    expect(result.json).toMatchObject({ outcome: "rejected", reason: "journal_busy" });
    expect(elapsed).toBeLessThan(7000);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(join(runDir, "journal.jsonl")).equals(journalBefore)).toBe(true);
  });
});

describe("woof attempt open", () => {
  it("only opens attempts newer than the stage's latest, within one run", () => {
    const runDir = makeRunDir();
    openAttemptOk(runDir, { visit: 2, attempt: 1 });

    for (const spec of [
      { visit: 2, attempt: 1 },
      { visit: 1, attempt: 9 },
    ]) {
      const conflict = openAttempt(runDir, spec);
      expect(conflict.status).toBe(2);
      expect(conflict.json).toMatchObject({ outcome: "rejected", reason: "attempt_open_conflict" });
    }
    const otherRun = openAttempt(runDir, { run: "run-2", visit: 3 });
    expect(otherRun.status).toBe(2);
    expect(otherRun.json).toMatchObject({ outcome: "rejected", reason: "run_mismatch" });

    const newer = openAttemptOk(runDir, { visit: 2, attempt: 2 });
    expect(newer.json?.attempt?.artifactDir).toBe(
      join(runDir, "artifacts/report/visit-2/attempt-2"),
    );
    expect(existsSync(join(runDir, "artifacts/report/visit-2/attempt-2"))).toBe(true);
    openAttemptOk(runDir, { stage: "review" });

    const lines = journal(runDir);
    expect(lines.map((line) => line.type)).toEqual([
      "run.opened",
      "attempt.opened",
      "attempt.opened",
      "attempt.opened",
    ]);
    expectContiguousSeq(lines);
  });
});
