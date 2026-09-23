import { isId } from "../contracts/envelope.js";
import { check, keysProblem, nonEmptyStringProblem } from "./record-fields.js";
import type { RecordBase } from "./records.js";

/**
 * Notification records: the agent that started a run inside Herdr (the caller) is the run's
 * notification target, and the run host pushes the events that need that agent into its pane.
 * `notify.target` names the caller once, right after the run opens; `notify.outcome` records what
 * became of each notification (sent, queued, dropped, ambiguous) and when notifying stopped. A run
 * without a target journals neither. Both are additive at schemaVersion 1: a journal without them
 * replays unchanged. Cross-record rules live in the reducer.
 */

/** The events that produce a notification; nothing else does. */
export const NOTIFY_EVENTS = [
  "action_required",
  "resumed",
  "error",
  "limit_reached",
  "done",
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** Each outcome and its closed set of reasons. */
export const NOTIFY_REASONS = {
  sent: ["delivered"],
  queued: ["caller_working", "caller_blocked", "caller_unreadable"],
  dropped: ["wait_bound", "host_exiting", "not_delivered"],
  ambiguous: ["delivery_ambiguous"],
  stopped: ["target_gone", "target_changed"],
} as const;
export type NotifyOutcome = keyof typeof NOTIFY_REASONS;
export type NotifyReason = (typeof NOTIFY_REASONS)[NotifyOutcome][number];

/** The caller as Herdr reported it when the run started: its pane and the agent session there. */
export interface NotifyTargetRecord extends RecordBase {
  type: "notify.target";
  paneId: string;
  /** The Herdr agent name the host prompts. */
  agentName: string;
  /** The agent kind Herdr detected (`claude`, …). */
  agent: string;
  sessionId: string | null;
  terminalId: string | null;
}

export interface NotifyOutcomeRecord extends RecordBase {
  type: "notify.outcome";
  /** The event notified; null for `stopped`, which concerns the target, not one notification. */
  event: NotifyEvent | null;
  /** The notification's identity, `<runId>#<seq>` of the record it reports; null for `stopped`. */
  key: string | null;
  outcome: NotifyOutcome;
  reason: NotifyReason;
}

const MAX_FIELD = 200;
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}#[1-9][0-9]*$/;

export function notifyTargetProblem(value: Record<string, unknown>): string | undefined {
  return (
    keysProblem(value, ["paneId", "agentName", "agent", "sessionId", "terminalId"]) ??
    boundedProblem(value, "paneId") ??
    boundedProblem(value, "agentName") ??
    boundedProblem(value, "agent") ??
    nullableProblem(value, "sessionId") ??
    nullableProblem(value, "terminalId")
  );
}

export function notifyOutcomeProblem(value: Record<string, unknown>): string | undefined {
  const problem = keysProblem(value, ["event", "key", "outcome", "reason"]);
  if (problem !== undefined) return problem;
  const outcome = value["outcome"];
  if (typeof outcome !== "string" || !Object.hasOwn(NOTIFY_REASONS, outcome))
    return "outcome is not a notification outcome";
  const reasons: readonly string[] = NOTIFY_REASONS[outcome as NotifyOutcome];
  const stopped = outcome === "stopped";
  const key = value["key"];
  return (
    check(
      typeof value["reason"] === "string" && reasons.includes(value["reason"]),
      `reason is not one of ${reasons.join(", ")}`,
    ) ??
    check(
      stopped
        ? value["event"] === null
        : (NOTIFY_EVENTS as readonly unknown[]).includes(value["event"]),
      stopped ? "event must be null when stopped" : "event is not a notification event",
    ) ??
    check(
      stopped
        ? key === null
        : typeof key === "string" && KEY_PATTERN.test(key) && isId(key.split("#")[0]),
      stopped ? "key must be null when stopped" : "key is not <runId>#<seq>",
    )
  );
}

function boundedProblem(value: Record<string, unknown>, field: string): string | undefined {
  return (
    nonEmptyStringProblem(value, field) ??
    check((value[field] as string).length <= MAX_FIELD, `${field} is longer than ${MAX_FIELD}`)
  );
}

function nullableProblem(value: Record<string, unknown>, field: string): string | undefined {
  return value[field] === null ? undefined : boundedProblem(value, field);
}
