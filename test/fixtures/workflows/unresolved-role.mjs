// A workflow whose single agent uses role `auditor`, which no built-in role defines and
// whose input never names an agent: admission must fill it from configuration or refuse
// it as role_unresolved. WOOF_TEST_REPO: the repository path `repository()` returns.
export default {
  schemaVersion: 1,
  name: "unresolved-role",
  version: "1",
  validateInput: (value) => ({ ok: true, input: value }),
  repository: () => process.env.WOOF_TEST_REPO,
  resolveAgents: () => ({}),
  resolveLimits: () => ({}),
  limitDefaults: {
    maxAttemptsPerVisit: 1,
    maxVisitsPerStage: 1,
    maxRounds: 1,
    runTimeoutMs: 60_000,
    readinessWaitMs: 10_000,
    blockedWaitMs: 10_000,
    deliveryTimeoutMs: 10_000,
  },
  agents: [{ agentId: "auditor", role: "auditor" }],
  start: "audit",
  roundStage: null,
  stages: [
    {
      kind: "agent",
      stageId: "audit",
      agentId: "auditor",
      verdicts: [],
      artifactFile: "audit.md",
      onFailedStatus: "fail",
      bindsRevision: false,
      request: () => ({ goal: "Audit.", instructions: "Write an audit.", inputs: [] }),
      next: () => ({ decision: "pass", reason: "audited", outcome: "completed" }),
    },
  ],
  edges: { audit: ["completed"] },
};
