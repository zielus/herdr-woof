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
  { ok: true; args: string[] } | { ok: false; reason: "agent_kind_unsupported"; message: string };

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

/**
 * `runDir` is the run directory a workflow agent writes its result into; null for an agent started
 * outside any run (`woof agent start`), which gets no run-directory grant.
 */
export function launchArgs(agent: {
  kind: string;
  model: string | null;
  args: readonly string[];
  runDir: string | null;
}): LaunchResult {
  const spec = agentKindSpec(agent.kind);
  if (spec === undefined) {
    return {
      ok: false,
      reason: "agent_kind_unsupported",
      message: `agent kind ${JSON.stringify(agent.kind)} is not supported; supported kinds: ${SUPPORTED_AGENT_KINDS.join(", ")}`,
    };
  }
  return {
    ok: true,
    args: [
      ...spec.engineArgs({ model: agent.model, provider: null, runDir: agent.runDir }),
      ...agent.args,
    ],
  };
}
