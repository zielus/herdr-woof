import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { repoRoot } from "./helpers/process.js";

/**
 * The acceptance matrix against `docs/acceptance/v1.md` (p5 D6, T8).
 *
 * This checks that references resolve — every v1.md row has exactly one matrix
 * entry, every disposition is in the vocabulary, and every test an entry names
 * exists in `test/`. It asserts no prose: renaming a row in v1.md is a matrix
 * edit, and a row quietly dropped from either side fails here.
 *
 * The other half — that every named gate is recorded PASS in a committed live
 * log, and that `docs/acceptance/v1-evidence.md` covers every row — lands with
 * the documents it reads (`test/acceptance-evidence.test.ts`, T11). Splitting
 * them keeps `bun run verify` green at every checkpoint of this phase without
 * making either check tolerant.
 */

interface MatrixEntry {
  id: string;
  row: string;
  disposition: string;
  tests: Array<{ file: string; name: string }>;
  gates: string[];
  command: string;
  note: string;
}

let MATRIX: MatrixEntry[];
let DISPOSITIONS: string[];
let LIVE_LOGS: string[];

const v1Path = join(repoRoot, "docs", "acceptance", "v1.md");

beforeAll(async () => {
  ({ MATRIX, DISPOSITIONS, LIVE_LOGS } = (await import(
    pathToFileURL(join(repoRoot, "scripts", "acceptance", "matrix.mjs")).href
  )) as { MATRIX: MatrixEntry[]; DISPOSITIONS: string[]; LIVE_LOGS: string[] });
});

/** The `## ` section of v1.md with this heading, up to the next `## `. */
function section(heading: string): string {
  const text = readFileSync(v1Path, "utf8");
  const start = text.indexOf(`\n## ${heading}\n`);
  expect(start, heading).not.toBe(-1);
  const rest = text.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The rows of v1.md, in document order: each "Required end-to-end flow" bullet
 * by its first clause (to the first `.` or `;`), then each verification-matrix
 * row by its Area cell.
 */
function v1Rows(): string[] {
  const bullets = section("Required end-to-end flow")
    .split("\n- ")
    .slice(1)
    .map((bullet) => bullet.split("\n\n")[0] ?? "")
    .map((bullet) => bullet.replaceAll(/\s+/g, " ").trim())
    .map((bullet) => {
      const end = bullet.search(/[.;]/);
      return end === -1 ? bullet : bullet.slice(0, end);
    })
    .filter((bullet) => bullet !== "");
  const areas = section("Verification matrix")
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => (line.split("|")[1] ?? "").trim())
    .filter((area) => area !== "" && area !== "Area" && !/^-+$/.test(area));
  return [...bullets, ...areas];
}

describe("the acceptance matrix", () => {
  it("maps 1:1 onto docs/acceptance/v1.md, in document order", () => {
    const rows = v1Rows();
    // Five flow bullets and nineteen matrix rows; a change to either side is a
    // matrix edit, not a silently unbacked row.
    expect(rows).toHaveLength(24);
    expect(MATRIX.map((entry) => entry.row)).toEqual(rows);
    expect(new Set(MATRIX.map((entry) => entry.id)).size).toBe(MATRIX.length);
    for (const entry of MATRIX) {
      expect(entry.id, entry.row).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("gives every row a disposition from the vocabulary and something that backs it", () => {
    expect(DISPOSITIONS).toEqual(["unit", "process", "cli", "live", "limit"]);
    for (const entry of MATRIX) {
      expect(DISPOSITIONS, entry.id).toContain(entry.disposition);
      expect(typeof entry.command, entry.id).toBe("string");
      if (entry.disposition === "limit") {
        // A documented gap needs a written reason, never silence.
        expect(entry.note.trim(), entry.id).not.toBe("");
      } else {
        expect(entry.tests.length + entry.gates.length, entry.id).toBeGreaterThan(0);
        expect(entry.command, entry.id).not.toBe("");
      }
    }
  });

  it("names only tests that exist, by the full name vitest's JSON reporter emits", () => {
    // The reporter's `fullName` is the describe titles and the it title joined
    // by single spaces (checked against vitest 4.1.11's --reporter=json). A
    // describe rename therefore unbacks every row naming a test inside it, and
    // this assertion is what makes that loud instead of silent.
    const missing: string[] = [];
    const sources = new Map<string, string>();
    for (const entry of MATRIX) {
      for (const test of entry.tests) {
        if (!sources.has(test.file)) {
          sources.set(test.file, readFileSync(join(repoRoot, test.file), "utf8"));
        }
        const source = sources.get(test.file) as string;
        // The full name is built from title literals in the file. Table-driven
        // cases name themselves from a data literal rather than inline in it(),
        // so every string literal in the file counts.
        const literals = stringLiteralsOf(source).filter((literal) => literal !== "");
        if (!literals.some((literal) => test.name.endsWith(literal))) {
          missing.push(
            `${entry.id}: ${test.file} has no title ending ${JSON.stringify(test.name)}`,
          );
        }
        if (!literals.some((literal) => test.name.startsWith(literal))) {
          missing.push(
            `${entry.id}: ${test.file} has no describe title starting ${JSON.stringify(test.name)}`,
          );
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("names only live logs the collector knows, with a gate id", () => {
    for (const entry of MATRIX) {
      for (const gate of entry.gates) {
        const [log, id, ...extra] = gate.split(":");
        expect(LIVE_LOGS, `${entry.id}: ${gate}`).toContain(log);
        expect(id, `${entry.id}: ${gate}`).toMatch(/^[A-Za-z0-9]+$/);
        expect(extra, `${entry.id}: ${gate}`).toEqual([]);
      }
      if (entry.disposition === "live") {
        expect(entry.gates.length, `${entry.id} is a live row`).toBeGreaterThan(0);
      }
    }
  });

  it("the acceptance matrix names no MCP adapter anywhere in src/", () => {
    // The Optional-adapters row cites this case: MCP is a documented non-goal,
    // and the shipped engine must not have grown one quietly.
    const found: string[] = [];
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
    for (const path of walk(join(repoRoot, "src"))) {
      if (/\bmcp\b/i.test(readFileSync(path, "utf8"))) found.push(path);
    }
    expect(found).toEqual([]);
  });
});

/** Every plain string literal in a test source, with its escapes resolved. */
function stringLiteralsOf(source: string): string[] {
  return [...source.matchAll(/(["'])((?:\\.|(?!\1)[^\n])*)\1/g)].map((match) =>
    (match[2] ?? "").replaceAll('\\"', '"').replaceAll("\\'", "'").replaceAll("\\\\", "\\"),
  );
}
