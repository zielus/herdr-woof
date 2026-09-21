// Journal record builders for pure-logic unit tests. Records are plain objects;
// `journalOf` gives them contiguous seq and fixed timestamps and checks each one
// against the compiled record field contract.
type Json = Record<string, unknown>;

export const PLAN = {
  workflow: { name: "build-review", version: "1" },
  agents: [
    { agentId: "builder", role: "builder", kind: "claude", model: null },
    { agentId: "reviewer", role: "reviewer", kind: "claude", model: "opus" },
  ],
  stages: [
    { stageId: "build", agentId: "builder", verdicts: [] },
    { stageId: "review", agentId: "reviewer", verdicts: ["approve", "reject"] },
  ],
  limits: {
    maxAttemptsPerVisit: 2,
    maxVisitsPerStage: 3,
    maxRounds: 3,
    runTimeoutMs: 600_000,
    readinessWaitMs: 60_000,
    blockedWaitMs: 60_000,
    deliveryTimeoutMs: 10_000,
  },
};

export const HEX = "a".repeat(64);

export function journalOf(parse: (line: string) => Json | string, ...bodies: Json[]): Json[] {
  return bodies.map((body, index) => {
    const record = {
      schemaVersion: 1,
      seq: index + 1,
      ts: new Date(Date.UTC(2026, 8, 14, 10, 0, 0, index)).toISOString(),
      ...body,
    };
    const parsed = parse(JSON.stringify(record));
    if (typeof parsed === "string") throw new Error(`fixture record ${index + 1}: ${parsed}`);
    return parsed;
  });
}

export const opened = (plan: Json | null = PLAN, runId = "run-1"): Json => ({
  type: "run.opened",
  runId,
  ...(plan !== null ? { plan } : {}),
});

export function attempt(
  stageId: string,
  agentId: string,
  visit = 1,
  attemptNo = 1,
  verdicts: string[] = stageId === "review" ? ["approve", "reject"] : [],
  runId = "run-1",
): Json {
  return {
    type: "attempt.opened",
    runId,
    agentId,
    stageId,
    visit,
    attempt: attemptNo,
    verdicts,
    artifactDir: `artifacts/${stageId}/visit-${visit}/attempt-${attemptNo}`,
  };
}

export const assigned = (agentId: string, paneId = `w1:${agentId}`): Json => ({
  type: "agent.assigned",
  agentId,
  runtime: { adapter: "scripted", runtimeName: `w-${agentId}`, paneId },
});

export function dispatched(
  stageId: string,
  agentId: string,
  visit = 1,
  attemptNo = 1,
  delivery = "started",
  reason = "observed_working",
): Json {
  return {
    type: "request.dispatched",
    agentId,
    stageId,
    visit,
    attempt: attemptNo,
    delivery,
    reason,
  };
}

export const terminated = (outcome = "cancelled", limit?: string): Json => ({
  type: "run.terminated",
  outcome,
  reason: "test",
  ...(limit !== undefined ? { limit } : {}),
});

/** An acceptance for (stage, visit, attempt) that lands at `seq`. */
export function accepted(
  seq: number,
  stageId: string,
  agentId: string,
  verdict: string | null,
  visit = 1,
  attemptNo = 1,
): Json {
  const dir = `${stageId}/visit-${visit}/attempt-${attemptNo}`;
  return {
    type: "submission.accepted",
    runId: "run-1",
    agentId,
    stageId,
    visit,
    attempt: attemptNo,
    status: "completed",
    verdict,
    envelopeDigest: HEX,
    artifact: {
      path: `artifacts/${dir}/out.md`,
      sha256: HEX,
      bytes: 10,
      acceptedPath: `accepted/${dir}/out.md`,
    },
    receiptId: `rcpt-${seq}-${HEX.slice(0, 12)}`,
  };
}

export const duplicate = (acceptedSeq: number): Json => ({
  type: "submission.duplicate",
  receiptId: `rcpt-${acceptedSeq}-${HEX.slice(0, 12)}`,
  acceptedSeq,
  envelopeDigest: HEX,
});

export function rejected(reason: string, identity?: Json): Json {
  return {
    type: "submission.rejected",
    reason,
    message: reason,
    details: [],
    ...(identity !== undefined ? { identity } : {}),
  };
}

/** A git revision fixture: 40-hex head and tree. */
export const REV = { head: "b".repeat(40), tree: "c".repeat(40) };

const receiptOf = (acceptedSeq: number): string => `rcpt-${acceptedSeq}-${HEX.slice(0, 12)}`;

/** A stage gate on the acceptance at `acceptedSeq` of (stage, visit, attempt). */
export function gate(
  acceptedSeq: number,
  stageId: string,
  visit = 1,
  attemptNo = 1,
  overrides: Json = {},
): Json {
  return {
    type: "gate.recorded",
    gate: stageId,
    kind: "stage",
    subject: { stageId, visit, attempt: attemptNo, acceptedSeq, receiptId: receiptOf(acceptedSeq) },
    decision: "pass",
    reason: "built",
    round: 0,
    next: { stageId: "review" },
    revision: REV,
    verdict: null,
    ...overrides,
  };
}

/** A check gate named `gateId` whose subject is the acceptance at `acceptedSeq`. */
export function checkGate(
  acceptedSeq: number,
  gateId: string,
  stageId: string,
  visit = 1,
  attemptNo = 1,
  overrides: Json = {},
): Json {
  return {
    type: "gate.recorded",
    gate: gateId,
    kind: "check",
    subject: { stageId, visit, attempt: attemptNo, acceptedSeq, receiptId: receiptOf(acceptedSeq) },
    decision: "pass",
    reason: "checks_passed",
    round: 0,
    next: { stageId: "review" },
    revision: REV,
    check: {
      command: ["node", "--test"],
      exitCode: 0,
      signal: null,
      timedOut: false,
      evidence: {
        path: `checks/${gateId}/${stageId}-v${visit}-a${attemptNo}/output.log`,
        sha256: HEX,
        bytes: 10,
      },
    },
    ...overrides,
  };
}

export function blocked(agentId: string, attemptRef?: [string, number, number]): Json {
  return {
    type: "run.blocked",
    agentId,
    reason: "blocked_on_input",
    requiredAction: `answer the prompt in the pane of ${agentId}`,
    observed: { runtimeStatus: "blocked", terminalId: "term-1", stateChangeSeq: 3 },
    ...(attemptRef !== undefined
      ? { stageId: attemptRef[0], visit: attemptRef[1], attempt: attemptRef[2] }
      : {}),
  };
}

export const unblocked = (agentId: string): Json => ({
  type: "run.unblocked",
  agentId,
  resolution: "observed_unblocked",
  observed: { runtimeStatus: "working", terminalId: "term-1", stateChangeSeq: 4 },
});

export function reconciled(
  dispatchSeq: number,
  stageId: string,
  agentId: string,
  visit = 1,
  attemptNo = 1,
  resolution = "delivered",
  evidence = "observed_activity",
): Json {
  return {
    type: "delivery.reconciled",
    agentId,
    stageId,
    visit,
    attempt: attemptNo,
    dispatchSeq,
    resolution,
    evidence,
  };
}

export const hostClaimed = (pid = 4242): Json => ({
  type: "host.claimed",
  pid,
  hostname: "test-host",
  startedAt: "2026-09-14T10:00:00.000Z",
  heartbeatMs: 2000,
  paneId: "w1:host",
  workspaceId: null,
});

export const hostExited = (pid = 4242, exitCode = 0, reason = "completed"): Json => ({
  type: "host.exited",
  pid,
  exitCode,
  reason,
});

export const hostLost = (pid: number | null = 4242, reason = "host_process_gone"): Json => ({
  type: "host.lost",
  pid,
  heartbeatAt: "2026-09-14T10:00:05.000Z",
  reason,
  detectedBy: "cli",
});

export const cancelRequested = (source = "cli", reason = "test"): Json => ({
  type: "run.cancel_requested",
  source,
  reason,
});

export const observationLost = (agentId: string, code = "timeout"): Json => ({
  type: "observation.lost",
  agentId,
  code,
  message: `${code} observing ${agentId}`,
  terminalId: null,
});

export const observationRecovered = (agentId: string, lostSeq: number): Json => ({
  type: "observation.recovered",
  agentId,
  lostSeq,
  terminalId: "term-1",
});
