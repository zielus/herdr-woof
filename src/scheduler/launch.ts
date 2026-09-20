/**
 * Agent kind table (p3, per-kind since p8a): how the engine turns a resolved
 * agent (kind, model, caller arguments) into runtime launch arguments. Only
 * kinds listed here are admitted; the engine adds only what the result contract
 * needs (write access to the run directory, for a kind that sandboxes
 * directories) and never adds permission flags.
 */

export type LaunchResult =
  { ok: true; args: string[] } | { ok: false; reason: "agent_kind_unsupported"; message: string };

interface LaunchInput {
  model: string | null;
  runDir: string | null;
}

interface KindEntry {
  /** Launch flags the engine owns for this kind: it sets them, so caller arguments must not. */
  ownedFlags: readonly string[];
  engineArgs(agent: LaunchInput): string[];
}

const modelArgs = (agent: LaunchInput): string[] =>
  agent.model !== null ? ["--model", agent.model] : [];

const KINDS = {
  claude: {
    ownedFlags: ["--model", "--add-dir"],
    engineArgs: (agent) => [
      ...modelArgs(agent),
      ...(agent.runDir !== null ? ["--add-dir", agent.runDir] : []),
    ],
  },
  // pi has no directory sandbox (its tools run with the pi process's permissions),
  // so the run directory needs no grant and pi owns only --model. Note --models
  // (model cycling) is a different flag and is not engine-owned.
  pi: {
    ownedFlags: ["--model"],
    engineArgs: modelArgs,
  },
} as const satisfies Record<string, KindEntry>;

export type SupportedAgentKind = keyof typeof KINDS;

export const SUPPORTED_AGENT_KINDS: readonly SupportedAgentKind[] = Object.keys(
  KINDS,
) as SupportedAgentKind[];

/** Only an own entry is a kind; an inherited key such as `constructor` is none. */
function entryOf(kind: string): KindEntry | undefined {
  return Object.hasOwn(KINDS, kind) ? KINDS[kind as SupportedAgentKind] : undefined;
}

/** Launch flags the engine owns for that kind; none for a kind the table does not list. */
export function engineOwnedFlags(kind: string): readonly string[] {
  return entryOf(kind)?.ownedFlags ?? [];
}

/** Indexes of caller arguments that set an engine-owned flag, in split or `--flag=value` form. */
export function engineOwnedArgIndexes(kind: string, args: readonly string[]): number[] {
  const flags = engineOwnedFlags(kind);
  return args.flatMap((arg, index) =>
    flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)) ? [index] : [],
  );
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
  const entry = entryOf(agent.kind);
  if (entry === undefined) {
    return {
      ok: false,
      reason: "agent_kind_unsupported",
      message: `agent kind ${JSON.stringify(agent.kind)} is not supported; supported kinds: ${SUPPORTED_AGENT_KINDS.join(", ")}`,
    };
  }
  return { ok: true, args: [...entry.engineArgs(agent), ...agent.args] };
}
