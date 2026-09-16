/**
 * Domain types for runs, plans, agents, stages, attempts and outcomes (p2
 * contract, unstable until v1). Role, agent kind, model, agent identity and
 * workflow stage stay distinct. Gate, block and delivery-reconciliation
 * records are written by the scheduler (p3).
 */

/** Role name; an id. */
export type RoleName = string;

/** Runtime agent kind label, for example "claude"; validated by the runtime adapter. */
export type AgentKind = string;

export type RunStatus =
  /** run.opened, no agent assigned. */
  | "created"
  /** At least one agent.assigned, no request.dispatched. */
  | "starting"
  /** At least one request.dispatched, not blocked, not terminated. */
  | "running"
  /** An unresolved run.blocked record, not terminated. */
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "exhausted";

export type TerminalOutcome = "completed" | "failed" | "cancelled" | "exhausted";

export const TERMINAL_OUTCOMES: readonly TerminalOutcome[] = [
  "completed",
  "failed",
  "cancelled",
  "exhausted",
];

export interface AgentSpec {
  agentId: string;
  role: RoleName;
  kind: AgentKind;
  model: string | null;
  /** Resolved launch arguments passed to the runtime (p3, optional). */
  args?: string[];
}

export interface StageSpec {
  stageId: string;
  /** Names an AgentSpec in the same plan. */
  agentId: string;
  /** Verdicts a submission may carry; empty means the verdict must be null. */
  verdicts: string[];
}

/**
 * Declared bounds. p2 validates and counts against them; enforcement (and the
 * response to reaching one) belongs to the scheduler.
 */
export interface Limits {
  maxAttemptsPerVisit: number;
  maxVisitsPerStage: number;
  maxRounds: number;
  runTimeoutMs: number;
  readinessWaitMs: number;
  blockedWaitMs: number;
  deliveryTimeoutMs: number;
  /** Format-repair attempts per visit, 0–1000; absent means 0 (p3). */
  maxFormatRepairs?: number;
}

export const COUNT_LIMIT_KEYS = ["maxAttemptsPerVisit", "maxVisitsPerStage", "maxRounds"] as const;
/** Count limits a plan may omit; an absent one means 0. */
export const OPTIONAL_COUNT_LIMIT_KEYS = ["maxFormatRepairs"] as const;
export const DURATION_LIMIT_KEYS = [
  "runTimeoutMs",
  "readinessWaitMs",
  "blockedWaitMs",
  "deliveryTimeoutMs",
] as const;
export const LIMIT_KEYS: readonly (keyof Limits)[] = [
  ...COUNT_LIMIT_KEYS,
  ...OPTIONAL_COUNT_LIMIT_KEYS,
  ...DURATION_LIMIT_KEYS,
];

/** Upper bound for count limits. */
export const MAX_COUNT_LIMIT = 1000;
/**
 * Upper bound for duration limits: seven days (604 800 000 ms). Lead decision
 * (plan §9 amendment, repair round 1, SC-008): every wait must be bounded, and
 * an unbounded duration is not a limit, so all `*Ms` limits are positive safe
 * integers of at most seven days.
 */
export const MAX_DURATION_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

export interface RunPlan {
  workflow: { name: string; version: string };
  agents: AgentSpec[];
  stages: StageSpec[];
  limits: Limits;
  /** Engine-run check ids (p3, optional): unique, disjoint from stage ids. */
  checks?: string[];
}

export interface AttemptRef {
  stageId: string;
  visit: number;
  attempt: number;
}

/** `abandoned` is derived in snapshots: an attempt still open when the run terminated. */
export type AttemptStatus = "open" | "superseded" | "accepted" | "abandoned";

export type DeliveryState = "undispatched" | "started" | "not_delivered" | "ambiguous";

/** Delivery certainty a dispatch can record. */
export type DispatchDelivery = Exclude<DeliveryState, "undispatched">;

export const DISPATCH_DELIVERIES: readonly DispatchDelivery[] = [
  "started",
  "not_delivered",
  "ambiguous",
];

/**
 * Closed reason set per recorded delivery. `started` names the runtime state
 * observed after submission; the others are runtime error codes: provably
 * nothing sent (`not_delivered`) or possibly sent (`ambiguous`).
 */
export const DISPATCH_REASONS = {
  started: ["observed_working", "observed_blocked"],
  not_delivered: [
    "not_found",
    "agent_blocked",
    "agent_busy",
    "invalid_request",
    "runtime_unavailable",
    "precondition_failed",
  ],
  ambiguous: ["stalled", "timeout", "protocol_error", "runtime_error"],
} as const satisfies Record<DispatchDelivery, readonly string[]>;

/** Why an attempt was opened, derived from the previous attempt of its visit (p3). */
export type AttemptCause = "initial" | "format_repair" | "work_retry";

/** Engine-computed repository fingerprint: HEAD (null without commits) and a git tree id. */
export interface Revision {
  head: string | null;
  tree: string;
}

export type GateDecision = "pass" | "reject";

export interface GateResult {
  stageId: string;
  visit: number;
  attempt: number;
  receiptId: string;
  verdict: string | null;
  decision: GateDecision;
  round: number;
}

export interface BlockInfo {
  agentId: string;
  reason: string;
  requiredAction: string;
  since: string;
}

/** `not_delivered` is kept in the type; no p3 record can carry it (no evidence proves non-delivery). */
export type DeliveryResolution = "delivered" | "not_delivered" | "abandoned";

export const BLOCK_REASONS = ["blocked_on_input", "startup_blocked"] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

export const RECONCILE_EVIDENCE = {
  delivered: ["submission_recorded", "observed_activity"],
  abandoned: ["no_evidence_before_deadline"],
} as const;

export interface Outcome {
  outcome: TerminalOutcome;
  reason: string;
  limit: keyof Limits | null;
}
