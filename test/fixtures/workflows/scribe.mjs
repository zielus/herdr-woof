// .woof/workflows/scribe.mjs — an external, project-authored workflow. Woof does
// not ship it: it is not in the built-in catalog and not in package.json#files.
// It exercises the shapes neither built-in does — `roundStage: null`, no
// `limitDefaults` (the p3 shape, where resolveLimits returns the complete set),
// an agent id that is not its role name, and a stage the engine has never seen.
//
// A definition needs no Woof import: every type in the contract is structural.
// WOOF_TEST_SIDE_EFFECT, when set, is appended to once per module evaluation, so
// a test can prove the module body runs exactly once in the process that hosts
// the run.
import { appendFileSync } from "node:fs";

const sideEffect = process.env["WOOF_TEST_SIDE_EFFECT"];
if (sideEffect !== undefined) appendFileSync(sideEffect, "evaluated\n");

function validateInput(value) {
  const details = [];
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { ok: false, details: [{ field: "input", message: "must be an object" }] };
  for (const key of Object.keys(value)) {
    if (!["schemaVersion", "repo", "note"].includes(key))
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

export default {
  schemaVersion: 1,
  name: "scribe",
  version: "1",
  validateInput,
  // The agent id is `scribe`; its role is `builder`, which configuration or the
  // built-in role resolves. Identity is not role.
  agents: [{ agentId: "scribe", role: "builder" }],
  resolveAgents: () => ({}),
  // No limitDefaults: resolveLimits returns the complete set, and configuration
  // fills only what it lacks.
  resolveLimits: () => ({
    maxAttemptsPerVisit: 1,
    maxVisitsPerStage: 1,
    maxRounds: 1,
    maxFormatRepairs: 1,
    runTimeoutMs: 900_000,
    readinessWaitMs: 180_000,
    blockedWaitMs: 300_000,
    deliveryTimeoutMs: 60_000,
  }),
  repository: (input) => input.repo,
  start: "note",
  // No rounds at all: `requires: "round"` anywhere in this definition would be a
  // definition_contract_violated.
  roundStage: null,
  stages: [
    {
      kind: "agent",
      stageId: "note",
      agentId: "scribe",
      verdicts: [],
      artifactFile: "note.md",
      onFailedStatus: "fail",
      bindsRevision: false,
      request: (ctx) => ({
        goal: "Write the note below into your artifact.",
        instructions: `Write the note as your artifact, in your own words, with today's repository state in mind. Do not change repository files.\n\nThe note: ${ctx.input.note}`,
        inputs: [],
      }),
      next: () => ({ decision: "pass", reason: "noted", outcome: "completed" }),
    },
  ],
  edges: { note: ["completed"] },
};
