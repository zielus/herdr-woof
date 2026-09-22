// .woof/workflows/composite.mjs — a project-authored workflow whose first two steps are
// workflows (composition): `first` and `second` each run the project's `scribe` workflow as a
// child run, the second's input mapped from the first's result, and a final agent stage `note`
// reads the first child's accepted note (copied into this run) and the second's result.json.
// `on` in the input chooses what a failed child does: "fail" (default) or "retry" the step.

function validateInput(value) {
  const details = [];
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { ok: false, details: [{ field: "input", message: "must be an object" }] };
  for (const key of Object.keys(value)) {
    if (!["schemaVersion", "repo", "note", "on", "limits"].includes(key))
      details.push({ field: key, message: "unknown field" });
  }
  if (value.schemaVersion !== 1) details.push({ field: "schemaVersion", message: "must be 1" });
  if (typeof value.repo !== "string" || !value.repo.startsWith("/"))
    details.push({ field: "repo", message: "must be an absolute path" });
  if (typeof value.note !== "string" || value.note.trim() === "")
    details.push({ field: "note", message: "must be a non-empty string" });
  if (details.length > 0) return { ok: false, details };
  return { ok: true, input: structuredClone(value) };
}

const routed = (to) => (ctx) =>
  ctx.accepted.verdict === "completed"
    ? { decision: "pass", reason: "child_completed", to }
    : ctx.input.on === "retry"
      ? { decision: "reject", reason: `child_${ctx.accepted.verdict}`, to: ctx.accepted.stageId }
      : { decision: "reject", reason: `child_${ctx.accepted.verdict}`, outcome: "failed" };

export default {
  schemaVersion: 1,
  name: "composite",
  version: "1",
  validateInput,
  checkout: "any",
  agents: [{ agentId: "summarizer", role: "builder" }],
  resolveAgents: () => ({}),
  resolveLimits: (input) => ({
    maxAttemptsPerVisit: 1,
    maxVisitsPerStage: 2,
    maxRounds: 1,
    maxFormatRepairs: 1,
    runTimeoutMs: 120_000,
    readinessWaitMs: 60_000,
    blockedWaitMs: 60_000,
    deliveryTimeoutMs: 60_000,
    ...input.limits,
  }),
  repository: (input) => input.repo,
  start: "first",
  roundStage: null,
  stages: [
    {
      kind: "workflow",
      stageId: "first",
      workflow: { name: "scribe" },
      input: (ctx) => ({ schemaVersion: 1, repo: ctx.input.repo, note: ctx.input.note }),
      next: routed("second"),
    },
    {
      kind: "workflow",
      stageId: "second",
      workflow: { name: "scribe" },
      // Declarative mapping: the second child's input names the first child's result.
      input: (ctx) => ({
        schemaVersion: 1,
        repo: ctx.input.repo,
        note: `after ${ctx.history.children.first.runId} (${ctx.history.children.first.outcome}), note sha256 ${ctx.history.children.first.artifacts.note.sha256}`,
      }),
      next: routed("note"),
    },
    {
      kind: "agent",
      stageId: "note",
      agentId: "summarizer",
      verdicts: [],
      artifactFile: "note.md",
      onFailedStatus: "fail",
      bindsRevision: false,
      request: () => ({
        goal: "Summarize both child runs.",
        instructions: "Read the inputs and write a one-paragraph summary as your artifact.",
        inputs: [
          { label: "first note", from: { stageId: "first", artifact: "note" } },
          { label: "second result", from: { stageId: "second" } },
        ],
      }),
      next: () => ({ decision: "pass", reason: "summarized", outcome: "completed" }),
    },
  ],
  edges: {
    first: ["second", "first", "failed"],
    second: ["note", "second", "failed"],
    note: ["completed"],
  },
};
