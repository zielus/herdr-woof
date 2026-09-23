/**
 * Agent kind spec: everything vendor-specific about one coding-agent CLI that Woof starts through
 * `herdr agent start --kind <kind>`. The scheduler, configuration and doctor look a spec up by
 * kind and never name a vendor. Herdr owns start, prompt delivery and lifecycle for every kind;
 * a spec only maps a resolved agent onto that CLI's own flags and states what Woof checks around
 * it. Each spec is a small module under this directory, verified against the installed CLI.
 */

export interface KindLaunchInput {
  model: string | null;
  /** Null unless the role selects one; only a kind with `providerFlag` accepts a provider. */
  provider: string | null;
  /** The run directory the agent writes its result into; null outside a run. */
  runDir: string | null;
}

/** An advisory warning about the agent's own startup trust question (never a rejection). */
export interface KindTrustWarning {
  code: `${string}_trust_untrusted` | `${string}_trust_unknown`;
  message: string;
  path: string;
}

/** A doctor readiness probe: run the kind's executable with `args`, then read its result. */
export interface KindReadinessProbe {
  /** What the probe checks, for example `provider github-copilot`. */
  subject: string;
  args: string[];
  read(result: { status: number | null; stdout: string; stderr: string }): {
    ready: boolean;
    detail: string;
  };
}

export interface AgentKindSpec {
  /** The Herdr `--kind` value and the role file's `kind`. */
  readonly kind: string;
  /** The canonical executable Herdr starts for this kind; doctor probes it on PATH. */
  readonly executable: string;
  /** The flag a role's `provider` maps to; null when the kind takes no provider selection. */
  readonly providerFlag: string | null;
  /** Launch flags the engine owns for this kind, named when caller arguments set one. */
  readonly ownedFlags: readonly string[];
  /** Indexes of caller arguments that set an engine-owned value. */
  ownedArgIndexes(args: readonly string[]): number[];
  /** Arguments the engine adds ahead of the caller's own. */
  engineArgs(input: KindLaunchInput): string[];
  /** Caller arguments Woof refuses because the run could not work with them. */
  refusedArgs?(args: readonly string[]): Array<{ index: number; message: string }>;
  /** Caller arguments that configure a permission bypass: reported, never added. */
  bypassArgs(args: readonly string[]): string[];
  /** Advisory pre-flight of the kind's own folder-trust question, when Woof can read it. */
  trustWarning?(dir: string, options: { homeDir?: string }): KindTrustWarning | null;
  /** How a startup question of this kind surfaces in Woof; stated in docs and doctor. */
  readonly startupNote: string;
  /** Fixed text appended to the work request's submit section; null for none. */
  readonly submitNote: string | null;
  /** Doctor readiness probe for a resolved role of this kind, beyond `--version`. */
  readinessProbe?(role: {
    model: string | null;
    provider: string | null;
  }): KindReadinessProbe | null;
}

/** Indexes of `--flag` or `--flag=value` among the arguments (exact flag names only). */
export function flagIndexes(args: readonly string[], flags: readonly string[]): number[] {
  return args.flatMap((arg, index) =>
    flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)) ? [index] : [],
  );
}

/**
 * Indexes of a single-letter short option that takes a value, in every form a clap parser
 * accepts: `-m value`, `-m=value` and `-mvalue`.
 */
export function shortOptionIndexes(args: readonly string[], short: string): number[] {
  return args.flatMap((arg, index) =>
    arg.startsWith(short) && !arg.startsWith("--") ? [index] : [],
  );
}

/** The value each occurrence of an option carries, in split or `=`-joined form. */
export function optionValues(
  args: readonly string[],
  flags: readonly string[],
): Array<{ index: number; value: string | undefined }> {
  return args.flatMap((arg, index) => {
    for (const flag of flags) {
      if (arg === flag) return [{ index, value: args[index + 1] }];
      if (arg.startsWith(`${flag}=`)) return [{ index, value: arg.slice(flag.length + 1) }];
      // A short flag also takes an attached value (`-sread-only`).
      if (/^-[A-Za-z]$/.test(flag) && arg.startsWith(flag) && arg.length > 2)
        return [{ index, value: arg.slice(2) }];
    }
    return [];
  });
}

/** The arguments among `args` that equal one of `flags` exactly. */
export function exactArgs(args: readonly string[], flags: readonly string[]): string[] {
  return args.filter((arg) => flags.includes(arg));
}
