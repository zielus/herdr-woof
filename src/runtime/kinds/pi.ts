import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { exactArgs, flagIndexes, type AgentKindSpec, type KindTrustWarning } from "./spec.js";

/**
 * pi (the pi coding agent, `pi`). Verified against pi 0.86.0 (`pi --help`, its bundled
 * `docs/security.md` and `docs/providers.md`):
 * - `--provider <name>` and `--model <pattern>` select the model; a role's `provider` and
 *   `model` map to them. `--models` (Ctrl+P cycling) is a different flag and is not owned.
 * - pi has no directory sandbox and no permission prompts: its tools act with the process's
 *   permissions, so the run directory needs no grant, and pi has no `--add-dir` (pi exits on it).
 * - `--approve`/`-a` trusts project-local files for one run; Woof reports it, never adds it.
 * - An interactive start asks a project-trust question only when the directory has resources that
 *   need trust, no saved decision applies (`~/.pi/agent/trust.json`, closest ancestor wins) and
 *   `defaultProjectTrust` is `ask` (the default). Woof pre-checks that, advisory only.
 */

const OWNED = ["--model", "--provider"];
const MAX_FILE_BYTES = 1024 * 1024;

export const pi: AgentKindSpec = {
  kind: "pi",
  executable: "pi",
  providerFlag: "--provider",
  ownedFlags: OWNED,
  ownedArgIndexes: (args) => flagIndexes(args, OWNED),
  engineArgs: ({ model, provider }) => [
    ...(provider !== null ? ["--provider", provider] : []),
    ...(model !== null ? ["--model", model] : []),
  ],
  refusedArgs: (args) =>
    flagIndexes(args, ["--add-dir"]).map((index) => ({
      index,
      message:
        "pi has no --add-dir flag and would exit on it; pi does not confine writes, so it needs no run-directory grant",
    })),
  bypassArgs: (args) => exactArgs(args, ["--approve", "-a"]),
  trustWarning: (dir, options) => piTrustWarning(dir, options.homeDir ?? homedir()),
  startupNote:
    "pi asks a project-trust question at startup only for a project with trust-requiring .pi/ resources and no saved decision; an unanswered question ends as a startup block or a start timeout",
  submitNote: null,
  readinessProbe: ({ model, provider }) => {
    // `pi auth check` needs a provider or a model; without either pi uses its own default.
    const selector =
      provider !== null
        ? ["--provider", provider]
        : model !== null && model.includes("/")
          ? ["--model", model]
          : null;
    if (selector === null) return null;
    return {
      subject: `provider ${provider ?? model ?? ""}`,
      // --no-refresh keeps the probe local: an expired OAuth credential is reported, not renewed.
      args: ["auth", "check", ...selector, "--json", "--no-refresh"],
      read: ({ stdout }) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout.trim());
        } catch {
          return { ready: false, detail: "pi auth check printed no JSON" };
        }
        const record = isObject(parsed) ? parsed : {};
        const ready = record["status"] === "ready";
        const reason = typeof record["reason"] === "string" ? record["reason"] : null;
        return {
          ready,
          detail: ready
            ? `ready (${String(record["authType"] ?? "credentials")})`
            : `not ready${reason !== null ? ` (${reason})` : ""}`,
        };
      },
    };
  },
};

/** The project resources pi's docs list as requiring trust, relative to the working directory. */
const TRUST_RESOURCES = [
  ".pi/settings.json",
  ".pi/extensions",
  ".pi/skills",
  ".pi/prompts",
  ".pi/themes",
  ".pi/SYSTEM.md",
  ".pi/APPEND_SYSTEM.md",
];

function piTrustWarning(dir: string, home: string): KindTrustWarning | null {
  const absolute = resolve(dir);
  const canonical = realpathOr(absolute);
  const resource = trustResource(canonical, realpathOr(resolve(home)));
  if (resource === undefined) return null;
  const agentDir = join(home, ".pi", "agent");
  const settings = readJson(join(agentDir, "settings.json"));
  const mode =
    settings.ok &&
    isObject(settings.value) &&
    typeof settings.value["defaultProjectTrust"] === "string"
      ? settings.value["defaultProjectTrust"]
      : "ask";
  if (mode !== "ask") return null;
  const trustPath = join(agentDir, "trust.json");
  const saved = readJson(trustPath);
  if (!saved.ok && saved.missing !== true) {
    return {
      code: "pi_trust_unknown",
      message: `pi project trust for ${absolute} could not be read from ${trustPath}; the project has ${resource}, so an untrusted project asks a trust question at startup`,
      path: trustPath,
    };
  }
  const decisions = saved.ok && isObject(saved.value) ? saved.value : {};
  for (let at = canonical; ; at = dirname(at)) {
    if (Object.hasOwn(decisions, at) && typeof decisions[at] === "boolean") return null;
    if (dirname(at) === at) break;
  }
  return {
    code: "pi_trust_untrusted",
    message: `pi has no saved project-trust decision for ${absolute}, which has ${resource}: pi asks whether to trust it at startup and the operator must answer in the agent's pane (Woof never answers it)`,
    path: trustPath,
  };
}

/** The first trust-requiring resource pi would find, else undefined. */
function trustResource(dir: string, home: string): string | undefined {
  const local = TRUST_RESOURCES.find((rel) => existsSync(join(dir, rel)));
  if (local !== undefined) return local;
  // Project `.agents/skills` in the directory or an ancestor; the user-global one is not a project's.
  for (let at = dir; ; at = dirname(at)) {
    if (at !== home && isDirectory(join(at, ".agents", "skills")))
      return join(at, ".agents/skills");
    if (dirname(at) === at) return undefined;
  }
}

function readJson(path: string): { ok: true; value: unknown } | { ok: false; missing: boolean } {
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return { ok: false, missing: false };
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) as unknown };
  } catch (error) {
    return { ok: false, missing: (error as NodeJS.ErrnoException).code === "ENOENT" };
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
