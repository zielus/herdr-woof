import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONTENT,
  artifactRel,
  cleanupRunDirs,
  envelopeFor,
  journal,
  makeRunDir,
  openAttemptOk,
  readyAttempt,
  sha256,
  submit,
  writeArtifact,
} from "./helpers/process.js";

afterEach(() => cleanupRunDirs());

interface Arranged {
  runDir: string;
  envelope: Record<string, unknown>;
  env?: Record<string, string>;
}

interface PrecedenceCase {
  name: string;
  arrange: () => Arranged;
  /** Rejection reason, or "duplicate". */
  expected: string;
  exit: number;
  /** The single record appended by the submission, or "unchanged". */
  journal: Record<string, unknown> | "unchanged";
}

function acceptFirst(
  runDir: string,
  envelope: Record<string, unknown>,
  env?: Record<string, string>,
) {
  const result = submit(runDir, envelope, env !== undefined ? { env } : {});
  if (result.json?.outcome !== "accepted") {
    throw new Error(`setup acceptance failed: ${result.stdout}${result.stderr}`);
  }
}

/** Two opened attempts for report visit 1; attempt 1 is stale and has an artifact. */
function staleAttempt(): { runDir: string; sha: string } {
  const runDir = makeRunDir();
  openAttemptOk(runDir);
  openAttemptOk(runDir, { attempt: 2 });
  return { runDir, sha: writeArtifact(runDir, artifactRel(), CONTENT) };
}

// Each case violates two checks at once; the earlier check in submitResult's
// documented order must win, and the journal must record exactly that outcome.
const cases: PrecedenceCase[] = [
  {
    name: "a corrupt journal outranks an invalid envelope, and neither is journaled",
    arrange: () => {
      const { runDir, envelope } = readyAttempt();
      appendFileSync(join(runDir, "journal.jsonl"), '{"schemaVersion":1,"se');
      return { runDir, envelope: { ...envelope, visit: 0 } };
    },
    expected: "journal_corrupt",
    exit: 3,
    journal: "unchanged",
  },
  {
    name: "an invalid envelope outranks a run mismatch",
    arrange: () => {
      const { runDir, envelope } = readyAttempt();
      return { runDir, envelope: { ...envelope, runId: "run-2", visit: 0 } };
    },
    expected: "envelope_invalid",
    exit: 2,
    journal: { type: "submission.rejected", reason: "envelope_invalid" },
  },
  {
    name: "a run mismatch outranks an unknown attempt",
    arrange: () => {
      const { runDir, envelope } = readyAttempt();
      return { runDir, envelope: { ...envelope, runId: "run-2", attempt: 9 } };
    },
    expected: "run_mismatch",
    exit: 2,
    journal: { type: "submission.rejected", reason: "run_mismatch" },
  },
  {
    name: "an unknown attempt outranks a wrong owner",
    arrange: () => {
      const { runDir, envelope } = readyAttempt();
      return { runDir, envelope: { ...envelope, attempt: 9, agentId: "intruder" } };
    },
    expected: "attempt_unknown",
    exit: 2,
    journal: { type: "submission.rejected", reason: "attempt_unknown" },
  },
  {
    name: "a wrong pane outranks an identical accepted digest",
    arrange: () => {
      const { runDir, envelope } = readyAttempt({ pane: "w1:p1" });
      acceptFirst(runDir, envelope, { HERDR_PANE_ID: "w1:p1" });
      return { runDir, envelope, env: { HERDR_PANE_ID: "w1:p2" } };
    },
    expected: "owner_mismatch",
    exit: 2,
    journal: { type: "submission.rejected", reason: "owner_mismatch" },
  },
  {
    name: "a wrong agent outranks a stale attempt",
    arrange: () => {
      const { runDir, sha } = staleAttempt();
      return {
        runDir,
        envelope: envelopeFor({
          agentId: "intruder",
          artifact: { path: artifactRel(), sha256: sha },
        }),
      };
    },
    expected: "owner_mismatch",
    exit: 2,
    journal: { type: "submission.rejected", reason: "owner_mismatch" },
  },
  {
    name: "a conflicting digest on an accepted attempt outranks a newer opened attempt",
    arrange: () => {
      const { runDir, envelope } = readyAttempt();
      acceptFirst(runDir, envelope);
      openAttemptOk(runDir, { attempt: 2 });
      return { runDir, envelope: { ...envelope, verdict: "fail" } };
    },
    expected: "attempt_closed_conflict",
    exit: 2,
    journal: { type: "submission.rejected", reason: "attempt_closed_conflict" },
  },
  {
    name: "an identical digest on an accepted attempt is a duplicate despite a newer attempt",
    arrange: () => {
      const { runDir, envelope } = readyAttempt();
      acceptFirst(runDir, envelope);
      openAttemptOk(runDir, { attempt: 2 });
      return { runDir, envelope };
    },
    expected: "duplicate",
    exit: 0,
    journal: { type: "submission.duplicate" },
  },
  {
    name: "a stale attempt outranks a disallowed verdict",
    arrange: () => {
      const { runDir, sha } = staleAttempt();
      return {
        runDir,
        envelope: envelopeFor({ verdict: "maybe", artifact: { path: artifactRel(), sha256: sha } }),
      };
    },
    expected: "attempt_stale",
    exit: 2,
    journal: { type: "submission.rejected", reason: "attempt_stale" },
  },
  {
    name: "a disallowed verdict outranks an out-of-scope artifact",
    arrange: () => {
      const { runDir, envelope } = readyAttempt();
      return {
        runDir,
        envelope: {
          ...envelope,
          verdict: "maybe",
          artifact: { path: artifactRel("review"), sha256: sha256(CONTENT) },
        },
      };
    },
    expected: "verdict_not_allowed",
    exit: 2,
    journal: { type: "submission.rejected", reason: "verdict_not_allowed" },
  },
  {
    name: "an out-of-scope artifact outranks a missing one",
    arrange: () => {
      const { runDir, envelope } = readyAttempt();
      return {
        runDir,
        envelope: {
          ...envelope,
          artifact: { path: artifactRel("review", 1, 1, "absent.md"), sha256: sha256(CONTENT) },
        },
      };
    },
    expected: "artifact_out_of_scope",
    exit: 2,
    journal: { type: "submission.rejected", reason: "artifact_out_of_scope" },
  },
  {
    name: "an empty artifact outranks a hash mismatch",
    arrange: () => {
      const { runDir, envelope } = readyAttempt();
      const rel = artifactRel("report", 1, 1, "empty.md");
      writeArtifact(runDir, rel, "  \n");
      return {
        runDir,
        envelope: { ...envelope, artifact: { path: rel, sha256: sha256(CONTENT) } },
      };
    },
    expected: "artifact_empty",
    exit: 2,
    journal: { type: "submission.rejected", reason: "artifact_empty" },
  },
];

describe("submitResult check precedence", () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const { runDir, envelope, env } = testCase.arrange();
      const journalPath = join(runDir, "journal.jsonl");
      const before = readFileSync(journalPath, "utf8");

      const result = submit(runDir, envelope, env !== undefined ? { env } : {});

      expect(result.json?.reason ?? result.json?.outcome, `${result.stdout}${result.stderr}`).toBe(
        testCase.expected,
      );
      expect(result.status).toBe(testCase.exit);
      const after = readFileSync(journalPath, "utf8");
      if (testCase.journal === "unchanged") {
        expect(after).toBe(before);
      } else {
        expect(after.startsWith(before)).toBe(true);
        const appended = after.slice(before.length).trim().split("\n");
        expect(appended).toHaveLength(1);
        expect(JSON.parse(appended[0] ?? "{}")).toMatchObject(testCase.journal);
      }
    });
  }
});

describe("an unopened run", () => {
  it("rejects any submission without journaling it, and can still be opened", () => {
    const runDir = makeRunDir();
    const journalPath = join(runDir, "journal.jsonl");
    writeFileSync(journalPath, "");

    for (const envelope of [JSON.stringify(envelopeFor()), "not json"]) {
      const result = submit(runDir, envelope);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(3);
      expect(result.json).toMatchObject({ outcome: "rejected", reason: "run_dir_invalid" });
      expect(result.json?.message).toContain("has no run.opened record");
      expect(readFileSync(journalPath, "utf8")).toBe("");
    }

    openAttemptOk(runDir);
    expect(journal(runDir).map((line) => line.type)).toEqual(["run.opened", "attempt.opened"]);
  });
});
