import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { gitTopLevel } from "../config/discover.js";
import { resolveConfiguration } from "../config/resolve.js";
import { claudeTrustStatus } from "../runtime/claude/trust.js";
import { agentKindSpecs, type AgentKindSpec } from "../runtime/kinds/index.js";
import { VERSION } from "../version.js";
import { parse } from "./common.js";
import { herdrBin } from "./run.js";

export const DOCTOR_USAGE = `Usage: woof doctor [--json] [--strict] [--repo <dir>]

Reports Woof, Herdr and Claude Code availability, every supported agent kind's
CLI, the read-only Claude folder-trust status of the repository and whether its
configuration resolves.
The repository is the git top level of --repo (or the working directory), or
that directory itself outside a git work tree; trust is read for exactly that
key, and an ancestor's trust does not count. The trust status is advisory: Woof
never answers or bypasses Claude Code's trust question.

--json prints the report as one JSON line; without it the same report is
printed as text. Both run the same probes: herdr and every kind's CLI with
--version, and, for a configured role whose kind has one, a readiness probe
(pi: pi auth check for the role's provider or provider/model, without
refreshing credentials). "kinds" lists each kind, the resolved roles that use
it and those probes. "problems" lists herdr_unavailable, claude_unavailable,
trust_untrusted, trust_unknown and config_invalid when they apply, and for a
kind other than claude that a resolved role uses: <kind>_unavailable,
<kind>_not_ready and <kind>_trust_untrusted or <kind>_trust_unknown.

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
  | "trust_untrusted"
  | "trust_unknown"
  | "config_invalid"
  // A kind other than claude that a resolved role uses, e.g. pi_unavailable.
  | `${string}_unavailable`
  | `${string}_not_ready`
  | `${string}_trust_untrusted`
  | `${string}_trust_unknown`;

/** One supported agent kind: its CLI probe, the resolved roles that use it, and their checks. */
export interface DoctorKind {
  kind: string;
  executable: string;
  status: ProbeStatus;
  version: string | null;
  /** Resolved role names whose kind this is (none when configuration did not resolve). */
  roles: string[];
  /** Readiness probes of those roles, one per distinct model/provider selection. */
  readiness: Array<{ roles: string[]; subject: string; ready: boolean; detail: string }>;
  /** The kind's advisory folder-trust warning for the repository, when a role uses it. */
  trust: { code: string; message: string } | null;
}

/** What `woof doctor --json` prints, and `woof herdr doctor` reports for its project. */
export interface DoctorReport {
  woof: { version: string; cli: string; node: string };
  herdr: { env: boolean; paneId: string | null; status: ProbeStatus; version: string | null };
  claude: { status: ProbeStatus; version: string | null };
  /** Every supported kind, claude included, in the order the kinds are listed. */
  kinds: DoctorKind[];
  trust: { dir: string; status: ReturnType<typeof claudeTrustStatus>["status"] };
  config:
    | { ok: true; project: string | null; warnings: unknown[] }
    | { ok: false; reason: string; message: string };
  /** Everything above that would stop or degrade a run, in this order; empty when none. */
  problems: DoctorProblem[];
}

/** Probes Herdr and Claude Code and reads the repository's Claude trust and configuration (read-only). */
export async function doctorReport(repo: string): Promise<DoctorReport> {
  const resolved = await resolveConfiguration({ projectDir: repo });
  const dir = await trustDir(repo);
  const roles = resolved.ok ? Object.entries(resolved.configuration.roles) : [];
  // Every probe is bounded and they run together, so doctor waits for the slowest one only.
  const [herdr, kinds] = await Promise.all([
    versionOf(herdrBin()),
    Promise.all(agentKindSpecs().map((spec) => kindReport(spec, roles, dir))),
  ]);
  const claude = kinds.find((kind) => kind.kind === "claude") ?? {
    status: "not_found" as const,
    version: null,
  };
  const trust = claudeTrustStatus(dir);
  const problems: DoctorProblem[] = [];
  if (herdr.status !== "available") problems.push("herdr_unavailable");
  if (claude.status !== "available") problems.push("claude_unavailable");
  if (trust.status === "untrusted") problems.push("trust_untrusted");
  if (trust.status === "unknown") problems.push("trust_unknown");
  if (!resolved.ok) problems.push("config_invalid");
  // claude keeps its unconditional problems above; another kind counts only when a role uses it.
  for (const kind of kinds) {
    if (kind.kind === "claude" || kind.roles.length === 0) continue;
    if (kind.status !== "available") problems.push(`${kind.kind}_unavailable`);
    if (kind.readiness.some((check) => !check.ready)) problems.push(`${kind.kind}_not_ready`);
    if (kind.trust !== null) problems.push(kind.trust.code as DoctorProblem);
  }
  return {
    woof: { version: VERSION, cli: cliPath, node: process.execPath },
    herdr: {
      env: process.env["HERDR_ENV"] === "1",
      paneId: process.env["HERDR_PANE_ID"] ?? null,
      status: herdr.status,
      version: herdr.version,
    },
    claude: { status: claude.status, version: claude.version },
    kinds,
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
    ...report.kinds.flatMap(kindLines),
    `trust: ${report.trust.status} (${report.trust.dir})`,
    `config: ${config}`,
    `problems: ${report.problems.length === 0 ? "none" : report.problems.join(", ")}`,
  ].join("\n");
}

/** Bound on each probe of an external executable, so a hung CLI cannot block doctor. */
const PROBE_TIMEOUT_MS = 10_000;

interface Probe {
  status: ProbeStatus;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one probe without a shell, bounded by PROBE_TIMEOUT_MS. */
function probe(command: string, args: readonly string[]): Promise<Probe> {
  return new Promise((done) => {
    execFile(
      command,
      [...args],
      // SIGKILL, not the default SIGTERM: a CLI that ignores SIGTERM must not outlive the bound.
      {
        encoding: "utf8",
        timeout: PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) return done({ status: "available", code: 0, stdout, stderr });
        if (error.code === "ENOENT")
          return done({ status: "not_found", code: null, stdout: "", stderr: "" });
        return done({
          status: "failed",
          code: typeof error.code === "number" ? error.code : null,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
  });
}

async function versionOf(
  command: string,
): Promise<{ status: ProbeStatus; version: string | null }> {
  const result = await probe(command, ["--version"]);
  if (result.status !== "available") return { status: result.status, version: null };
  return { status: "available", version: result.stdout.trim().split("\n")[0] ?? null };
}

/** A kind's CLI probe, the resolved roles that use it, their readiness probes and trust warning. */
async function kindReport(
  spec: AgentKindSpec,
  roles: ReadonlyArray<
    [string, { value: { kind: string; model: string | null; provider?: string } }]
  >,
  dir: string,
): Promise<DoctorKind> {
  const used = roles.filter(([, role]) => role.value.kind === spec.kind);
  const version = await versionOf(spec.executable);
  // One probe per distinct selection, run only when the CLI answered --version.
  const selections = new Map<
    string,
    { roles: string[]; model: string | null; provider: string | null }
  >();
  for (const [name, role] of used) {
    const provider = role.value.provider ?? null;
    const key = JSON.stringify([role.value.model, provider]);
    const entry = selections.get(key) ?? { roles: [], model: role.value.model, provider };
    entry.roles.push(name);
    selections.set(key, entry);
  }
  // One selection at a time: however many roles a project defines, a kind runs one probe at once.
  const readiness: DoctorKind["readiness"] = [];
  for (const selection of selections.values()) {
    const check = version.status === "available" ? spec.readinessProbe?.(selection) : undefined;
    if (check === undefined || check === null) continue;
    // oxlint-disable-next-line no-await-in-loop
    const result = await probe(spec.executable, check.args);
    readiness.push({
      roles: selection.roles,
      subject: check.subject,
      ...(result.status === "not_found"
        ? { ready: false, detail: `${spec.executable} not found` }
        : check.read({ status: result.code, stdout: result.stdout, stderr: result.stderr })),
    });
  }
  const warning = used.length > 0 ? (spec.trustWarning?.(dir, {}) ?? null) : null;
  return {
    kind: spec.kind,
    executable: spec.executable,
    status: version.status,
    version: version.version,
    roles: used.map(([name]) => name),
    readiness,
    trust: warning === null ? null : { code: warning.code, message: warning.message },
  };
}

/** The text lines of one kind other than claude (claude has its own line above). */
function kindLines(kind: DoctorKind): string[] {
  if (kind.kind === "claude") return [];
  return [
    `${kind.kind}: ${probeText(kind.status, kind.version)}${kind.roles.length === 0 ? "" : ` (roles: ${kind.roles.join(", ")})`}`,
    ...kind.readiness.map(
      (check) => `  ${check.subject}: ${check.detail} (roles: ${check.roles.join(", ")})`,
    ),
    ...(kind.trust !== null ? [`  trust: ${kind.trust.code}: ${kind.trust.message}`] : []),
  ];
}
