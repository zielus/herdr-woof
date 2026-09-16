import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { describeSource, resolveConfiguration } from "../config/resolve.js";
import { isId } from "../contracts/envelope.js";
import type { RuntimeError } from "../runtime/adapter.js";
import { createHerdrCliRuntime } from "../runtime/herdr/adapter.js";
import { execHerdr } from "../runtime/herdr/exec.js";
import { parseHerdrOutput } from "../runtime/herdr/parse.js";
import { isHerdrRuntimeName } from "../runtime/names.js";
import { launchArgs } from "../scheduler/launch.js";
import { UsageError, parse, rejected } from "./common.js";
import { herdrBin } from "./run.js";

export const AGENT_START_USAGE = `Usage: woof agent start <role> [--split right|down | --pane <pane-id>]
                        [--name <agent-name>] [--project <dir>]

Starts one agent from a role definition, outside any workflow run. The role is
resolved like a run's: <project>/.woof/roles/<role>.json, else
~/.woof/roles/<role>.json, else a built-in role (builder, planner, reviewer).
Its model and args become the launch flags; no run directory exists, so no
--add-dir is added, and Woof never adds a permission flag.

The agent starts in a new pane split from this one (--split, default down), or
in the existing pane --pane. It is named --name (default: the role name), which
must be a valid Herdr agent name. --project (default: the working directory) is
where configuration is read and the new pane's working directory.

Prints one JSON line: {"outcome":"started","role","roleSource","agent"} with the
started agent's pane, terminal, session and Herdr name. No journal is written.
Exits 0 when started; 2 when the role or configuration is refused
(role_unresolved, role_invalid, agent_kind_unsupported, config_invalid, ...);
3 when Herdr is unavailable (herdr_unavailable) or the split or start fails
(agent_start_failed; a pane this command split is then closed, and "paneClosed"
says whether that worked); 1 on usage errors.`;

/** Bound on `herdr agent start` (Herdr refuses 3000 ms or less) and on the pane split. */
const AGENT_START_TIMEOUT_MS = 30_000;
/** Bound on closing the split pane after a failed start, as the adapter bounds pane commands. */
const PANE_CLOSE_TIMEOUT_MS = 10_000;
const PANE_CLOSE_GRACE_MS = 2000;

export async function agentCommand(args: string[]): Promise<number> {
  if (args[0] !== "start") throw new UsageError(`expected "agent start"\n\n${AGENT_START_USAGE}`);
  const { values, positionals } = parse(
    () =>
      parseArgs({
        args: args.slice(1),
        strict: true,
        allowPositionals: true,
        options: {
          split: { type: "string" },
          pane: { type: "string" },
          name: { type: "string" },
          project: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      }),
    AGENT_START_USAGE,
  );
  if (values.help === true) {
    console.log(AGENT_START_USAGE);
    return 0;
  }
  const usage = (message: string) => new UsageError(`${message}\n\n${AGENT_START_USAGE}`);
  if (positionals.length !== 1) throw usage("expected exactly one <role>");
  const role = positionals[0] as string;
  if (!isId(role)) throw usage(`<role> ${JSON.stringify(role)} is not a valid role name`);
  const split = values.split;
  if (split !== undefined && split !== "right" && split !== "down")
    throw usage("--split must be right or down");
  if (split !== undefined && values.pane !== undefined)
    throw usage("--split and --pane cannot be combined");
  if (values.pane === "") throw usage("--pane must name a pane");
  const name = values.name ?? role;
  if (!isHerdrRuntimeName(name)) {
    throw usage(
      values.name === undefined
        ? `role ${JSON.stringify(role)} is not a valid Herdr agent name; pass --name`
        : `--name ${JSON.stringify(name)} is not a valid Herdr agent name (lowercase letters, digits, - and _, at most 32, starting with a letter)`,
    );
  }
  const project = resolve(values.project ?? process.cwd());

  const resolved = await resolveConfiguration({ projectDir: project });
  if (!resolved.ok) return rejected(resolved.reason, resolved.message, resolved.details, 2);
  const configuration = resolved.configuration;
  const chosen = Object.hasOwn(configuration.roles, role) ? configuration.roles[role] : undefined;
  if (chosen === undefined) {
    const searched = [
      ...(configuration.roots.project !== null
        ? [`${configuration.roots.project.dir}/roles/${role}.json`]
        : []),
      ...(configuration.roots.user !== null
        ? [`${configuration.roots.user.dir}/roles/${role}.json`]
        : []),
      "built-in roles",
    ];
    const message = `no role ${role} is defined; searched ${searched.join(", ")}`;
    return rejected("role_unresolved", message, [{ field: "role", message }], 2);
  }
  const launch = launchArgs({ ...chosen.value, runDir: null });
  if (!launch.ok) return rejected(launch.reason, launch.message, [], 2);
  for (const warning of configuration.warnings)
    if (warning.message.startsWith(`role ${role} `))
      console.error(`woof: warning: ${warning.message}`);

  const herdrPane = process.env["HERDR_PANE_ID"];
  if (process.env["HERDR_ENV"] !== "1")
    return rejected(
      "herdr_unavailable",
      "HERDR_ENV is not 1; woof agent start runs inside Herdr",
      [],
      3,
    );
  if (values.pane === undefined && (herdrPane === undefined || herdrPane === ""))
    return rejected(
      "herdr_unavailable",
      "HERDR_PANE_ID is not set, so there is no pane to split from; name an existing pane with --pane",
      [],
      3,
    );

  const runtime = createHerdrCliRuntime({ bin: herdrBin(), env: process.env });
  let paneId = values.pane;
  if (paneId === undefined) {
    const opened = await runtime.openPane({
      near: "current",
      cwd: project,
      direction: split ?? "down",
      timeoutMs: AGENT_START_TIMEOUT_MS,
    });
    if (!opened.ok) return startFailed("pane split failed", opened.error);
    paneId = opened.value.paneId;
  }
  const started = await runtime.startAgent({
    runtimeName: name,
    kind: chosen.value.kind,
    paneId,
    args: launch.args,
    timeoutMs: AGENT_START_TIMEOUT_MS,
  });
  if (!started.ok) {
    // A pane this command split holds no agent now: close it, so a retry does not pile up empty
    // panes. A pane named with --pane is the caller's and stays open.
    if (values.pane !== undefined) return startFailed("agent start failed", started.error);
    const close = ["pane", "close", paneId];
    const closed = parseHerdrOutput(
      close,
      await execHerdr(close, {
        bin: herdrBin(),
        env: process.env,
        timeoutMs: PANE_CLOSE_TIMEOUT_MS,
        graceMs: PANE_CLOSE_GRACE_MS,
      }),
    );
    const cleanup = closed.ok
      ? `; the pane ${paneId} it split was closed`
      : `; the pane ${paneId} it split could not be closed (${closed.error.message}); close it with herdr pane close ${paneId}`;
    return startFailed(`agent start failed`, started.error, cleanup, closed.ok);
  }
  console.log(
    JSON.stringify({
      outcome: "started",
      role,
      roleSource: describeSource(chosen),
      agent: started.value,
    }),
  );
  return 0;
}

function startFailed(
  what: string,
  error: RuntimeError,
  cleanup = "",
  paneClosed?: boolean,
): number {
  return rejected("agent_start_failed", `${what}: ${error.message}${cleanup}`, [], 3, {
    runtime: { code: error.code, runtimeCode: error.runtimeCode },
    ...(paneClosed !== undefined ? { paneClosed } : {}),
  });
}
