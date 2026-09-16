import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { repoRoot } from "./helpers/process.js";

/**
 * The acceptance evidence document against the matrix (p5 D6, T11).
 *
 * `test/acceptance-matrix.test.ts` (T8) checks `scripts/acceptance/matrix.mjs`
 * against `docs/acceptance/v1.md`, and lands green before any live log or
 * evidence document exists. This file is the other half: it checks
 * `docs/acceptance/v1-evidence.md` against the same matrix, and every gate id
 * the matrix names against the committed `docs/research/*.log` files. It lands
 * with the documents it reads, at the docs gate (T11), not earlier — a version
 * that read an evidence file that does not exist yet would redden `bun run
 * verify` at every checkpoint before T11.
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
let LIVE_LOGS: string[];

const evidencePath = join(repoRoot, "docs", "acceptance", "v1-evidence.md");

beforeAll(async () => {
  ({ MATRIX, LIVE_LOGS } = (await import(
    pathToFileURL(join(repoRoot, "scripts", "acceptance", "matrix.mjs")).href
  )) as { MATRIX: MatrixEntry[]; LIVE_LOGS: string[] });
});

/** The `## ` section of a markdown document with this heading, up to the next `## `. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  expect(start, heading).not.toBe(-1);
  const rest = text.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every `### ` subsection heading directly under a section's text. */
function subsections(text: string): string[] {
  return [...text.matchAll(/^### (.+)$/gm)].map((match) => (match[1] ?? "").trim());
}

/** A markdown table's body rows (skipping the header and separator), each split into cells. */
function tableRows(text: string): string[][] {
  const lines = text.split("\n").filter((line) => line.trim().startsWith("|"));
  return lines
    .slice(2) // header row, then the `---` separator row
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

/** The first clause of a bullet/requirement sentence, matching `test/acceptance-matrix.test.ts`. */
function firstClause(text: string): string {
  const end = text.search(/[.;]/);
  return (end === -1 ? text : text.slice(0, end)).trim();
}

describe("the acceptance evidence document", () => {
  it("exists and maps 1:1 onto the acceptance matrix, in document order", () => {
    expect(existsSync(evidencePath)).toBe(true);
    const text = readFileSync(evidencePath, "utf8");
    const flowRows = tableRows(section(text, "Required end-to-end flow")).map((cells) =>
      firstClause(cells[0] ?? ""),
    );
    const matrixRows = tableRows(section(text, "Verification matrix")).map((cells) => cells[0]);
    expect([...flowRows, ...matrixRows]).toEqual(MATRIX.map((entry) => entry.row));
  });

  it("gives every row a non-empty evidence cell", () => {
    const text = readFileSync(evidencePath, "utf8");
    for (const heading of ["Required end-to-end flow", "Verification matrix"]) {
      const rows = tableRows(section(text, heading));
      const evidenceIndex = heading === "Required end-to-end flow" ? 1 : 2;
      for (const cells of rows) {
        expect(cells[evidenceIndex]?.trim(), `${heading}: ${cells[0]}`).not.toBe("");
      }
    }
  });

  it("names only tests that actually exist in test/, and only known live logs", () => {
    for (const entry of MATRIX) {
      for (const test of entry.tests) {
        expect(existsSync(join(repoRoot, test.file)), `${entry.id}: ${test.file}`).toBe(true);
      }
      for (const gate of entry.gates) {
        const [log] = gate.split(":");
        expect(LIVE_LOGS, `${entry.id}: ${gate}`).toContain(log);
      }
    }
  });

  it("backs every named gate id with a committed `GATE <id> PASS` line", () => {
    const problems: string[] = [];
    const logText = new Map<string, string>();
    for (const entry of MATRIX) {
      for (const gate of entry.gates) {
        const [log, id] = gate.split(":");
        if (log === undefined || id === undefined) continue;
        if (!logText.has(log)) {
          const path = join(repoRoot, "docs", "research", log);
          if (!existsSync(path)) {
            problems.push(`${entry.id}: docs/research/${log} is not committed`);
            logText.set(log, "");
            continue;
          }
          logText.set(log, readFileSync(path, "utf8"));
        }
        const text = logText.get(log) ?? "";
        const passed = new RegExp(`^GATE ${id} PASS\\b`, "m").test(text);
        const failed = new RegExp(`^GATE ${id} FAIL\\b`, "m").test(text);
        if (failed) problems.push(`${entry.id}: ${log} records GATE ${id} FAIL`);
        else if (!passed) problems.push(`${entry.id}: ${log} has no GATE ${id} PASS`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("carries a `## Documented limits` subsection for every `limit`-disposition row", () => {
    const text = readFileSync(evidencePath, "utf8");
    const limitsText = section(text, "Documented limits");
    const headings = subsections(limitsText).join("\n");
    for (const entry of MATRIX.filter((candidate) => candidate.disposition === "limit")) {
      expect(headings, entry.id).toContain(entry.row);
    }
  });

  it("names every limit plan §6 requires, plus the resolved checklist-injection observation", () => {
    const text = readFileSync(evidencePath, "utf8");
    const headings = subsections(section(text, "Documented limits"));
    const required = [
      "Crash resume and re-hosting a lost run",
      "C1",
      "A second agent kind",
      "Parallel scheduling",
      "MCP",
      "Per-stage structural artifact schemas",
      "LV-002",
      "PR-fix-4 untested paths",
      "Role instruction/context files",
      "checklist-injection",
    ];
    for (const name of required) {
      expect(
        headings.some((heading) => heading.includes(name)),
        `no "## Documented limits" subsection mentions ${JSON.stringify(name)}`,
      ).toBe(true);
    }
  });
});
