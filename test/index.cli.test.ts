import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  distUrl,
  openAttempt,
  openAttemptAsync,
  runNode,
  testPlan,
  woof,
  woofAsync,
} from "./helpers/process.js";

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
        openAttemptAsync(join(s.outside, runId), { run: runId }, { env: s.env }),
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
    const result = openAttempt(
      runDir,
      { run: "unindexed-1" },
      { env: { HOME: s.home, WOOF_INDEX_DIR: blocker } },
    );
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

    const events = woof(["events", "by-id-1"], { env: s.env });
    expect(events.status).toBe(0);
    expect(lines(events.stdout).map((line) => line["type"] ?? line["kind"])).toEqual([
      "run.opened",
      "woof.events.end",
    ]);
    // The human view by default: the opening block names the run, then one row per record.
    const watch = woof(["watch", "by-id-1"], { env: s.env });
    expect(watch.status, watch.stdout + watch.stderr).toBe(0);
    expect(watch.stdout).toContain("run by-id-1 · workflow v1");
    expect(watch.stdout).toMatch(/^\d\d:\d\d:\d\d [·.] run {14}Started$/m);
    const rawWatch = woof(["watch", "by-id-1", "--plain"], { env: s.env });
    expect(rawWatch.status, rawWatch.stdout + rawWatch.stderr).toBe(0);
    expect(rawWatch.stdout).toContain("run.opened");

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

  it("rejects a run id that names two runs instead of picking one, and keeps the first locator", () => {
    const s = sandbox();
    const elsewhere = { HOME: s.home, WOOF_INDEX_DIR: join(s.root, "unused") };
    // Run A under the runs directory, never indexed; run B elsewhere with the same id, indexed.
    const a = join(s.runsDir, "dup-1");
    const b = join(s.outside, "dup-b");
    openRun(s, a, "dup-1", elsewhere);
    openRun(s, b, "dup-1");

    for (const args of [
      ["run", "cancel", "dup-1"],
      ["status", "dup-1"],
      ["events", "dup-1"],
    ]) {
      const refused = woof(args, { env: s.env });
      expect(refused.status, args.join(" ")).toBe(3);
      expect(refused.json, args.join(" ")).toMatchObject({
        outcome: "rejected",
        reason: "run_id_ambiguous",
      });
      const message = String((refused.json as Json)["message"]);
      expect(message).toContain(a);
      expect(message).toContain(b);
    }
    // Nothing was cancelled, and each run is still addressable by its directory.
    for (const runDir of [a, b]) {
      expect(woof(["status", runDir], { env: s.env }).json).toMatchObject({
        status: { runId: "dup-1", status: "created" },
      });
    }
    expect(woof(["run", "cancel", a], { env: s.env }).status).toBe(0);
    expect(woof(["status", a], { env: s.env }).json).toMatchObject({
      status: { status: "cancelled" },
    });
    expect(woof(["status", b], { env: s.env }).json).toMatchObject({
      status: { status: "created" },
    });

    // A directory of that name that holds no such run is not a second run.
    const empty = sandbox();
    openRun(empty, join(empty.outside, "only"), "only-1");
    mkdirSync(join(empty.runsDir, "only-1"), { recursive: true });
    const resolved = runNode(
      `const { resolveRunTarget } = await import(${JSON.stringify(distUrl("inspect/target.js"))});
console.log(JSON.stringify(await resolveRunTarget("only-1", { runsDir: async () => process.argv[1] })));`,
      [empty.runsDir],
      { env: { ...empty.env, HOME: empty.root } },
    );
    expect(resolved.json).toMatchObject({ ok: true, via: "index" });

    // A third run with the same id does not take over B's locator; its open still succeeds.
    const c = join(s.outside, "dup-c");
    const opened = openAttempt(c, { run: "dup-1" }, { env: s.env });
    expect(opened.status, opened.stdout + opened.stderr).toBe(0);
    expect(opened.json).toMatchObject({ outcome: "opened" });
    expect(opened.stderr).toContain("run id dup-1 is already indexed at");
    expect(
      (JSON.parse(readFileSync(join(s.indexDir, "runs", "dup-1.json"), "utf8")) as Json)["runDir"],
    ).toBe(b);
    expect(woof(["status", c], { env: s.env }).status).toBe(0);
    // Once B is gone its locator is dead, and a new run with that id may be indexed.
    rmSync(b, { recursive: true });
    const d = join(s.outside, "dup-d");
    openRun(s, d, "dup-1");
    expect(
      (JSON.parse(readFileSync(join(s.indexDir, "runs", "dup-1.json"), "utf8")) as Json)["runDir"],
    ).toBe(d);
  });

  it("never follows a locator with a relative run directory", () => {
    const s = sandbox();
    // A real run the relative path would reach from the inspector's working directory.
    const elsewhere = { HOME: s.home, WOOF_INDEX_DIR: join(s.root, "unused") };
    openRun(s, join(s.outside, "rel"), "rel-1", elsewhere);
    mkdirSync(join(s.indexDir, "runs"), { recursive: true });
    const path = join(s.indexDir, "runs", "rel-1.json");
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        kind: "woof.run.locator",
        runId: "rel-1",
        runDir: "rel",
        projectRoot: null,
        workflow: null,
        openedAt: "2026-01-01T00:00:00.000Z",
        registeredAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const result = runNode(
      `process.chdir(process.argv[1]);
const { listRuns } = await import(${JSON.stringify(distUrl("inspect/runs.js"))});
const { resolveRunTarget } = await import(${JSON.stringify(distUrl("inspect/target.js"))});
const listed = listRuns({ runsDir: process.argv[2], indexDir: process.argv[3], all: true });
const target = await resolveRunTarget("rel-1", { indexDir: process.argv[3] });
console.log(JSON.stringify({ listed, target }));`,
      [s.outside, s.runsDir, s.indexDir],
      { env: s.env },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      listed: { runs: [], skipped: [{ path, reason: "locator_invalid" }] },
      target: { ok: false, reason: "run_dir_invalid" },
    });
  });

  it("names the real directory of a run indexed through a symlink", () => {
    const s = sandbox();
    const runDir = join(s.outside, "real");
    openRun(s, runDir, "link-1");
    const link = join(s.outside, "link");
    symlinkSync(runDir, link);
    const path = join(s.indexDir, "runs", "link-1.json");
    const locator = JSON.parse(readFileSync(path, "utf8")) as Json;
    writeFileSync(path, JSON.stringify({ ...locator, runDir: link }));
    expect((woof(["runs"], { env: s.env }).json as Json)["runs"]).toMatchObject([
      { runId: "link-1", runDir },
    ]);
  });

  it("--reindex writes missing locators, keeps unreachable ones, and prunes only with --prune", () => {
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

    expect(woof(["runs", "--prune"], { env: s.env }).status).toBe(1);

    // A directory that is not there now may be on a volume that is not mounted: the locator stays.
    const reindexed = woof(["runs", "--reindex"], { env: s.env });
    expect(reindexed.status, reindexed.stdout + reindexed.stderr).toBe(0);
    expect(reindexed.json).toMatchObject({
      outcome: "reindexed",
      runsDir: s.runsDir,
      indexDir: s.indexDir,
      exists: true,
      written: [{ runId: "repair-1", runDir: unindexed }],
      pruned: [],
      unavailable: [{ runId: "pruned-1", runDir: gone, reason: "run_dir_missing" }],
      kept: 1,
      conflicts: [],
      skipped: [],
    });
    expect(readdirSync(join(s.indexDir, "runs")).toSorted()).toEqual([
      "kept-1.json",
      "pruned-1.json",
      "repair-1.json",
    ]);
    // The run comes back (the volume is mounted again): it is found through the kept locator.
    openRun(s, gone, "pruned-1", elsewhere);
    expect(woof(["status", "pruned-1"], { env: s.env }).json).toMatchObject({
      outcome: "status",
      status: { runId: "pruned-1", runDir: gone },
    });
    rmSync(gone, { recursive: true });

    const pruned = woof(["runs", "--reindex", "--prune"], { env: s.env });
    expect(pruned.status, pruned.stdout + pruned.stderr).toBe(0);
    expect(pruned.json).toMatchObject({
      written: [],
      pruned: [{ runId: "pruned-1", runDir: gone }],
      unavailable: [],
      kept: 2,
    });
    expect(readdirSync(join(s.indexDir, "runs")).toSorted()).toEqual([
      "kept-1.json",
      "repair-1.json",
    ]);
    const again = woof(["runs", "--reindex"], { env: s.env });
    expect(again.json).toMatchObject({ written: [], pruned: [], unavailable: [], kept: 2 });
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
    expect(openAttempt(a, { run: "merge-a" }, { env: s.env }).status).toBe(0);
    expect(openAttempt(b, { run: "merge-b" }, { env: s.env }).status).toBe(0);
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
    expect(openAttempt(first, { run: "follow-1" }, { env: s.env }).status).toBe(0);
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

  it("--follow polls at most --max-runs runs, names the ones that wait, and follows them when a place frees", async () => {
    const s = sandbox();
    const dirs3 = ["cap-1", "cap-2", "cap-3"].map((runId) => join(s.outside, runId));
    for (const [index, runDir] of dirs3.entries()) {
      openRun(s, runDir, `cap-${index + 1}`);
      // Distinct openedAt, so "most recent first" is decided.
      // oxlint-disable-next-line no-await-in-loop
      await delay(15);
    }
    expect(woof(["events", "--all", "--max-runs", "0"], { env: s.env }).status).toBe(1);
    expect(woof(["events", dirs3[0] as string, "--max-runs", "2"], { env: s.env }).status).toBe(1);

    const following = woofAsync(
      ["events", "--all", "--follow", "--max-runs", "1", "--poll-ms", "50", "--timeout-ms", "5000"],
      { env: s.env },
    );
    await delay(1200);
    // cap-3 (the most recent) is followed; the others wait. Ending it frees its place for cap-2.
    expect(openAttempt(dirs3[1] as string, { run: "cap-2" }, { env: s.env }).status).toBe(0);
    expect(woof(["run", "cancel", dirs3[2] as string], { env: s.env }).status).toBe(0);

    const result = await following;
    expect(result.status, result.stdout + result.stderr).toBe(7);
    const out = lines(result.stdout);
    expect(out.filter((line) => line["kind"] === "woof.events.skipped")).toEqual([
      expect.objectContaining({ runId: "cap-2", runDir: dirs3[1], reason: "follow_cap" }),
      expect.objectContaining({ runId: "cap-1", runDir: dirs3[0], reason: "follow_cap" }),
    ]);
    const of = (runId: string) =>
      out
        .filter((line) => line["runId"] === runId && line["kind"] === "woof.run.event")
        .map((line) => line["type"]);
    expect(of("cap-3")).toEqual(["run.opened", "run.cancel_requested", "run.terminated"]);
    // Followed from its backlog cursor once cap-3 ended: nothing of it was lost.
    expect(of("cap-2")).toEqual(["run.opened", "attempt.opened"]);
    expect(of("cap-1")).toEqual(["run.opened"]);
    expect(out.at(-1)).toMatchObject({ scope: "all", runs: 3, reason: "timeout" });
  }, 20_000);
});
