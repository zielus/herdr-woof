/**
 * Closed set of reasons `submitResult` can reject a submission with, grouped by
 * the stage that decides them. This list is not the precedence order: the
 * envelope is parsed before the journal lock is taken, but its rejection is
 * reported only once the lock is held and the journal is readable and opened,
 * so `journal_busy`, `journal_corrupt` and an unopened run (`run_dir_invalid`)
 * outrank `envelope_malformed` and `envelope_invalid`. The authoritative order
 * is the doc comment on `submitResult`, pinned by test/precedence.cli.test.ts.
 * Adding a check means adding a code here, a branch in `submitResult`, and a
 * process test that reaches it.
 */
export const REJECTION_REASONS = [
  "run_dir_invalid",
  "envelope_malformed",
  "envelope_invalid",
  "journal_busy",
  "journal_corrupt",
  "run_mismatch",
  "run_closed",
  "attempt_unknown",
  "owner_mismatch",
  "attempt_closed_conflict",
  "attempt_stale",
  "verdict_not_allowed",
  "artifact_out_of_scope",
  "artifact_missing",
  "artifact_empty",
  "artifact_too_large",
  "artifact_hash_mismatch",
  "verdict_artifact_mismatch",
  "journal_write_failed",
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

/**
 * Reasons caused by the run directory or journal rather than by the submitted
 * envelope. They cannot be journaled and the CLI exits 3 for them.
 */
export const INFRA_REASONS = [
  "run_dir_invalid",
  "journal_busy",
  "journal_corrupt",
  "journal_write_failed",
] as const satisfies readonly RejectionReason[];

export type InfraReason = (typeof INFRA_REASONS)[number];

/** Reasons `openAttempt` can refuse to declare an attempt with. */
export type AttemptOpenReason =
  | "attempt_open_conflict"
  | "attempt_dir_out_of_scope"
  | "run_mismatch"
  | "run_closed"
  | "stage_unknown"
  | "owner_mismatch"
  | "verdicts_mismatch"
  | "journal_busy"
  | "journal_corrupt"
  | "journal_write_failed";

/**
 * Reasons the state store refuses to record a run fact. Store refusals are
 * invariants (the record would make the journal impossible), not policy, and
 * are not journaled.
 */
export type StoreReason =
  | InfraReason
  | "plan_invalid"
  | "run_exists"
  | "run_mismatch"
  | "run_closed"
  | "agent_unknown"
  | "agent_unassigned"
  | "agent_busy"
  | "assignment_unchanged"
  | "stage_unknown"
  | "attempt_unknown"
  | "owner_mismatch"
  | "verdicts_mismatch"
  | "dispatch_exists"
  | "dispatch_not_latest"
  | "gate_subject_unknown"
  | "gate_subject_stale"
  | "gate_mismatch"
  | "gate_exists"
  | "round_invalid"
  | "run_blocked"
  | "not_blocked"
  | "dispatch_not_ambiguous"
  | "reconcile_exists"
  | "assignment_mismatch"
  | "host_exists"
  | "host_unknown"
  | "host_gone"
  | "observation_lost"
  | "observation_not_lost";

/**
 * Reasons workflow admission refuses a run with, before any pane or journal
 * write. p4 adds the configuration reasons and the loader reasons, so a host
 * that resolves configuration and loads a definition reports one closed set.
 */
export const ADMISSION_REASONS = [
  "input_invalid",
  "repo_invalid",
  "agent_kind_unsupported",
  "plan_invalid",
  "definition_invalid",
  "config_invalid",
  "config_conflict",
  "setting_scope_invalid",
  "role_invalid",
  "role_unresolved",
  "project_mismatch",
  "workflow_not_found",
  "definition_not_found",
  "definition_syntax_unsupported",
  "definition_load_failed",
] as const;

export type AdmissionReason = (typeof ADMISSION_REASONS)[number];

export function isInfraReason(reason: string): reason is InfraReason {
  return (INFRA_REASONS as readonly string[]).includes(reason);
}
