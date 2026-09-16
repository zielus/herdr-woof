import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
 *
 * DOC-001 (review-3): the earlier version of this file checked the matrix's own
 * `tests`/`gates` arrays, never the prose Evidence cells of `v1-evidence.md`
 * itself — a fabricated test path or gate id typed into the document's own
 * table would have left every check here green. This version parses those
 * cells directly: every backticked `test/….ts` path must exist, every quoted
 * test title must be a real vitest `fullName` in that file (the same
 * composer/keying approach as `test/acceptance-matrix.test.ts`, duplicated
 * here rather than imported so this file's self-test stays independent), and
 * every `<log>:<id>` citation must be a `GATE <id> PASS` line in the named
 * committed `docs/research/` log.
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

/** `WOOF_EVIDENCE_PATH` lets the self-test below point this file at a mutated copy. */
function evidencePath(): string {
  return (
    process.env["WOOF_EVIDENCE_PATH"] ?? join(repoRoot, "docs", "acceptance", "v1-evidence.md")
  );
}

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

// --- Duplicated from test/acceptance-matrix.test.ts (DOC-001): the exact same
// fullName composer, kept local so this file's own self-test (which spawns
// vitest on a mutated document) never depends on that other file changing.

const unescape = (text: string): string =>
  text.replaceAll('\\"', '"').replaceAll("\\'", "'").replaceAll("\\\\", "\\");

/**
 * The source with every comment and string body blanked to spaces, so brace
 * depth can be counted without a parser and every offset still lines up with the
 * original. Only `{`/`}` outside strings and comments survive.
 */
function blanked(source: string): string {
  const out = [...source];
  const blank = (from: number, to: number) => {
    for (let at = from; at < to && at < out.length; at += 1) {
      if (out[at] !== "\n") out[at] = " ";
    }
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
    } else if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
    } else if (char === '"' || char === "'" || char === "`") {
      let at = index + 1;
      while (at < source.length && source[at] !== char) at += source[at] === "\\" ? 2 : 1;
      blank(index + 1, at);
      index = at + 1;
    } else if (char === "/" && startsRegex(source, index)) {
      // A regex literal can hold quotes and braces (`/["'`](a|b)/`); without
      // skipping it, one stray backtick swallows the rest of the file.
      let at = index + 1;
      let inClass = false;
      while (at < source.length) {
        const here = source[at];
        if (here === "\\") {
          at += 2;
          continue;
        }
        if (here === "/" && !inClass) break;
        if (here === "\n") break;
        if (here === "[") inClass = true;
        else if (here === "]") inClass = false;
        at += 1;
      }
      blank(index + 1, at);
      index = at + 1;
    } else {
      index += 1;
    }
  }
  return out.join("");
}

/**
 * Whether the `/` at `index` opens a regex literal rather than a division: true
 * when the previous non-whitespace character can only precede an expression.
 */
function startsRegex(source: string, index: number): boolean {
  let at = index - 1;
  while (at >= 0 && /\s/.test(source[at] as string)) at -= 1;
  return at < 0 || "(,=:[!&|?{};+-*%~^".includes(source[at] as string);
}

/**
 * Every `fullName` vitest would emit for a test source: the enclosing describe
 * titles and the it title joined by single spaces. A table-driven `it(x.name, …)`
 * has no literal title, so its enclosing prefix is paired with every `name:`
 * string literal in the file — which is how `test/precedence.cli.test.ts` and
 * `test/journal-integrity.process.test.ts` name their cases.
 */
function fullNamesOf(source: string): Set<string> {
  const braces = blanked(source);
  const depthAt = (index: number): number => {
    let depth = 0;
    for (let at = 0; at < index; at += 1) {
      if (braces[at] === "{") depth += 1;
      else if (braces[at] === "}") depth -= 1;
    }
    return depth;
  };
  const events: Array<{
    kind: "describe" | "it";
    title: string | null;
    /** A template title's literal parts around its one interpolation. */
    template: [string, string] | null;
    index: number;
  }> = [];
  for (const match of source.matchAll(
    /\b(describe|it)(?:\.\w+)?\(\s*(?:(["'])((?:\\.|(?!\2).)*)\2|`([^`]*)`|([A-Za-z_$][\w$.]*))/g,
  )) {
    const backticked = match[4];
    // `it(`fails closed on ${case.name}`)`: the literal halves are fixed, the
    // slot is filled from the file's case titles below.
    const slot = backticked === undefined ? null : /^([^$]*)\$\{[^}]*\}([^$]*)$/.exec(backticked);
    events.push({
      kind: match[1] === "describe" ? "describe" : "it",
      title:
        match[3] !== undefined
          ? unescape(match[3])
          : backticked !== undefined && !backticked.includes("${")
            ? backticked
            : null,
      template: slot === null ? null : [slot[1] ?? "", slot[2] ?? ""],
      index: match.index,
    });
  }
  const caseTitles = [...source.matchAll(/\bname:\s*(["'])((?:\\.|(?!\1).)*)\1/g)].map((match) =>
    unescape(match[2] ?? ""),
  );

  const names = new Set<string>();
  const stack: Array<{ title: string; depth: number }> = [];
  for (const event of events) {
    const depth = depthAt(event.index);
    while (stack.length > 0 && (stack.at(-1) as { depth: number }).depth >= depth) stack.pop();
    const prefix = stack.map((item) => item.title);
    if (event.kind === "describe") {
      if (event.title !== null) stack.push({ title: event.title, depth });
      continue;
    }
    if (event.title !== null) {
      names.add([...prefix, event.title].join(" "));
      continue;
    }
    // A title the call takes from data: every case title in the file is a
    // candidate, either whole or inside the template's literal halves.
    for (const title of caseTitles) {
      const composed =
        event.template === null ? title : `${event.template[0]}${title}${event.template[1]}`;
      names.add([...prefix, composed].join(" "));
    }
  }
  return names;
}

/**
 * Whether a quoted, "…"-abbreviated citation from the evidence document
 * matches a real vitest `fullName`: split the quote on any run of "…" and
 * require each remaining part to appear in the name, in order, allowing text
 * (the elided clause) between them. An empty part from a leading/trailing "…"
 * matches trivially, so this also covers a bare tail with no ellipsis at all.
 */
function quoteMatchesName(quote: string, name: string): boolean {
  const parts = quote
    .split(/…+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  let cursor = 0;
  for (const part of parts) {
    const index = name.indexOf(part, cursor);
    if (index === -1) return false;
    cursor = index + part.length;
  }
  return true;
}

interface EvidenceCitation {
  row: string;
  file: string;
  quote: string;
}

interface GateCitation {
  row: string;
  log: string;
  id: string;
}

/**
 * Every backticked `test/….ts` path plus the quoted test title(s) that follow
 * it in the same Evidence cell (a cell may cite several titles from the same
 * file before naming another file, e.g. the "Required output" row), and every
 * backticked `<log basename>.log:<gate id>` citation, from both tables'
 * Evidence columns.
 */
function evidenceCitationsOf(text: string): {
  citations: EvidenceCitation[];
  gates: GateCitation[];
} {
  const citations: EvidenceCitation[] = [];
  const gates: GateCitation[] = [];
  for (const heading of ["Required end-to-end flow", "Verification matrix"]) {
    const rows = tableRows(section(text, heading));
    const evidenceIndex = heading === "Required end-to-end flow" ? 1 : 2;
    for (const cells of rows) {
      const rowLabel =
        heading === "Required end-to-end flow" ? firstClause(cells[0] ?? "") : (cells[0] ?? "");
      const evidence = cells[evidenceIndex] ?? "";
      let currentFile: string | null = null;
      for (const match of evidence.matchAll(/`(test\/[^`]+\.ts)`|"([^"]+)"/g)) {
        if (match[1] !== undefined) currentFile = match[1];
        else if (match[2] !== undefined && currentFile !== null) {
          citations.push({ row: rowLabel, file: currentFile, quote: match[2] });
        }
      }
      for (const match of evidence.matchAll(/`([A-Za-z0-9._-]+\.log):([A-Za-z0-9]+)`/g)) {
        gates.push({ row: rowLabel, log: match[1] as string, id: match[2] as string });
      }
    }
  }
  return { citations, gates };
}

describe("the acceptance evidence document", () => {
  it("exists and maps 1:1 onto the acceptance matrix, in document order", () => {
    expect(existsSync(evidencePath())).toBe(true);
    const text = readFileSync(evidencePath(), "utf8");
    const flowRows = tableRows(section(text, "Required end-to-end flow")).map((cells) =>
      firstClause(cells[0] ?? ""),
    );
    const matrixRows = tableRows(section(text, "Verification matrix")).map((cells) => cells[0]);
    expect([...flowRows, ...matrixRows]).toEqual(MATRIX.map((entry) => entry.row));
  });

  it("gives every row a non-empty evidence cell", () => {
    const text = readFileSync(evidencePath(), "utf8");
    for (const heading of ["Required end-to-end flow", "Verification matrix"]) {
      const rows = tableRows(section(text, heading));
      const evidenceIndex = heading === "Required end-to-end flow" ? 1 : 2;
      for (const cells of rows) {
        expect(cells[evidenceIndex]?.trim(), `${heading}: ${cells[0]}`).not.toBe("");
      }
    }
  });

  it("names only tests that actually exist in test/, and only known live logs (matrix rows)", () => {
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

  it("backs every matrix-named gate id with a committed `GATE <id> PASS` line", () => {
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

  // DOC-001: the check above only ever reads scripts/acceptance/matrix.mjs's own
  // arrays. This one reads the document's prose Evidence cells directly, so a
  // fabricated path or gate id typed straight into v1-evidence.md is caught even
  // though the matrix itself was never touched.
  it("parses the Evidence cells: every test path exists, every quoted title is real, every log gate citation is a committed PASS", () => {
    const text = readFileSync(evidencePath(), "utf8");
    const { citations, gates } = evidenceCitationsOf(text);
    // A regression that stops matching anything would make every loop below a
    // silent no-op; require real cardinality first.
    expect(citations.length).toBeGreaterThan(10);
    expect(gates.length).toBeGreaterThan(10);

    const problems: string[] = [];
    const namesByFile = new Map<string, Set<string>>();
    for (const citation of citations) {
      const fullPath = join(repoRoot, citation.file);
      if (!existsSync(fullPath)) {
        problems.push(`${citation.row}: ${citation.file} does not exist`);
        continue;
      }
      if (!namesByFile.has(citation.file)) {
        namesByFile.set(citation.file, fullNamesOf(readFileSync(fullPath, "utf8")));
      }
      const names = namesByFile.get(citation.file) as Set<string>;
      // The document abbreviates long fullNames with "…" — at the start, the
      // end, or in the middle in place of a dropped clause (e.g. the Runtime
      // loss row). Splitting on "…" and requiring each remaining part to match
      // in order, not necessarily contiguously, covers every shape the doc
      // actually uses, including the bare tail with no ellipsis at all (the
      // describe prefix simply dropped).
      const found = [...names].some((name) => quoteMatchesName(citation.quote, name));
      if (!found) {
        problems.push(
          `${citation.row}: ${citation.file} has no test matching ${JSON.stringify(citation.quote)}`,
        );
      }
    }

    const logText = new Map<string, string>();
    for (const gate of gates) {
      if (!LIVE_LOGS.includes(gate.log)) {
        problems.push(`${gate.row}: ${gate.log} is not a known live log`);
        continue;
      }
      if (!logText.has(gate.log)) {
        const path = join(repoRoot, "docs", "research", gate.log);
        logText.set(gate.log, existsSync(path) ? readFileSync(path, "utf8") : "");
      }
      const logBody = logText.get(gate.log) ?? "";
      const passed = new RegExp(`^GATE ${gate.id} PASS\\b`, "m").test(logBody);
      const failed = new RegExp(`^GATE ${gate.id} FAIL\\b`, "m").test(logBody);
      if (failed) problems.push(`${gate.row}: ${gate.log} records GATE ${gate.id} FAIL`);
      else if (!passed) problems.push(`${gate.row}: ${gate.log} has no GATE ${gate.id} PASS`);
    }

    expect(problems).toEqual([]);
  });

  // DOC-001's own falsification: prove the check above actually fails closed,
  // not just that it passes on a document nobody has broken yet.
  it("self-test: catches a fabricated test path and a fabricated gate id via WOOF_EVIDENCE_PATH", () => {
    const real = readFileSync(join(repoRoot, "docs", "acceptance", "v1-evidence.md"), "utf8");
    const dir = mkdtempSync(join(tmpdir(), "woof-evidence-"));
    const testNamePattern =
      "parses the Evidence cells: every test path exists, every quoted title is real, every log gate citation is a committed PASS";

    const runAgainst = (mutated: string) => {
      const path = join(dir, "v1-evidence.md");
      writeFileSync(path, mutated);
      return spawnSync(
        "bun",
        ["x", "vitest", "run", "test/acceptance-evidence.test.ts", "-t", testNamePattern],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...process.env, WOOF_EVIDENCE_PATH: path },
          timeout: 60_000,
        },
      );
    };

    try {
      const fakePath = real.replace(
        "`test/scheduler.process.test.ts`",
        "`test/does-not-exist.process.test.ts`",
      );
      expect(fakePath).not.toBe(real);
      const fakePathResult = runAgainst(fakePath);
      expect(fakePathResult.status, fakePathResult.stdout + fakePathResult.stderr).not.toBe(0);
      expect(fakePathResult.stdout + fakePathResult.stderr).toContain(
        "test/does-not-exist.process.test.ts does not exist",
      );

      const fakeGate = real.replace("`build-review-live.log:4`", "`build-review-live.log:99`");
      expect(fakeGate).not.toBe(real);
      const fakeGateResult = runAgainst(fakeGate);
      expect(fakeGateResult.status, fakeGateResult.stdout + fakeGateResult.stderr).not.toBe(0);
      expect(fakeGateResult.stdout + fakeGateResult.stderr).toContain(
        "build-review-live.log has no GATE 99 PASS",
      );

      // Control: the unmodified document, through the same child-process path,
      // still passes — the two failures above are about the mutations, not
      // about spawning vitest inside vitest.
      const controlResult = runAgainst(real);
      expect(controlResult.status, controlResult.stdout + controlResult.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("carries a `## Documented limits` subsection for every `limit`-disposition row", () => {
    const text = readFileSync(evidencePath(), "utf8");
    const limitsText = section(text, "Documented limits");
    const headings = subsections(limitsText).join("\n");
    for (const entry of MATRIX.filter((candidate) => candidate.disposition === "limit")) {
      expect(headings, entry.id).toContain(entry.row);
    }
  });

  it("names every limit plan §6 requires, plus the resolved checklist-injection observation", () => {
    const text = readFileSync(evidencePath(), "utf8");
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
