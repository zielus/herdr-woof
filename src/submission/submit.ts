import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join, resolve } from "node:path";

import { sha256Hex } from "../contracts/canonical-json.js";
import {
  MAX_ENVELOPE_BYTES,
  parseEnvelope,
  type AttemptIdentity,
  type Envelope,
  type RejectionDetail,
  type SubmitOutcome,
} from "../contracts/envelope.js";
import type { RejectionReason } from "../contracts/reasons.js";
import {
  JOURNAL_FILE,
  JournalFileError,
  appendRecord,
  describeEntryKind,
  inspectJournalPath,
  readJournal,
} from "../journal/journal.js";
import { withJournalLock, type LockOptions } from "../journal/lock.js";
import {
  acceptedPathFor,
  receiptFromAccepted,
  receiptIdFor,
  type JournalRecord,
} from "../journal/records.js";
import { attemptKey, replay, verdictAllowed } from "../state/reducer.js";
import {
  acceptedCopyProblem,
  publishAccepted,
  removePublished,
  resolveArtifact,
} from "./artifact.js";

export type SubmitInput = {
  /** Run directory holding `journal.jsonl`. */
  runDir?: string;
  /** Submitter's Herdr pane; the CLI passes HERDR_PANE_ID. */
  paneId?: string;
  lock?: LockOptions;
} & ({ envelopeRaw: string | Uint8Array } | { envelopePath: string });

type Rejection = Extract<SubmitOutcome, { outcome: "rejected" }>;

const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = constants;

/**
 * Bytes of the artifact check 17b decodes looking for the first non-blank line.
 * A first line further in than this is not a first line anyone writes, and
 * bounding the decode keeps a 32 MiB artifact from being decoded whole again.
 */
const MAX_VERDICT_LINE_SCAN = 64 * 1024;

/**
 * Validates a result envelope and its artifact, then records the outcome in the
 * run journal. The first failing check wins, in this order (pinned by
 * test/precedence.cli.test.ts):
 *
 *  1. run directory given and holds a journal entry    → run_dir_invalid
 *     journal entry is a symlink or not a regular file → journal_corrupt
 *  2. journal lock acquired                            → journal_busy
 *  3. journal file is regular and replays cleanly      → journal_corrupt
 *  4. journal holds run.opened (the run was opened)    → run_dir_invalid
 *  5. envelope regular file, ≤ 64 KiB, a JSON object   → envelope_malformed
 *  6. envelope matches schema v1                       → envelope_invalid
 *  7. runId equals the journal's run                   → run_mismatch
 * 7b. the run has no run.terminated record              → run_closed
 *  8. the attempt was opened                           → attempt_unknown
 *  9. agentId (and paneId, when both sides have one)   → owner_mismatch
 * 10. attempt already accepted: different digest       → attempt_closed_conflict
 *     same digest, accepted copy intact                → duplicate (prior receipt)
 *     same digest, accepted copy missing or altered    → journal_corrupt
 * 11. attempt superseded by a newer opened attempt     → attempt_stale
 * 12. verdict allowed by the attempt                   → verdict_not_allowed
 * 13. artifact path resolves inside the attempt dir    → artifact_out_of_scope
 * 14. artifact exists and is a regular file            → artifact_missing
 * 15. artifact has non-whitespace content              → artifact_empty
 * 16. artifact size ≤ MAX_ARTIFACT_BYTES (32 MiB)      → artifact_too_large
 * 17. artifact sha256 matches the envelope             → artifact_hash_mismatch
 *     artifact size unchanged while it was read        → artifact_hash_mismatch
 * 17b. artifact verdict marker agrees with the envelope → verdict_artifact_mismatch
 * 18. publish the accepted copy, append the record     → accepted / journal_write_failed
 *
 * The envelope is read and parsed before the lock is taken, but an envelope
 * rejection is reported only once checks 2–4 pass, because every contract
 * rejection is appended to the journal under the lock. A journal with no
 * `run.opened` record is never appended to: a record there would precede
 * `run.opened` and make the run permanently unreadable.
 *
 * Check 16 is decided from the file's size before it is read, so only artifacts
 * within the cap reach check 15's content read; a whitespace-only file larger
 * than the cap is therefore `artifact_too_large`.
 *
 * Check 17b runs only when the attempt was opened with an `artifactVerdictMarker`
 * (p5 D5: the stage opts in; nothing is checked otherwise). It reads the
 * artifact's **first non-blank line only**: when that line starts with the
 * marker, the rest of it must equal the envelope's verdict. An artifact whose
 * first non-blank line does not start with the marker is accepted unchanged, and
 * a marker-looking line further down is ignored — a reviewer quoting the required
 * line inside an example writes it at the start of a line too, and scanning the
 * whole artifact would reject that. The check runs after 17, so a submission
 * whose bytes do not match its own digest is reported as the hash mismatch it is.
 *
 * Every rejection except run_dir_invalid, journal_busy, journal_corrupt and
 * journal_write_failed is appended to the journal before it is returned.
 *
 * Engine-owned entries are inspected with lstat before any open, so a FIFO,
 * socket, directory or symlink cannot block or redirect the engine. The journal
 * must be a regular, non-symlink file in the run directory and is opened without
 * following symlinks; anything else is `journal_corrupt` and its target is never
 * read or written. Accepted copies live under real in-run `accepted/`
 * directories: a symlinked destination component refuses publication
 * (`journal_write_failed`, naming the component) and, on the duplicate path, a
 * non-regular or relocated copy makes the copy check fail (`journal_corrupt`).
 *
 * Only a copy referenced by a `submission.accepted` record is accepted. When the
 * acceptance cannot be journaled, the copy this call published is removed while
 * its content is unchanged; a crash between publication and the append can
 * still leave an unreferenced file under `accepted/`, which is not accepted.
 */
export async function submitResult(input: SubmitInput): Promise<SubmitOutcome> {
  // 1. Run directory and journal entry (lstat only, never opened here).
  if (input.runDir === undefined || input.runDir === "") {
    return rejection("run_dir_invalid", "no run directory given (--run-dir or WOOF_RUN_DIR)");
  }
  const runDir = resolve(input.runDir);
  const journalPath = join(runDir, JOURNAL_FILE);
  let journalEntry: ReturnType<typeof inspectJournalPath>;
  try {
    journalEntry = inspectJournalPath(journalPath);
  } catch (error) {
    return rejection(
      "run_dir_invalid",
      `cannot inspect ${journalPath}: ${(error as Error).message}`,
    );
  }
  if (journalEntry === "missing") {
    return rejection("run_dir_invalid", `${runDir} does not contain ${JOURNAL_FILE}`);
  }
  if (journalEntry instanceof JournalFileError) {
    return rejection("journal_corrupt", journalEntry.message);
  }
  const paneId = input.paneId === "" ? undefined : input.paneId;

  // 5–6. Envelope: parsed now, reported and journaled under the lock.
  const raw = "envelopeRaw" in input ? input.envelopeRaw : readEnvelopeFile(input.envelopePath);
  let preLock: Rejection | undefined;
  let rawDigest: string | undefined;
  let parsed: { envelope: Envelope; digest: string } | undefined;
  if (typeof raw === "object" && "error" in raw) {
    preLock = rejection("envelope_malformed", raw.error);
  } else {
    rawDigest = sha256Hex(raw);
    const result = parseEnvelope(raw);
    if (result.ok) {
      parsed = { envelope: result.envelope, digest: result.digest };
    } else {
      preLock = rejection(result.reason, result.message, result.details);
    }
  }

  // 2–4. Lock, journal replay and opened run. readJournal re-inspects the
  // journal entry under the lock, so an entry swapped in after check 1 is caught.
  let locked;
  try {
    locked = await withJournalLock(
      runDir,
      (): SubmitOutcome => {
        const read = readJournal(runDir);
        if (!read.ok) return rejection(read.reason, read.message);
        const records = read.records;
        if (records.length === 0) {
          return rejection(
            "run_dir_invalid",
            `${journalPath} has no run.opened record; the run has not been opened (open an attempt first)`,
          );
        }

        if (preLock !== undefined || parsed === undefined) {
          return journalRejection(
            runDir,
            records,
            preLock ?? rejection("envelope_malformed", "envelope could not be read"),
            {
              ...(rawDigest !== undefined ? { envelopeDigest: rawDigest } : {}),
              ...(paneId !== undefined ? { paneId } : {}),
            },
          );
        }
        return decide(runDir, records, parsed.envelope, parsed.digest, paneId);
      },
      input.lock,
    );
  } catch (error) {
    return rejection(
      "journal_write_failed",
      `cannot lock the journal: ${(error as Error).message}`,
    );
  }
  return locked.ok ? locked.value : rejection(locked.reason, locked.message);
}

/** Checks 7–18, run while holding the journal lock on an opened run. */
function decide(
  runDir: string,
  records: JournalRecord[],
  envelope: Envelope,
  digest: string,
  paneId: string | undefined,
): SubmitOutcome {
  const identity: AttemptIdentity = {
    runId: envelope.runId,
    agentId: envelope.agentId,
    stageId: envelope.stageId,
    visit: envelope.visit,
    attempt: envelope.attempt,
  };
  const context = {
    envelopeDigest: digest,
    identity,
    ...(paneId !== undefined ? { paneId } : {}),
  };
  const reject = (reason: RejectionReason, message: string, details: RejectionDetail[] = []) =>
    journalRejection(runDir, records, rejection(reason, message, details), context);

  // readJournal already replayed these records; this keeps the state typed.
  const replayed = replay(records);
  if (!replayed.ok) {
    return rejection("journal_corrupt", `line ${replayed.line}: ${replayed.message}`);
  }
  const state = replayed.state;

  // 7. Run.
  if (envelope.runId !== state.runId) {
    return reject("run_mismatch", `envelope runId ${envelope.runId} is not this run`, [
      { field: "runId", message: `expected ${String(state.runId)}` },
    ]);
  }

  // 7b. Terminated run: late results are rejected, even identical duplicates.
  if (state.termination !== undefined) {
    return reject(
      "run_closed",
      `run ${String(state.runId)} terminated as ${state.termination.outcome}; no further submissions are accepted`,
    );
  }

  // 8. Attempt declared.
  const attempt = state.attempts.get(
    attemptKey(envelope.stageId, envelope.visit, envelope.attempt),
  );
  if (attempt === undefined) {
    return reject(
      "attempt_unknown",
      `no attempt opened for stage ${envelope.stageId} visit ${envelope.visit} attempt ${envelope.attempt}`,
    );
  }

  // 9. Owner.
  const ownerDetails: RejectionDetail[] = [];
  if (envelope.agentId !== attempt.opened.agentId) {
    ownerDetails.push({
      field: "agentId",
      message: `attempt is owned by ${attempt.opened.agentId}`,
    });
  }
  if (
    attempt.opened.paneId !== undefined &&
    paneId !== undefined &&
    paneId !== attempt.opened.paneId
  ) {
    ownerDetails.push({
      field: "paneId",
      message: `attempt is bound to pane ${attempt.opened.paneId}, submitted from ${paneId}`,
    });
  }
  if (ownerDetails.length > 0) {
    return reject(
      "owner_mismatch",
      "submission does not come from the attempt owner",
      ownerDetails,
    );
  }

  // 10. Closed attempt: identical retry gets the prior receipt, but only while
  // the accepted copy is still a real in-run file matching the journal.
  if (attempt.accepted !== undefined) {
    const receipt = receiptFromAccepted(attempt.accepted);
    if (attempt.accepted.envelopeDigest !== digest) {
      return reject(
        "attempt_closed_conflict",
        `attempt was already accepted (${receipt.receiptId}) with a different envelope`,
        [{ field: "envelope", message: `accepted digest ${attempt.accepted.envelopeDigest}` }],
      );
    }
    const copyProblem = acceptedCopyProblem(runDir, attempt.accepted.artifact);
    if (copyProblem !== undefined) {
      return rejection("journal_corrupt", `${receipt.receiptId}: ${copyProblem}`);
    }
    try {
      appendRecord(runDir, records, {
        type: "submission.duplicate",
        receiptId: receipt.receiptId,
        acceptedSeq: receipt.seq,
        envelopeDigest: digest,
        ...(paneId !== undefined ? { paneId } : {}),
      });
    } catch (error) {
      return writeFailure(error, "");
    }
    return { outcome: "duplicate", receipt };
  }

  // 11. Stale.
  if (attempt.status === "superseded") {
    return reject("attempt_stale", "a newer attempt has been opened for this stage");
  }

  // 12. Verdict.
  const allowed = attempt.opened.verdicts;
  if (!verdictAllowed(allowed, envelope.verdict)) {
    return reject(
      "verdict_not_allowed",
      `verdict ${JSON.stringify(envelope.verdict)} is not allowed`,
      [
        {
          field: "verdict",
          message: allowed.length === 0 ? "must be null" : `must be one of ${allowed.join(", ")}`,
        },
      ],
    );
  }

  // 13–16. Artifact scope, existence, content and size.
  const artifact = resolveArtifact(runDir, attempt.opened.artifactDir, envelope.artifact.path);
  if (!artifact.ok) {
    return reject(artifact.reason, artifact.message, [
      { field: "artifact.path", message: artifact.message },
    ]);
  }

  // 17. Hash of the exact bytes checked above.
  const actual = sha256Hex(artifact.bytes);
  if (actual !== envelope.artifact.sha256) {
    return reject("artifact_hash_mismatch", "artifact content does not match artifact.sha256", [
      { field: "artifact.sha256", message: `file hashes to ${actual}` },
    ]);
  }

  // 17b. Opt-in artifact/envelope verdict agreement, on the first non-blank line.
  const mismatch = verdictMarkerMismatch(
    attempt.opened.artifactVerdictMarker,
    artifact.bytes,
    envelope.verdict,
  );
  if (mismatch !== undefined) {
    return reject("verdict_artifact_mismatch", mismatch.message, [
      { field: "verdict", message: mismatch.detail },
    ]);
  }

  // 18. Publish the immutable accepted copy, then persist acceptance.
  const acceptedPath = acceptedPathFor(
    envelope.stageId,
    envelope.visit,
    envelope.attempt,
    envelope.artifact.path,
  );
  let published: string;
  try {
    published = publishAccepted(runDir, acceptedPath, artifact.bytes);
  } catch (error) {
    return rejection(
      "journal_write_failed",
      `cannot publish ${acceptedPath}: ${(error as Error).message}`,
    );
  }
  if (published !== actual) {
    removePublished(runDir, acceptedPath, published);
    return reject("artifact_hash_mismatch", "accepted copy changed while it was published", [
      { field: "artifact.sha256", message: `accepted copy hashes to ${published}` },
    ]);
  }

  const seq = (records.at(-1)?.seq ?? 0) + 1;
  try {
    const record = appendRecord(runDir, records, {
      type: "submission.accepted",
      ...identity,
      status: envelope.status,
      verdict: envelope.verdict,
      envelopeDigest: digest,
      artifact: {
        path: envelope.artifact.path,
        sha256: actual,
        bytes: artifact.bytes.byteLength,
        acceptedPath,
      },
      ...(paneId !== undefined ? { paneId } : {}),
      receiptId: receiptIdFor(seq, digest),
    });
    if (record.type !== "submission.accepted") throw new Error("unexpected record type");
    return { outcome: "accepted", receipt: receiptFromAccepted(record) };
  } catch (error) {
    removePublished(runDir, acceptedPath, actual);
    return writeFailure(
      error,
      "cannot journal the acceptance, so the unreferenced accepted copy was removed: ",
    );
  }
}

/**
 * The artifact's first non-blank line against the envelope's verdict, for a
 * stage that declared a marker. Returns undefined when the stage declared none,
 * when the artifact has no non-blank line, when that line does not start with
 * the marker, or when the two agree.
 */
function verdictMarkerMismatch(
  marker: string | undefined,
  bytes: Uint8Array,
  envelopeVerdict: string | null,
): { message: string; detail: string } | undefined {
  if (marker === undefined) return undefined;
  // Only the head of the artifact is decoded: the first non-blank line is not further in.
  const head = Buffer.from(
    bytes.subarray(0, Math.min(bytes.byteLength, MAX_VERDICT_LINE_SCAN)),
  ).toString("utf8");
  const first = head.split("\n").find((line) => line.trim() !== "");
  if (first === undefined || !first.startsWith(marker)) return undefined;
  const artifactVerdict = first.slice(marker.length).trim();
  if (artifactVerdict === envelopeVerdict) return undefined;
  return {
    message: `the artifact's first line ${JSON.stringify(first.trim())} declares verdict ${JSON.stringify(artifactVerdict)}, but the envelope carries ${JSON.stringify(envelopeVerdict)}`,
    detail: `the artifact says ${JSON.stringify(artifactVerdict)}; the envelope says ${JSON.stringify(envelopeVerdict)}`,
  };
}

function journalRejection(
  runDir: string,
  records: JournalRecord[],
  outcome: Rejection,
  context: { envelopeDigest?: string; identity?: AttemptIdentity; paneId?: string },
): SubmitOutcome {
  try {
    appendRecord(runDir, records, {
      type: "submission.rejected",
      reason: outcome.reason,
      message: outcome.message,
      details: outcome.details,
      ...context,
    });
  } catch (error) {
    return writeFailure(error, `cannot journal ${outcome.reason} rejection: `);
  }
  return outcome;
}

/** A journal file that stopped being a regular in-run file is corrupt, not a write failure. */
function writeFailure(error: unknown, prefix: string): Rejection {
  return rejection(
    error instanceof JournalFileError ? "journal_corrupt" : "journal_write_failed",
    `${prefix}${(error as Error).message}`,
  );
}

/**
 * Reads an envelope file. The path is inspected with lstat before opening: a
 * symlink, FIFO, socket, directory or device is refused (envelope_malformed)
 * without an open that could block. The open uses O_NOFOLLOW | O_NONBLOCK and
 * the descriptor must be a regular file.
 */
function readEnvelopeFile(path: string): Uint8Array | { error: string } {
  let fd: number;
  try {
    const named = lstatSync(path);
    if (!named.isFile()) {
      return {
        error: `cannot read envelope ${path}: it is not a regular file (${describeEntryKind(named)})`,
      };
    }
    fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    return { error: `cannot read envelope ${path}: ${(error as Error).message}` };
  }
  try {
    if (!fstatSync(fd).isFile()) {
      return { error: `cannot read envelope ${path}: it is not a regular file` };
    }
    // Read one byte past the limit so oversized envelopes are detectable.
    const buffer = Buffer.alloc(MAX_ENVELOPE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return buffer.subarray(0, length);
  } catch (error) {
    return { error: `cannot read envelope ${path}: ${(error as Error).message}` };
  } finally {
    closeSync(fd);
  }
}

function rejection(
  reason: RejectionReason,
  message: string,
  details: RejectionDetail[] = [],
): Rejection {
  return { outcome: "rejected", reason, message, details };
}
