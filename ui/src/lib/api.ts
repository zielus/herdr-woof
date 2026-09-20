/**
 * The shapes the `woof ui` server returns, which are the engine's own documents
 * (`woof.run.status`, `woof.run.snapshot`, `woof.run.event`) passed through
 * unchanged. Only the fields this UI reads are declared; the engine's surface is
 * unstable until v1, so narrowing here keeps the UI honest about what it uses.
 */

import { token, tokenQuery } from "@/lib/token";

export type RunStatusName =
  | "created"
  | "starting"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "exhausted";

export type HostOwner = "unhosted" | "alive" | "lost" | "exited";

export const TERMINAL_STATUSES: readonly RunStatusName[] = [
  "completed",
  "failed",
  "cancelled",
  "exhausted",
];

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export interface WorkflowRef {
  name: string;
  version: string;
}

export interface ActiveAttempt {
  agentId: string;
  stageId: string;
  visit: number;
  attempt: number;
  dispatchedAt: string | null;
}

export interface SnapshotBlocked {
  seq: number;
  agentId: string;
  reason: string;
  requiredAction: string;
  since: string;
  attempt?: { stageId: string; visit: number; attempt: number };
}

export interface Attention {
  ambiguousDeliveries: Array<{
    agentId?: string;
    stageId?: string;
    visit?: number;
    attempt?: number;
  }>;
  blocked: SnapshotBlocked | null;
}

export interface RunListEntry {
  runId: string;
  runDir: string;
  workflow: WorkflowRef | null;
  status: RunStatusName;
  owner: HostOwner;
  openedAt: string;
  updatedAt: string;
  project: string | null;
  /** Added by the web server from the same snapshot; null when it could not be read. */
  activeAttempts: ActiveAttempt[] | null;
  attention: Attention | null;
}

export interface RunsResponse {
  outcome: "runs";
  runsDir: string;
  exists: boolean;
  runs: RunListEntry[];
  skipped: Array<{ path: string; reason: string }>;
}

export interface SnapshotAgent {
  agentId: string;
  role: string;
  kind: string;
  model: string | null;
  assignment: { paneId: string | null; runtimeName: string | null; at: string } | null;
  activeAttempt: { stageId: string; visit: number; attempt: number } | null;
}

export interface SnapshotAttempt {
  attempt: number;
  seq: number;
  agentId: string;
  status: "open" | "superseded" | "accepted" | "abandoned";
  cause: "initial" | "format_repair" | "work_retry";
  openedAt: string;
  delivery: "undispatched" | "started" | "not_delivered" | "ambiguous";
  accepted: { verdict: string | null; status: string; at: string } | null;
  rejectionLog: Array<{ seq: number; reason: string; message: string }>;
}

export interface SnapshotStage {
  stageId: string;
  agentId: string;
  verdicts: string[] | null;
  visits: Array<{ visit: number; attempts: SnapshotAttempt[] }>;
}

export interface SnapshotGate {
  seq: number;
  at: string;
  gate: string;
  kind: "stage" | "check";
  decision: "pass" | "reject";
  reason: string;
  verdict?: string | null;
  round: number;
}

export interface RunSnapshot {
  runId: string;
  revision: number;
  cursor: string;
  workflow: WorkflowRef | null;
  status: RunStatusName;
  openedAt: string;
  updatedAt: string;
  outcome: { outcome: string; reason: string; limit: string | null; at: string } | null;
  agents: SnapshotAgent[];
  stages: SnapshotStage[];
  gates: SnapshotGate[];
  attention: Attention;
  liveness: { owner: HostOwner; host: { paneId?: string | null; pid?: number } | null };
}

export interface RunStatusView {
  runId: string;
  runDir: string;
  workflow: WorkflowRef | null;
  status: RunStatusName;
  openedAt: string;
  updatedAt: string;
  liveness: RunSnapshot["liveness"];
  activeAttempts: ActiveAttempt[];
  lastGate: { gate: string; decision: string; reason: string; round: number; at: string } | null;
  attention: Attention;
  cursor: string;
}

export interface RunResponse {
  outcome: "run";
  status: RunStatusView;
  result: { outcome: string; reason: string; limit: string | null } | null;
  snapshot: RunSnapshot;
  project: string | null;
}

export interface RunEvent {
  schemaVersion: 1;
  kind: "woof.run.event";
  runId: string;
  seq: number;
  ts: string;
  type: string;
  cursor: string;
  subject: { agentId?: string; stageId?: string; visit?: number; attempt?: number };
  data: Record<string, unknown>;
}

export interface UnsupportedAction {
  supported: false;
  reason: string;
  message: string;
}

export interface Capabilities {
  schemaVersion: 1;
  kind: "woof.ui.capabilities";
  actions: {
    cancel: { supported: true; method: string; path: string };
    answerBlocked: UnsupportedAction;
    retry: UnsupportedAction;
    start: UnsupportedAction;
  };
}

/** A rejection the server named, carried with its reason so the UI can quote it. */
export class ApiError extends Error {
  readonly reason: string;
  readonly status: number;

  constructor(status: number, reason: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.reason = reason;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const secret = token();
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
      ...init?.headers,
    },
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    throw new ApiError(response.status, "response_invalid", `${path} did not return JSON`);
  }
  if (!response.ok) {
    const named = body as { reason?: string; message?: string } | null;
    throw new ApiError(
      response.status,
      named?.reason ?? "request_failed",
      named?.message ?? `${path} failed with ${response.status}`,
    );
  }
  return body as T;
}

export const runPath = (runId: string): string => `/api/runs/${encodeURIComponent(runId)}`;

/** The run's event stream. `EventSource` cannot set headers, so the token rides in the query. */
export const eventsUrl = (runId: string): string => `${runPath(runId)}/events${tokenQuery()}`;

export const fetchRuns = (): Promise<RunsResponse> => request<RunsResponse>("/api/runs");

export const fetchRun = (runId: string): Promise<RunResponse> =>
  request<RunResponse>(runPath(runId));

export const fetchCapabilities = (): Promise<Capabilities> =>
  request<Capabilities>("/api/capabilities");

/** Records `run.terminated{outcome:"cancelled"}`, the engine's one operator action. */
export const cancelRun = (runId: string, reason: string): Promise<{ outcome: string }> =>
  request<{ outcome: string }>(`${runPath(runId)}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
