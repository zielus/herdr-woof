/**
 * Agent kind table (p3): how the engine turns a resolved agent (kind, model,
 * caller arguments) into runtime launch arguments. Only kinds listed here are
 * admitted; the engine adds only what the result contract needs (write access
 * to the run directory) and never adds permission flags.
 */

export type LaunchResult =
  { ok: true; args: string[] } | { ok: false; reason: "agent_kind_unsupported"; message: string };

export const SUPPORTED_AGENT_KINDS = ["claude"] as const;

/** Launch flags the engine owns: it sets them from the resolved model and the run directory. */
export const ENGINE_OWNED_FLAGS = ["--model", "--add-dir"] as const;

/** Indexes of caller arguments that set an engine-owned flag, in split or `--flag=value` form. */
export function engineOwnedArgIndexes(args: readonly string[]): number[] {
  return args.flatMap((arg, index) =>
    ENGINE_OWNED_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)) ? [index] : [],
  );
}

export function launchArgs(agent: {
  kind: string;
  model: string | null;
  args: readonly string[];
  runDir: string;
}): LaunchResult {
  switch (agent.kind) {
    case "claude":
      return {
        ok: true,
        args: [
          ...(agent.model !== null ? ["--model", agent.model] : []),
          "--add-dir",
          agent.runDir,
          ...agent.args,
        ],
      };
    default:
      return {
        ok: false,
        reason: "agent_kind_unsupported",
        message: `agent kind ${JSON.stringify(agent.kind)} is not supported; supported kinds: ${SUPPORTED_AGENT_KINDS.join(", ")}`,
      };
  }
}
