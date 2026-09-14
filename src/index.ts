/**
 * Public SDK entry point.
 *
 * Keeping this module free of CLI and plugin imports preserves the package
 * boundary. The package's ESM metadata makes this compiled file importable as
 * a module.
 *
 * The result-handoff exports below are a p1 prototype, not a stable API: the
 * envelope, journal records and function signatures may change when the SDK
 * contracts are defined. `woof attempt open` and `woof submit` call the same
 * functions.
 */
export const SDK_FOUNDATION = true;

export { REJECTION_REASONS } from "./contracts/reasons.js";
export type { AttemptOpenReason, InfraReason, RejectionReason } from "./contracts/reasons.js";
export type {
  AttemptIdentity,
  Envelope,
  Receipt,
  RejectionDetail,
  SubmissionStatus,
  SubmitOutcome,
} from "./contracts/envelope.js";
export { readJournal } from "./journal/journal.js";
export type { ReadJournalResult } from "./journal/journal.js";
export type { JournalRecord } from "./journal/records.js";
export { openAttempt } from "./submission/attempt.js";
export type { OpenAttemptInput, OpenAttemptOutcome, OpenedAttempt } from "./submission/attempt.js";
export { MAX_ARTIFACT_BYTES } from "./submission/artifact.js";
export { submitResult } from "./submission/submit.js";
export type { SubmitInput } from "./submission/submit.js";
