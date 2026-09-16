import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  artifactRel,
  cleanupRunDirs,
  envelopeFor,
  journal,
  makeRunDir,
  ofType,
  openAttemptOk,
  openAttemptWithMarker,
  repoRoot,
  runNode,
  runSdk,
  submit,
  writeArtifact,
} from "./helpers/process.js";

/**
 * Check 17b (p5 D5): opt-in artifact/envelope verdict agreement. Every case is a
 * real `node dist/cli.js submit` process against a real journal.
 *
 * The contract is narrow on purpose. A stage opts in by declaring a marker; the
 * check reads the artifact's first non-blank line only; an artifact that does not
 * open with the marker makes no claim and is accepted unchanged.
 */
const MARKER = "Woof-Verdict:";

afterEach(() => cleanupRunDirs());

/** An opened attempt (optionally declaring the marker) with an artifact and its envelope. */
function arrange(options: { marker?: string; artifact: string; verdict: string | null }) {
  const runDir = makeRunDir();
  if (options.marker === undefined) openAttemptOk(runDir);
  else openAttemptWithMarker(runDir, options.marker);
  const sha = writeArtifact(runDir, artifactRel(), options.artifact);
  return {
    runDir,
    envelope: envelopeFor({
      verdict: options.verdict,
      artifact: { path: artifactRel(), sha256: sha },
    }),
  };
}

const acceptedCopy = (runDir: string) =>
  join(runDir, "accepted", "report", "visit-1", "attempt-1", "report.md");

describe("check 17b: an artifact verdict marker that disagrees with the envelope", () => {
  it("rejects it as verdict_artifact_mismatch, naming both, with no accepted copy", () => {
    const { runDir, envelope } = arrange({
      marker: MARKER,
      artifact: `${MARKER} fail\n\nThe migration drops a column with no backfill.\n`,
      verdict: "pass",
    });
    const before = journal(runDir).length;
    const result = submit(runDir, envelope);

    expect(result.status, result.stdout + result.stderr).toBe(2);
    expect(result.json).toMatchObject({
      outcome: "rejected",
      reason: "verdict_artifact_mismatch",
    });
    // The message names the offending line, the artifact's verdict and the envelope's.
    expect(result.json?.message).toContain(`"${MARKER} fail"`);
    expect(result.json?.message).toContain('"fail"');
    expect(result.json?.message).toContain('"pass"');
    expect(result.json?.details).toEqual([
      { field: "verdict", message: 'the artifact says "fail"; the envelope says "pass"' },
    ]);

    // Exactly one record appended, and it is the rejection.
    const lines = journal(runDir);
    expect(lines).toHaveLength(before + 1);
    expect(lines.at(-1)).toMatchObject({
      type: "submission.rejected",
      reason: "verdict_artifact_mismatch",
    });
    expect(ofType(lines, "submission.accepted")).toEqual([]);
    // Nothing was published: no accepted copy, so no gate can advance on it.
    expect(existsSync(acceptedCopy(runDir))).toBe(false);
  });

  it("accepts the same artifact once the two agree", () => {
    const { runDir, envelope } = arrange({
      marker: MARKER,
      artifact: `${MARKER} fail\n\nThe migration drops a column with no backfill.\n`,
      verdict: "fail",
    });
    const result = submit(runDir, envelope);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.json?.outcome).toBe("accepted");
    expect(readFileSync(acceptedCopy(runDir), "utf8")).toContain(`${MARKER} fail`);
  });

  it("accepts an artifact that declares no marker: the check makes no claim", () => {
    const { runDir, envelope } = arrange({
      marker: MARKER,
      artifact: "# Review\n\nNothing blocking.\n",
      verdict: "pass",
    });
    expect(submit(runDir, envelope)).toMatchObject({ status: 0, json: { outcome: "accepted" } });
  });

  it("ignores a marker-looking line that is not the first: the anchor holds", () => {
    // A reviewer quoting the required line inside an example writes it at the
    // start of a line too. Scanning the whole artifact would reject that.
    const { runDir, envelope } = arrange({
      marker: MARKER,
      artifact: `# Review\n\nThe request asked me to write:\n\n${MARKER} fail\n\nI have no blocking findings.\n`,
      verdict: "pass",
    });
    expect(submit(runDir, envelope)).toMatchObject({ status: 0, json: { outcome: "accepted" } });
  });

  it("checks nothing when the stage declared no marker, even with a marker-looking first line", () => {
    const { runDir, envelope } = arrange({
      artifact: `${MARKER} fail\n\nStill just prose to this stage.\n`,
      verdict: "pass",
    });
    expect(submit(runDir, envelope)).toMatchObject({ status: 0, json: { outcome: "accepted" } });
    const opened = ofType(journal(runDir), "attempt.opened")[0] as unknown as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(opened, "artifactVerdictMarker")).toBe(false);
  });

  it("catches a BOM-prefixed marker line, and still makes no claim about a space-indented one (PB-004)", () => {
    // `trim()` treats a UTF-8 BOM as whitespace when the first non-blank line is
    // chosen, so a BOM-prefixed marker line reaches the prefix test and must not
    // fall through it: an editor that writes a BOM would otherwise skip 17b.
    const rejected = arrange({
      marker: MARKER,
      artifact: `\uFEFF${MARKER} fail\n\nThe migration drops a column.\n`,
      verdict: "pass",
    });
    const result = submit(rejected.runDir, rejected.envelope);
    expect(result).toMatchObject({ status: 2, json: { reason: "verdict_artifact_mismatch" } });
    expect(result.json?.message).toContain('"fail"');
    expect(existsSync(acceptedCopy(rejected.runDir))).toBe(false);

    // The same bytes agreeing are accepted, so the BOM itself is never the failure.
    const agreeing = arrange({
      marker: MARKER,
      artifact: `\uFEFF${MARKER} fail\n\nThe migration drops a column.\n`,
      verdict: "fail",
    });
    expect(submit(agreeing.runDir, agreeing.envelope)).toMatchObject({
      status: 0,
      json: { outcome: "accepted" },
    });

    // A space-indented marker line does NOT start with the marker, so the stage's
    // contract makes no claim about it and it is accepted (plan §2 D5).
    const indented = arrange({
      marker: MARKER,
      artifact: `   ${MARKER} fail\n\nFindings.\n`,
      verdict: "pass",
    });
    expect(submit(indented.runDir, indented.envelope)).toMatchObject({
      status: 0,
      json: { outcome: "accepted" },
    });
  });

  it("finds the first non-blank line however far in it is, with no prefix cap (PR #7 submit.ts:432)", () => {
    // The scan used to decode only the first 64 KiB of a 32 MiB-capped artifact.
    // More leading blank content than that hid a disagreement entirely, and a
    // marker line straddling the cap was truncated into a false mismatch.
    const blanks = "\n".repeat(70_000);
    const rejected = arrange({
      marker: MARKER,
      artifact: `${blanks}${MARKER} fail\n\nThe migration drops a column.\n`,
      verdict: "pass",
    });
    const result = submit(rejected.runDir, rejected.envelope);
    expect(result, result.stdout + result.stderr).toMatchObject({
      status: 2,
      json: { reason: "verdict_artifact_mismatch" },
    });
    expect(result.json?.message).toContain('"fail"');
    expect(existsSync(acceptedCopy(rejected.runDir))).toBe(false);

    // The same artifact agreeing is accepted, so the depth itself is never the failure.
    const agreeing = arrange({
      marker: MARKER,
      artifact: `${blanks}${MARKER} fail\n\nThe migration drops a column.\n`,
      verdict: "fail",
    });
    expect(submit(agreeing.runDir, agreeing.envelope)).toMatchObject({
      status: 0,
      json: { outcome: "accepted" },
    });

    // A marker line whose verdict text used to be cut in half by the old cap.
    const straddling = arrange({
      marker: MARKER,
      artifact: `${"\n".repeat(64 * 1024 - 16)}${MARKER} pass\n\nNothing blocking.\n`,
      verdict: "pass",
    });
    expect(submit(straddling.runDir, straddling.envelope)).toMatchObject({
      status: 0,
      json: { outcome: "accepted" },
    });
  }, 60_000);

  it("compares the remainder of the line trimmed, which is the contract (PR #7 submit.ts:457)", () => {
    // plan §2 D5: "the remainder of the line, trimmed, must equal the envelope's
    // verdict". Trailing and repeated spaces around the verdict word are
    // therefore agreement, not a malformed line, and CRLF is not a disagreement
    // either — the carriage return is whitespace like any other. These cases make
    // that explicit rather than leaving it to be read off `.trim()`.
    const agreeing = [
      ["a trailing space", `${MARKER} pass \n\nNothing blocking.\n`],
      ["repeated spaces after the colon", `${MARKER}    pass\n\nNothing blocking.\n`],
      ["a tab after the colon", `${MARKER}\tpass\n\nNothing blocking.\n`],
      ["CRLF line endings", `${MARKER} pass\r\n\r\nNothing blocking.\r\n`],
      ["trailing whitespace and CRLF", `${MARKER} pass  \r\n\r\nNothing blocking.\r\n`],
    ] as const;
    for (const [what, artifact] of agreeing) {
      const run = arrange({ marker: MARKER, artifact, verdict: "pass" });
      expect(submit(run.runDir, run.envelope), what).toMatchObject({
        status: 0,
        json: { outcome: "accepted" },
      });
    }

    // The same shapes still catch a real disagreement: whitespace is ignored,
    // the verdict word is not.
    for (const [what, artifact] of agreeing) {
      const run = arrange({
        marker: MARKER,
        artifact: artifact.replace("pass", "fail"),
        verdict: "pass",
      });
      const result = submit(run.runDir, run.envelope);
      expect(result, `${what}, disagreeing`).toMatchObject({
        status: 2,
        json: { reason: "verdict_artifact_mismatch" },
      });
      // The reported artifact verdict is the trimmed word, with no stray whitespace.
      expect(result.json?.details, what).toEqual([
        { field: "verdict", message: 'the artifact says "fail"; the envelope says "pass"' },
      ]);
    }

    // A word that merely starts with the verdict is still a disagreement.
    const nearly = arrange({
      marker: MARKER,
      artifact: `${MARKER} passed\n\nNothing blocking.\n`,
      verdict: "pass",
    });
    expect(submit(nearly.runDir, nearly.envelope)).toMatchObject({
      status: 2,
      json: { reason: "verdict_artifact_mismatch" },
    });
  }, 60_000);

  it("skips leading blank lines to find the first line, and tolerates a null envelope verdict", () => {
    const rejected = arrange({
      marker: MARKER,
      artifact: `\n\n   \n${MARKER} fail\n\nFindings.\n`,
      verdict: "pass",
    });
    expect(submit(rejected.runDir, rejected.envelope)).toMatchObject({
      status: 2,
      json: { reason: "verdict_artifact_mismatch" },
    });

    // A stage with no allowed verdicts submits null; a marker line then disagrees
    // with null rather than crashing on it.
    const runDir = makeRunDir();
    openAttemptWithMarker(runDir, MARKER, { verdicts: "" });
    const sha = writeArtifact(runDir, artifactRel(), `${MARKER} pass\n\nDone.\n`);
    const result = submit(
      runDir,
      envelopeFor({ verdict: null, artifact: { path: artifactRel(), sha256: sha } }),
    );
    expect(result).toMatchObject({ status: 2, json: { reason: "verdict_artifact_mismatch" } });
    expect(result.json?.message).toContain("the envelope carries null");
  });
});

describe("the optional attempt.opened field is additive at schemaVersion 1", () => {
  it("replays an attempt.opened record both with and without artifactVerdictMarker", () => {
    // Exact-key record validation is where an additive field bites: a record
    // carrying the new key must be valid, and one without it must stay valid.
    const runDir = makeRunDir();
    openAttemptWithMarker(runDir, MARKER);
    const withMarker = ofType(journal(runDir), "attempt.opened")[0] as unknown as Record<
      string,
      unknown
    >;
    expect(withMarker["artifactVerdictMarker"]).toBe(MARKER);

    const plain = makeRunDir();
    openAttemptOk(plain);
    const without = ofType(journal(plain), "attempt.opened")[0] as unknown as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(without, "artifactVerdictMarker")).toBe(false);

    const state = runSdk<{ ok: boolean; problem?: string }>(
      runDir,
      `const read = readJournal(runDir);
out = { ok: read.ok, ...(read.ok ? {} : { problem: read.message }) };`,
    );
    expect(state).toMatchObject({ ok: true });

    // Exact-key record validation: the new key must be allowed, absent must stay
    // valid, and a value that is not a marker must be refused rather than replayed.
    const bad = runNode(
      `const { parseRecordLine } = await import(${JSON.stringify(
        pathToFileURL(join(repoRoot, "dist", "journal", "records.js")).href,
      )});
const base = JSON.parse(process.argv[1]);
const problem = (marker) => {
  const record = marker === undefined ? base : { ...base, artifactVerdictMarker: marker };
  const parsed = parseRecordLine(JSON.stringify(record));
  return typeof parsed === "string" ? parsed : null;
};
console.log(
  JSON.stringify({
    withField: problem("Woof-Verdict:"),
    withoutField: problem(undefined),
    multiline: problem("a\\nb"),
    empty: problem(""),
    tooLong: problem("x".repeat(65)),
    unknownKey: (() => {
      const parsed = parseRecordLine(JSON.stringify({ ...base, notAField: 1 }));
      return typeof parsed === "string" ? parsed : null;
    })(),
  }),
);`,
      [JSON.stringify(without)],
    );
    expect(bad.status, bad.stderr).toBe(0);
    const problems = JSON.parse(bad.stdout.trim()) as Record<string, string | null>;
    expect(problems["withField"]).toBeNull();
    expect(problems["withoutField"]).toBeNull();
    for (const key of ["multiline", "empty", "tooLong"]) {
      expect(problems[key], key).toContain("artifactVerdictMarker");
    }
    // The key set is still exact: an unrelated field is still refused.
    expect(problems["unknownKey"]).toContain("notAField");
  });

  it("still replays the committed p1 and p2 journal fixtures, which predate the field", () => {
    for (const fixture of ["p1-journal.jsonl", "p2-journal.jsonl"]) {
      const runDir = makeRunDir();
      copyFileSync(join(repoRoot, "test", "fixtures", fixture), join(runDir, "journal.jsonl"));
      const out = runSdk<{ ok: boolean; message?: string; records?: number }>(
        runDir,
        `const read = readJournal(runDir);
out = read.ok
  ? { ok: true, records: read.records.length }
  : { ok: false, message: read.message };`,
      );
      expect(out, fixture).toMatchObject({ ok: true });
      expect(out.records, fixture).toBeGreaterThan(0);
    }
  });
});

describe("the definition contract validates a declared marker", () => {
  it("refuses a multi-line, empty or over-long marker and accepts a plain one", () => {
    const out = runNode(
      `const { validateWorkflowDefinition } = await import(${JSON.stringify(
        pathToFileURL(join(repoRoot, "dist", "scheduler", "definition.js")).href,
      )});
const { buildReviewWorkflow } = await import(${JSON.stringify(
        pathToFileURL(join(repoRoot, "dist", "workflows", "build-review.js")).href,
      )});
const withMarker = (marker) => ({
  ...buildReviewWorkflow,
  stages: buildReviewWorkflow.stages.map((stage) =>
    stage.stageId === "review" ? { ...stage, artifactVerdictMarker: marker } : stage,
  ),
});
const fieldsOf = (marker) => {
  const result = validateWorkflowDefinition(withMarker(marker));
  return result.ok ? [] : result.details.map((detail) => detail.field);
};
console.log(
  JSON.stringify({
    shipped: buildReviewWorkflow.stages.find((s) => s.stageId === "review").artifactVerdictMarker,
    plain: fieldsOf("Woof-Verdict:"),
    empty: fieldsOf("  "),
    multiline: fieldsOf("Woof-Verdict:\\n"),
    tooLong: fieldsOf("x".repeat(65)),
    number: fieldsOf(7),
    absent: (() => {
      const stages = buildReviewWorkflow.stages.map((stage) => {
        const copy = { ...stage };
        delete copy.artifactVerdictMarker;
        return copy;
      });
      const result = validateWorkflowDefinition({ ...buildReviewWorkflow, stages });
      return result.ok ? [] : result.details.map((d) => d.field);
    })(),
  }),
);`,
    );
    expect(out.status, out.stderr).toBe(0);
    const result = JSON.parse(out.stdout.trim()) as Record<string, unknown>;
    expect(result["shipped"]).toBe(MARKER);
    expect(result["plain"]).toEqual([]);
    // Opt-in: a definition that declares none is valid.
    expect(result["absent"]).toEqual([]);
    for (const key of ["empty", "multiline", "tooLong", "number"]) {
      expect(result[key], key).toEqual(["stages[2].artifactVerdictMarker"]);
    }
  });
});
