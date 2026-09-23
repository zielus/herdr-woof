import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repoRoot, "bin", "woof");

function runCli(...args: string[]) {
  return spawnSync(cliPath, args, { encoding: "utf8" });
}

describe("SDK foundation", () => {
  it("exports the foundation marker, the p2 SDK contracts and the p3 workflow engine from the built entry", () => {
    const entryPath = join(repoRoot, "dist", "index.js");
    const script = `const entry = await import(${JSON.stringify(pathToFileURL(entryPath).href)});
console.log(JSON.stringify({
  marker: entry.SDK_FOUNDATION,
  types: Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, typeof value])),
}));`;

    const result = spawnSync("node", ["--input-type=module", "--eval", script], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    const entry = JSON.parse(result.stdout) as { marker: unknown; types: Record<string, string> };
    expect(entry.marker).toBe(true);
    // Module namespace keys are ordered by code unit, not by declaration.
    const expected: Record<string, string> = {
      ACTIVITY_KINDS: "object",
      ACTIVITY_PHASES: "object",
      BUILT_IN_WORKFLOWS: "object",
      DISPATCH_REASONS: "object",
      MAX_ARTIFACT_BYTES: "number",
      ObservationTracker: "function",
      REJECTION_REASONS: "object",
      SDK_FOUNDATION: "boolean",
      admitWorkflow: "function",
      assignAgent: "function",
      blockRun: "function",
      buildReviewWorkflow: "object",
      builtInWorkflow: "function",
      builtInWorkflowNames: "function",
      cancelRun: "function",
      claimHost: "function",
      claudeTrustStatus: "function",
      createHerdrCliRuntime: "function",
      createRunRenderer: "function",
      deriveRunResult: "function",
      deriveSnapshot: "function",
      discoverRoots: "function",
      foldEvents: "function",
      herdrRuntimeName: "function",
      listRuns: "function",
      loadWorkflowDefinition: "function",
      openAdmittedRun: "function",
      openAttempt: "function",
      openRun: "function",
      overlayRuntime: "function",
      planBuildReviewWorkflow: "object",
      probeHost: "function",
      readEvents: "function",
      readJournal: "function",
      readRunStatus: "function",
      readSnapshot: "function",
      reconcileDelivery: "function",
      recordDispatch: "function",
      recordGate: "function",
      resolveConfiguration: "function",
      runWorkflow: "function",
      submitResult: "function",
      subscribeEvents: "function",
      terminateRun: "function",
      unblockRun: "function",
      validateRunPlan: "function",
      validateWorkflowDefinition: "function",
      watchAgent: "function",
    };
    expect(Object.keys(entry.types)).toEqual(Object.keys(expected).toSorted());
    expect(entry.types).toEqual(expected);
    expect(readFileSync(entryPath, "utf8")).not.toContain("cli.js");
    for (const internal of ["abandonHost", "launchInPane", "createMetadataReporter"]) {
      expect(entry.types).not.toHaveProperty(internal);
    }
  });

  it("PI-201: the package entry's probe has no claim-read test seam, at runtime or in its declarations", () => {
    const dir = mkdtempSync(join(tmpdir(), "woof-pi201-"));
    try {
      writeFileSync(join(dir, "host.json"), "");
      const script = `const { probeHost } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, "dist", "index.js")).href)});
let calls = 0;
const probed = probeHost(process.argv[1], { onInvalidRead() { calls += 1; } });
console.log(JSON.stringify({ probed, calls }));`;
      const result = spawnSync("node", ["--input-type=module", "--eval", script, dir], {
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        probed: {
          owner: "lost",
          host: null,
          problem: "host.json exists but is not a valid run host claim",
        },
        calls: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const entryTypes = readFileSync(join(repoRoot, "dist", "index.d.ts"), "utf8");
    expect(entryTypes).toContain('export { probeHost } from "./host/probe.js";');
    expect(entryTypes).toMatch(
      /export type \{[^}]*\bProbeOptions\b[^}]*\} from "\.\/host\/probe\.js";/,
    );
    expect(entryTypes).not.toContain("ClaimReadOptions");
    expect(entryTypes).not.toContain("readHostClaim");
    const probeTypes = readFileSync(join(repoRoot, "dist", "host", "probe.d.ts"), "utf8");
    const publicOptions = /export interface ProbeOptions \{[^}]*\}/.exec(probeTypes)?.[0];
    expect(publicOptions).toBeDefined();
    expect(publicOptions).not.toContain("onInvalidRead");
    expect(publicOptions?.match(/^\s+(\w+)\?:/gm)?.map((line) => line.trim())).toEqual([
      "now?:",
      "terminal?:",
    ]);
    expect(probeTypes).toMatch(
      /declare function probeHost\(runDir: string, options\?: ProbeOptions\)/,
    );
  });
});

describe("herdr-woof/testing", () => {
  it("exports only the scripted runtime, and the main entry does not", () => {
    const script = `const testing = await import(${JSON.stringify(pathToFileURL(join(repoRoot, "dist", "testing.js")).href)});
const entry = await import(${JSON.stringify(pathToFileURL(join(repoRoot, "dist", "index.js")).href)});
console.log(JSON.stringify({ testing: Object.fromEntries(Object.entries(testing).map(([key, value]) => [key, typeof value])), inEntry: "createScriptedRuntime" in entry }));`;

    const result = spawnSync("node", ["--input-type=module", "--eval", script], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      testing: { createScriptedRuntime: "function" },
      inEntry: false,
    });
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./testing": { types: "./dist/testing.d.ts", import: "./dist/testing.js" },
      "./package.json": "./package.json",
    });
  });
});

describe("woof CLI", () => {
  it("prints the package version", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };

    const result = runCli("--version");

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("lists run start as the one way to run a workflow, and no other entry point", () => {
    const result = runCli("--help");

    expect(result.status).toBe(0);
    for (const command of [
      "run start",
      "run cancel",
      "submit",
      "status",
      "runs",
      "events",
      "config show",
      "doctor",
    ]) {
      expect(result.stdout).toMatch(new RegExp(`^  ${command} `, "m"));
    }
    for (const removed of ["run build-review", "herdr start", "agent start", "attempt open"]) {
      expect(result.stdout).not.toContain(removed);
    }
    expect(result.stdout).not.toMatch(/^ {2}run show /m);
    expect(result.stdout).not.toContain("not implemented");
  });

  it("refuses the removed entry points as usage errors", () => {
    for (const args of [
      ["run", "build-review", "--help"],
      ["run", "show", "--help"],
      ["attempt", "open", "--help"],
      ["agent", "start", "--help"],
      ["ui", "--help"],
    ]) {
      const result = runCli(...args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stdout, args.join(" ")).toBe("");
    }
  });

  it("names every run subcommand in the run usage error, and prints help for a herdr action", () => {
    const bare = runCli("run");
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain('expected "run start", "run cancel" or "run host"');
    for (const action of ["status", "cancel", "doctor", "watch"]) {
      const help = runCli("herdr", action, "--help");
      expect(help.status, action).toBe(0);
      expect(help.stdout, action).toContain("Usage: woof herdr <status|cancel|doctor|watch>");
    }
  });

  it("rejects commands that do not exist", () => {
    for (const name of ["frobnicate", "nosuch"]) {
      const result = runCli(name);

      // F-025: an unknown command is named as unknown, not as unimplemented.
      expect(result.status, name).toBe(1);
      expect(result.stderr, name).toBe(`woof: unknown command "${name}"; see woof --help\n`);
      expect(result.stdout, name).toBe("");
    }
  });

  it("names every workflow module extension the loader accepts in run start --help", () => {
    const result = runCli("run", "start", "--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(".woof/workflows/<name>.{mjs,js,ts}");
    expect(result.stdout).not.toMatch(/<name>\.mjs\b/);
  });

  it("lists runs from a runs directory (an absent one lists nothing)", () => {
    const runsDir = join(mkdtempSync(join(tmpdir(), "woof-runs-")), "absent");
    const result = runCli("runs", "--runs-dir", runsDir);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      outcome: "runs",
      runsDir,
      exists: false,
      runs: [],
      skipped: [],
    });
  });

  it("runs the diagnostic command without requiring Herdr or Claude", () => {
    // PATH holds node but neither herdr nor claude: a test never runs the real Herdr CLI.
    const binDir = mkdtempSync(join(tmpdir(), "woof-doctor-path-"));
    try {
      symlinkSync(process.execPath, join(binDir, "node"));
      const result = spawnSync(cliPath, ["doctor"], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin` },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("woof");
      expect(result.stdout).toMatch(/^herdr: not found$/m);
      expect(result.stdout).toMatch(/^claude: not found$/m);
    } finally {
      rmSync(binDir, { force: true, recursive: true });
    }
  });

  it("reports a probe that exists but cannot be started", () => {
    const binDir = mkdtempSync(join(tmpdir(), "woof-doctor-"));
    try {
      for (const name of ["herdr", "claude"]) {
        writeFileSync(join(binDir, name), "not executable\n", { mode: 0o644 });
      }

      const result = spawnSync(process.execPath, [join(repoRoot, "dist", "cli.js"), "doctor"], {
        encoding: "utf8",
        env: { PATH: binDir },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^herdr: failed$/m);
      expect(result.stdout).toMatch(/^claude: failed$/m);
    } finally {
      rmSync(binDir, { force: true, recursive: true });
    }
  });
});
