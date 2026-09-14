import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { distUrl, runNode, sha256 } from "./helpers/process.js";

// Check execution and engine evidence files, in real child processes.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

interface CheckOut {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  output: string;
  bytes: number;
  ms: number;
}

function check(argv: string[], cwd: string, timeoutMs = 10_000): CheckOut {
  const result = runNode(
    `const { runCheck } = await import(${JSON.stringify(distUrl("scheduler/check.js"))});
const started = Date.now();
const run = await runCheck({ argv: JSON.parse(process.argv[1]), cwd: process.argv[2], timeoutMs: Number(process.argv[3]), graceMs: 200 });
console.log(JSON.stringify({ ...run, output: run.output.toString("utf8").slice(-2000), head: run.output.subarray(0, 400).toString("utf8"), bytes: run.output.byteLength, ms: Date.now() - started }));`,
    [JSON.stringify(argv), cwd, String(timeoutMs)],
    { timeoutMs: 30_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.json as unknown as CheckOut;
}

describe("runCheck", () => {
  it("runs argv without a shell in the given directory and records the exit code", () => {
    const cwd = tempDir("woof-check-");
    const ok = check(["node", "-e", "console.log(process.cwd()); console.error('warn')"], cwd);
    expect(ok).toMatchObject({ exitCode: 0, signal: null, timedOut: false, aborted: false });
    expect(ok.output).toContain(`$ node -e`);
    expect(ok.output).toContain("# exit 0 signal none");
    expect(ok.output).toMatch(/private|tmp|var/);
    expect(ok.output).toContain("warn");
    const failed = check(["node", "-e", "process.exit(3)"], cwd);
    expect(failed).toMatchObject({ exitCode: 3, timedOut: false });
    const literal = check(["node", "-e", "console.log(process.argv[1])", "$(echo no-shell)"], cwd);
    expect(literal.output).toContain("$(echo no-shell)");
  });

  it("kills a check that outlives its timeout, including its children", () => {
    const cwd = tempDir("woof-check-");
    const out = check(
      [
        "node",
        "-e",
        "require('child_process').spawn('sleep', ['30'], { stdio: 'inherit' }); setInterval(() => {}, 1000)",
      ],
      cwd,
      300,
    );
    expect(out.timedOut).toBe(true);
    expect(out.exitCode).toBeNull();
    expect(out.signal).toBe("SIGTERM");
    expect(out.ms).toBeLessThan(10_000);
    expect(out.output).toContain("timed out after 300 ms");
  });

  it("keeps only the last 1 MiB of output", () => {
    const cwd = tempDir("woof-check-");
    const out = check(
      [
        "node",
        "-e",
        "process.stdout.write('x'.repeat(2 * 1024 * 1024)); process.stdout.write('TAIL-END')",
      ],
      cwd,
    );
    expect(out.exitCode).toBe(0);
    expect(out.output.endsWith("TAIL-END")).toBe(true);
    expect((out as CheckOut & { head: string }).head).toContain(
      "# output truncated to the last 1048576 bytes",
    );
    expect(out.bytes).toBeLessThanOrEqual(1024 * 1024 + 512);
    expect(out.bytes).toBeGreaterThan(1024 * 1024);
  });

  it("reports a command that cannot start as a failed check with evidence", () => {
    const cwd = tempDir("woof-check-");
    const out = check(["woof-no-such-command-xyz"], cwd);
    expect(out).toMatchObject({ exitCode: null, signal: null, timedOut: false });
    expect(out.output).toContain("# failed to start:");
  });

  it("reports a synchronous spawn failure (a file as a PATH component) as a failed start", () => {
    const cwd = tempDir("woof-check-");
    const file = join(tempDir("woof-path-"), "not-a-dir");
    writeFileSync(file, "");
    const result = runNode(
      `const { runCheck } = await import(${JSON.stringify(distUrl("scheduler/check.js"))});
const run = await runCheck({ argv: ["woof-no-such-command-xyz"], cwd: process.argv[1], timeoutMs: 5000 });
console.log(JSON.stringify({ ...run, output: run.output.toString("utf8") }));`,
      [cwd],
      { env: { PATH: `${file}:${process.env["PATH"] ?? ""}` }, timeoutMs: 30_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const out = result.json as unknown as CheckOut;
    expect(out).toMatchObject({ exitCode: null, signal: null, timedOut: false, aborted: false });
    expect(out.output).toContain("$ woof-no-such-command-xyz");
    expect(out.output).toContain("# failed to start:");
  });
});

describe("writeEngineFile", () => {
  const write = (runDir: string, rel: string, content: string) =>
    runNode(
      `const { writeEngineFile } = await import(${JSON.stringify(distUrl("scheduler/files.js"))});
try { console.log(JSON.stringify({ ok: true, ...writeEngineFile(process.argv[1], process.argv[2], Buffer.from(process.argv[3])) })); }
catch (error) { console.log(JSON.stringify({ ok: false, message: error.message })); }`,
      [runDir, rel, content],
    ).json as unknown as {
      ok: boolean;
      path?: string;
      sha256?: string;
      bytes?: number;
      message?: string;
    };

  it("creates a read-only file with its digest and accepts an identical rewrite only", () => {
    const runDir = tempDir("woof-files-");
    const rel = "checks/verify/build-v1-a1/output.log";
    const first = write(runDir, rel, "evidence\n");
    expect(first).toMatchObject({ ok: true, sha256: sha256("evidence\n"), bytes: 9 });
    expect(readFileSync(join(runDir, rel), "utf8")).toBe("evidence\n");
    expect(lstatSync(join(runDir, rel)).mode & 0o777).toBe(0o444);
    expect(write(runDir, rel, "evidence\n")).toMatchObject({ ok: true });
    expect(write(runDir, rel, "other\n")).toMatchObject({ ok: false });
    expect(readFileSync(join(runDir, rel), "utf8")).toBe("evidence\n");
  });

  it("refuses a symlinked directory component", () => {
    const runDir = tempDir("woof-files-");
    const outside = tempDir("woof-outside-");
    mkdirSync(join(runDir, "requests"));
    symlinkSync(outside, join(runDir, "requests", "build"));
    const out = write(runDir, "requests/build/visit-1/attempt-1/request.md", "text");
    expect(out.ok).toBe(false);
    expect(out.message).toContain("symlink");
  });
});
