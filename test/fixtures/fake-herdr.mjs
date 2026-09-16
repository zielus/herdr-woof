#!/usr/bin/env node
// Fake `herdr` executable for adapter process tests. Never talks to a server.
//
// FAKE_HERDR_SCENARIO: path to a JSON list of entries
//   { match: [argv prefix], call?: n, stdout?: string, stderr?: string, exit?: number, hangMs?: number }
// The first entry whose `match` prefixes argv (and, with `call`, only on the
// n-th invocation with that prefix) decides the output. FAKE_HERDR_LOG: every
// invocation's argv is appended as one JSON line before the entry runs.
// An entry may add `spawn: { commandIndex, env?, log? }` (p4): argv from
// commandIndex on is joined with spaces and run with `sh -c`, detached, with the
// extra env and stdio appended to `log` (default FAKE_HERDR_LOG + ".spawn"). It
// stands in for `herdr pane run` typing a command into a fresh pane. The spawn
// happens before `hangMs` delays the reply, so an entry with both starts the
// command and still reports failure.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, openSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const logPath = process.env.FAKE_HERDR_LOG;
const previous =
  logPath !== undefined && existsSync(logPath)
    ? readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
    : [];
if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify(argv)}\n`);

const startsWith = (args, prefix) => prefix.every((part, index) => args[index] === part);
const scenario = JSON.parse(readFileSync(process.env.FAKE_HERDR_SCENARIO ?? "", "utf8"));
const entry = scenario.find((candidate) => {
  if (!startsWith(argv, candidate.match)) return false;
  if (candidate.call === undefined) return true;
  const count = previous.filter((args) => startsWith(args, candidate.match)).length + 1;
  return count === candidate.call;
});

const respond = () => {
  if (entry === undefined) {
    process.stderr.write(
      `${JSON.stringify({ error: { code: "fake_unscripted", message: argv.join(" ") }, id: "fake" })}\n`,
    );
    process.exit(1);
  }
  if (entry.stdout !== undefined) process.stdout.write(entry.stdout);
  if (entry.stderr !== undefined) process.stderr.write(entry.stderr);
  process.exitCode = entry.exit ?? 0;
};

// The spawn stands in for the pane typing the command, which happens as the pane
// runs it — before this process reports anything. `hangMs` therefore delays only
// the reply, so an entry with both spawns first and fails afterwards: a real pane
// whose command started and whose `pane run` still reported failure.
if (entry?.spawn !== undefined) {
  const out = openSync(entry.spawn.log ?? `${logPath ?? "/dev/null"}.spawn`, "a");
  const child = spawn("sh", ["-c", argv.slice(entry.spawn.commandIndex).join(" ")], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, ...entry.spawn.env },
  });
  child.unref();
}

if (entry?.hangMs !== undefined) setTimeout(respond, entry.hangMs);
else respond();
