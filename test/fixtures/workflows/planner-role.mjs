// A workflow whose single agent uses role `planner`, which no built-in role defines and
// whose input never names an agent: admission must fill it from configuration or refuse
// it as role_unresolved. WOOF_TEST_REPO: the repository path `repository()` returns.
export default {
  schemaVersion: 1,
  name: "planner-role",
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
  agents: [{ agentId: "planner", role: "planner" }],
  start: "plan",
  roundStage: null,
  stages: [
    {
      kind: "agent",
      stageId: "plan",
      agentId: "planner",
      verdicts: [],
      artifactFile: "plan.md",
      onFailedStatus: "fail",
      bindsRevision: false,
      request: () => ({ goal: "Plan.", instructions: "Write a plan.", inputs: [] }),
      next: () => ({ decision: "pass", reason: "planned", outcome: "completed" }),
    },
  ],
  edges: { plan: ["completed"] },
};
