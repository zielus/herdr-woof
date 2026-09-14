import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupRunDirs,
  distUrl,
  readyAttempt,
  runNodeAsync,
  runSdk,
  submit,
  woof,
} from "./helpers/process.js";

afterEach(() => cleanupRunDirs());

// Writer A takes the journal lock, reads the journal and pauses before its
// append (inside the artifact read seam, which runs after the locked read). A
// person deletes the held journal.lock; writer B acquires a fresh lock and
// appends; A resumes and appends from its stale read. This is carry-over C1:
// the compare-and-remove race can break mutual exclusion, and the journal must
// then fail closed instead of replaying two acceptances as valid.
const WRITER_A = `
import { existsSync, writeFileSync } from "node:fs";
const { lockTestHooks } = await import(${JSON.stringify(distUrl("journal/lock.js"))});
const { artifactReadHooks } = await import(${JSON.stringify(distUrl("submission/artifact.js"))});
const { submitResult } = await import(${JSON.stringify(distUrl("submission/submit.js"))});
const [runDir, envelope, signalDir] = process.argv.slice(1);
lockTestHooks.afterAcquire = (lockPath) => writeFileSync(signalDir + "/a-locked", lockPath);
artifactReadHooks.beforeRead = () => {
  writeFileSync(signalDir + "/a-paused", "");
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 8000;
  while (!existsSync(signalDir + "/a-release") && Date.now() < deadline) Atomics.wait(cell, 0, 0, 20);
};
console.log(JSON.stringify(await submitResult({ runDir, envelopeRaw: envelope })));
`;

async function waitFor(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await delay(20);
  }
}

describe("journal lock compare-and-remove race (C1)", () => {
  it("degrades to journal_corrupt instead of replaying two acceptances", async () => {
    const started = Date.now();
    const { runDir, envelope } = readyAttempt();
    const signalDir = join(runDir, "signals");
    runSdk(runDir, `(await import("node:fs")).mkdirSync(input.dir); out = true;`, {
      dir: signalDir,
    });

    const writerA = runNodeAsync(WRITER_A, [runDir, JSON.stringify(envelope), signalDir], {
      timeoutMs: 15_000,
    });
    await waitFor(join(signalDir, "a-paused"), 8000);
    expect(readFileSync(join(signalDir, "a-locked"), "utf8")).toBe(join(runDir, "journal.lock"));

    // A person removes the lock A still holds; B acquires and appends.
    rmSync(join(runDir, "journal.lock"));
    const writerB = submit(runDir, envelope);
    writeFileSync(join(signalDir, "a-release"), "");
    const resultA = await writerA;

    expect(writerB.json?.outcome, `${writerB.stdout}${writerB.stderr}`).toBe("accepted");
    expect(resultA.status, resultA.stderr).toBe(0);
    expect((JSON.parse(resultA.stdout) as { outcome: string }).outcome).toBe("accepted");

    // Both appends landed with the same seq: mutual exclusion was broken.
    const raw = readFileSync(join(runDir, "journal.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { seq: number; type: string });
    expect(raw.map((line) => [line.seq, line.type])).toEqual([
      [1, "run.opened"],
      [2, "attempt.opened"],
      [3, "submission.accepted"],
      [3, "submission.accepted"],
    ]);

    // Every reader fails closed: no state with both acceptances replays.
    const reads = runSdk<{
      journal: { ok: boolean; reason: string; line: number };
      snapshot: { ok: boolean; reason: string };
    }>(runDir, `out = { journal: readJournal(runDir), snapshot: snapshots.readSnapshot(runDir) };`);
    expect(reads.journal).toMatchObject({ ok: false, reason: "journal_corrupt", line: 4 });
    expect(reads.snapshot).toMatchObject({ ok: false, reason: "journal_corrupt" });
    const shown = woof(["run", "show", runDir]);
    expect(shown.status).toBe(3);
    expect(shown.json).toMatchObject({ outcome: "rejected", reason: "journal_corrupt" });
    const retry = submit(runDir, envelope);
    expect(retry.status).toBe(3);
    expect(retry.json).toMatchObject({ outcome: "rejected", reason: "journal_corrupt" });

    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
