import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { repoRoot, runNode } from "./helpers/process.js";

// Live gate 10 (p4 carry-over G10): the observer comparison, fed the committed
// verify-4 evidence and synthetic disagreements, in a child process.
const observerUrl = pathToFileURL(join(repoRoot, "scripts", "live", "lib", "observer.mjs")).href;

type Json = Record<string, any>; // oxlint-disable-line no-explicit-any

function evaluate(samples: Json[], records: Json[], options?: Json): Json {
  const result = runNode(
    `const observer = await import(${JSON.stringify(observerUrl)});
const input = JSON.parse(process.argv[1]);
console.log(JSON.stringify({
  disagreements: observer.observerDisagreements(input.samples, input.records, input.options),
  working: Object.fromEntries(["builder", "reviewer"].map((id) => [id, observer.workingWhileActive(input.samples, id)])),
}));`,
    [JSON.stringify({ samples, records, ...(options !== undefined ? { options } : {}) })],
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as Json;
}

/** The samples and acceptances of the verify-4 run in docs/research/build-review-live.log. */
function verify4(): { samples: Json[]; records: Json[] } {
  const lines = readFileSync(
    join(repoRoot, "docs", "research", "build-review-live.log"),
    "utf8",
  ).split("\n");
  const samples: Json[] = [];
  for (const line of lines) {
    const match = /^\[sample\] (\S+) status=(\S+) rev=\d+ ?(.*)$/.exec(line);
    if (match === null) continue;
    const agents: Json = {};
    for (const agent of (match[3] ?? "").matchAll(/(\w+)=herdr:([^/\s]+)\/attempt:(\S+)/g)) {
      const [, agentId = "", herdr, attempt = "none"] = agent;
      const [stageId, visit, number] = attempt.split(".");
      agents[agentId] = {
        herdr,
        activeAttempt:
          attempt === "none" ? null : { stageId, visit: Number(visit), attempt: Number(number) },
      };
    }
    samples.push({ at: match[1], status: match[2], agents });
  }
  const shown = lines.find((line) => line.startsWith('{"outcome":"snapshot"'));
  const snapshot = (JSON.parse(shown ?? "null") as Json)["snapshot"] as Json;
  const records: Json[] = [];
  for (const stage of snapshot["stages"] as Json[])
    for (const visit of stage["visits"] as Json[])
      for (const attempt of visit["attempts"] as Json[])
        if (attempt["accepted"] !== null)
          records.push({
            type: "submission.accepted",
            agentId: attempt["agentId"],
            ts: attempt["accepted"]["at"],
          });
  return { samples, records };
}

describe("observerDisagreements (live gate 10)", () => {
  it("accepts the verify-4 samples, whose only disagreements fall within the grace window", () => {
    const { samples, records } = verify4();
    expect(samples).toHaveLength(31);
    expect(records).toHaveLength(4);
    const strict = evaluate(samples, records, { graceMs: 0 });
    expect(strict["disagreements"]).toEqual([
      expect.objectContaining({ at: "2026-09-14T23:52:13.742Z", agentId: "builder", kind: "soft" }),
      expect.objectContaining({
        at: "2026-09-14T23:52:53.761Z",
        agentId: "reviewer",
        kind: "soft",
      }),
      expect.objectContaining({ at: "2026-09-14T23:53:28.762Z", agentId: "builder", kind: "soft" }),
    ]);
    for (const item of strict["disagreements"] as Json[])
      expect(item["sinceAcceptedMs"]).toBeLessThan(2000);
    const graced = evaluate(samples, records);
    expect(graced["disagreements"]).toEqual([]);
    expect(graced["working"]).toEqual({ builder: true, reviewer: true });
  });

  it("flags working 20 s after acceptance, working with no acceptance, and gone while active", () => {
    const accepted = "2026-09-15T10:00:00.000Z";
    const records = [{ type: "submission.accepted", agentId: "builder", ts: accepted }];
    const row = (at: string, agents: Json, status = "running") => ({ at, status, agents });
    const active = { stageId: "build", visit: 1, attempt: 1 };
    const result = evaluate(
      [
        row("2026-09-15T10:00:10.000Z", { builder: { herdr: "working", activeAttempt: null } }),
        row("2026-09-15T10:00:20.000Z", { builder: { herdr: "working", activeAttempt: null } }),
        row("2026-09-15T10:00:21.000Z", { reviewer: { herdr: "working", activeAttempt: null } }),
        row("2026-09-15T10:00:22.000Z", { reviewer: { herdr: "gone", activeAttempt: active } }),
        row("2026-09-15T10:00:23.000Z", {
          builder: { herdr: "error:not_found", activeAttempt: active },
        }),
        row("2026-09-15T10:00:24.000Z", { builder: { herdr: "idle", activeAttempt: active } }),
        row(
          "2026-09-15T10:00:30.000Z",
          { builder: { herdr: "working", activeAttempt: null } },
          "completed",
        ),
      ],
      records,
    );
    expect(result["disagreements"]).toEqual([
      {
        at: "2026-09-15T10:00:20.000Z",
        agentId: "builder",
        kind: "soft",
        herdr: "working",
        sinceAcceptedMs: 20_000,
      },
      {
        at: "2026-09-15T10:00:21.000Z",
        agentId: "reviewer",
        kind: "soft",
        herdr: "working",
        sinceAcceptedMs: null,
      },
      { at: "2026-09-15T10:00:22.000Z", agentId: "reviewer", kind: "hard", herdr: "gone" },
      {
        at: "2026-09-15T10:00:23.000Z",
        agentId: "builder",
        kind: "hard",
        herdr: "error:not_found",
      },
    ]);
    expect(result["working"]).toEqual({ builder: false, reviewer: false });
  });
});

describe("live gate L4 settled result agreement (LV-005)", () => {
  function agreement(reads: Json[], options: Json = {}): Json {
    const result = runNode(
      `const observer = await import(${JSON.stringify(observerUrl)});
const { reads, options } = JSON.parse(process.argv[1]);
const slept = [];
let next = 0;
const out = await observer.settledResultAgreement(async () => reads[Math.min(next++, reads.length - 1)], {
  ...options,
  sleep: async (ms) => { slept.push(ms); },
});
console.log(JSON.stringify({ ...out, reads: next, slept }));`,
      [JSON.stringify({ reads, options })],
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout.trim()) as Json;
  }

  const derived = { outcome: "completed", revision: 12, counters: { rounds: 1 } };

  it("passes at once when status and outcome.json equal the derived result", () => {
    expect(agreement([{ status: derived, outcome: { ...derived }, derived }])).toEqual({
      pass: true,
      attempts: 1,
      mismatches: [],
      reads: 1,
      slept: [],
    });
  });

  it("re-reads a transient mismatch after the delay and names the read and fields that differed", () => {
    const stale = { ...derived, revision: 11 };
    expect(
      agreement([
        { status: derived, outcome: stale, derived },
        { status: derived, outcome: derived, derived },
      ]),
    ).toEqual({
      pass: true,
      attempts: 2,
      mismatches: [{ attempt: 1, differs: [{ read: "outcome.json", fields: ["revision"] }] }],
      reads: 2,
      slept: [2000],
    });
  });

  it("fails after the bounded attempts when the mismatch persists", () => {
    const out = agreement([{ status: null, outcome: derived, derived: null }], {
      attempts: 3,
      delayMs: 5,
    });
    expect(out).toMatchObject({ pass: false, attempts: 3, reads: 3, slept: [5, 5] });
    expect(out["mismatches"]).toEqual(
      [1, 2, 3].map((attempt) => ({ attempt, differs: [{ read: "derived", fields: [] }] })),
    );
    const diverged = agreement(
      [{ status: null, outcome: { ...derived, outcome: "failed" }, derived }],
      {
        attempts: 1,
      },
    );
    expect(diverged["mismatches"]).toEqual([
      {
        attempt: 1,
        differs: [
          { read: "status", fields: ["(whole value)"] },
          { read: "outcome.json", fields: ["outcome"] },
        ],
      },
    ]);
  });
});
