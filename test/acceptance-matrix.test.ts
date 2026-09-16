import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("names only tests that exist, by the exact full name vitest's JSON reporter emits", () => {
    // Keyed the way `collect.mjs` keys: the exact `fullName` vitest 4.1.11's
    // --reporter=json emits, which is the enclosing describe titles and the it
    // title joined by single spaces. Independent prefix/suffix literals were not
    // enough — one literal in the file satisfied both sides at once, so a row
    // could name a string that is no test and still pass verify (PB-002).
    const missing: string[] = [];
    const names = new Map<string, Set<string>>();
    for (const entry of MATRIX) {
      for (const test of entry.tests) {
        if (!names.has(test.file)) {
          names.set(test.file, fullNamesOf(readFileSync(join(repoRoot, test.file), "utf8")));
        }
        if (!(names.get(test.file) as Set<string>).has(test.name)) {
          missing.push(`${entry.id}: ${test.file} has no test named ${JSON.stringify(test.name)}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("composes full names the way vitest does, and rejects a name that is merely a literal", () => {
    // The composer against the shapes it has to handle: inline titles inside a
    // describe, and table-driven cases whose title is a data literal.
    const inline = fullNamesOf(
      readFileSync(join(repoRoot, "test", "artifact-verdict.process.test.ts"), "utf8"),
    );
    expect([...inline]).toContain(
      "check 17b: an artifact verdict marker that disagrees with the envelope accepts the same artifact once the two agree",
    );
    // A bare string literal in that file is not a test name.
    expect([...inline]).not.toContain("Woof-Verdict:");

    const tableDriven = fullNamesOf(
      readFileSync(join(repoRoot, "test", "precedence.cli.test.ts"), "utf8"),
    );
    expect([...tableDriven]).toContain(
      "submitResult check precedence a verdict marker mismatch is the last check before publication",
    );
    expect([...tableDriven]).not.toContain("artifact_hash_mismatch");
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

  it("writes an offline report the repository's own Prettier accepts (LV-103)", () => {
    // The report is committed, so an unformatted one breaks `bun run format:check`
    // for anyone whose tree holds it. `--no-tests` runs neither the build nor the
    // suite, so this is a fast real process, not vitest inside vitest.
    const out = join(mkdtempSync(join(tmpdir(), "woof-acceptance-")), "evidence", "offline.json");
    const collected = spawnSync(
      "node",
      [join(repoRoot, "scripts", "acceptance", "collect.mjs"), "--no-tests", "--out", out],
      { cwd: repoRoot, encoding: "utf8", timeout: 120_000 },
    );
    expect(collected.stderr, collected.stdout).not.toContain("cannot format");
    expect(existsSync(out), collected.stdout + collected.stderr).toBe(true);

    const checked = spawnSync("bun", ["x", "prettier", "--check", out], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);

    // It is still the report, not just well-formatted bytes.
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      kind: string;
      tests: unknown;
      format: { ok: boolean; problem: string | null };
      rows: Array<{ id: string; backed: boolean; problems: string[] }>;
    };
    expect(report.kind).toBe("woof.acceptance.offline");
    // The report records that its own formatting succeeded, so an unformatted
    // report on disk is self-describing rather than silently different.
    expect(report.format).toEqual({ ok: true, problem: null });
    expect(report.tests).toBeNull();
    expect(report.rows).toHaveLength(MATRIX.length);
    // PB-001: a gates-only pass never reports a test-backed row as backed.
    const backedWithTests = report.rows.filter(
      (row, index) => row.backed && (MATRIX[index]?.tests.length ?? 0) > 0,
    );
    expect(backedWithTests).toEqual([]);
  }, 180_000);

  it("fails when it cannot format its own report, instead of overwriting that status (PR #7 collect.mjs)", () => {
    // A failed formatter used to set exitCode 1 and then have the final
    // unconditional assignment overwrite it, so the collector could exit 0 having
    // failed to produce the formatted evidence report it documents.
    // WOOF_ACCEPTANCE_FORMATTER is the collector's test seam; the default is the
    // repository's own Prettier and every other run here leaves it unset.
    const out = join(mkdtempSync(join(tmpdir(), "woof-acceptance-")), "evidence", "offline.json");
    const collected = spawnSync(
      "node",
      [join(repoRoot, "scripts", "acceptance", "collect.mjs"), "--no-tests", "--out", out],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, WOOF_ACCEPTANCE_FORMATTER: "node --eval process.exit(3)" },
      },
    );
    expect(collected.status, collected.stdout + collected.stderr).not.toBe(0);
    expect(collected.stderr).toContain("cannot format");
    expect(collected.stderr).toContain("exit 3");

    // The report on disk says so too, and names the command that failed.
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      format: { ok: boolean; problem: string | null };
    };
    expect(report.format.ok).toBe(false);
    expect(report.format.problem).toContain("cannot format");

    // The success condition includes it: with everything else identical, a
    // formatter that works reports ok.
    const okOut = join(mkdtempSync(join(tmpdir(), "woof-acceptance-")), "evidence", "offline.json");
    const ok = spawnSync(
      "node",
      [join(repoRoot, "scripts", "acceptance", "collect.mjs"), "--no-tests", "--out", okOut],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, WOOF_ACCEPTANCE_FORMATTER: "node --eval process.exit(0)" },
      },
    );
    expect(ok.stderr, ok.stdout + ok.stderr).not.toContain("cannot format");
    expect((JSON.parse(readFileSync(okOut, "utf8")) as { format: { ok: boolean } }).format.ok).toBe(
      true,
    );
  }, 180_000);

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
