// A workflow whose revision-bound review can end the run with `reject → failed`.
// `globalThis.woofReviewNextCalls` counts calls of the review's `next`.
const LIMITS = {
  maxAttemptsPerVisit: 2,
  maxVisitsPerStage: 3,
  maxRounds: 1,
  maxFormatRepairs: 1,
  runTimeoutMs: 60_000,
  readinessWaitMs: 10_000,
  blockedWaitMs: 10_000,
  deliveryTimeoutMs: 10_000,
};
globalThis.woofReviewNextCalls = 0;

export default {
  schemaVersion: 1,
  name: "reject-fails",
  version: "1",
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
  roundStage: null,
  stages: [
    {
      kind: "agent",
      stageId: "draft",
      agentId: "writer",
      verdicts: [],
      artifactFile: "draft.md",
      onFailedStatus: "fail",
      bindsRevision: false,
      request: () => ({ goal: "Write the draft.", instructions: "Draft it.", inputs: [] }),
      next: () => ({ decision: "pass", reason: "drafted", to: "judge" }),
    },
    {
      kind: "agent",
      stageId: "judge",
      agentId: "critic",
      verdicts: ["ok", "bad"],
      artifactFile: "judgement.md",
      onFailedStatus: "fail",
      bindsRevision: true,
      request: () => ({
        goal: "Judge the draft.",
        instructions: "Judge it.",
        inputs: [{ label: "draft", from: { stageId: "draft" } }],
      }),
      next: (ctx) => {
        globalThis.woofReviewNextCalls += 1;
        return ctx.accepted.verdict === "ok"
          ? { decision: "pass", reason: "fine", outcome: "completed" }
          : { decision: "reject", reason: "unfixable", outcome: "failed" };
      },
    },
  ],
  edges: { draft: ["judge"], judge: ["completed", "failed"] },
};
