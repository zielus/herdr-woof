import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupRunDirs,
  journal,
  ofType,
  openAttempt,
  openAttemptOk,
  readyAttempt,
  submit,
  type EnvelopeJson,
  type ProcessResult,
  type ReceiptJson,
} from "./helpers/process.js";

afterEach(() => cleanupRunDirs());

type RawRecord = Record<string, unknown>;

function rawRecords(runDir: string): RawRecord[] {
  return readFileSync(join(runDir, "journal.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as RawRecord);
}

function acceptedRun(): {
  runDir: string;
  envelope: EnvelopeJson;
  accepted: RawRecord;
  receipt: ReceiptJson;
} {
  const { runDir, envelope } = readyAttempt();
  const first = submit(runDir, envelope);
  const receipt = first.json?.receipt;
  if (first.json?.outcome !== "accepted" || receipt === undefined) {
    throw new Error(`setup acceptance failed: ${first.stdout}${first.stderr}`);
  }
  const accepted = rawRecords(runDir).find((record) => record["type"] === "submission.accepted");
  if (accepted === undefined) throw new Error("setup: no submission.accepted record");
  return { runDir, envelope, accepted, receipt };
}

/** The accepted record moved to another stage, with paths kept consistent. */
function onStage(record: RawRecord, stageId: string, extra: RawRecord = {}): RawRecord {
  return {
    ...record,
    stageId,
    artifact: {
      ...(record["artifact"] as RawRecord),
      path: `artifacts/${stageId}/visit-1/attempt-1/report.md`,
      acceptedPath: `accepted/${stageId}/visit-1/attempt-1/report.md`,
    },
    ...extra,
  };
}

/**
 * Appends a hand-written, newline-terminated record with the next seq and a
 * valid timestamp (and a consistent receiptId for acceptances), then `after`.
 */
function appendRaw(runDir: string, record: RawRecord, after: RawRecord = {}): number {
  const seq = rawRecords(runDir).length + 1;
  const digest = typeof record["envelopeDigest"] === "string" ? record["envelopeDigest"] : "";
  const line = {
    ...record,
    seq,
    ts: new Date().toISOString(),
    ...(record["type"] === "submission.accepted"
      ? { receiptId: `rcpt-${seq}-${digest.slice(0, 12)}` }
      : {}),
    ...after,
  };
  appendFileSync(join(runDir, "journal.jsonl"), `${JSON.stringify(line)}\n`);
  return seq;
}

function expectCorrupt(result: ProcessResult, text: string): void {
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(3);
  expect(result.json).toMatchObject({ outcome: "rejected", reason: "journal_corrupt" });
  expect(result.json?.message).toContain(text);
}

interface CorruptionCase {
  name: string;
  corrupt: (runDir: string, accepted: RawRecord) => RawRecord;
  after?: RawRecord;
}

const corruptions: CorruptionCase[] = [
  {
    // Review RH-003 reproduction: fields missing or malformed on an open attempt.
    name: "an acceptance with missing status and verdict, a bad hash and negative bytes",
    corrupt: (runDir, accepted) => {
      openAttemptOk(runDir, { stage: "review" });
      const moved = onStage(accepted, "review");
      const withoutStatus = Object.fromEntries(
        Object.entries(moved).filter(([key]) => key !== "status" && key !== "verdict"),
      );
      return {
        ...withoutStatus,
        artifact: {
          ...(moved["artifact"] as RawRecord),
          sha256: "not-a-hash",
          bytes: -1,
          acceptedPath: "accepted/review/visit-1/attempt-1/nonexistent.md",
        },
      };
    },
  },
  {
    name: "an acceptance for an attempt that was never opened",
    corrupt: (_runDir, accepted) => onStage(accepted, "ghost"),
  },
  {
    name: "an acceptance whose agent disagrees with the opened attempt",
    corrupt: (runDir, accepted) => {
      openAttemptOk(runDir, { stage: "review" });
      return onStage(accepted, "review", { agentId: "intruder" });
    },
  },
  {
    name: "a second acceptance for an already accepted attempt",
    corrupt: (_runDir, accepted) => ({ ...accepted }),
  },
  {
    name: "an acceptance with a verdict the attempt does not allow",
    corrupt: (runDir, accepted) => {
      openAttemptOk(runDir, { stage: "review" });
      return onStage(accepted, "review", { verdict: "maybe" });
    },
  },
  {
    name: "an attempt record with an unexpected field",
    corrupt: (runDir) => ({
      ...rawRecords(runDir).find((record) => record["type"] === "attempt.opened"),
      stageId: "notes",
      artifactDir: "artifacts/notes/visit-1/attempt-1",
      extra: true,
    }),
  },
  {
    name: "an attempt record with a timestamp that is not ISO-8601",
    corrupt: (runDir) => ({
      ...rawRecords(runDir).find((record) => record["type"] === "attempt.opened"),
      stageId: "notes",
      artifactDir: "artifacts/notes/visit-1/attempt-1",
    }),
    after: { ts: "yesterday" },
  },
  {
    name: "a duplicate that names the wrong envelope digest",
    corrupt: (_runDir, accepted) => ({
      schemaVersion: 1,
      type: "submission.duplicate",
      receiptId: accepted["receiptId"],
      acceptedSeq: accepted["seq"],
      envelopeDigest: "f".repeat(64),
    }),
  },
];

describe("journal integrity", () => {
  for (const corruption of corruptions) {
    it(`fails closed on ${corruption.name}`, () => {
      const { runDir, envelope, accepted } = acceptedRun();
      const line = appendRaw(runDir, corruption.corrupt(runDir, accepted), corruption.after);
      const journalPath = join(runDir, "journal.jsonl");
      const before = readFileSync(journalPath);

      expectCorrupt(submit(runDir, envelope), `line ${line}:`);
      const open = openAttempt(runDir, { stage: "later" });
      expect(open.status).toBe(3);
      expect(open.json).toMatchObject({ outcome: "rejected", reason: "journal_corrupt" });
      expect(readFileSync(journalPath).equals(before)).toBe(true);
    });
  }

  it("returns journal_corrupt instead of duplicate when the accepted copy is missing", () => {
    const { runDir, envelope, receipt } = acceptedRun();
    rmSync(join(runDir, receipt.artifact.acceptedPath));

    expectCorrupt(submit(runDir, envelope), receipt.artifact.acceptedPath);
    expect(ofType(journal(runDir), "submission.duplicate")).toHaveLength(0);
  });

  it("returns journal_corrupt instead of duplicate when the accepted copy was altered", () => {
    const { runDir, envelope, receipt } = acceptedRun();
    const copy = join(runDir, receipt.artifact.acceptedPath);
    rmSync(copy);
    writeFileSync(copy, "# Tampered after acceptance\n");

    expectCorrupt(submit(runDir, envelope), receipt.artifact.acceptedPath);
    expect(ofType(journal(runDir), "submission.duplicate")).toHaveLength(0);
  });
});
