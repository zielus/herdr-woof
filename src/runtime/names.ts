import { createHash } from "node:crypto";

/** Herdr agent name rule. */
export const HERDR_RUNTIME_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

const MAX_AGENT_PART = 22;

/**
 * Deterministic Herdr agent name for an agent in a run: `w-` + the agent id
 * lowercased with other characters replaced by `-` (at most 22 characters) +
 * `-` + 6 hex characters of sha256(`runId/agentId`). The hash keeps names from
 * concurrent runs on one Herdr server apart.
 */
export function herdrRuntimeName(runId: string, agentId: string): string {
  const agentPart = agentId
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/g, "-")
    .slice(0, MAX_AGENT_PART);
  const hash = createHash("sha256").update(`${runId}/${agentId}`).digest("hex").slice(0, 6);
  return `w-${agentPart}-${hash}`;
}

export function isHerdrRuntimeName(name: string): boolean {
  return HERDR_RUNTIME_NAME_PATTERN.test(name);
}
