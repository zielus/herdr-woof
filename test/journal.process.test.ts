import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  artifactRel,
  cleanupRunDirs,
  distIndexUrl,
  envelopeFor,
  journal,
  makeRunDir,
  ofType,
  openAttempt,
  openAttemptOk,
  openPlannedRun,
  readyAttempt,
  runNode,
  sha256,
  submit,
  terminateRunOk,
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

  it("reports journal_busy naming the lock and its holder when the lock is held", () => {
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
    expect(result.json?.message).toContain(lockPath);
    expect(result.json?.message).toContain(`pid ${process.pid}`);
    expect(elapsed).toBeLessThan(7000);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(join(runDir, "journal.jsonl")).equals(journalBefore)).toBe(true);
  });

  it("treats timeoutMs as an upper bound even when pollMs is longer", () => {
    const { runDir, envelope } = readyAttempt();
    writeFileSync(
      join(runDir, "journal.lock"),
      JSON.stringify({ pid: process.pid, host: hostname(), ts: new Date().toISOString() }),
    );
    // Lock options are SDK-only, so the check runs submitResult in a child process.
    const script = `
const sdk = await import(${JSON.stringify(distIndexUrl)});
const started = Date.now();
const outcome = await sdk.submitResult({
  runDir: process.argv[1],
  envelopeRaw: process.argv[2],
  lock: { timeoutMs: 100, pollMs: 10000 },
});
console.log(JSON.stringify({ outcome, elapsed: Date.now() - started }));
`;

    const started = Date.now();
    const result = runNode(script, [runDir, JSON.stringify(envelope)]);
    const wall = Date.now() - started;

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      outcome: { outcome: string; reason: string };
      elapsed: number;
    };
    expect(output.outcome).toMatchObject({ outcome: "rejected", reason: "journal_busy" });
    expect(output.elapsed).toBeLessThan(2000);
    expect(wall).toBeLessThan(2000);
  });
});

describe("tolerant journal prefix read", () => {
  const journalModuleUrl = distIndexUrl.replace(/index\.js$/, "journal/journal.js");
  const readScript = `
const journal = await import(${JSON.stringify(journalModuleUrl)});
const options = process.argv[2] === undefined ? undefined : JSON.parse(process.argv[2]);
const locked = journal.readJournal(process.argv[1]);
const prefix = journal.readJournalPrefix(process.argv[1], options);
console.log(JSON.stringify({
  locked: { ok: locked.ok, reason: locked.reason, line: locked.line },
  prefix: prefix.ok
    ? { ok: true, seqs: prefix.records.map((r) => r.seq), tailPending: prefix.tailPending, endOffset: prefix.endOffset, anchor: prefix.anchor }
    : { ok: false, reason: prefix.reason, line: prefix.line, message: prefix.message },
}));
`;
  interface Output {
    locked: { ok: boolean; reason?: string; line?: number };
    prefix: {
      ok: boolean;
      seqs?: number[];
      tailPending?: boolean;
      endOffset?: number;
      anchor?: string | null;
      reason?: string;
      line?: number;
    };
  }
  const read = (runDir: string, options?: Record<string, number>): Output => {
    const result = runNode(
      readScript,
      options === undefined ? [runDir] : [runDir, JSON.stringify(options)],
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as Output;
  };

  it("excludes a partial final line as tailPending while readJournal fails closed", () => {
    const runDir = makeRunDir();
    openAttemptOk(runDir);
    const journalPath = join(runDir, "journal.jsonl");
    const complete = readFileSync(journalPath);
    appendFileSync(journalPath, '{"schemaVersion":1,"se');

    const output = read(runDir);

    expect(output.locked).toMatchObject({ ok: false, reason: "journal_corrupt", line: 3 });
    expect(output.prefix).toEqual({
      ok: true,
      seqs: [1, 2],
      tailPending: true,
      endOffset: complete.byteLength,
      anchor: sha256(complete.subarray(0, complete.indexOf(0x0a))).slice(0, 12),
    });
  });

  it("fails closed on a newline-terminated invalid line, naming it", () => {
    const runDir = makeRunDir();
    openAttemptOk(runDir);
    appendFileSync(join(runDir, "journal.jsonl"), '{"schemaVersion":1,"se\n');

    const output = read(runDir);

    expect(output.prefix).toMatchObject({ ok: false, reason: "journal_corrupt", line: 3 });
  });

  it("continues from a byte offset with seq continuity", () => {
    const runDir = makeRunDir();
    openAttemptOk(runDir);
    const offset = readFileSync(join(runDir, "journal.jsonl")).byteLength;
    openAttemptOk(runDir, { attempt: 2 });

    const next = read(runDir, { fromOffset: offset, expectSeq: 3 });
    expect(next.prefix).toMatchObject({ ok: true, seqs: [3], tailPending: false, anchor: null });

    const gap = read(runDir, { fromOffset: offset, expectSeq: 4 });
    expect(gap.prefix).toMatchObject({ ok: false, reason: "journal_corrupt", line: 4 });
  });

  it("reports a missing journal as run_dir_invalid and an empty one as no records", () => {
    const runDir = makeRunDir();
    expect(read(runDir).prefix).toMatchObject({ ok: false, reason: "run_dir_invalid" });
    writeFileSync(join(runDir, "journal.jsonl"), "");
    expect(read(runDir).prefix).toEqual({
      ok: true,
      seqs: [],
      tailPending: false,
      endOffset: 0,
      anchor: null,
    });
  });
});

describe("openAttempt", () => {
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

  it("refuses attempts outside a planned run's stages, owners and verdicts, and after termination", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);

    for (const [spec, reason] of [
      [{ stage: "deploy" }, "stage_unknown"],
      [{ agent: "reviewer" }, "owner_mismatch"],
      [{ verdicts: "pass" }, "verdicts_mismatch"],
      [{ verdicts: "pass,fail,maybe" }, "verdicts_mismatch"],
    ] as const) {
      const refused = openAttempt(runDir, spec);
      expect(refused.status, `${refused.stdout}${refused.stderr}`).toBe(2);
      expect(refused.json).toMatchObject({ outcome: "rejected", reason });
    }
    // The verdict set is compared without regard to order.
    openAttemptOk(runDir, { verdicts: "fail,pass" });
    terminateRunOk(runDir);
    const closed = openAttempt(runDir, { attempt: 2 });
    expect(closed.status).toBe(2);
    expect(closed.json).toMatchObject({ outcome: "rejected", reason: "run_closed" });

    expect(journal(runDir).map((line) => line.type)).toEqual([
      "run.opened",
      "attempt.opened",
      "run.terminated",
    ]);
  });
});
