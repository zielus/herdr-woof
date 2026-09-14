import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

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
import { JOURNAL_FILE, appendRecord, attemptKey, readJournal, replay } from "../journal/journal.js";
import { withJournalLock, type LockOptions } from "../journal/lock.js";
import { receiptFromAccepted, type JournalRecord } from "../journal/records.js";
import { publishAccepted, resolveArtifact } from "./artifact.js";

export type SubmitInput = {
  /** Run directory holding `journal.jsonl`. */
  runDir?: string;
  /** Submitter's Herdr pane; the CLI passes HERDR_PANE_ID. */
  paneId?: string;
  lock?: LockOptions;
} & ({ envelopeRaw: string | Uint8Array } | { envelopePath: string });

type Rejection = Extract<SubmitOutcome, { outcome: "rejected" }>;

/**
 * Validates a result envelope and its artifact, then records the outcome in the
 * run journal. Checks run in this order and the first failure wins:
 *
 *  1. run directory given and holds a journal         → run_dir_invalid
 *  2. envelope readable, ≤ 64 KiB, a JSON object       → envelope_malformed
 *  3. envelope matches schema v1                       → envelope_invalid
 *  4. journal lock acquired, journal replays cleanly   → journal_busy / journal_corrupt
 *  5. runId equals the journal's run                   → run_mismatch
 *  6. the attempt was opened                           → attempt_unknown
 *  7. agentId (and paneId, when both sides have one)   → owner_mismatch
 *  8. attempt already accepted: same digest            → duplicate (prior receipt)
 *                               different digest       → attempt_closed_conflict
 *  9. attempt superseded by a newer opened attempt     → attempt_stale
 * 10. verdict allowed by the attempt                   → verdict_not_allowed
 * 11. artifact path resolves inside the attempt dir    → artifact_out_of_scope
 * 12. artifact exists and is a regular file            → artifact_missing
 * 13. artifact has non-whitespace content              → artifact_empty
 * 14. artifact sha256 matches the envelope             → artifact_hash_mismatch
 * 15. publish the accepted copy, append the record     → accepted / journal_write_failed
 *
 * Every rejection except run_dir_invalid, journal_busy, journal_corrupt and
 * journal_write_failed is appended to the journal before it is returned.
 */
export async function submitResult(input: SubmitInput): Promise<SubmitOutcome> {
  // 1. Run directory.
  if (input.runDir === undefined || input.runDir === "") {
    return rejection("run_dir_invalid", "no run directory given (--run-dir or WOOF_RUN_DIR)");
  }
  const runDir = resolve(input.runDir);
  if (!isFile(join(runDir, JOURNAL_FILE))) {
    return rejection("run_dir_invalid", `${runDir} does not contain ${JOURNAL_FILE}`);
  }
  const paneId = input.paneId === "" ? undefined : input.paneId;

  // 2–3. Envelope. Decided before the lock, journaled under it.
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

  // 4. Lock and replay.
  let locked;
  try {
    locked = await withJournalLock(
      runDir,
      (): SubmitOutcome => {
        const read = readJournal(runDir);
        if (!read.ok) return rejection(read.reason, read.message);
        const records = read.records;

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

/** Checks 5–15, run while holding the journal lock. */
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

  const state = replay(records);

  // 5. Run.
  if (envelope.runId !== state.runId) {
    return reject("run_mismatch", `envelope runId ${envelope.runId} is not this run`, [
      { field: "runId", message: `expected ${String(state.runId)}` },
    ]);
  }

  // 6. Attempt declared.
  const attempt = state.attempts.get(
    attemptKey(envelope.stageId, envelope.visit, envelope.attempt),
  );
  if (attempt === undefined) {
    return reject(
      "attempt_unknown",
      `no attempt opened for stage ${envelope.stageId} visit ${envelope.visit} attempt ${envelope.attempt}`,
    );
  }

  // 7. Owner.
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

  // 8. Closed attempt: identical retry gets the prior receipt.
  if (attempt.accepted !== undefined) {
    const receipt = receiptFromAccepted(attempt.accepted);
    if (attempt.accepted.envelopeDigest !== digest) {
      return reject(
        "attempt_closed_conflict",
        `attempt was already accepted (${receipt.receiptId}) with a different envelope`,
        [{ field: "envelope", message: `accepted digest ${attempt.accepted.envelopeDigest}` }],
      );
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
      return rejection("journal_write_failed", (error as Error).message);
    }
    return { outcome: "duplicate", receipt };
  }

  // 9. Stale.
  if (attempt.status === "superseded") {
    return reject("attempt_stale", "a newer attempt has been opened for this stage");
  }

  // 10. Verdict.
  const allowed = attempt.opened.verdicts;
  if (
    allowed.length === 0 ? envelope.verdict !== null : !allowed.includes(envelope.verdict ?? "")
  ) {
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

  // 11–13. Artifact scope, existence, content.
  const artifact = resolveArtifact(runDir, attempt.opened.artifactDir, envelope.artifact.path);
  if (!artifact.ok) {
    return reject(artifact.reason, artifact.message, [
      { field: "artifact.path", message: artifact.message },
    ]);
  }

  // 14. Hash of the exact bytes checked above.
  const actual = sha256Hex(artifact.bytes);
  if (actual !== envelope.artifact.sha256) {
    return reject("artifact_hash_mismatch", "artifact content does not match artifact.sha256", [
      { field: "artifact.sha256", message: `file hashes to ${actual}` },
    ]);
  }

  // 15. Publish the immutable accepted copy, then persist acceptance.
  const acceptedPath = join(
    "accepted",
    envelope.stageId,
    `visit-${envelope.visit}`,
    `attempt-${envelope.attempt}`,
    basename(envelope.artifact.path),
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
      receiptId: `rcpt-${seq}-${digest.slice(0, 12)}`,
    });
    if (record.type !== "submission.accepted") throw new Error("unexpected record type");
    return { outcome: "accepted", receipt: receiptFromAccepted(record) };
  } catch (error) {
    return rejection("journal_write_failed", (error as Error).message);
  }
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
    return rejection(
      "journal_write_failed",
      `cannot journal ${outcome.reason} rejection: ${(error as Error).message}`,
    );
  }
  return outcome;
}

function readEnvelopeFile(path: string): Uint8Array | { error: string } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    return { error: `cannot read envelope ${path}: ${(error as Error).message}` };
  }
  try {
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

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function rejection(
  reason: RejectionReason,
  message: string,
  details: RejectionDetail[] = [],
): Rejection {
  return { outcome: "rejected", reason, message, details };
}
