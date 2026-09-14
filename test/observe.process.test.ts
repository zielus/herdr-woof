import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "./helpers/dist.js";
import {
  cleanupRunDirs,
  distUrl,
  makeRunDir,
  openPlannedRun,
  repoRoot,
  runNode,
  runNodeAsync,
  runSdk,
  sdkScript,
  testPlan,
  woof,
} from "./helpers/process.js";

// Observer transport runs in real child processes: a writer appends through the
// store and submission path, an observer subscribes, is killed and resumes from
// its stored cursor.
let eventsDir: string;
beforeAll(() => {
  eventsDir = mkdtempSync(join(tmpdir(), "woof-events-"));
});
afterAll(() => {
  rmSync(eventsDir, { recursive: true, force: true });
  cleanupRunDirs();
});

type Json = Record<string, unknown>;
interface Item extends Json {
  kind?: string;
  type: string;
  seq?: number;
  cursor?: string;
  reason?: string;
}

const OBSERVER = `
import { appendFileSync } from "node:fs";
const { subscribeEvents } = await import(${JSON.stringify(distUrl("observe/subscribe.js"))});
const [runDir, eventsFile, after, extra] = process.argv.slice(1);
const options = { pollMs: 15, ...(after ? { after } : {}), ...(extra ? JSON.parse(extra) : {}) };
for await (const item of subscribeEvents(runDir, options)) {
  appendFileSync(eventsFile, JSON.stringify(item) + "\\n");
  if (item.kind !== "woof.run.event") process.exit(5);
  if (item.type === "run.terminated") process.exit(0);
}
process.exit(6);
`;

// 1 run.opened + 1 agent.assigned + 39 × (attempt.opened, request.dispatched,
// submission.rejected) + 1 run.terminated = 120 records, with jittered pauses.
const WRITER = `
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let state = 7;
const jitter = () => { state = (state * 48271) % 2147483647; return 8 + (state % 22); };
await store.openRun({ runDir, runId: "run-1", plan: input.plan });
await sleep(jitter());
await store.assignAgent({ runDir, agentId: "worker", runtime: { adapter: "scripted", runtimeName: "w-worker", paneId: "w1:p1" } });
for (let attempt = 1; attempt <= 39; attempt += 1) {
  await sleep(jitter());
  await openAttempt({ runDir, runId: "run-1", agentId: "worker", stageId: "report", visit: 1, attempt, verdicts: ["pass", "fail"] });
  await sleep(jitter());
  const ambiguous = attempt % 3 === 0;
  await store.recordDispatch({ runDir, agentId: "worker", stageId: "report", visit: 1, attempt, delivery: ambiguous ? "ambiguous" : "started", reason: ambiguous ? "timeout" : "observed_working" });
  await sleep(jitter());
  await submitResult({ runDir, envelopeRaw: JSON.stringify({ schemaVersion: 1, runId: "run-1", agentId: "worker", stageId: "report", visit: 1, attempt, status: "completed", verdict: "pass", artifact: { path: "artifacts/report/visit-1/attempt-" + attempt + "/missing.md", sha256: "a".repeat(64) } }) });
}
await store.terminateRun({ runDir, outcome: "cancelled", reason: "writer finished" });
out = readJournal(runDir).records.length;
`;

function startNode(script: string, args: string[]) {
  const child = spawn("node", ["--input-type=module", "--eval", script, ...args], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const done = new Promise<{ status: number | null; signal: string | null; stderr: string }>(
    (resolve) => child.on("close", (status, signal) => resolve({ status, signal, stderr })),
  );
  return { child, done };
}

function items(file: string): Item[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return line === "" ? [] : [JSON.parse(line) as Item];
      } catch {
        return []; // a line cut by SIGKILL
      }
    });
}

async function waitUntil(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe("event subscription across a reconnect", () => {
  it("misses no transition when the observer is killed and resumes from its stored cursor", async () => {
    const runDir = makeRunDir();
    const firstFile = join(eventsDir, "reconnect-1.jsonl");
    const secondFile = join(eventsDir, "reconnect-2.jsonl");

    const first = startNode(OBSERVER, [runDir, firstFile, ""]);
    const writer = runNodeAsync(sdkScript(WRITER), [runDir, JSON.stringify({ plan: testPlan() })], {
      timeoutMs: 60_000,
    });
    await waitUntil(() => items(firstFile).length >= 40, 20_000, "40 events");
    first.child.kill("SIGKILL");
    const firstExit = await first.done;
    expect(firstExit.signal).toBe("SIGKILL");

    const seen1 = items(firstFile);
    const stored = seen1.at(-1)?.cursor as string;
    const storedSeq = Number(stored.split(".")[1]);
    const second = startNode(OBSERVER, [runDir, secondFile, stored]);
    const written = await writer;
    expect(written.status, written.stderr).toBe(0);
    expect(written.json as unknown).toBe(120);
    const secondExit = await withTimeout(second.done, 20_000, "the resumed observer");
    expect(secondExit.status, secondExit.stderr).toBe(0);

    const seen2 = items(secondFile);
    for (const item of [...seen1, ...seen2]) expect(item.kind).toBe("woof.run.event");
    // Within one subscription each seq arrives once and in order.
    expect(seen1.map((item) => item.seq)).toEqual(seen1.map((_, index) => index + 1));
    expect(seen2.map((item) => item.seq)).toEqual(
      Array.from({ length: 120 - storedSeq }, (_, index) => storedSeq + 1 + index),
    );
    const union = new Set([...seen1, ...seen2].map((item) => item.seq));
    expect([...union].toSorted((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      Array.from({ length: 120 }, (_, index) => index + 1),
    );

    // Folding the observed events reproduces a fresh snapshot of the journal.
    const { foldEvents } = await loadDist<{
      foldEvents: (base: null, events: Item[]) => { ok: boolean; projection: { snapshot: Json } };
    }>("observe/events.js");
    const bySeq = new Map([...seen1, ...seen2].map((item) => [item.seq, item]));
    const ordered = [...bySeq.values()].toSorted((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const folded = foldEvents(null, ordered);
    expect(folded.ok).toBe(true);
    const shown = woof(["run", "show", runDir]);
    expect(shown.status, shown.stderr).toBe(0);
    const fresh = JSON.parse(shown.stdout) as { outcome: string; snapshot: Json };
    expect(fresh.outcome).toBe("snapshot");
    expect(folded.projection.snapshot).toEqual(fresh.snapshot);
    expect(fresh.snapshot["status"]).toBe("cancelled");
  }, 60_000);
});

describe("event subscription and partial lines", () => {
  it("yields a record written in two halves once, without an error", async () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    const file = join(eventsDir, "in-flight.jsonl");
    const observer = startNode(OBSERVER, [runDir, file, ""]);
    await waitUntil(() => items(file).length >= 1, 10_000, "run.opened event");

    const writer = await runNodeAsync(
      `
import { appendFileSync, readFileSync } from "node:fs";
const path = process.argv[1] + "/journal.jsonl";
const count = readFileSync(path, "utf8").split("\\n").filter(Boolean).length;
const line = JSON.stringify({ schemaVersion: 1, seq: count + 1, ts: new Date().toISOString(), type: "run.terminated", outcome: "cancelled", reason: "written in two halves" }) + "\\n";
const half = Math.floor(line.length / 2);
appendFileSync(path, line.slice(0, half));
await new Promise((resolve) => setTimeout(resolve, 500));
appendFileSync(path, line.slice(half));
`,
      [runDir],
    );
    expect(writer.status, writer.stderr).toBe(0);
    const exit = await withTimeout(observer.done, 10_000, "observer exit");

    expect(exit.status, exit.stderr).toBe(0);
    expect(items(file).map((item) => [item.type, item.seq])).toEqual([
      ["run.opened", 1],
      ["run.terminated", 2],
    ]);
  });

  it("ends with journal_corrupt when a torn final line persists past the grace period", async () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    appendFileSync(join(runDir, "journal.jsonl"), '{"schemaVersion":1,"seq":2,"ts":"20');
    const file = join(eventsDir, "torn.jsonl");
    const started = Date.now();

    const observer = startNode(OBSERVER, [
      runDir,
      file,
      "",
      JSON.stringify({ tornTailGraceMs: 300 }),
    ]);
    const exit = await withTimeout(observer.done, 10_000, "observer exit");

    expect(exit.status, exit.stderr).toBe(5);
    const seen = items(file);
    expect(seen.map((item) => item.type)).toEqual(["run.opened", "error"]);
    expect(seen[1]).toMatchObject({ reason: "journal_corrupt" });
    expect(Date.now() - started).toBeLessThan(5000);

    const shown = woof(["run", "show", runDir]);
    expect(shown.status, shown.stderr).toBe(0);
    const snapshot = JSON.parse(shown.stdout) as { snapshot: { journal: Json } };
    expect(snapshot.snapshot.journal).toEqual({ records: 1, tailPending: true });
  });
});

describe("resuming against a replaced run directory", () => {
  it("requires a resync instead of resuming into another run", async () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    const old = runSdk<{ cursor: string }>(
      runDir,
      `out = (await import(${JSON.stringify(distUrl("observe/events.js"))})).readEvents(runDir);`,
    );
    rmSync(join(runDir, "journal.jsonl"));
    await delay(5);
    openPlannedRun(runDir);
    const replaced = runSdk<{ cursor: string }>(
      runDir,
      `out = (await import(${JSON.stringify(distUrl("observe/events.js"))})).readEvents(runDir);`,
    );
    expect(replaced.cursor).not.toBe(old.cursor);

    const file = join(eventsDir, "replaced.jsonl");
    const exit = await withTimeout(
      startNode(OBSERVER, [runDir, file, old.cursor]).done,
      10_000,
      "observer",
    );

    expect(exit.status).toBe(5);
    expect(items(file)).toEqual([
      expect.objectContaining({ type: "resync_required", reason: "cursor_foreign" }),
    ]);
  });
});

describe("live subscription against a replaced journal", () => {
  const TS = "2026-09-14T10:00:00.000Z";
  const line = (record: Json) => `${JSON.stringify({ schemaVersion: 1, ts: TS, ...record })}\n`;
  const openedLine = (runId: string) => line({ seq: 1, type: "run.opened", runId });
  const terminatedLine = line({
    seq: 2,
    type: "run.terminated",
    outcome: "cancelled",
    reason: "replacement",
  });

  async function subscribeThenReplace(name: string, replace: (journal: string) => void) {
    const runDir = makeRunDir();
    const journal = join(runDir, "journal.jsonl");
    writeFileSync(journal, openedLine("run-old"));
    const file = join(eventsDir, `${name}.jsonl`);
    const observer = startNode(OBSERVER, [runDir, file, ""]);
    await waitUntil(() => items(file).length >= 1, 10_000, "run.opened event");
    replace(journal);
    const exit = await withTimeout(observer.done, 10_000, "observer exit");
    return { exit, seen: items(file) };
  }

  it("ends with cursor_foreign when the journal is rewritten in place with a same-length line 1", async () => {
    expect(openedLine("run-new")).toHaveLength(openedLine("run-old").length);
    const { exit, seen } = await subscribeThenReplace("rewritten", (journal) =>
      writeFileSync(journal, openedLine("run-new") + terminatedLine),
    );

    expect(exit.status, exit.stderr).toBe(5);
    expect(seen).toEqual([
      expect.objectContaining({ type: "run.opened", seq: 1, runId: "run-old" }),
      expect.objectContaining({ type: "resync_required", reason: "cursor_foreign" }),
    ]);
  });

  it("ends with cursor_foreign when another file with an identical line 1 is renamed into place", async () => {
    const { exit, seen } = await subscribeThenReplace("renamed", (journal) => {
      const replacement = `${journal}.new`;
      writeFileSync(replacement, openedLine("run-old") + terminatedLine);
      renameSync(replacement, journal);
    });

    expect(exit.status, exit.stderr).toBe(5);
    expect(seen).toEqual([
      expect.objectContaining({ type: "run.opened", seq: 1, runId: "run-old" }),
      expect.objectContaining({ type: "resync_required", reason: "cursor_foreign" }),
    ]);
  });

  // Deterministic interleavings: the subscriber's journal read hooks spawn a
  // separate writer process at an exact read boundary and wait for it.
  const BOUNDARY_OBSERVER = `
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const { journalReadHooks } = await import(${JSON.stringify(distUrl("journal/journal.js"))});
const { subscribeEvents } = await import(${JSON.stringify(distUrl("observe/subscribe.js"))});
const [runDir, eventsFile, mode, replacement, invalidLine] = process.argv.slice(1);
const journal = runDir + "/journal.jsonl";
setTimeout(() => process.exit(7), 8000).unref();
const writer = (code, ...args) => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, journal, ...args]);
  if (result.status !== 0) { console.error(String(result.stderr)); process.exit(9); }
};
const REWRITE = 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], process.argv[2]);';
const APPEND = 'import { appendFileSync } from "node:fs"; appendFileSync(process.argv[1], process.argv[2]);';
const RENAME = 'import { renameSync, writeFileSync } from "node:fs"; writeFileSync(process.argv[1] + ".new", process.argv[2]); renameSync(process.argv[1] + ".new", process.argv[1]);';
let checks = 0;
let prefixReads = 0;
let swapped = false;
journalReadHooks.afterPrefixRead = () => {
  prefixReads += 1;
  // prefix: same inode, new line 1, while the subscription's first full read is in progress.
  if (mode === "prefix" && prefixReads === 1) writer(REWRITE, replacement);
};
journalReadHooks.afterLineOneCheck = () => {
  checks += 1;
  if (checks !== 1) return;
  // rewrite: same inode, new line 1, after line 1 was checked and before the continuation read.
  if (mode === "rewrite") writer(REWRITE, replacement);
  // swap: make the continuation read fail on the original inode.
  if (mode === "swap") writer(APPEND, invalidLine);
};
journalReadHooks.afterContinuationRead = (result) => {
  // swap: between the failed continuation read and the fallback full read, rename in another inode.
  if (mode === "swap" && !swapped && !result.ok) { swapped = true; writer(RENAME, replacement); }
};
for await (const item of subscribeEvents(runDir, { pollMs: 15 })) {
  appendFileSync(eventsFile, JSON.stringify(item) + "\\n");
  if (item.kind !== "woof.run.event") process.exit(5);
}
process.exit(6);
`;

  async function atBoundary(
    name: string,
    mode: "rewrite" | "swap" | "prefix",
    replacement: string,
  ) {
    const runDir = makeRunDir();
    writeFileSync(join(runDir, "journal.jsonl"), openedLine("run-old"));
    const file = join(eventsDir, `${name}.jsonl`);
    const invalidLine = `${JSON.stringify({ schemaVersion: 1, seq: 2, ts: TS, type: "run.terminated" })}\n`;
    const exit = await withTimeout(
      startNode(BOUNDARY_OBSERVER, [runDir, file, mode, replacement, invalidLine]).done,
      10_000,
      "boundary observer",
    );
    return { exit, seen: items(file) };
  }

  it("never yields seq 2 when the journal is rewritten in place between the line-1 check and the continuation read", async () => {
    const { exit, seen } = await atBoundary(
      "boundary-rewrite",
      "rewrite",
      openedLine("run-new") + terminatedLine,
    );

    expect(exit.status, exit.stderr).toBe(5);
    expect(seen).toEqual([
      expect.objectContaining({ type: "run.opened", seq: 1, runId: "run-old" }),
      expect.objectContaining({ type: "resync_required", reason: "cursor_foreign" }),
    ]);
  });

  it("ends a fresh subscription with cursor_foreign when line 1 is rewritten during its first full read", async () => {
    const { exit, seen } = await atBoundary(
      "boundary-prefix",
      "prefix",
      openedLine("run-new") + terminatedLine,
    );

    expect(exit.status, exit.stderr).toBe(5);
    expect(seen).toEqual([
      expect.objectContaining({ type: "resync_required", reason: "cursor_foreign" }),
    ]);
  });

  it("shows a journal rewritten in place during a snapshot read as the replacement, never as the old prefix", () => {
    const runDir = makeRunDir();
    writeFileSync(join(runDir, "journal.jsonl"), openedLine("run-old"));
    const out = runSdk<Json>(
      runDir,
      `import { spawnSync } from "node:child_process";
const { journalReadHooks } = await import(${JSON.stringify(distUrl("journal/journal.js"))});
let reads = 0;
journalReadHooks.afterPrefixRead = () => {
  reads += 1;
  if (reads !== 1) return;
  const code = 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], process.argv[2]);';
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, runDir + "/journal.jsonl", input.replacement]);
  if (result.status !== 0) throw new Error(String(result.stderr));
};
const read = snapshots.readSnapshot(runDir);
out = { ok: read.ok, runId: read.snapshot?.runId, revision: read.snapshot?.revision, status: read.snapshot?.status, reads };`,
      { replacement: openedLine("run-new") + terminatedLine },
    );

    expect(out).toEqual({
      ok: true,
      runId: "run-new",
      revision: 2,
      status: "cancelled",
      reads: 2,
    });
  });

  it("reports journal_replaced from readSnapshot, readEvents and woof run show when line 1 changes on every read", () => {
    const runDir = makeRunDir();
    const journalPath = join(runDir, "journal.jsonl");
    writeFileSync(journalPath, openedLine("run-a"));
    const lines = [openedLine("run-b"), openedLine("run-a")];
    // Every offset-0 read sees its line 1 rewritten in place (alternating run-b/run-a) by a separate process.
    const preload = join(runDir, "rewrite-every-read.mjs");
    writeFileSync(
      preload,
      `import { spawnSync } from "node:child_process";
const { journalReadHooks } = await import(${JSON.stringify(distUrl("journal/journal.js"))});
const journal = ${JSON.stringify(journalPath)};
const lines = ${JSON.stringify(lines)};
let reads = 0;
journalReadHooks.afterPrefixRead = () => {
  const line = lines[reads % 2];
  reads += 1;
  globalThis.__woofPrefixReads = reads;
  const code = 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], process.argv[2]);';
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, journal, line]);
  if (result.status !== 0) throw new Error(String(result.stderr));
};
`,
    );

    const sdk = runNode(
      `await import(${JSON.stringify(pathToFileURL(preload).href)});
const snapshots = await import(${JSON.stringify(distUrl("state/snapshot.js"))});
const { readEvents } = await import(${JSON.stringify(distUrl("observe/events.js"))});
const snapshot = snapshots.readSnapshot(process.argv[1]);
const afterSnapshot = globalThis.__woofPrefixReads;
const events = readEvents(process.argv[1]);
const afterEvents = globalThis.__woofPrefixReads;
const missingSnapshot = snapshots.readSnapshot(process.argv[1] + "/nope");
const missingEvents = readEvents(process.argv[1] + "/nope");
console.log(JSON.stringify({ snapshot, events, afterSnapshot, afterEvents, missingSnapshot, missingEvents }));`,
      [runDir],
    );
    expect(sdk.status, sdk.stderr).toBe(0);
    const out = JSON.parse(sdk.stdout) as Record<string, Json>;
    const replaced = {
      ok: false,
      reason: "journal_replaced",
      message: `${journalPath}: the journal's line 1 changed during each of 3 consecutive reads`,
    };
    expect(out["snapshot"]).toEqual(replaced);
    expect(out["events"]).toEqual(replaced);
    expect([out["afterSnapshot"], out["afterEvents"]]).toEqual([3, 6]);
    expect(out["missingSnapshot"]).toMatchObject({ ok: false, reason: "run_dir_invalid" });
    expect(out["missingEvents"]).toMatchObject({ ok: false, reason: "run_dir_invalid" });

    const shown = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        join(repoRoot, "dist", "cli.js"),
        "run",
        "show",
        runDir,
      ],
      { encoding: "utf8" },
    );
    expect(shown.status, shown.stderr).toBe(3);
    expect(JSON.parse(shown.stdout)).toEqual({
      outcome: "rejected",
      reason: "journal_replaced",
      message: replaced.message,
    });
    const missing = spawnSync(
      process.execPath,
      [join(repoRoot, "dist", "cli.js"), "run", "show", join(runDir, "nope")],
      { encoding: "utf8" },
    );
    expect(missing.status).toBe(3);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      outcome: "rejected",
      reason: "run_dir_invalid",
    });
  });

  it("never yields seq 2 when another inode is renamed in between a failed continuation read and the fallback full read", async () => {
    const { exit, seen } = await atBoundary(
      "boundary-swap",
      "swap",
      openedLine("run-old") + terminatedLine,
    );

    expect(exit.status, exit.stderr).toBe(5);
    expect(seen).toEqual([
      expect.objectContaining({ type: "run.opened", seq: 1, runId: "run-old" }),
      expect.objectContaining({ type: "resync_required", reason: "cursor_foreign" }),
    ]);
  });
});

describe("readEvents", () => {
  it("pages events and reports stale cursors", () => {
    const runDir = makeRunDir();
    openPlannedRun(runDir);
    runSdk(
      runDir,
      `out = await store.assignAgent({ runDir, agentId: "worker", runtime: { adapter: "scripted", runtimeName: "w-worker", paneId: "w1:p1" } });`,
    );
    runSdk(
      runDir,
      `out = await store.terminateRun({ runDir, outcome: "failed", reason: "done" });`,
    );

    const out = runSdk<
      Record<string, { ok: boolean; reason?: string; events?: Item[]; cursor?: string }>
    >(
      runDir,
      `const { readEvents } = await import(${JSON.stringify(distUrl("observe/events.js"))});
const all = readEvents(runDir);
const anchor = all.cursor.split(".")[2];
const other = anchor === "0123456789ab" ? "ba9876543210" : "0123456789ab";
out = {
  all,
  page: readEvents(runDir, { limit: 2 }),
  rest: readEvents(runDir, { after: readEvents(runDir, { limit: 2 }).cursor }),
  head: readEvents(runDir, { after: all.cursor }),
  ahead: readEvents(runDir, { after: "v1.4." + anchor }),
  foreign: readEvents(runDir, { after: "v1.1." + other }),
  malformed: readEvents(runDir, { after: "not-a-cursor" }),
  missing: readEvents(runDir + "/nope"),
};`,
    );

    expect(out["all"]?.events?.map((item) => item.type)).toEqual([
      "run.opened",
      "agent.assigned",
      "run.terminated",
    ]);
    expect(out["page"]?.events?.map((item) => item.seq)).toEqual([1, 2]);
    expect(out["rest"]?.events?.map((item) => item.seq)).toEqual([3]);
    expect(out["head"]).toMatchObject({ ok: true, events: [], cursor: out["all"]?.cursor });
    expect(out["ahead"]).toMatchObject({ ok: false, reason: "cursor_ahead" });
    expect(out["foreign"]).toMatchObject({ ok: false, reason: "cursor_foreign" });
    expect(out["malformed"]).toMatchObject({ ok: false, reason: "cursor_malformed" });
    expect(out["missing"]).toMatchObject({ ok: false, reason: "run_dir_invalid" });
  });

  it("reports replay time for a 10 000-record journal (R9 evidence, not gated)", () => {
    const runDir = makeRunDir();
    const lines = [
      JSON.stringify({
        schemaVersion: 1,
        seq: 1,
        ts: "2026-09-14T10:00:00.000Z",
        type: "run.opened",
        runId: "big-run",
      }),
    ];
    for (let seq = 2; seq <= 10_000; seq += 1) {
      lines.push(
        JSON.stringify({
          schemaVersion: 1,
          seq,
          ts: "2026-09-14T10:00:01.000Z",
          type: "submission.rejected",
          reason: "envelope_malformed",
          message: "envelope is not valid JSON",
          details: [],
        }),
      );
    }
    writeFileSync(join(runDir, "journal.jsonl"), `${lines.join("\n")}\n`);

    const out = runSdk<{ records: number; snapshotMs: number; eventsMs: number; events: number }>(
      runDir,
      `const { readEvents } = await import(${JSON.stringify(distUrl("observe/events.js"))});
let started = performance.now();
const snapshot = snapshots.readSnapshot(runDir);
const snapshotMs = Math.round(performance.now() - started);
started = performance.now();
const events = readEvents(runDir, { limit: 10000 });
out = { records: snapshot.snapshot.revision, snapshotMs, eventsMs: Math.round(performance.now() - started), events: events.events.length };`,
    );

    expect(out.records).toBe(10_000);
    expect(out.events).toBe(10_000);
    console.info(
      `R9: readSnapshot over 10000 records took ${out.snapshotMs} ms; readEvents took ${out.eventsMs} ms`,
    );
  });
});
