import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { resolveConfiguration } from "../config/resolve.js";
import { claudeTrustStatus } from "../runtime/claude/trust.js";
import { VERSION } from "../version.js";
import { parse } from "./common.js";
import { herdrBin } from "./run.js";

export const DOCTOR_USAGE = `Usage: woof doctor [--json] [--repo <dir>]

Reports Woof, Herdr and Claude Code availability. --json prints one JSON line
with the CLI path, the Herdr environment, Claude Code, the read-only Claude
folder-trust status of --repo (or the working directory) and whether its
configuration resolves. The trust status is advisory: Woof never answers or
bypasses Claude Code's trust question. Always exits 0.`;

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
  if (values.json !== true) {
    console.log(`woof ${VERSION}`);
    console.log(probe("herdr", ["status"]));
    console.log(probe("claude", ["--version"]));
    return 0;
  }
  const repo = resolve(values.repo ?? process.cwd());
  const herdr = versionOf(herdrBin());
  const claude = versionOf("claude");
  const resolved = await resolveConfiguration({ projectDir: repo });
  console.log(
    JSON.stringify({
      woof: { version: VERSION, cli: cliPath, node: process.execPath },
      herdr: {
        env: process.env["HERDR_ENV"] === "1",
        paneId: process.env["HERDR_PANE_ID"] ?? null,
        status: herdr.status,
        version: herdr.version,
      },
      claude: { status: claude.status, version: claude.version },
      trust: (({ dir, status }) => ({ dir, status }))(claudeTrustStatus(repo)),
      config: resolved.ok
        ? {
            ok: true,
            project: resolved.configuration.roots.project?.root ?? null,
            warnings: resolved.configuration.warnings,
          }
        : { ok: false, reason: resolved.reason, message: resolved.message },
    }),
  );
  return 0;
}

/** Bound on each probe of an external executable, so a hung `herdr` or `claude` cannot block doctor. */
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

function probe(commandName: string, args: readonly string[]): string {
  const label = `${commandName} ${args.join(" ")}`;
  const result = spawnSync(commandName, args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });

  if (result.error !== undefined && "code" in result.error && result.error.code === "ENOENT") {
    return `${label}: not found`;
  }
  if (result.status === 0) {
    const output = result.stdout.trim();
    return output === "" ? `${label}: available` : `${label}:\n${indent(output)}`;
  }

  // stdio is null when the executable exists but cannot be started (EACCES).
  const detail =
    (result.stderr ?? "").trim() || result.error?.message || `exit ${result.status ?? "unknown"}`;
  return `${label}: failed (${detail.split("\n")[0]})`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
