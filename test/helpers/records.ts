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
