import {
  exactArgs,
  flagIndexes,
  optionValues,
  shortOptionIndexes,
  type AgentKindSpec,
} from "./spec.js";

/**
 * Grok Build (`grok`). Verified against grok 1.0.41 (`grok --help`, its bundled user guide
 * `18-sandbox.md`, `22-permissions-and-safety.md`, `10-hooks.md`) and the local grok skill:
 * - `-m, --model` selects the model; grok has no provider selection.
 * - grok has no directory grant. Its default sandbox is `off`, so it can write the result into
 *   the run directory; the `read-only` and `strict` profiles never can, and Woof refuses them.
 *   `workspace` writes only the working directory, `~/.grok` and temp dirs (see the docs).
 * - `-w/--worktree` and `--cwd` would move grok off the run's checkout: Woof refuses them.
 * - `--always-approve`, `--permission-mode bypassPermissions`, the compat alias
 *   `--dangerously-skip-permissions` and `--trust` are reported as bypasses, never added.
 */

const OWNED = ["--model", "-m"];

export const grok: AgentKindSpec = {
  kind: "grok",
  executable: "grok",
  providerFlag: null,
  ownedFlags: OWNED,
  ownedArgIndexes: (args) =>
    [...flagIndexes(args, ["--model"]), ...shortOptionIndexes(args, "-m")].toSorted(
      (a, b) => a - b,
    ),
  engineArgs: ({ model }) => (model !== null ? ["--model", model] : []),
  refusedArgs: (args) =>
    [
      ...optionValues(args, ["--sandbox"])
        .filter(({ value }) => value === "read-only" || value === "strict")
        .map(({ index, value }) => ({
          index,
          message: `grok's ${value ?? ""} sandbox cannot write the result into the run directory, and grok has no directory grant`,
        })),
      ...[...flagIndexes(args, ["--worktree", "--cwd"]), ...shortOptionIndexes(args, "-w")].map(
        (index) => ({
          index,
          message: `${args[index] ?? ""} would move grok off the run's checkout; Woof starts every agent in it`,
        }),
      ),
    ].toSorted((a, b) => a.index - b.index),
  bypassArgs: (args) => [
    ...exactArgs(args, ["--always-approve", "--dangerously-skip-permissions", "--trust"]),
    ...optionValues(args, ["--permission-mode"])
      .filter(({ value }) => value === "bypassPermissions")
      .map(() => "--permission-mode bypassPermissions"),
  ],
  startupNote:
    "grok asks a folder-trust question for a folder ~/.grok/trusted_folders.toml does not trust, and asks before tool calls its permission mode does not allow; Woof does not pre-check folder trust, and an unanswered question ends as a startup block or a blocked agent",
  submitNote:
    "Grok: if a sandbox refuses writing the run directory or the submit command, say so and end your turn; never write the artifact or envelope elsewhere.",
};
