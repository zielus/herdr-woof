import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONTENT,
  artifactRel,
  cleanupRunDirs,
  distIndexUrl,
  envelopeFor,
  journal,
  makeRunDir,
  ofType,
  openAttempt,
  openAttemptOk,
  readyAttempt,
  runNode,
  sha256,
  submit,
  woof,
  writeArtifact,
  writeEnvelope,
  type ProcessResult,
} from "./helpers/process.js";

// Reasons produced by the cases in this file, checked against the exported
// closed set by the last test.
const seen = new Set<string>();
// journal_busy needs a 5 s lock timeout; journal.process.test.ts reaches it.
const REACHED_IN_JOURNAL_TEST = new Set(["journal_busy"]);

function expectRejected(result: ProcessResult, reason: string, exit = 2): void {
  expect(result.json, `${result.stdout}${result.stderr}`).toMatchObject({
    outcome: "rejected",
    reason,
  });
  expect(result.status).toBe(exit);
  seen.add(reason);
}

function expectOutcome(result: ProcessResult, outcome: "accepted" | "duplicate"): void {
  expect(result.json?.outcome, `${result.stdout}${result.stderr}`).toBe(outcome);
  expect(result.status).toBe(0);
}

function fields(result: ProcessResult): string[] {
  return (result.json?.details ?? []).map((detail) => detail.field);
}

function reversedKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .toReversed()
      .map(([key, item]) => [key, reversedKeys(item)]),
  );
}

afterEach(() => cleanupRunDirs());

describe("woof submit", () => {
  it("accepts a valid submission and publishes a read-only accepted copy", () => {
    const { runDir, envelope, sha } = readyAttempt();

    const result = submit(runDir, envelope);

    expectOutcome(result, "accepted");
    const accepted = ofType(journal(runDir), "submission.accepted");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.artifact?.sha256).toBe(sha);
    const receipt = result.json?.receipt;
    expect(receipt).toMatchObject({
      receiptId: accepted[0]?.receiptId,
      seq: accepted[0]?.seq,
      runId: "run-1",
      agentId: "worker",
      stageId: "report",
      visit: 1,
      attempt: 1,
      artifact: { path: artifactRel(), sha256: sha, bytes: Buffer.byteLength(CONTENT) },
    });
    const acceptedPath = join(runDir, receipt?.artifact.acceptedPath ?? "missing");
    expect(receipt?.artifact.acceptedPath).toBe("accepted/report/visit-1/attempt-1/report.md");
    expect(statSync(acceptedPath).mode & 0o777).toBe(0o444);
    expect(readFileSync(acceptedPath, "utf8")).toBe(CONTENT);
  });

  it("returns the original receipt for an identical resubmission", () => {
    const { runDir, envelope } = readyAttempt();
    const first = submit(runDir, envelope);
    expectOutcome(first, "accepted");

    const second = submit(runDir, JSON.stringify(reversedKeys(envelope), null, 4));

    expectOutcome(second, "duplicate");
    expect(JSON.stringify(second.json?.receipt)).toBe(JSON.stringify(first.json?.receipt));
    const lines = journal(runDir);
    expect(ofType(lines, "submission.accepted")).toHaveLength(1);
    const duplicates = ofType(lines, "submission.duplicate");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({
      receiptId: first.json?.receipt?.receiptId,
      acceptedSeq: first.json?.receipt?.seq,
    });
  });

  it("rejects a conflicting submission for an accepted attempt", () => {
    const { runDir, envelope } = readyAttempt();
    expectOutcome(submit(runDir, envelope), "accepted");
    const acceptedBefore = ofType(journal(runDir), "submission.accepted");

    expectRejected(submit(runDir, { ...envelope, verdict: "fail" }), "attempt_closed_conflict");
    const otherRel = artifactRel("report", 1, 1, "other.md");
    const otherSha = writeArtifact(runDir, otherRel, "# Other report\n");
    expectRejected(
      submit(runDir, { ...envelope, artifact: { path: otherRel, sha256: otherSha } }),
      "attempt_closed_conflict",
    );

    const lines = journal(runDir);
    expect(ofType(lines, "submission.accepted")).toEqual(acceptedBefore);
    expect(ofType(lines, "submission.rejected").map((line) => line.reason)).toEqual([
      "attempt_closed_conflict",
      "attempt_closed_conflict",
    ]);
  });

  it("rejects a superseded attempt and its artifacts, and accepts the newer attempt", () => {
    const runDir = makeRunDir();
    openAttemptOk(runDir);
    openAttemptOk(runDir, { attempt: 2 });
    const oldRel = artifactRel("report", 1, 1);
    const oldSha = writeArtifact(runDir, oldRel, CONTENT);

    expectRejected(
      submit(runDir, envelopeFor({ artifact: { path: oldRel, sha256: oldSha } })),
      "attempt_stale",
    );
    // A previous attempt's artifact cannot satisfy the new attempt.
    expectRejected(
      submit(runDir, envelopeFor({ attempt: 2, artifact: { path: oldRel, sha256: oldSha } })),
      "artifact_out_of_scope",
    );

    const newRel = artifactRel("report", 1, 2);
    const newSha = writeArtifact(runDir, newRel, CONTENT);
    expectOutcome(
      submit(runDir, envelopeFor({ attempt: 2, artifact: { path: newRel, sha256: newSha } })),
      "accepted",
    );
  });

  it("rejects a submission for an attempt that was never opened", () => {
    const { runDir, envelope } = readyAttempt();

    expectRejected(submit(runDir, { ...envelope, attempt: 5 }), "attempt_unknown");
    expectRejected(submit(runDir, { ...envelope, stageId: "review" }), "attempt_unknown");
  });

  it("rejects a submission from another agent", () => {
    const { runDir, envelope } = readyAttempt();

    const result = submit(runDir, { ...envelope, agentId: "intruder" });

    expectRejected(result, "owner_mismatch");
    expect(fields(result)).toEqual(["agentId"]);
    expect(ofType(journal(runDir), "submission.rejected")[0]?.identity).toMatchObject({
      agentId: "intruder",
    });
  });

  it("rejects a submission from another Herdr pane when the attempt is bound to one", () => {
    const { runDir, envelope } = readyAttempt({ pane: "w1:p1" });

    const wrong = submit(runDir, envelope, { env: { HERDR_PANE_ID: "w1:p2" } });
    expectRejected(wrong, "owner_mismatch");
    expect(fields(wrong)).toEqual(["paneId"]);

    expectOutcome(submit(runDir, envelope, { env: { HERDR_PANE_ID: "w1:p1" } }), "accepted");
    expect(ofType(journal(runDir), "submission.accepted")[0]?.paneId).toBe("w1:p1");
  });

  it("rejects malformed envelopes and journals them without identity", () => {
    const { runDir, envelope } = readyAttempt();
    const raws = [
      "not json",
      '{"schemaVersion":1,"run',
      "[]",
      JSON.stringify({ ...envelope, padding: "x".repeat(70_000) }),
    ];

    for (const raw of raws) expectRejected(submit(runDir, raw), "envelope_malformed");
    expectRejected(
      woof(["submit", "--run-dir", runDir, "--envelope", join(runDir, "absent.json")]),
      "envelope_malformed",
    );

    const rejected = ofType(journal(runDir), "submission.rejected");
    expect(rejected).toHaveLength(5);
    for (const record of rejected) {
      expect(record.reason).toBe("envelope_malformed");
      expect(record.identity).toBeUndefined();
    }
    expect(rejected[0]?.envelopeDigest).toBe(sha256("not json"));
  });

  it("rejects envelopes that do not match schema v1 with the offending field", () => {
    const { runDir, envelope } = readyAttempt();
    const withoutAttempt = Object.fromEntries(
      Object.entries(envelope).filter(([key]) => key !== "attempt"),
    );
    const cases: Array<[string, Record<string, unknown>]> = [
      ["attempt", withoutAttempt],
      ["visit", { ...envelope, visit: 0 }],
      ["extra", { ...envelope, extra: true }],
      ["artifact.sha256", { ...envelope, artifact: { ...envelope.artifact, sha256: "ABC123" } }],
      ["artifact.path", { ...envelope, artifact: { ...envelope.artifact, path: "/etc/hosts" } }],
      [
        "artifact.path",
        { ...envelope, artifact: { ...envelope.artifact, path: "artifacts/report/../x.md" } },
      ],
    ];

    for (const [field, invalid] of cases) {
      const result = submit(runDir, invalid);
      expectRejected(result, "envelope_invalid");
      expect(fields(result)).toContain(field);
    }
  });

  it("rejects missing, empty and non-file artifacts", () => {
    const { runDir, envelope, sha } = readyAttempt();
    const at = (name: string) => artifactRel("report", 1, 1, name);

    expectRejected(
      submit(runDir, { ...envelope, artifact: { path: at("missing.md"), sha256: sha } }),
      "artifact_missing",
    );
    const emptySha = writeArtifact(runDir, at("empty.md"), "");
    expectRejected(
      submit(runDir, { ...envelope, artifact: { path: at("empty.md"), sha256: emptySha } }),
      "artifact_empty",
    );
    const blankSha = writeArtifact(runDir, at("blank.md"), " \n\t\n");
    expectRejected(
      submit(runDir, { ...envelope, artifact: { path: at("blank.md"), sha256: blankSha } }),
      "artifact_empty",
    );
    mkdirSync(join(runDir, at("dir.md")));
    expectRejected(
      submit(runDir, { ...envelope, artifact: { path: at("dir.md"), sha256: sha } }),
      "artifact_missing",
    );
  });

  it("rejects a partially written artifact and accepts it once complete", () => {
    const runDir = makeRunDir();
    openAttemptOk(runDir);
    const full = `# Report\n\n${"A finding with its file and line reference.\n".repeat(200)}`;
    writeArtifact(runDir, artifactRel(), full.slice(0, full.length / 2));
    const envelope = envelopeFor({ artifact: { path: artifactRel(), sha256: sha256(full) } });

    expectRejected(submit(runDir, envelope), "artifact_hash_mismatch");
    writeArtifact(runDir, artifactRel(), full);
    expectOutcome(submit(runDir, envelope), "accepted");
  });

  it("rejects artifacts that resolve outside the attempt directory", () => {
    const runDir = makeRunDir();
    openAttemptOk(runDir);
    openAttemptOk(runDir, { stage: "review" });
    const at = (name: string) => artifactRel("report", 1, 1, name);

    const otherRel = artifactRel("review");
    const otherSha = writeArtifact(runDir, otherRel, CONTENT);
    expectRejected(
      submit(runDir, envelopeFor({ artifact: { path: otherRel, sha256: otherSha } })),
      "artifact_out_of_scope",
    );

    writeFileSync(join(runDir, "outside.md"), CONTENT);
    symlinkSync(join(runDir, "outside.md"), join(runDir, at("link.md")));
    expectRejected(
      submit(runDir, envelopeFor({ artifact: { path: at("link.md"), sha256: sha256(CONTENT) } })),
      "artifact_out_of_scope",
    );

    mkdirSync(join(runDir, "elsewhere"));
    symlinkSync(join(runDir, "elsewhere"), join(runDir, at("sub")));
    expectRejected(
      submit(
        runDir,
        envelopeFor({ artifact: { path: at("sub/new.md"), sha256: sha256(CONTENT) } }),
      ),
      "artifact_out_of_scope",
    );

    // A symlink that stays inside the attempt directory is fine.
    writeArtifact(runDir, at("real.md"), CONTENT);
    symlinkSync(join(runDir, at("real.md")), join(runDir, at("inside.md")));
    expectOutcome(
      submit(runDir, envelopeFor({ artifact: { path: at("inside.md"), sha256: sha256(CONTENT) } })),
      "accepted",
    );
  });

  it("rejects disallowed verdicts and envelopes for another run", () => {
    const { runDir, envelope } = readyAttempt();

    const maybe = submit(runDir, { ...envelope, verdict: "maybe" });
    expectRejected(maybe, "verdict_not_allowed");
    expect(fields(maybe)).toEqual(["verdict"]);
    expectRejected(submit(runDir, { ...envelope, verdict: null }), "verdict_not_allowed");
    expectRejected(submit(runDir, { ...envelope, runId: "run-2" }), "run_mismatch");

    // A stage opened without verdicts requires null.
    openAttemptOk(runDir, { stage: "notes", verdicts: "" });
    const notesRel = artifactRel("notes");
    const notesSha = writeArtifact(runDir, notesRel, CONTENT);
    const notes = envelopeFor({ stageId: "notes", artifact: { path: notesRel, sha256: notesSha } });
    expectRejected(submit(runDir, notes), "verdict_not_allowed");
    expectOutcome(submit(runDir, { ...notes, verdict: null }), "accepted");
  });

  it("requires a run directory with a journal, from --run-dir or WOOF_RUN_DIR", () => {
    const { runDir, envelope } = readyAttempt();
    const envelopePath = writeEnvelope(runDir, envelope);

    expectRejected(woof(["submit", "--envelope", envelopePath]), "run_dir_invalid", 3);
    expectRejected(
      woof(["submit", "--run-dir", makeRunDir(), "--envelope", envelopePath]),
      "run_dir_invalid",
      3,
    );
    expect(ofType(journal(runDir), "submission.rejected")).toHaveLength(0);

    expectOutcome(
      woof(["submit", "--envelope", envelopePath], { env: { WOOF_RUN_DIR: runDir } }),
      "accepted",
    );
  });

  it("reports journal corruption and accepted-copy write failures as infrastructure errors", () => {
    const { runDir, envelope } = readyAttempt();
    writeFileSync(join(runDir, "accepted"), "not a directory\n");

    expectRejected(submit(runDir, envelope), "journal_write_failed", 3);
    const lines = journal(runDir);
    expect(ofType(lines, "submission.accepted")).toHaveLength(0);
    expect(ofType(lines, "submission.rejected")).toHaveLength(0);

    appendFileSync(join(runDir, "journal.jsonl"), '{"schemaVersion":1,"se');
    expectRejected(submit(runDir, envelope), "journal_corrupt", 3);
  });

  it("keeps the accepted copy and receipt when the original changes or disappears", () => {
    const { runDir, envelope, sha } = readyAttempt();
    const first = submit(runDir, envelope);
    expectOutcome(first, "accepted");
    const acceptedPath = join(runDir, first.json?.receipt?.artifact.acceptedPath ?? "missing");

    writeFileSync(join(runDir, artifactRel()), "# Rewritten after acceptance\n");
    expect(sha256(readFileSync(acceptedPath))).toBe(sha);
    const retry = submit(runDir, envelope);
    expectOutcome(retry, "duplicate");
    expect(retry.json?.receipt).toEqual(first.json?.receipt);

    rmSync(join(runDir, artifactRel()));
    const afterDelete = submit(runDir, envelope);
    expectOutcome(afterDelete, "duplicate");
    expect(afterDelete.json?.receipt).toEqual(first.json?.receipt);
    expect(readFileSync(acceptedPath, "utf8")).toBe(CONTENT);
  });

  it("reads the envelope from stdin with --envelope -", () => {
    const { runDir, envelope } = readyAttempt();

    const result = woof(["submit", "--run-dir", runDir, "--envelope", "-"], {
      input: JSON.stringify(envelope),
    });

    expectOutcome(result, "accepted");
  });

  it("reports usage errors on stderr with exit 1", () => {
    const runDir = makeRunDir();
    const cases = [
      ["submit"],
      ["submit", "--envelope", "x.json", "--bogus"],
      ["attempt"],
      ["attempt", "open", "--run-dir", runDir, "--run", "run-1"],
      [
        "attempt",
        "open",
        "--run-dir",
        runDir,
        "--run",
        "run-1",
        "--agent",
        "worker",
        "--stage",
        "report",
        "--visit",
        "0",
        "--attempt",
        "1",
      ],
      [
        "attempt",
        "open",
        "--run-dir",
        runDir,
        "--run",
        "bad/id",
        "--agent",
        "worker",
        "--stage",
        "report",
        "--visit",
        "1",
        "--attempt",
        "1",
      ],
    ];

    for (const args of cases) {
      const result = woof(args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^woof: /);
    }
  });

  it("refuses to open an attempt whose directory or an ancestor is a symlink out of the run", () => {
    for (const link of ["artifacts/report/visit-1/attempt-1", "artifacts/report", "artifacts"]) {
      const runDir = makeRunDir();
      const outside = makeRunDir();
      mkdirSync(dirname(join(runDir, link)), { recursive: true });
      symlinkSync(outside, join(runDir, link));

      const result = openAttempt(runDir);

      expect(result.status, `${link}: ${result.stdout}${result.stderr}`).toBe(2);
      expect(result.json).toMatchObject({
        outcome: "rejected",
        reason: "attempt_dir_out_of_scope",
      });
      expect(existsSync(join(runDir, "journal.jsonl"))).toBe(false);
      expect(readdirSync(outside)).toEqual([]);
    }
  });

  it("rejects artifacts once the attempt directory or an ancestor is replaced by a symlink out of the run", () => {
    for (const replaced of ["artifacts/report/visit-1/attempt-1", "artifacts/report"]) {
      const { runDir, envelope } = readyAttempt();
      const outside = makeRunDir();
      // Mirror the replaced subtree outside the run, with a matching artifact.
      writeArtifact(outside, artifactRel().slice(replaced.length + 1), CONTENT);
      rmSync(join(runDir, replaced), { recursive: true, force: true });
      symlinkSync(outside, join(runDir, replaced));

      const result = submit(runDir, envelope);

      expectRejected(result, "artifact_out_of_scope");
      expect(ofType(journal(runDir), "submission.accepted")).toHaveLength(0);
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    "removes the published copy when the acceptance cannot be journaled",
    () => {
      const { runDir, envelope } = readyAttempt();
      const journalPath = join(runDir, "journal.jsonl");
      const before = readFileSync(journalPath);
      chmodSync(journalPath, 0o444);
      try {
        expectRejected(submit(runDir, envelope), "journal_write_failed", 3);
      } finally {
        chmodSync(journalPath, 0o644);
      }

      expect(readFileSync(journalPath).equals(before)).toBe(true);
      expect(readdirSync(join(runDir, "accepted/report/visit-1/attempt-1"))).toEqual([]);
    },
  );

  it("leaves no temporary file when the accepted copy cannot be put in place", () => {
    const { runDir, envelope } = readyAttempt();
    const acceptedDir = join(runDir, "accepted/report/visit-1/attempt-1");
    // A non-empty directory at the destination makes the final rename fail.
    mkdirSync(join(acceptedDir, "report.md", "blocker"), { recursive: true });

    expectRejected(submit(runDir, envelope), "journal_write_failed", 3);

    expect(readdirSync(acceptedDir)).toEqual(["report.md"]);
    expect(ofType(journal(runDir), "submission.accepted")).toHaveLength(0);
  });

  it("reaches every exported rejection reason", () => {
    const exported = runNode(
      `const m = await import(${JSON.stringify(distIndexUrl)}); console.log(JSON.stringify(m.REJECTION_REASONS));`,
    );
    expect(exported.status, exported.stderr).toBe(0);
    const reasons = JSON.parse(exported.stdout) as string[];

    expect(
      reasons.filter((reason) => !seen.has(reason) && !REACHED_IN_JOURNAL_TEST.has(reason)),
    ).toEqual([]);
    expect([...seen].filter((reason) => !reasons.includes(reason))).toEqual([]);
  });
});
