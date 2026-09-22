import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

// The artifact pager's read-only loader (pure I/O, no engine records): text,
// binary and error classification against real files on disk.
type ArtifactText =
  | { ok: true; lines: string[]; bytes: number; truncated: boolean }
  | {
      ok: false;
      state: "missing" | "unreadable" | "not_file" | "binary";
      message: string;
      bytes: number | null;
    };
interface ArtifactModule {
  readArtifact(path: string, options?: { maxBytes?: number }): ArtifactText;
  DEFAULT_MAX_ARTIFACT_BYTES: number;
}

let readArtifact: ArtifactModule["readArtifact"];
let DEFAULT_MAX_ARTIFACT_BYTES: number;

let dir: string;

beforeAll(async () => {
  ({ readArtifact, DEFAULT_MAX_ARTIFACT_BYTES } =
    await loadDist<ArtifactModule>("tui/artifact.js"));
  dir = mkdtempSync(join(tmpdir(), "woof-tui-artifact-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string | Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("readArtifact", () => {
  it("reports the default max bytes", () => {
    expect(DEFAULT_MAX_ARTIFACT_BYTES).toBe(1_048_576);
  });

  it("reads a plain text file", () => {
    const path = write("plain.txt", "first line\nsecond line\nthird line\n");
    const result = readArtifact(path);
    expect(result).toEqual({
      ok: true,
      lines: ["first line", "second line", "third line"],
      bytes: 34,
      truncated: false,
    });
  });

  it("strips a trailing carriage return from CRLF lines", () => {
    const path = write("crlf.txt", "one\r\ntwo\r\nthree\r\n");
    const result = readArtifact(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toEqual(["one", "two", "three"]);
    expect(result.truncated).toBe(false);
  });

  it("expands tabs to 8-column stops", () => {
    const path = write("tabs.txt", "a\tb\n");
    const result = readArtifact(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toEqual(["a       b"]);
  });

  it("shows an embedded escape sequence in caret notation", () => {
    const path = write("escape.txt", "before \x1b[31mred\x1b[0m after\n");
    const result = readArtifact(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toEqual(["before ^[[31mred^[[0m after"]);
  });

  it("reports an empty file as ok with no lines", () => {
    const path = write("empty.txt", "");
    const result = readArtifact(path);
    expect(result).toEqual({ ok: true, lines: [], bytes: 0, truncated: false });
  });

  it("reports a missing file", () => {
    const path = join(dir, "does-not-exist.txt");
    const result = readArtifact(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("missing");
    expect(result.bytes).toBeNull();
    expect(result.message).toBe(`${path} does not exist`);
  });

  it("reports a directory as not_file", () => {
    const path = join(dir, "a-directory");
    mkdirSync(path);
    const result = readArtifact(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("not_file");
    expect(result.bytes).toBeNull();
  });

  it("reports a NUL byte as binary", () => {
    const path = write("nul.bin", Buffer.from([0x68, 0x69, 0x00, 0x68, 0x69]));
    const result = readArtifact(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("binary");
  });

  it("reports invalid UTF-8 as binary", () => {
    const path = write("invalid-utf8.bin", Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x68, 0x69]));
    const result = readArtifact(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("binary");
  });

  it("truncates an oversized file at a whole line and utf-8 boundary", () => {
    // A multi-byte character ("é", 2 bytes in UTF-8) sits right where a naive
    // byte-count cut would land, and a later line pushes the file past maxBytes.
    const firstLine = "x".repeat(20) + "é"; // 20 ascii bytes + 2-byte char = 22 bytes
    const content = `${firstLine}\n${"y".repeat(500)}\n`;
    const path = write("oversized.txt", content);
    const result = readArtifact(path, { maxBytes: 25 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    // Only whole, validly-decoded lines are present; the cut character is not mangled.
    for (const line of result.lines) {
      expect(line.includes("�")).toBe(false);
    }
    expect(result.lines).toEqual([firstLine]);
    expect(result.bytes).toBeLessThanOrEqual(25);
  });

  it("reports an unreadable file", () => {
    if (process.getuid?.() === 0) return; // root ignores file permissions
    const path = write("unreadable.txt", "secret\n");
    chmodSync(path, 0o000);
    try {
      const result = readArtifact(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.state).toBe("unreadable");
      expect(result.bytes).toBe(7);
    } finally {
      chmodSync(path, 0o644);
    }
  });
});
