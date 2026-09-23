import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { pi } from "./pi.js";
import type { AgentKindSpec } from "./spec.js";

export type {
  AgentKindSpec,
  KindLaunchInput,
  KindReadinessProbe,
  KindTrustWarning,
} from "./spec.js";

/**
 * The agent kinds Woof admits, by kind. A kind that is not listed is refused at admission with
 * `agent_kind_unsupported`; Herdr supporting a kind does not make Woof admit it.
 */
const SPECS: Readonly<Record<string, AgentKindSpec>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, AgentKindSpec>, { claude, pi, codex }),
);

export const SUPPORTED_AGENT_KINDS: readonly string[] = Object.freeze(Object.keys(SPECS));

/** The spec for a kind; only an own entry counts, so `constructor` or `toString` is none. */
export function agentKindSpec(kind: string): AgentKindSpec | undefined {
  return Object.hasOwn(SPECS, kind) ? SPECS[kind] : undefined;
}

/** Every admitted kind's spec, in `SUPPORTED_AGENT_KINDS` order. */
export function agentKindSpecs(): AgentKindSpec[] {
  return SUPPORTED_AGENT_KINDS.map((kind) => SPECS[kind] as AgentKindSpec);
}
