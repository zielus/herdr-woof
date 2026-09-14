import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupRunDirs, makeRunDir, repoRoot, runNode } from "./helpers/process.js";

afterEach(() => cleanupRunDirs());

const writeAllUrl = pathToFileURL(join(repoRoot, "dist", "journal", "write-all.js")).href;

describe("writeAll", () => {
  it("resumes after short writes and refuses a write that makes no progress", () => {
    const path = join(makeRunDir(), "out.txt");
    const script = `
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
const { writeAll } = await import(${JSON.stringify(writeAllUrl)});
const path = process.argv[1];
const text = "journal line with short writes\\n";

let calls = 0;
const fd = openSync(path, "w");
// A writer that accepts at most 3 bytes per call forces the resume loop.
writeAll(fd, text, (target, buffer, offset, length) => {
  calls += 1;
  return writeSync(target, buffer, offset, Math.min(3, length));
});
closeSync(fd);

let stalled = "no error";
const stalledFd = openSync(path, "a");
try {
  writeAll(stalledFd, "more", () => 0);
} catch (error) {
  stalled = error.message;
} finally {
  closeSync(stalledFd);
}
console.log(JSON.stringify({ content: readFileSync(path, "utf8"), calls, stalled, expected: text }));
`;

    const result = runNode(script, [path]);

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      content: string;
      calls: number;
      stalled: string;
      expected: string;
    };
    expect(output.content).toBe(output.expected);
    expect(output.calls).toBe(Math.ceil(Buffer.byteLength(output.expected) / 3));
    expect(output.stalled).toContain("short write: 0 of 4 bytes written");
  });
});
