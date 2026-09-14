/**
 * Agent kind table (p3): how the engine turns a resolved agent (kind, model,
 * caller arguments) into runtime launch arguments. Only kinds listed here are
 * admitted; the engine adds only what the result contract needs (write access
 * to the run directory) and never adds permission flags.
 */

export type LaunchResult =
  { ok: true; args: string[] } | { ok: false; reason: "agent_kind_unsupported"; message: string };

export const SUPPORTED_AGENT_KINDS = ["claude"] as const;

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
