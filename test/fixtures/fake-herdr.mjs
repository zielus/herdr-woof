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
// command and still reports failure. Detached, the spawned process is its own
// session and process group leader (pgid === its own pid, whatever pid a shell
// or `env` exec chain inside it ends up as); that pgid is appended to
// FAKE_HERDR_LOG + ".pgids" so a test can wait out or terminate the whole group
// a pane host's own Herdr calls (report-metadata, notification show) make from
// inside it — those are separate, non-detached processes a single-pid wait
// never sees, and one can outlive an abruptly killed host (F-002).
// An entry may add `worktree: { dir, workspaceId, paneId? }` (composition) for
// `herdr worktree create`: a real `git worktree add -b <branch> <dir>/<branch
// with / as ->` [base] from `--cwd`, answered in herdr 0.9.1's worktree_created
// shape (docs/design/composition.md); a git failure answers
// worktree_create_failed with exit 1. With `worktree: { remove: true }` on
// `herdr worktree remove`, the worktree the matching create made (found by
// --workspace in FAKE_HERDR_LOG + ".worktrees") is removed with
// `git worktree remove --force`.
import { spawn, spawnSync } from "node:child_process";
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
  if (logPath !== undefined) {
    try {
      appendFileSync(`${logPath}.pgids`, `${child.pid}\n`);
    } catch {
      // Best effort: a missing marker only weakens a test's teardown, never the scenario.
    }
  }
  child.unref();
}

const flag = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
const worktrees = `${logPath ?? "/dev/null"}.worktrees`;
if (entry?.worktree !== undefined && argv[0] === "worktree" && argv[1] === "create") {
  const branch = flag("--branch");
  const base = flag("--base");
  const path = `${entry.worktree.dir}/${branch.replaceAll("/", "-")}`;
  const git = spawnSync(
    "git",
    ["-C", flag("--cwd"), "worktree", "add", "-q", "-b", branch, path, ...(base ? [base] : [])],
    { encoding: "utf8" },
  );
  if (git.status !== 0) {
    entry.stdout = undefined;
    entry.stderr = `${JSON.stringify({ error: { code: "worktree_create_failed", message: git.stderr.trim() }, id: "cli:worktree:create" })}\n`;
    entry.exit = 1;
  } else {
    const workspaceId = entry.worktree.workspaceId;
    const paneId = entry.worktree.paneId ?? `${workspaceId}:p1`;
    const tabId = `${workspaceId}:t1`;
    if (logPath !== undefined)
      appendFileSync(worktrees, `${JSON.stringify({ workspaceId, path })}\n`);
    entry.stdout = `${JSON.stringify({
      id: "cli:worktree:create",
      result: {
        type: "worktree_created",
        root_pane: { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId, cwd: path },
        tab: { tab_id: tabId, workspace_id: workspaceId },
        workspace: { workspace_id: workspaceId, label: flag("--label") },
        worktree: { branch, path, open_workspace_id: workspaceId },
      },
    })}\n`;
  }
}
if (entry?.worktree?.remove === true && argv[0] === "worktree" && argv[1] === "remove") {
  const workspaceId = flag("--workspace");
  const made = existsSync(worktrees)
    ? readFileSync(worktrees, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
        .findLast((item) => item.workspaceId === workspaceId)
    : undefined;
  if (made !== undefined)
    spawnSync("git", ["-C", made.path, "worktree", "remove", "--force", made.path]);
  entry.stdout = `${JSON.stringify({ id: "cli:worktree:remove", result: { type: "worktree_removed", path: made?.path ?? null, workspace_id: workspaceId, forced: true } })}\n`;
}

if (entry?.hangMs !== undefined) setTimeout(respond, entry.hangMs);
else respond();
