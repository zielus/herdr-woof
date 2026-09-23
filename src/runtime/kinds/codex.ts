import {
  exactArgs,
  flagIndexes,
  optionValues,
  shortOptionIndexes,
  type AgentKindSpec,
} from "./spec.js";

/**
 * Codex CLI (`codex`). Verified against codex-cli 0.156.1 (`codex --help`, `codex login --help`)
 * and the local codex skill's probes:
 * - `-m, --model` selects the model; `-c model=…` would override it too, so both are owned.
 * - Codex sandboxes shell commands. Under `workspace-write` (the trusted-project default) it may
 *   write only the working root, temp dirs and `--add-dir` directories, so the engine grants the
 *   run directory with `--add-dir`. `woof submit` writes only inside that directory.
 * - A `read-only` sandbox cannot write the result at all, and `-C/--cd` or `--worktree` would move
 *   the agent off the run's checkout: Woof refuses those arguments.
 * - `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`), a `danger-full-access`
 *   sandbox, `--approve-for-me` and `--dangerously-bypass-hook-trust` are reported as bypasses.
 * - Codex has no provider selection flag; `model_provider` belongs to codex's own config.
 */

const OWNED = ["--model", "-m", "--add-dir", "--config model=", "-c model="];
const BYPASS = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
  "--approve-for-me",
  "--dangerously-bypass-hook-trust",
];
const CONFIG = ["--config", "-c"];
const SANDBOX = ["--sandbox", "-s"];

/** `-c key=value` overrides whose key is `key` (the value is TOML, optionally quoted). */
function configValues(args: readonly string[], key: string) {
  return optionValues(args, CONFIG).flatMap(({ index, value }) => {
    const match = value === undefined ? null : /^\s*([\w.]+)\s*=\s*(.*)$/.exec(value);
    return match?.[1] === key
      ? [{ index, value: (match[2] ?? "").replace(/^["']|["']$/g, "") }]
      : [];
  });
}

export const codex: AgentKindSpec = {
  kind: "codex",
  executable: "codex",
  providerFlag: null,
  ownedFlags: OWNED,
  ownedArgIndexes: (args) =>
    [
      ...flagIndexes(args, ["--model", "--add-dir"]),
      ...shortOptionIndexes(args, "-m"),
      ...configValues(args, "model").map(({ index }) => index),
    ].toSorted((a, b) => a - b),
  engineArgs: ({ model, runDir }) => [
    ...(model !== null ? ["--model", model] : []),
    ...(runDir !== null ? ["--add-dir", runDir] : []),
  ],
  refusedArgs: (args) =>
    [
      ...[...optionValues(args, SANDBOX), ...configValues(args, "sandbox_mode")]
        .filter(({ value }) => value === "read-only")
        .map(({ index }) => ({
          index,
          message:
            "codex's read-only sandbox cannot write the result into the run directory (--add-dir applies to workspace-write only)",
        })),
      ...[...flagIndexes(args, ["--cd", "--worktree"]), ...shortOptionIndexes(args, "-C")].map(
        (index) => ({
          index,
          message: `${args[index] ?? ""} would move codex off the run's checkout; Woof starts every agent in it`,
        }),
      ),
    ].toSorted((a, b) => a.index - b.index),
  bypassArgs: (args) => [
    ...exactArgs(args, BYPASS),
    ...[...optionValues(args, SANDBOX), ...configValues(args, "sandbox_mode")]
      .filter(({ value }) => value === "danger-full-access")
      .map(() => "--sandbox danger-full-access"),
  ],
  startupNote:
    "codex asks whether to trust a project that ~/.codex/config.toml does not trust, and asks to review new or changed hooks (Herdr's state hook among them) before it reports lifecycle; Woof does not pre-check either, and an unanswered question ends as a startup block or a start timeout",
  submitNote:
    "Codex: --add-dir lets your sandbox write the run directory. If it refuses the submit command, ask to approve that command; never write the artifact or envelope elsewhere.",
  readinessProbe: () => ({
    subject: "login",
    args: ["login", "status"],
    read: ({ status, stdout }) => ({
      ready: status === 0,
      detail: stdout.trim().split("\n")[0] || (status === 0 ? "logged in" : "not logged in"),
    }),
  }),
};
