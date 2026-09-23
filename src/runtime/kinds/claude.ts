import { claudeTrustStatus } from "../claude/trust.js";
import { exactArgs, flagIndexes, optionValues, type AgentKindSpec } from "./spec.js";

/**
 * Claude Code (`claude`). The engine sets `--model` and grants the run directory with
 * `--add-dir`, since Claude Code limits edits to its working directory plus added ones. Folder
 * trust is pre-checked read-only from `~/.claude.json` (advisory; never answered by Woof).
 */

const OWNED = ["--model", "--add-dir"];
const BYPASS = ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"];

export const claude: AgentKindSpec = {
  kind: "claude",
  executable: "claude",
  providerFlag: null,
  ownedFlags: OWNED,
  ownedArgIndexes: (args) => flagIndexes(args, OWNED),
  engineArgs: ({ model, runDir }) => [
    ...(model !== null ? ["--model", model] : []),
    "--add-dir",
    runDir,
  ],
  bypassArgs: (args) => [
    ...exactArgs(args, BYPASS),
    ...optionValues(args, ["--permission-mode"])
      .filter(({ value }) => value === "bypassPermissions")
      .map(() => "--permission-mode bypassPermissions"),
  ],
  trustWarning(dir, options) {
    const trust = claudeTrustStatus(
      dir,
      options.homeDir !== undefined ? { homeDir: options.homeDir } : {},
    );
    if (trust.status === "untrusted") {
      return {
        code: "claude_trust_untrusted",
        message: `Claude Code has no accepted folder trust for ${trust.dir}: the operator must open claude there once and accept its trust question (Woof never answers it)`,
        path: trust.path,
      };
    }
    if (trust.status === "unknown") {
      return {
        code: "claude_trust_unknown",
        message: `Claude Code folder trust for ${trust.dir} could not be read from ${trust.path}; an untrusted folder blocks the agent at startup`,
        path: trust.path,
      };
    }
    return null;
  },
  startupNote:
    "an unanswered folder-trust or permission question leaves the agent blocked; the run records startup_blocked",
  submitNote: null,
};
