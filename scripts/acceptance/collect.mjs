#!/usr/bin/env node
/**
 * Acceptance collector (p5 D6). Runs the test suite once, reads the committed
 * live logs, and reports whether every acceptance row is actually backed.
 *
 * It is deliberately **not** part of `bun run verify`: it needs the committed
 * live logs, which only exist once the live gate has run. `verify` stays green
 * at every checkpoint; this is the separate, final gate.
 *
 *   bun run acceptance:collect [--no-tests] [--out <path>]
 *
 * Exit 0 only when every non-`limit` row is backed by tests that ran and passed
 * and by gates that are recorded PASS. Exit 1 names each unbacked row and why.
 * Writes `docs/acceptance/evidence/offline.json`.
 *
 * The report it writes is formatted with the repository's own Prettier, so a tree
 * that holds it still passes `bun run format:check`.
 *
 * `--no-tests` is a gates-only pass for inspecting the live half quickly. It can
 * never report a test-backed row as backed: a row whose evidence includes tests
 * is `backed: false` with `tests not run (--no-tests)`, so the flag cannot turn
 * an unverified row green.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DISPOSITIONS, LIVE_LOGS, MATRIX } from "./matrix.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const runTests = !args.includes("--no-tests");
const outIndex = args.indexOf("--out");
const outPath =
  outIndex === -1
    ? join(repoRoot, "docs", "acceptance", "evidence", "offline.json")
    : resolve(args[outIndex + 1] ?? "");

function run(command, argv) {
  const result = spawnSync(command, argv, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function gitRevision() {
  const result = run("git", ["rev-parse", "HEAD"]);
  return result.status === 0 ? result.stdout.trim() : null;
}

function versionOf(command, argv) {
  const result = run(command, argv);
  return result.status === 0 ? result.stdout.trim().split("\n")[0] : null;
}

/** Every test the suite ran, keyed by JSON [repo-relative file, fullName]. */
function testResults() {
  if (!runTests) return null;
  const build = run("bun", ["run", "build"]);
  if (build.status !== 0) {
    process.stderr.write(`${build.stdout}${build.stderr}`);
    throw new Error(`bun run build exited ${build.status}`);
  }
  const result = run("bun", ["x", "vitest", "run", "--reporter=json"]);
  const start = result.stdout.indexOf("{");
  if (start === -1) {
    process.stderr.write(`${result.stdout}${result.stderr}`);
    throw new Error("vitest --reporter=json printed no JSON");
  }
  const report = JSON.parse(result.stdout.slice(start));
  const statuses = new Map();
  for (const file of report.testResults ?? []) {
    const rel = relative(repoRoot, file.name);
    for (const assertion of file.assertionResults ?? []) {
      statuses.set(JSON.stringify([rel, assertion.fullName]), assertion.status);
    }
  }
  return { statuses, total: report.numTotalTests ?? 0, success: report.success === true };
}

/** `GATE <id> PASS` ids per committed live log that exists. */
function liveGates() {
  const gates = new Map();
  for (const log of LIVE_LOGS) {
    const path = join(repoRoot, "docs", "research", log);
    if (!existsSync(path)) continue;
    const passed = new Set();
    const failed = new Set();
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = /^GATE (\S+) (PASS|FAIL)\b/.exec(line);
      if (match === null) continue;
      (match[2] === "PASS" ? passed : failed).add(match[1]);
    }
    gates.set(log, { passed, failed });
  }
  return gates;
}

const tests = testResults();
const gates = liveGates();
const rows = [];

for (const entry of MATRIX) {
  const problems = [];
  if (!DISPOSITIONS.includes(entry.disposition)) {
    problems.push(`disposition ${JSON.stringify(entry.disposition)} is not in the vocabulary`);
  }
  if (entry.disposition === "limit") {
    if (entry.note.trim() === "") problems.push("a limit row needs a note saying why");
  } else if (entry.tests.length === 0 && entry.gates.length === 0) {
    problems.push("no test and no gate backs this row");
  }
  if (tests === null && entry.tests.length > 0) {
    // --no-tests skips the suite, so a row whose evidence is tests has no
    // evidence in this report. Saying `backed` here would let the flag turn an
    // unverified row green, which is the one thing this collector exists to stop.
    problems.push(`tests not run (--no-tests): ${entry.tests.length} named test(s) unverified`);
  }
  for (const test of tests === null ? [] : entry.tests) {
    const status = tests.statuses.get(JSON.stringify([test.file, test.name]));
    if (status === undefined) problems.push(`${test.file}: no test named ${test.name}`);
    else if (status !== "passed") problems.push(`${test.file}: ${test.name} is ${status}`);
  }
  for (const gate of entry.gates) {
    const [log, id] = gate.split(":");
    const found = gates.get(log);
    if (found === undefined) problems.push(`docs/research/${log} is not committed yet`);
    else if (found.failed.has(id)) problems.push(`${log} records GATE ${id} FAIL`);
    else if (!found.passed.has(id)) problems.push(`${log} has no GATE ${id} PASS`);
  }
  rows.push({
    id: entry.id,
    row: entry.row,
    disposition: entry.disposition,
    tests: entry.tests,
    gates: entry.gates,
    command: entry.command,
    note: entry.note,
    backed: problems.length === 0,
    problems,
  });
}

const report = {
  schemaVersion: 1,
  kind: "woof.acceptance.offline",
  collectedAt: new Date().toISOString(),
  revision: gitRevision(),
  versions: {
    node: process.version,
    bun: versionOf("bun", ["--version"]),
    git: versionOf("git", ["--version"]),
  },
  tests:
    tests === null
      ? null
      : { total: tests.total, success: tests.success, ran: tests.statuses.size },
  rows,
};

mkdirSync(dirname(outPath), { recursive: true });
const write = () => writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
write();
// The report is committed, so it must satisfy `bun run format:check` like every
// other file: `JSON.stringify(_, null, 2)` always expands short arrays, Prettier
// collapses the ones that fit in printWidth. Rather than reimplement that rule,
// the repo's own Prettier formats the file it just wrote — same binary, same
// .prettierrc. A failure is reported, never silently shipped unformatted.
// WOOF_ACCEPTANCE_FORMATTER is a test seam: a whitespace-separated command the
// report path is appended to. Unset (always, outside tests) it is the
// repository's own Prettier.
const formatter = (process.env["WOOF_ACCEPTANCE_FORMATTER"] ?? "bun x prettier --write").split(
  /\s+/,
);
const formatOnce = () => {
  const result = run(formatter[0], [...formatter.slice(1), outPath]);
  return result.status === 0
    ? null
    : `cannot format ${outPath} with ${formatter.join(" ")}: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`;
};
// Two passes, and **both** count. Adding `format` to the report means writing the
// file again, which un-formats it, so it has to be formatted once more; the
// second result used to be discarded, and a formatter that failed only then left
// a report claiming `format.ok: true` on disk (PR #7, collect.mjs:189).
const firstProblem = formatOnce();
// The report says whether its own formatting succeeded, so an unformatted report
// on disk is self-describing rather than silently different from a formatted one.
report.format = { ok: firstProblem === null, problem: firstProblem };
write();
const formatProblem = firstProblem ?? formatOnce();
if (formatProblem !== null) {
  // The file on disk must not claim a success it did not have. This last write
  // leaves it unformatted, which is correct and which it now says: the collector
  // is failing, and `format.problem` is the reason.
  report.format = { ok: false, problem: formatProblem };
  write();
  process.stderr.write(`${formatProblem}\n`);
}

const width = Math.max(...rows.map((row) => row.id.length));
for (const row of rows) {
  const mark = row.backed ? "ok  " : "MISS";
  process.stdout.write(`${mark} ${row.id.padEnd(width)}  ${row.disposition}\n`);
  for (const problem of row.problems) process.stdout.write(`       ${problem}\n`);
}

const unbacked = rows.filter((row) => !row.backed);
process.stdout.write(
  `\n${rows.length - unbacked.length}/${rows.length} rows backed; wrote ${relative(repoRoot, outPath)}\n`,
);
if (tests !== null && !tests.success) {
  process.stdout.write("the test run itself was not green\n");
}
// The formatting result is part of the success condition, not a separate
// exitCode written earlier and then overwritten here: a report this collector
// could not format is not a report it produced successfully.
process.exitCode =
  unbacked.length === 0 && (tests === null || tests.success) && formatProblem === null ? 0 : 1;
