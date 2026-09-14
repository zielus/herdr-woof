// A minimal valid workflow definition, compiled JavaScript.
const done = () => ({ decision: "pass", reason: "done", outcome: "completed" });

export default {
  schemaVersion: 1,
  name: "fixture-mjs",
  version: "1",
  validateInput: (value) => ({ ok: true, input: value }),
  resolveAgents: () => ({ writer: { kind: "claude", model: null, args: [] } }),
  resolveLimits: () => ({}),
  repository: () => "/repo",
  agents: [{ agentId: "writer", role: "writer" }],
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
      request: () => ({ goal: "Draft.", instructions: "Write.", inputs: [] }),
      next: done,
    },
  ],
  edges: { draft: ["completed"] },
};
