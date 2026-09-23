import {
  agentKindSpec,
  agentKindSpecs,
  SUPPORTED_AGENT_KINDS,
  type KindTrustWarning,
} from "../runtime/kinds/index.js";
import { flagIndexes } from "../runtime/kinds/spec.js";

/**
 * Agent launch mapping (p3; per-kind specs since the agent-kinds change): turns a resolved agent
 * (kind, model, caller arguments) into runtime launch arguments by looking up the kind's spec
 * under `runtime/kinds/`. Only kinds with a spec are admitted; the engine adds only what the
 * result contract needs (the model and, for a kind that confines writes, a grant for the run
 * directory) and never adds permission flags. Nothing here names a vendor.
 */

export type LaunchResult =
  | { ok: true; args: string[] }
  | { ok: false; reason: "agent_kind_unsupported" | "role_invalid"; message: string };

export { SUPPORTED_AGENT_KINDS };

/**
 * Flags refused in the arguments of a kind that has no spec. Such a kind is refused at admission
 * anyway; a role file naming it keeps failing on these flags as it always did.
 */
const UNLISTED_OWNED_FLAGS = ["--model", "--add-dir"] as const;

/** The launch flags the engine owns for a kind. */
export function engineOwnedFlags(kind: string): readonly string[] {
  return agentKindSpec(kind)?.ownedFlags ?? UNLISTED_OWNED_FLAGS;
}

/** Indexes of caller arguments that set a flag the engine owns for this kind. */
export function engineOwnedArgIndexes(kind: string, args: readonly string[]): number[] {
  const spec = agentKindSpec(kind);
  return spec !== undefined ? spec.ownedArgIndexes(args) : flagIndexes(args, UNLISTED_OWNED_FLAGS);
}

/**
 * Why a role's provider cannot be used with its kind, or undefined when it can: a provider is
 * refused, never dropped, for a listed kind that takes no provider selection. An unlisted kind
 * is refused at admission for its kind alone.
 */
export function providerRefusal(
  kind: string,
  provider: string | null | undefined,
): string | undefined {
  const spec = agentKindSpec(kind);
  if (spec === undefined || provider === null || provider === undefined) return undefined;
  if (spec.providerFlag !== null) return undefined;
  return `agent kind ${JSON.stringify(kind)} takes no provider selection, but provider ${JSON.stringify(provider)} is set; select the provider in that CLI's own configuration, or leave provider unset`;
}

/** How a refusal of engine-owned flags tells the author where the value belongs instead. */
export function engineOwnedHint(kind: string): string {
  const flags = engineOwnedFlags(kind);
  const fields =
    agentKindSpec(kind)?.providerFlag != null ? "model and provider fields" : "model field";
  return `use the ${fields} (the engine adds ${flags.length === 2 ? "both" : "these"})`;
}

/** Caller arguments the kind's spec refuses, with the reason for each. */
export function refusedArgs(
  kind: string,
  args: readonly string[],
): Array<{ index: number; message: string }> {
  return agentKindSpec(kind)?.refusedArgs?.(args) ?? [];
}

/** The permission-bypass arguments among a kind's caller arguments (reported, never added). */
export function permissionBypassArgs(kind: string, args: readonly string[]): string[] {
  return agentKindSpec(kind)?.bypassArgs(args) ?? [];
}

/** The fixed note a kind adds to the submit section of a work request, if any. */
export function submitNoteOf(kind: string): string | null {
  return agentKindSpec(kind)?.submitNote ?? null;
}

/** The longest submit note of any admitted kind, in bytes, for request size bounds. */
export function longestSubmitNoteBytes(): number {
  return Math.max(
    0,
    ...agentKindSpecs().map((spec) =>
      spec.submitNote === null ? 0 : Buffer.byteLength(spec.submitNote, "utf8"),
    ),
  );
}

/**
 * The advisory folder-trust warnings for the given kinds working in `dir`: one per kind whose spec
 * can read its trust state, in the order the kinds are first named.
 */
export function trustWarnings(
  kinds: readonly string[],
  dir: string,
  options: { homeDir?: string } = {},
): KindTrustWarning[] {
  return [...new Set(kinds)].flatMap((kind) => {
    const warning = agentKindSpec(kind)?.trustWarning?.(dir, options) ?? null;
    return warning === null ? [] : [warning];
  });
}

/** `runDir` is the run directory the workflow agent writes its result into. */
export function launchArgs(agent: {
  kind: string;
  model: string | null;
  /** Absent or null: the kind's own default provider. */
  provider?: string | null;
  args: readonly string[];
  runDir: string;
}): LaunchResult {
  const spec = agentKindSpec(agent.kind);
  if (spec === undefined) {
    return {
      ok: false,
      reason: "agent_kind_unsupported",
      message: `agent kind ${JSON.stringify(agent.kind)} is not supported; supported kinds: ${SUPPORTED_AGENT_KINDS.join(", ")}`,
    };
  }
  const provider = agent.provider ?? null;
  const refused = providerRefusal(agent.kind, provider);
  if (refused !== undefined) return { ok: false, reason: "role_invalid", message: refused };
  return {
    ok: true,
    args: [
      ...spec.engineArgs({ model: agent.model, provider, runDir: agent.runDir }),
      ...agent.args,
    ],
  };
}
