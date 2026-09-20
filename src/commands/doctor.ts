import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { gitTopLevel } from "../config/discover.js";
import { resolveConfiguration } from "../config/resolve.js";
import { claudeTrustStatus } from "../runtime/claude/trust.js";
import { VERSION } from "../version.js";
import { parse } from "./common.js";
import { herdrBin } from "./run.js";

export const DOCTOR_USAGE = `Usage: woof doctor [--json] [--strict] [--repo <dir>]

Reports Woof, Herdr, Claude Code and pi availability, the read-only Claude
folder-trust status of the repository and whether its configuration resolves.
The repository is the git top level of --repo (or the working directory), or
that directory itself outside a git work tree; trust is read for exactly that
key, and an ancestor's trust does not count. The trust status is advisory: Woof
never answers or bypasses Claude Code's trust question. pi has no folder-trust
pre-flight; it is reported as a known limit, not checked here.

--json prints the report as one JSON line; without it the same report is
printed as text. Both run the same probes (herdr, claude and pi --version).
"problems" lists herdr_unavailable, claude_unavailable, pi_unavailable,
trust_untrusted, trust_unknown and config_invalid when they apply. pi is always
probed, but a missing pi is a problem only when some resolved role has
kind "pi"; a missing claude is always a problem, because the built-in roles are
claude and are the bottom layer of resolution.

Exits 0, or 2 with --strict when the report lists any problem.`;

const cliPath = join(dirname(dirname(fileURLToPath(import.meta.url))), "cli.js");

export async function doctorCommand(args: string[]): Promise<number> {
  const { values } = parse(
    () =>
      parseArgs({
        args,
        strict: true,
        allowPositionals: false,
        options: {
          json: { type: "boolean" },
          strict: { type: "boolean" },
          repo: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      }),
    DOCTOR_USAGE,
  );
  if (values.help === true) {
    console.log(DOCTOR_USAGE);
    return 0;
  }
  const report = await doctorReport(resolve(values.repo ?? process.cwd()));
  console.log(values.json === true ? JSON.stringify(report) : renderReport(report));
  return values.strict === true && report.problems.length > 0 ? 2 : 0;
}

type ProbeStatus = "available" | "not_found" | "failed";

export type DoctorProblem =
  | "herdr_unavailable"
  | "claude_unavailable"
  | "pi_unavailable"
  | "trust_untrusted"
  | "trust_unknown"
  | "config_invalid";

/** What `woof doctor --json` prints, and `woof herdr doctor` reports for its project. */
export interface DoctorReport {
  woof: { version: string; cli: string; node: string };
  herdr: { env: boolean; paneId: string | null; status: ProbeStatus; version: string | null };
  claude: { status: ProbeStatus; version: string | null };
  /** Always probed; a problem only when some resolved role has kind "pi". */
  pi: { status: ProbeStatus; version: string | null };
  trust: { dir: string; status: ReturnType<typeof claudeTrustStatus>["status"] };
  config:
    | { ok: true; project: string | null; warnings: unknown[] }
    | { ok: false; reason: string; message: string };
  /** Everything above that would stop or degrade a run, in this order; empty when none. */
  problems: DoctorProblem[];
}

/** Probes Herdr, Claude Code and pi and reads the repository's Claude trust and configuration (read-only). */
export async function doctorReport(repo: string): Promise<DoctorReport> {
  const herdr = versionOf(herdrBin());
  const claude = versionOf("claude");
  const pi = versionOf("pi");
  const resolved = await resolveConfiguration({ projectDir: repo });
  const trust = claudeTrustStatus(await trustDir(repo));
  const problems: DoctorProblem[] = [];
  if (herdr.status !== "available") problems.push("herdr_unavailable");
  if (claude.status !== "available") problems.push("claude_unavailable");
  // A run needs pi only when a role selects it, and doctor has no run input, so any resolved
  // role counts. claude stays unconditional on purpose: built-in roles are the bottom layer of
  // resolution, so a project that shadows builder, planner and reviewer with pi roles leaves no
  // resolved claude role, and gating claude the same way would silently stop claude_unavailable
  // firing for it -- a documented --strict contract this phase did not set out to change.
  if (pi.status !== "available" && usesPi(resolved)) problems.push("pi_unavailable");
  if (trust.status === "untrusted") problems.push("trust_untrusted");
  if (trust.status === "unknown") problems.push("trust_unknown");
  if (!resolved.ok) problems.push("config_invalid");
  return {
    woof: { version: VERSION, cli: cliPath, node: process.execPath },
    herdr: {
      env: process.env["HERDR_ENV"] === "1",
      paneId: process.env["HERDR_PANE_ID"] ?? null,
      status: herdr.status,
      version: herdr.version,
    },
    claude: { status: claude.status, version: claude.version },
    pi: { status: pi.status, version: pi.version },
    trust: { dir: trust.dir, status: trust.status },
    config: resolved.ok
      ? {
          ok: true,
          project: resolved.configuration.roots.project?.root ?? null,
          warnings: resolved.configuration.warnings,
        }
      : { ok: false, reason: resolved.reason, message: resolved.message },
    problems,
  };
}

/** Whether any resolved role selects pi. An unresolved configuration reports config_invalid instead. */
function usesPi(resolved: Awaited<ReturnType<typeof resolveConfiguration>>): boolean {
  const configuration = resolved.configuration;
  if (configuration === undefined) return false;
  return Object.values(configuration.roles).some((role) => role.value.kind === "pi");
}

/**
 * The directory whose exact trust key doctor reads (F-016): the git top level
 * of `repo`, spelled as the ancestor of `repo` that is that top level (so a
 * path given through a symlink keeps its spelling, and trust.ts also tries the
 * real path), or `repo` itself outside a work tree.
 */
async function trustDir(repo: string): Promise<string> {
  const top = await gitTopLevel(repo);
  if (top === undefined) return repo;
  const real = realpathOrUndefined(top);
  for (let dir = repo; ; dir = dirname(dir)) {
    if (dir === top || (real !== undefined && realpathOrUndefined(dir) === real)) return dir;
    if (dirname(dir) === dir) return top;
  }
}

function realpathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function probeText(status: ProbeStatus, version: string | null): string {
  return `${status === "not_found" ? "not found" : status}${version === null ? "" : ` (${version})`}`;
}

/** The report as text: the same facts as --json, one subject per line. */
function renderReport(report: DoctorReport): string {
  const env = report.herdr.env
    ? `inside Herdr${report.herdr.paneId === null ? "" : ` (pane ${report.herdr.paneId})`}`
    : "HERDR_ENV is not 1";
  const config = report.config.ok
    ? `ok (${report.config.project === null ? "no project" : `project ${report.config.project}`})`
    : `${report.config.reason}: ${report.config.message}`;
  return [
    `woof ${report.woof.version}`,
    `  cli: ${report.woof.cli}`,
    `  node: ${report.woof.node}`,
    `herdr: ${probeText(report.herdr.status, report.herdr.version)}`,
    `  env: ${env}`,
    `claude: ${probeText(report.claude.status, report.claude.version)}`,
    `pi: ${probeText(report.pi.status, report.pi.version)}`,
    `trust: ${report.trust.status} (${report.trust.dir})`,
    `config: ${config}`,
    `problems: ${report.problems.length === 0 ? "none" : report.problems.join(", ")}`,
  ].join("\n");
}

/** Bound on each probe of an external executable, so a hung `herdr`, `claude` or `pi` cannot block doctor. */
const PROBE_TIMEOUT_MS = 10_000;

function versionOf(command: string): {
  status: "available" | "not_found" | "failed";
  version: string | null;
} {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
  if (result.error !== undefined && "code" in result.error && result.error.code === "ENOENT")
    return { status: "not_found", version: null };
  if (result.status !== 0) return { status: "failed", version: null };
  return { status: "available", version: result.stdout.trim().split("\n")[0] ?? null };
}
