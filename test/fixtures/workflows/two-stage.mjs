// A synthetic second workflow for engine reuse: draft → critique with its own
// ids, verdicts and artifact names, and no check. The engine has no branch for it.
const LIMITS = {
  maxAttemptsPerVisit: 2,
  maxVisitsPerStage: 3,
  maxRounds: 3,
  maxFormatRepairs: 1,
  runTimeoutMs: 60_000,
  readinessWaitMs: 10_000,
  blockedWaitMs: 10_000,
  deliveryTimeoutMs: 10_000,
};

export default {
  schemaVersion: 1,
  name: "draft-critique",
  version: "2",
  validateInput: (value) =>
    typeof value === "object" && value !== null && typeof value.repo === "string"
      ? { ok: true, input: { repo: value.repo } }
      : { ok: false, details: [{ field: "repo", message: "must be a string" }] },
  agents: [
    { agentId: "writer", role: "writer" },
    { agentId: "critic", role: "critic" },
  ],
  resolveAgents: () => ({
    writer: { kind: "claude", model: null, args: [] },
    critic: { kind: "claude", model: null, args: [] },
  }),
  resolveLimits: () => LIMITS,
  repository: (input) => input.repo,
  start: "draft",
  roundStage: "critique",
  stages: [
    {
      kind: "agent",
      stageId: "draft",
      agentId: "writer",
      verdicts: [],
      artifactFile: "draft.md",
      onFailedStatus: "fail",
      bindsRevision: false,
      request: (ctx) => ({
        goal: "Write the draft.",
        instructions: "Draft it.",
        inputs:
          ctx.history.latestAccepted.critique === undefined
            ? []
            : [{ label: "critique", from: { stageId: "critique" } }],
      }),
      next: () => ({ decision: "pass", reason: "drafted", to: "critique" }),
    },
    {
      kind: "agent",
      stageId: "critique",
      agentId: "critic",
      verdicts: ["approve", "rework"],
      artifactFile: "critique.md",
      onFailedStatus: "fail",
      bindsRevision: false,
      request: () => ({
        goal: "Critique the draft.",
        instructions: "Critique it.",
        inputs: [{ label: "draft", from: { stageId: "draft" } }],
      }),
      next: (ctx) =>
        ctx.accepted.verdict === "approve"
          ? { decision: "pass", reason: "approved", outcome: "completed" }
          : { decision: "reject", reason: "rework", to: "draft", requires: "round" },
    },
  ],
  edges: { draft: ["critique"], critique: ["completed", "draft"] },
};
