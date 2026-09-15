// A minimal valid workflow definition in erasable TypeScript (loaded through
// Node's type stripping): interfaces, annotations and `satisfies`, no enums.
interface Transition {
  decision: "pass" | "reject";
  reason: string;
  outcome: "completed" | "failed";
}

interface FixtureInput {
  topic: string;
}

const done = (): Transition => ({ decision: "pass", reason: "done", outcome: "completed" });

const definition = {
  schemaVersion: 1 as const,
  name: "fixture-ts",
  version: "1",
  validateInput: (value: unknown) => ({ ok: true as const, input: value as FixtureInput }),
  resolveAgents: () => ({ writer: { kind: "claude", model: null, args: [] as string[] } }),
  resolveLimits: () => ({}),
  repository: (input: FixtureInput): string => `/repo/${input.topic}`,
  agents: [{ agentId: "writer", role: "writer" }],
  start: "draft",
  roundStage: null,
  stages: [
    {
      kind: "agent" as const,
      stageId: "draft",
      agentId: "writer",
      verdicts: [] as string[],
      artifactFile: "draft.md",
      onFailedStatus: "fail" as const,
      bindsRevision: false,
      request: () => ({ goal: "Draft.", instructions: "Write.", inputs: [] }),
      next: done,
    },
  ],
  edges: { draft: ["completed"] },
} satisfies Record<string, unknown>;

export default definition;
