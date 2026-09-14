import { DISPATCH_REASONS } from "../domain/types.js";

/**
 * Runtime adapter contract (p2, unstable until v1). A runtime starts agents in
 * panes, reports their observed lifecycle, delivers one prompt and stops panes
 * it opened. It never writes the run journal: runtime observations are lossy
 * samples, and no lifecycle value completes, accepts or fails an attempt.
 */

export type Lifecycle = "ready" | "working" | "blocked" | "unknown" | "gone";

/** Ordering keys from the runtime; any may be unknown. */
export interface ObservationOrder {
  terminalId: string | null;
  stateChangeSeq: number | null;
  revision: number | null;
}

export interface LifecycleObservation {
  runtimeName: string;
  paneId: string;
  lifecycle: Lifecycle;
  /** Raw runtime status ("idle", "done", "working", "blocked", "unknown"); null when gone. */
  runtimeStatus: string | null;
  sessionId: string | null;
  order: ObservationOrder;
  /** Adapter clock when the observation was taken. */
  observedAt: string;
}

export interface AgentHandle {
  adapter: "herdr" | "scripted";
  runtimeName: string;
  kind: string;
  paneId: string;
  /**
   * Display only: whether this adapter instance opened the pane. `stop` never
   * trusts this field; it closes a pane only when the same instance returned it
   * from `openPane`.
   */
  paneOwned: boolean;
  terminalId: string | null;
  sessionId: string | null;
}

export type RuntimeErrorCode =
  /** Binary missing, HERDR_ENV is not 1, or the server is unreachable. */
  | "runtime_unavailable"
  /** Bad name, kind or arguments; Herdr usage errors (exit 2). */
  | "invalid_request"
  /** agent_not_found or pane_not_found. */
  | "not_found"
  /** The agent was blocked during startup; its name stays addressable. */
  | "agent_not_ready"
  /** A prompt was rejected before any input was sent. */
  | "agent_blocked"
  /** Adapter precondition: the agent is working. */
  | "agent_busy"
  | "timeout"
  /** agent_prompt_stalled. */
  | "stalled"
  /** For example stop on a pane the adapter did not open. */
  | "unsupported"
  /** Non-JSON or unexpected output. */
  | "protocol_error"
  /** Any other runtime error; `runtimeCode` keeps the raw code. */
  | "runtime_error";

export interface RuntimeError {
  code: RuntimeErrorCode;
  runtimeCode: string | null;
  message: string;
  command: string[];
  exitCode: number | null;
}

export type RuntimeResult<T> = { ok: true; value: T } | { ok: false; error: RuntimeError };

/** Error codes that prove nothing was sent; the same closed set a dispatch records. */
export type NotDeliveredCode = (typeof DISPATCH_REASONS.not_delivered)[number];

/** Error codes for a prompt that may have been typed; the same closed set a dispatch records. */
export type AmbiguousCode = (typeof DISPATCH_REASONS.ambiguous)[number];

export type NotDeliveredError = RuntimeError & { code: NotDeliveredCode };
export type AmbiguousDeliveryError = RuntimeError & { code: AmbiguousCode };

/**
 * Delivery certainty. `not_delivered` means provably nothing was sent;
 * `ambiguous` means the prompt may have been typed. Each carries only its own
 * code set, so a timeout can never be reported as not delivered. There is no
 * resend: trying again is a new, explicitly opened attempt.
 */
export type DeliveryResult =
  | { outcome: "started"; observation: LifecycleObservation }
  | { outcome: "not_delivered"; error: NotDeliveredError }
  | { outcome: "ambiguous"; error: AmbiguousDeliveryError };

export const NOT_DELIVERED_CODES: readonly NotDeliveredCode[] = DISPATCH_REASONS.not_delivered;
export const AMBIGUOUS_CODES: readonly AmbiguousCode[] = DISPATCH_REASONS.ambiguous;

// The type predicates also check at compile time that both sets are runtime error codes.
export function isNotDeliveredCode(code: RuntimeErrorCode): code is NotDeliveredCode {
  return (NOT_DELIVERED_CODES as readonly string[]).includes(code);
}

export function isAmbiguousCode(code: RuntimeErrorCode): code is AmbiguousCode {
  return (AMBIGUOUS_CODES as readonly string[]).includes(code);
}

export interface OpenPaneInput {
  /** A pane id to split, or "current" for the caller's pane. */
  near: string;
  cwd: string;
  env?: Record<string, string>;
  direction?: "right" | "down";
}

export interface StartAgentInput {
  runtimeName: string;
  kind: string;
  paneId: string;
  /** Ignored: ownership comes from the adapter's own `openPane` calls. */
  paneOwned?: boolean;
  args?: string[];
  timeoutMs: number;
}

export interface RuntimeAdapter {
  readonly adapter: "herdr" | "scripted";
  openPane(input: OpenPaneInput): Promise<RuntimeResult<{ paneId: string }>>;
  startAgent(input: StartAgentInput): Promise<RuntimeResult<AgentHandle>>;
  /** A pane or agent that no longer exists is the `gone` lifecycle, not an error. */
  observe(handle: AgentHandle): Promise<RuntimeResult<LifecycleObservation>>;
  waitFor(
    handle: AgentHandle,
    states: Lifecycle[],
    timeoutMs: number,
  ): Promise<RuntimeResult<LifecycleObservation>>;
  deliver(
    handle: AgentHandle,
    text: string,
    options: { timeoutMs: number },
  ): Promise<DeliveryResult>;
  /** Closes the handle's pane only when this instance opened it; otherwise `unsupported`. */
  stop(
    handle: AgentHandle,
    options: { timeoutMs: number },
  ): Promise<RuntimeResult<{ paneClosed: true }>>;
}

/**
 * Maps a raw runtime status to a lifecycle. `idle` and `done` both mean ready
 * for input: which one Herdr reports depends on whether someone focused the
 * pane, not on the agent. Unrecognized statuses are `unknown`.
 */
export function lifecycleFromStatus(status: string): Exclude<Lifecycle, "gone"> {
  switch (status) {
    case "idle":
    case "done":
      return "ready";
    case "working":
      return "working";
    case "blocked":
      return "blocked";
    default:
      return "unknown";
  }
}

export function runtimeError<C extends RuntimeErrorCode>(
  code: C,
  message: string,
  details: { command?: string[]; runtimeCode?: string | null; exitCode?: number | null } = {},
): RuntimeError & { code: C } {
  return {
    code,
    runtimeCode: details.runtimeCode ?? null,
    message,
    command: details.command ?? [],
    exitCode: details.exitCode ?? null,
  };
}
