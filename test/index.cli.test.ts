import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { distUrl, runNode, testPlan, woof, woofAsync } from "./helpers/process.js";

// The run locator index and the cross-run event stream, as real processes. Every test gets its own
// HOME (so its own ~/.woof/runs) and its own WOOF_INDEX_DIR: nothing here touches the operator's.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Json = Record<string, any>; // oxlint-disable-line no-explicit-any

interface Sandbox {
  root: string;
  home: string;
  runsDir: string;
  indexDir: string;
  /** A directory outside the runs directory, for runs started with their own --run-dir. */
  outside: string;
  env: Record<string, string>;
}

function sandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "woof-index-")));
  dirs.push(root);
  const home = join(root, "home");
  const indexDir = join(root, "index");
  const outside = join(root, "outside");
  mkdirSync(home);
  mkdirSync(outside);
  return {
    root,
    home,
    runsDir: join(home, ".woof", "runs"),
    indexDir,
    outside,
    env: { HOME: home, WOOF_INDEX_DIR: indexDir },
  };
}

function lines(stdout: string): Json[] {
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Json);
}

/** Opens a planned run through the compiled store, in a child process with the sandbox's index. */
function openRun(s: Sandbox, runDir: string, runId: string, env = s.env): void {
  const result = runNode(
    `const { openRun } = await import(${JSON.stringify(distUrl("state/store.js"))});
const out = await openRun({ runDir: process.argv[1], runId: process.argv[2], plan: JSON.parse(process.argv[3]) });
console.log(JSON.stringify(out));`,
    [runDir, runId, JSON.stringify(testPlan())],
    { env },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.json).toMatchObject({ outcome: "recorded" });
}

function attemptOpenArgs(runDir: string, runId: string, attempt = 1): string[] {
  return [
    "attempt",
    "open",
    "--run-dir",
    runDir,
    "--run",
    runId,
    "--agent",
    "worker",
    "--stage",
    "report",
    "--visit",
    "1",
    "--attempt",
    String(attempt),
    "--verdicts",
    "pass,fail",
  ];
}

function runIds(json: Json | undefined): string[] {
  return ((json?.["runs"] ?? []) as Json[]).map((run) => run["runId"] as string);
}

describe("run locator index", () => {
  it("lists a run opened in its own --run-dir with no flags, from a locator that holds no state", () => {
    const s = sandbox();
    const runDir = join(s.outside, "elsewhere");
    openRun(s, runDir, "outlier-1");

    const locator = JSON.parse(
      readFileSync(join(s.indexDir, "runs", "outlier-1.json"), "utf8"),
    ) as Json;
    expect(Object.keys(locator).toSorted()).toEqual(
      [
        "kind",
        "openedAt",
        "projectRoot",
        "registeredAt",
        "runDir",
        "runId",
        "schemaVersion",
        "workflow",
      ].toSorted(),
    );
    expect(locator).toMatchObject({
      schemaVersion: 1,
      kind: "woof.run.locator",
      runId: "outlier-1",
      runDir,
      projectRoot: null,
      workflow: { name: "report-review", version: "1" },
    });

    const listed = woof(["runs"], { env: s.env });
    expect(listed.status, listed.stdout + listed.stderr).toBe(0);
    expect(listed.json).toMatchObject({
      outcome: "runs",
      runsDir: s.runsDir,
      indexDir: s.indexDir,
      exists: false,
      skipped: [],
    });
    expect((listed.json as Json)["runs"]).toMatchObject([
      { runId: "outlier-1", runDir, status: "created", owner: "unhosted" },
    ]);

    // Status follows the journal, not the locator: cancel the run and list again.
    expect(woof(["run", "cancel", "outlier-1"], { env: s.env }).status).toBe(0);
    const after = woof(["runs"], { env: s.env });
    expect((after.json as Json)["runs"]).toMatchObject([
      { runId: "outlier-1", status: "cancelled" },
    ]);

    // An explicit --runs-dir lists that directory only.
    const scoped = woof(["runs", "--runs-dir", s.runsDir], { env: s.env });
    expect(scoped.json).toMatchObject({ outcome: "runs", runs: [] });
    expect(scoped.json).not.toHaveProperty("indexDir");
  });

  it("lists a run once when the runs directory and the index both name it", () => {
    const s = sandbox();
    openRun(s, join(s.runsDir, "both"), "both-1");
    const listed = woof(["runs"], { env: s.env });
    expect(runIds(listed.json)).toEqual(["both-1"]);
    expect(listed.json).toMatchObject({ exists: true, skipped: [] });
  });

  it("reports a locator it cannot follow as skipped, never as a run", () => {
    const s = sandbox();
    const gone = join(s.outside, "gone");
    const emptied = join(s.outside, "emptied");
    const replaced = join(s.outside, "replaced");
    openRun(s, gone, "gone-1");
    openRun(s, emptied, "emptied-1");
    openRun(s, replaced, "replaced-1");
    rmSync(gone, { recursive: true });
    rmSync(join(emptied, "journal.jsonl"));
    // Another run now lives where the locator points; it has no locator of its own.
    rmSync(replaced, { recursive: true });
    openRun(s, replaced, "other-1", { HOME: s.home, WOOF_INDEX_DIR: join(s.root, "unused") });

    const listed = woof(["runs", "--all"], { env: s.env });
    expect(listed.status, listed.stdout + listed.stderr).toBe(0);
    expect(runIds(listed.json)).toEqual([]);
    expect((listed.json as Json)["skipped"]).toEqual([
      { path: emptied, reason: "run_dir_invalid", runId: "emptied-1" },
      { path: gone, reason: "run_dir_missing", runId: "gone-1" },
      { path: replaced, reason: "run_id_mismatch", runId: "replaced-1" },
    ]);

    const status = woof(["status", "gone-1"], { env: s.env });
    expect(status.status).toBe(3);
    expect(status.json).toMatchObject({ outcome: "rejected", reason: "run_dir_invalid" });
    expect(String((status.json as Json)["message"])).toContain("run_dir_missing");
  });

  it("ignores a torn temporary file and reports an unparsable locator", () => {
    const s = sandbox();
    openRun(s, join(s.outside, "ok"), "ok-1");
    writeFileSync(
      join(s.indexDir, "runs", "torn-1.json.4242.deadbeef.tmp"),
      '{"schemaVersion":1,"ki',
    );
    writeFileSync(join(s.indexDir, "runs", "bad-1.json"), "{ not json");
    const listed = woof(["runs"], { env: s.env });
    expect(listed.status, listed.stdout + listed.stderr).toBe(0);
    expect(runIds(listed.json)).toEqual(["ok-1"]);
    expect((listed.json as Json)["skipped"]).toEqual([
      { path: join(s.indexDir, "runs", "bad-1.json"), reason: "locator_invalid" },
    ]);
  });

  it("gives two runs opened at the same time a locator each", async () => {
    const s = sandbox();
    const opened = await Promise.all(
      ["c-1", "c-2", "c-3", "c-4"].map((runId) =>
        woofAsync(attemptOpenArgs(join(s.outside, runId), runId), { env: s.env }),
      ),
    );
    for (const result of opened) expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readdirSync(join(s.indexDir, "runs")).toSorted()).toEqual([
      "c-1.json",
      "c-2.json",
      "c-3.json",
      "c-4.json",
    ]);
    expect(runIds(woof(["runs"], { env: s.env }).json).toSorted()).toEqual([
      "c-1",
      "c-2",
      "c-3",
      "c-4",
    ]);
  });

  it("never fails the run when the index cannot be written", () => {
    const s = sandbox();
    const blocker = join(s.root, "not-a-directory");
    writeFileSync(blocker, "");
    const runDir = join(s.outside, "unindexed");
    const result = woof(attemptOpenArgs(runDir, "unindexed-1"), {
      env: { HOME: s.home, WOOF_INDEX_DIR: blocker },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.json).toMatchObject({ outcome: "opened" });
    expect(result.stderr).toContain("cannot index run unindexed-1");
    expect(woof(["status", runDir], { env: s.env }).status).toBe(0);
  });

  it("addresses a run by id: index first, then <runs-dir>/<id>, and rejects an unknown id", () => {
    const s = sandbox();
    const indexed = join(s.outside, "indexed");
    openRun(s, indexed, "by-id-1");
    // Under the runs directory but never indexed: found as <runs-dir>/<id>.
    const plain = join(s.runsDir, "plain-1");
    openRun(s, plain, "plain-1", { HOME: s.home, WOOF_INDEX_DIR: join(s.root, "unused") });

    const status = woof(["status", "by-id-1"], { env: s.env });
    expect(status.status, status.stdout + status.stderr).toBe(0);
    expect(status.json).toMatchObject({
      outcome: "status",
      status: { runId: "by-id-1", runDir: indexed },
    });
    expect(woof(["status", "plain-1"], { env: s.env }).json).toMatchObject({
      outcome: "status",
      status: { runId: "plain-1", runDir: plain },
    });

    const show = woof(["run", "show", "by-id-1"], { env: s.env });
    expect(show.json).toMatchObject({ outcome: "snapshot", snapshot: { runId: "by-id-1" } });
    const events = woof(["events", "by-id-1"], { env: s.env });
    expect(events.status).toBe(0);
    expect(lines(events.stdout).map((line) => line["type"] ?? line["kind"])).toEqual([
      "run.opened",
      "woof.events.end",
    ]);
    const watch = woof(["watch", "by-id-1"], { env: s.env });
    expect(watch.status, watch.stdout + watch.stderr).toBe(0);
    expect(watch.stdout).toContain("run.opened");

    // An existing directory wins over an id of the same name.
    const shadow = join(s.root, "cwd");
    mkdirSync(join(shadow, "by-id-1"), { recursive: true });
    const resolved = runNode(
      `const { resolveRunTarget } = await import(${JSON.stringify(distUrl("inspect/target.js"))});
process.chdir(process.argv[1]);
console.log(JSON.stringify(await resolveRunTarget("by-id-1")));`,
      [shadow],
      { env: s.env },
    );
    expect(resolved.json).toMatchObject({ ok: true, via: "path", runDir: join(shadow, "by-id-1") });

    for (const args of [
      ["status", "nope-1"],
      ["run", "show", "nope-1"],
      ["run", "cancel", "nope-1"],
      ["events", "nope-1"],
    ]) {
      const unknown = woof(args, { env: s.env });
      expect(unknown.status, args.join(" ")).toBe(3);
      expect(unknown.json, args.join(" ")).toMatchObject({
        outcome: "rejected",
        reason: "run_dir_invalid",
      });
      expect(String((unknown.json as Json)["message"])).toContain("nope-1");
    }

    const cancelled = woof(["run", "cancel", "by-id-1"], { env: s.env });
    expect(cancelled.status, cancelled.stdout).toBe(0);
    expect(woof(["status", "by-id-1"], { env: s.env }).json).toMatchObject({
      status: { status: "cancelled" },
    });
  });

  it("--reindex writes missing locators and prunes those whose run directory is gone", () => {
    const s = sandbox();
    const elsewhere = { HOME: s.home, WOOF_INDEX_DIR: join(s.root, "unused") };
    const unindexed = join(s.runsDir, "unindexed");
    openRun(s, unindexed, "repair-1", elsewhere);
    openRun(s, join(s.runsDir, "indexed"), "kept-1");
    const gone = join(s.outside, "gone");
    openRun(s, gone, "pruned-1");
    rmSync(gone, { recursive: true });

    const refused = woof(["runs", "--reindex", "--all"], { env: s.env });
    expect(refused.status).toBe(1);

    const reindexed = woof(["runs", "--reindex"], { env: s.env });
    expect(reindexed.status, reindexed.stdout + reindexed.stderr).toBe(0);
    expect(reindexed.json).toMatchObject({
      outcome: "reindexed",
      runsDir: s.runsDir,
      indexDir: s.indexDir,
      exists: true,
      written: [{ runId: "repair-1", runDir: unindexed }],
      pruned: [{ runId: "pruned-1", runDir: gone }],
      kept: 1,
      conflicts: [],
      skipped: [],
    });
    expect(readdirSync(join(s.indexDir, "runs")).toSorted()).toEqual([
      "kept-1.json",
      "repair-1.json",
    ]);
    const again = woof(["runs", "--reindex"], { env: s.env });
    expect(again.json).toMatchObject({ written: [], pruned: [], kept: 2 });
    // The journal was only read.
    expect(existsSync(join(unindexed, "journal.jsonl"))).toBe(true);
    expect(woof(["runs"], { env: s.env }).json).toMatchObject({ skipped: [] });
  });
});

describe("woof events --all", () => {
  it("merges the recorded events of every known run by time", () => {
    const s = sandbox();
    const a = join(s.outside, "a");
    const b = join(s.runsDir, "b");
    openRun(s, a, "merge-a");
    openRun(s, b, "merge-b");
    expect(woof(attemptOpenArgs(a, "merge-a"), { env: s.env }).status).toBe(0);
    expect(woof(attemptOpenArgs(b, "merge-b"), { env: s.env }).status).toBe(0);
    expect(woof(["run", "cancel", a], { env: s.env }).status).toBe(0);

    const result = woof(["events", "--all"], { env: s.env });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const out = lines(result.stdout);
    expect(out.map((line) => `${line["runId"] ?? "-"} ${line["type"] ?? line["kind"]}`)).toEqual([
      "merge-a woof.events.run",
      "merge-a run.opened",
      "merge-b woof.events.run",
      "merge-b run.opened",
      "merge-a attempt.opened",
      "merge-b attempt.opened",
      "merge-a run.cancel_requested",
      "merge-a run.terminated",
      "- woof.events.end",
    ]);
    expect(out[0]).toEqual({
      kind: "woof.events.run",
      runId: "merge-a",
      runDir: a,
      project: null,
    });
    expect(out.at(-1)).toEqual({
      kind: "woof.events.end",
      scope: "all",
      runs: 2,
      cursor: null,
      terminal: false,
      reason: "end",
    });
    // Each event is the journal's own: identical to the single-run stream.
    const single = lines(woof(["events", a], { env: s.env }).stdout).filter(
      (line) => line["kind"] === "woof.run.event",
    );
    expect(out.filter((line) => line["runId"] === "merge-a" && line["seq"] !== undefined)).toEqual(
      single,
    );
    const events = out.filter((line) => line["kind"] === "woof.run.event");
    const times = events.map((event) => event["ts"] as string);
    expect(times).toEqual(times.toSorted());

    const since = woof(["events", "--all", "--since", events[3]?.["ts"] as string], {
      env: s.env,
    });
    expect(
      lines(since.stdout)
        .filter((line) => line["kind"] === "woof.run.event")
        .map((line) => `${line["runId"]} ${line["type"]}`),
    ).toEqual(["merge-b attempt.opened", "merge-a run.cancel_requested", "merge-a run.terminated"]);

    const pretty = woof(["watch", "--all"], { env: s.env });
    expect(pretty.status, pretty.stdout + pretty.stderr).toBe(0);
    const text = pretty.stdout.trim().split("\n");
    expect(text[0]).toBe(`== merge-a  run merge-a  ${a}`);
    expect(text[1]).toMatch(/^merge-a {6}\d\d:\d\d:\d\d #1 run\.opened/);
    expect(text.at(-1)).toBe("-- end (end) 2 run(s)");

    const usage = woof(["events", "--all", a], { env: s.env });
    expect(usage.status).toBe(1);
  });

  it("reports an unreadable run with its run id and keeps streaming the others", () => {
    const s = sandbox();
    const good = join(s.outside, "good");
    const bad = join(s.runsDir, "bad");
    openRun(s, good, "good-1");
    openRun(s, bad, "bad-1");
    writeFileSync(join(bad, "journal.jsonl"), "not a journal\n");
    const result = woof(["events", "--all"], { env: s.env });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const out = lines(result.stdout);
    expect(out[0]).toMatchObject({ type: "skipped", runDir: bad, reason: "journal_corrupt" });
    expect(out.slice(1).map((line) => line["type"] ?? line["kind"])).toEqual([
      "woof.events.run",
      "run.opened",
      "woof.events.end",
    ]);
  });

  it("--follow picks up a run opened after it started, and ends on --timeout-ms", async () => {
    const s = sandbox();
    const first = join(s.outside, "first");
    openRun(s, first, "follow-1");
    const following = woofAsync(
      ["events", "--all", "--follow", "--poll-ms", "50", "--timeout-ms", "5000"],
      { env: s.env },
    );
    await delay(1200);
    const late = join(s.outside, "late");
    openRun(s, late, "follow-2");
    expect(woof(attemptOpenArgs(first, "follow-1"), { env: s.env }).status).toBe(0);
    expect(woof(["run", "cancel", late], { env: s.env }).status).toBe(0);

    const result = await following;
    expect(result.status, result.stdout + result.stderr).toBe(7);
    const out = lines(result.stdout);
    // Live lines of different runs arrive as each is polled; within a run the order is the journal's.
    const of = (runId: string) =>
      out.filter((line) => line["runId"] === runId).map((line) => line["type"] ?? line["kind"]);
    expect(of("follow-1")).toEqual(["woof.events.run", "run.opened", "attempt.opened"]);
    expect(of("follow-2")).toEqual([
      "woof.events.run",
      "run.opened",
      "run.cancel_requested",
      "run.terminated",
    ]);
    expect(out.find((line) => line["runId"] === "follow-2")).toMatchObject({ runDir: late });
    expect(out).toHaveLength(8);
    expect(out.at(-1)).toMatchObject({ scope: "all", runs: 2, reason: "timeout" });
  }, 20_000);
});
