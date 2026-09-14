/**
 * Domain types for runs, plans, agents, stages, attempts and outcomes (p2
 * contract, unstable until v1). Role, agent kind, model, agent identity and
 * workflow stage stay distinct. Gate, block and delivery-reconciliation types
 * exist so consumers can handle them now; their journal records arrive with
 * the scheduler (phase 3).
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
  /** Never derived in p2: run.blocked records arrive in phase 3. */
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
}

export const COUNT_LIMIT_KEYS = ["maxAttemptsPerVisit", "maxVisitsPerStage", "maxRounds"] as const;
export const DURATION_LIMIT_KEYS = [
  "runTimeoutMs",
  "readinessWaitMs",
  "blockedWaitMs",
  "deliveryTimeoutMs",
] as const;
export const LIMIT_KEYS: readonly (keyof Limits)[] = [...COUNT_LIMIT_KEYS, ...DURATION_LIMIT_KEYS];

/** Upper bound for count limits. */
export const MAX_COUNT_LIMIT = 1000;
/** Upper bound for duration limits: seven days. */
export const MAX_DURATION_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

export interface RunPlan {
  workflow: { name: string; version: string };
  agents: AgentSpec[];
  stages: StageSpec[];
  limits: Limits;
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
  ],
  ambiguous: ["stalled", "timeout", "protocol_error", "runtime_error"],
} as const satisfies Record<DispatchDelivery, readonly string[]>;

// Types only in p2; records arrive with the scheduler.
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

export type DeliveryResolution = "delivered" | "not_delivered" | "abandoned";

export interface Outcome {
  outcome: TerminalOutcome;
  reason: string;
  limit: keyof Limits | null;
}
