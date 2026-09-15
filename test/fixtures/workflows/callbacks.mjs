// A workflow definition whose callbacks misbehave on demand, for admission tests.
// WOOF_TEST_CALLBACK: validate-throws | validate-bad | details-bad | normalize | repository-throws |
// repository-bad | agents-throws | agents-bad | limits-throws | limits-bad | none.
// WOOF_TEST_REPO: the repository path `repository()` returns.
const mode = process.env.WOOF_TEST_CALLBACK ?? "none";
const fail = (name) => {
  throw new Error(`${name} failed on purpose`);
};
const done = () => ({ decision: "pass", reason: "done", outcome: "completed" });

export default {
  schemaVersion: 1,
  name: "fixture-callbacks",
  version: "1",
  validateInput: (value) =>
    mode === "validate-throws"
      ? fail("validateInput")
      : mode === "validate-bad"
        ? 42
        : mode === "details-bad"
          ? { ok: false, details: [{ field: "topic", message: "bad" }, { field: 1 }, null] }
          : mode === "normalize"
            ? {
                ok: true,
                input: { topic: String(value.topic).trim().toUpperCase(), normalized: true },
              }
            : { ok: true, input: value },
  repository: () =>
    mode === "repository-throws"
      ? fail("repository")
      : mode === "repository-bad"
        ? 7
        : process.env.WOOF_TEST_REPO,
  resolveAgents: () =>
    mode === "agents-throws"
      ? fail("resolveAgents")
      : mode === "agents-bad"
        ? { writer: { kind: 3 } }
        : { writer: { kind: "claude", model: null, args: [] } },
  resolveLimits: () =>
    mode === "limits-throws"
      ? fail("resolveLimits")
      : mode === "limits-bad"
        ? "not limits"
        : {
            maxAttemptsPerVisit: 2,
            maxVisitsPerStage: 3,
            maxRounds: 1,
            maxFormatRepairs: 1,
            runTimeoutMs: 60_000,
            readinessWaitMs: 10_000,
            blockedWaitMs: 10_000,
            deliveryTimeoutMs: 10_000,
          },
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
