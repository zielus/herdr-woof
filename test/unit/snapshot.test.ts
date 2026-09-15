import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDist, repoRoot } from "../helpers/dist.js";
import {
  HEX,
  PLAN,
  REV,
  accepted,
  assigned,
  attempt,
  blocked,
  checkGate,
  dispatched,
  gate,
  journalOf,
  opened,
  reconciled,
  rejected,
  terminated,
  unblocked,
} from "../helpers/records.js";

type Json = Record<string, unknown>;
type Parse = (line: string) => Json | string;
interface Snapshot {
  runId: string;
  revision: number;
  cursor: string;
  status: string;
  workflow: Json | null;
  limits: Json | null;
  outcome: Json | null;
  counters: Json;
  journal: Json;
  agents: Array<Json & { agentId: string; activeAttempt: Json | null }>;
  stages: Array<{
    stageId: string;
    agentId: string | null;
    verdicts: string[] | null;
    visits: Array<{ visit: number; attempts: Array<Json & { status: string }> }>;
  }>;
  input: Json | null;
  checks: string[] | null;
  gates: Json[];
  attention: { ambiguousDeliveries: Json[]; blocked: Json | null };
  outputs: { latestAcceptedByStage: Record<string, Json> };
  liveness: Json;
  integrity: Json;
}
type Derive = (
  records: readonly Json[],
  options?: { anchor?: string; tailPending?: boolean },
) => { ok: true; snapshot: Snapshot } | { ok: false; reason: string; message: string };

let parse: Parse;
let deriveSnapshot: Derive;

beforeAll(async () => {
  ({ parseRecordLine: parse } = await loadDist<{ parseRecordLine: Parse }>("journal/records.js"));
  ({ deriveSnapshot } = await loadDist<{ deriveSnapshot: Derive }>("state/snapshot.js"));
});

function snapshotOf(...bodies: Json[]): Snapshot {
  const result = deriveSnapshot(journalOf(parse, ...bodies));
  if (!result.ok) throw new Error(result.message);
  return result.snapshot;
}

const attemptAt = (snapshot: Snapshot, stageId: string, visit: number, attemptNo: number) =>
  snapshot.stages
    .find((stage) => stage.stageId === stageId)
    ?.visits.find((item) => item.visit === visit)
    ?.attempts.find((item) => item["attempt"] === attemptNo);

describe("deriveSnapshot status", () => {
  it("derives each run status from the records", () => {
    expect(snapshotOf(opened()).status).toBe("created");
    expect(snapshotOf(opened(), assigned("builder")).status).toBe("starting");
    expect(
      snapshotOf(
        opened(),
        assigned("builder"),
        attempt("build", "builder"),
        dispatched("build", "builder"),
      ).status,
    ).toBe("running");
    for (const outcome of ["completed", "failed", "cancelled"]) {
      expect(snapshotOf(opened(), terminated(outcome)).status).toBe(outcome);
    }
    const exhausted = snapshotOf(opened(), terminated("exhausted", "maxAttemptsPerVisit"));
    expect(exhausted.status).toBe("exhausted");
    expect(exhausted.outcome).toMatchObject({
      outcome: "exhausted",
      limit: "maxAttemptsPerVisit",
      reason: "test",
    });
  });

  it("marks attempts open at termination abandoned and clears active attempts", () => {
    const before = snapshotOf(opened(), assigned("builder"), attempt("build", "builder"));
    expect(attemptAt(before, "build", 1, 1)?.status).toBe("open");
    expect(before.agents[0]?.activeAttempt).toEqual({ stageId: "build", visit: 1, attempt: 1 });

    const after = snapshotOf(
      opened(),
      assigned("builder"),
      attempt("build", "builder"),
      terminated(),
    );
    expect(attemptAt(after, "build", 1, 1)?.status).toBe("abandoned");
    expect(after.agents[0]?.activeAttempt).toBeNull();
    expect(after.outcome).toMatchObject({ outcome: "cancelled", limit: null });
  });
});

describe("deriveSnapshot documents", () => {
  it("lists planned agents and stages with plan metadata, limits and counters", () => {
    const snapshot = snapshotOf(
      opened(),
      assigned("builder", "w1:p7"),
      attempt("build", "builder"),
      dispatched("build", "builder", 1, 1, "not_delivered", "agent_busy"),
    );
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      kind: "woof.run.snapshot",
      runId: "run-1",
      revision: 4,
      journal: { records: 4, tailPending: false },
      workflow: PLAN.workflow,
      limits: PLAN.limits,
      liveness: { owner: "unhosted", runtime: "not_observed" },
      integrity: { artifacts: "unchecked" },
    });
    expect(snapshot.agents).toEqual([
      {
        agentId: "builder",
        role: "builder",
        kind: "claude",
        model: null,
        args: null,
        assignment: {
          adapter: "scripted",
          runtimeName: "w-builder",
          paneId: "w1:p7",
          terminalId: null,
          sessionId: null,
          at: expect.any(String),
        },
        activeAttempt: { stageId: "build", visit: 1, attempt: 1 },
        runtime: null,
      },
      {
        agentId: "reviewer",
        role: "reviewer",
        kind: "claude",
        model: "opus",
        args: null,
        assignment: null,
        activeAttempt: null,
        runtime: null,
      },
    ]);
    expect(snapshot.stages.map((stage) => [stage.stageId, stage.agentId, stage.verdicts])).toEqual([
      ["build", "builder", []],
      ["review", "reviewer", ["approve", "reject"]],
    ]);
    expect(attemptAt(snapshot, "build", 1, 1)).toMatchObject({
      agentId: "builder",
      status: "open",
      paneId: null,
      delivery: "not_delivered",
      accepted: null,
    });
    expect(snapshot.counters["dispatches"]).toEqual({ started: 0, not_delivered: 1, ambiguous: 0 });
  });

  it("derives a p1 journal without a plan", () => {
    const records = readFileSync(join(repoRoot, "test", "fixtures", "p1-journal.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => parse(line) as Json);
    const result = deriveSnapshot(records);
    if (!result.ok) throw new Error(result.message);
    const snapshot = result.snapshot;
    expect(snapshot.workflow).toBeNull();
    expect(snapshot.limits).toBeNull();
    expect(snapshot.checks).toBeNull();
    expect(snapshot.input).toBeNull();
    expect(snapshot.gates).toEqual([]);
    expect(snapshot.attention).toEqual({ ambiguousDeliveries: [], blocked: null });
    expect(snapshot.status).toBe("created");
    expect(snapshot.agents).toEqual([
      {
        agentId: "worker",
        role: null,
        kind: null,
        model: null,
        args: null,
        assignment: null,
        activeAttempt: null,
        runtime: null,
      },
    ]);
    expect(snapshot.stages).toEqual([
      {
        stageId: "report",
        agentId: null,
        verdicts: null,
        visits: [
          {
            visit: 1,
            attempts: [
              {
                attempt: 1,
                seq: 2,
                agentId: "worker",
                status: "accepted",
                cause: "initial",
                openedAt: "2026-09-10T10:00:01.000Z",
                paneId: "w1:p1",
                delivery: "undispatched",
                dispatch: null,
                request: null,
                target: null,
                revision: null,
                reconciliation: null,
                rejections: { artifact_missing: 1 },
                rejectionLog: [
                  {
                    seq: 3,
                    reason: "artifact_missing",
                    message: "artifacts/report/visit-1/attempt-1/report.md does not exist",
                  },
                ],
                accepted: {
                  seq: 4,
                  receiptId: "rcpt-4-ace34e83039e",
                  status: "completed",
                  verdict: "pass",
                  artifact: {
                    path: "artifacts/report/visit-1/attempt-1/report.md",
                    acceptedPath: "accepted/report/visit-1/attempt-1/report.md",
                    sha256: "fee2183d0bca324428fcd2f491d264ed18fc979fb454e7035c99271360c7b9f0",
                    bytes: 71,
                  },
                  at: "2026-09-10T10:02:00.000Z",
                },
              },
            ],
          },
        ],
      },
    ]);
    expect(snapshot.outputs.latestAcceptedByStage).toEqual({
      report: {
        stageId: "report",
        visit: 1,
        attempt: 1,
        receiptId: "rcpt-4-ace34e83039e",
        acceptedPath: "accepted/report/visit-1/attempt-1/report.md",
      },
    });
    // The fixture was written like the engine writes, so the default anchor is the raw one.
    const firstLine = readFileSync(
      join(repoRoot, "test", "fixtures", "p1-journal.jsonl"),
      "utf8",
    ).split("\n")[0] as string;
    const anchor = createHash("sha256").update(firstLine).digest("hex").slice(0, 12);
    expect(snapshot.cursor).toBe(`v1.5.${anchor}`);
  });

  it("never embeds artifact bodies or envelope digests", () => {
    const snapshot = snapshotOf(
      opened(null),
      attempt("build", "builder"),
      accepted(3, "build", "builder", null),
    );
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("envelopeDigest");
    expect(Object.keys(attemptAt(snapshot, "build", 1, 1)?.["accepted"] as Json)).toEqual([
      "seq",
      "receiptId",
      "status",
      "verdict",
      "artifact",
      "at",
    ]);
  });

  it("uses the given anchor and tail state", () => {
    const result = deriveSnapshot(journalOf(parse, opened()), {
      anchor: "0123456789ab",
      tailPending: true,
    });
    expect(result.ok && result.snapshot.cursor).toBe("v1.1.0123456789ab");
    expect(result.ok && result.snapshot.journal).toEqual({ records: 1, tailPending: true });
  });

  it("reports a journal without run.opened as run_dir_invalid", () => {
    expect(deriveSnapshot([])).toMatchObject({ ok: false, reason: "run_dir_invalid" });
  });
});

describe("deriveSnapshot with prototype-named ids", () => {
  // `__proto__` is not a valid id (ID_PATTERN needs a leading letter or digit);
  // these ids are, and they collide with Object.prototype members.
  const plan = {
    ...PLAN,
    agents: [
      { agentId: "hasOwnProperty", role: "writer", kind: "claude", model: null },
      { agentId: "valueOf", role: "reviewer", kind: "claude", model: null },
    ],
    stages: [
      { stageId: "constructor", agentId: "hasOwnProperty", verdicts: [] },
      { stageId: "toString", agentId: "valueOf", verdicts: [] },
    ],
  };

  it("counts, groups and indexes them as ordinary keys in null-prototype dictionaries", () => {
    const snapshot = snapshotOf(
      opened(plan),
      assigned("hasOwnProperty", "w1:a"),
      assigned("hasOwnProperty", "w1:b"),
      attempt("constructor", "hasOwnProperty"),
      accepted(5, "constructor", "hasOwnProperty", null),
      attempt("toString", "valueOf"),
      rejected("artifact_missing", {
        runId: "run-1",
        agentId: "valueOf",
        stageId: "toString",
        visit: 1,
        attempt: 1,
      }),
      attempt("constructor", "hasOwnProperty", 2, 1),
      accepted(9, "constructor", "hasOwnProperty", null, 2, 1),
    );
    const counters = snapshot.counters as Record<string, Record<string, unknown>>;
    const latest = snapshot.outputs.latestAcceptedByStage;

    for (const value of [
      counters["visitsByStage"],
      counters["attemptsByVisit"],
      counters["rejectionsByReason"],
      counters["replacementsByAgent"],
      latest,
      attemptAt(snapshot, "toString", 1, 1)?.["rejections"],
    ]) {
      expect(Object.getPrototypeOf(value)).toBeNull();
    }
    const plain = JSON.parse(JSON.stringify(snapshot)) as Snapshot;
    expect(plain.counters).toMatchObject({
      attemptsOpened: 3,
      visitsByStage: { constructor: 2, toString: 1 },
      attemptsByVisit: { "constructor/1": 1, "constructor/2": 1, "toString/1": 1 },
      rejectionsByReason: { artifact_missing: 1 },
      replacementsByAgent: { hasOwnProperty: 1 },
      submissionsAccepted: 2,
    });
    expect(Object.keys(plain.outputs.latestAcceptedByStage)).toEqual(["constructor"]);
    expect(plain.outputs.latestAcceptedByStage["constructor"]).toMatchObject({
      stageId: "constructor",
      visit: 2,
      attempt: 1,
    });
    expect(attemptAt(plain, "toString", 1, 1)?.["rejections"]).toEqual({ artifact_missing: 1 });
  });
});

describe("deriveSnapshot attention and outputs", () => {
  it("lists an ambiguous delivery until its attempt is superseded", () => {
    const base = [
      opened(),
      assigned("builder"),
      attempt("build", "builder"),
      dispatched("build", "builder", 1, 1, "ambiguous", "stalled"),
    ];
    expect(snapshotOf(...base).attention.ambiguousDeliveries).toEqual([
      { stageId: "build", visit: 1, attempt: 1, agentId: "builder", reason: "stalled" },
    ]);
    const superseded = snapshotOf(...base, attempt("build", "builder", 1, 2));
    expect(superseded.attention.ambiguousDeliveries).toEqual([]);
    expect(attemptAt(superseded, "build", 1, 1)).toMatchObject({
      status: "superseded",
      delivery: "ambiguous",
    });
  });

  it("drops an ambiguous delivery once its attempt is accepted", () => {
    const snapshot = snapshotOf(
      opened(null),
      assigned("builder"),
      attempt("build", "builder"),
      dispatched("build", "builder", 1, 1, "ambiguous", "timeout"),
      accepted(5, "build", "builder", null),
    );
    expect(snapshot.attention.ambiguousDeliveries).toEqual([]);
  });

  it("keeps the older accepted visit as the latest output while a newer visit is open or rejected", () => {
    const snapshot = snapshotOf(
      opened(null),
      attempt("build", "builder"),
      accepted(3, "build", "builder", null),
      attempt("build", "builder", 2, 1),
      rejected("artifact_missing", {
        runId: "run-1",
        agentId: "builder",
        stageId: "build",
        visit: 2,
        attempt: 1,
      }),
    );
    expect(snapshot.outputs.latestAcceptedByStage["build"]).toMatchObject({
      visit: 1,
      attempt: 1,
      receiptId: `rcpt-3-${"a".repeat(12)}`,
    });
    expect(attemptAt(snapshot, "build", 2, 1)).toMatchObject({
      status: "open",
      accepted: null,
      rejections: { artifact_missing: 1 },
    });
  });

  it("moves the latest output to a newer accepted visit", () => {
    const snapshot = snapshotOf(
      opened(null),
      attempt("build", "builder"),
      accepted(3, "build", "builder", null),
      attempt("build", "builder", 2, 1),
      accepted(5, "build", "builder", null, 2, 1),
    );
    expect(snapshot.outputs.latestAcceptedByStage["build"]).toMatchObject({ visit: 2, attempt: 1 });
  });
});

describe("deriveSnapshot p3 projection", () => {
  const request = { path: "requests/build/visit-1/attempt-1/request.md", sha256: HEX, bytes: 42 };
  // seq: 1 opened, 2 assigned, 3 attempt, 4 dispatch, 5 accepted.
  const built = (plan: Json = PLAN) => [
    opened(plan),
    { ...assigned("builder"), terminalId: "term-1" },
    attempt("build", "builder"),
    {
      ...dispatched("build", "builder"),
      request,
      target: { terminalId: "term-1", sessionId: "sess-1" },
      revision: REV,
    },
    accepted(5, "build", "builder", null),
  ];

  it("reports limits with maxFormatRepairs, planned checks, agent args and the input digest", () => {
    const plan = {
      ...PLAN,
      checks: ["verify"],
      agents: [{ ...PLAN.agents[0], args: ["--add-dir", "/run"] }, PLAN.agents[1]],
    };
    const snapshot = snapshotOf({
      ...opened(plan),
      input: { path: "input.json", sha256: HEX, bytes: 7 },
    });
    expect(snapshot.limits).toEqual({ ...PLAN.limits, maxFormatRepairs: 0 });
    expect(snapshot.checks).toEqual(["verify"]);
    expect(snapshot.agents.map((agent) => agent["args"])).toEqual([["--add-dir", "/run"], null]);
    expect(snapshot.input).toEqual({ path: "input.json", sha256: HEX, bytes: 7 });
    const withRepairs = snapshotOf(
      opened({ ...PLAN, limits: { ...PLAN.limits, maxFormatRepairs: 2 } }),
    );
    expect(withRepairs.limits?.["maxFormatRepairs"]).toBe(2);
  });

  it("reports checks null when the plan lists none, including an explicit empty list", () => {
    expect(snapshotOf(opened({ ...PLAN, checks: [] })).checks).toBeNull();
    expect(snapshotOf(opened(PLAN)).checks).toBeNull();
  });

  it("projects attempt cause, dispatch, request, target and revision", () => {
    const snapshot = snapshotOf(...built(), attempt("build", "builder", 2, 1));
    expect(attemptAt(snapshot, "build", 1, 1)).toMatchObject({
      seq: 3,
      cause: "initial",
      delivery: "started",
      dispatch: { seq: 4, at: expect.any(String), reason: "observed_working" },
      request,
      target: { terminalId: "term-1", sessionId: "sess-1" },
      revision: REV,
      reconciliation: null,
      accepted: { seq: 5 },
    });
    expect(attemptAt(snapshot, "build", 2, 1)).toMatchObject({
      seq: 6,
      cause: "initial",
      dispatch: null,
      request: null,
      target: null,
      revision: null,
    });
    const repaired = snapshotOf(
      opened(),
      assigned("builder"),
      attempt("build", "builder"),
      dispatched("build", "builder"),
      attempt("build", "builder", 1, 2),
    );
    expect(attemptAt(repaired, "build", 1, 2)?.["cause"]).toBe("format_repair");
  });

  it("lists gates in journal order with their subject, next step and evidence", () => {
    const snapshot = snapshotOf(
      ...built(),
      gate(5, "build", 1, 1, { next: { stageId: "verify" } }),
      checkGate(5, "verify", "build", 1, 1, {
        decision: "reject",
        reason: "checks_failed",
        next: { stageId: "repair" },
      }),
    );
    expect(snapshot.gates).toEqual([
      {
        seq: 6,
        at: expect.any(String),
        gate: "build",
        kind: "stage",
        subject: {
          stageId: "build",
          visit: 1,
          attempt: 1,
          acceptedSeq: 5,
          receiptId: `rcpt-5-${HEX.slice(0, 12)}`,
        },
        decision: "pass",
        reason: "built",
        verdict: null,
        round: 0,
        next: { stageId: "verify" },
        revision: REV,
        reviewed: null,
        check: null,
      },
      {
        seq: 7,
        at: expect.any(String),
        gate: "verify",
        kind: "check",
        subject: {
          stageId: "build",
          visit: 1,
          attempt: 1,
          acceptedSeq: 5,
          receiptId: `rcpt-5-${HEX.slice(0, 12)}`,
        },
        decision: "reject",
        reason: "checks_failed",
        verdict: null,
        round: 0,
        next: { stageId: "repair" },
        revision: REV,
        reviewed: null,
        check: {
          command: ["node", "--test"],
          exitCode: 0,
          signal: null,
          timedOut: false,
          evidence: { path: "checks/verify/build-v1-a1/output.log", sha256: HEX, bytes: 10 },
        },
      },
    ]);
    expect(snapshot.counters).toMatchObject({
      rounds: 0,
      gatesByDecision: { pass: 1, reject: 1 },
      gatesByGate: { build: 1, verify: 1 },
    });
  });

  it("shows the unresolved block in attention and clears it after unblock", () => {
    const base = [
      opened(),
      assigned("builder"),
      attempt("build", "builder"),
      dispatched("build", "builder"),
    ];
    const snapshot = snapshotOf(...base, blocked("builder", ["build", 1, 1]));
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.attention.blocked).toEqual({
      seq: 5,
      agentId: "builder",
      reason: "blocked_on_input",
      requiredAction: "answer the prompt in the pane of builder",
      since: expect.any(String),
      observed: { runtimeStatus: "blocked", terminalId: "term-1", stateChangeSeq: 3 },
      attempt: { stageId: "build", visit: 1, attempt: 1 },
    });
    const resumed = snapshotOf(...base, blocked("builder"), unblocked("builder"));
    expect(resumed.status).toBe("running");
    expect(resumed.attention.blocked).toBeNull();
    expect(resumed.counters["blocks"]).toBe(1);
  });

  it("removes a reconciled ambiguous delivery from attention and projects the reconciliation", () => {
    const base = [
      opened(),
      assigned("builder"),
      attempt("build", "builder"),
      dispatched("build", "builder", 1, 1, "ambiguous", "stalled"),
    ];
    expect(snapshotOf(...base).attention.ambiguousDeliveries).toHaveLength(1);
    const snapshot = snapshotOf(...base, reconciled(4, "build", "builder"));
    expect(snapshot.attention.ambiguousDeliveries).toEqual([]);
    expect(attemptAt(snapshot, "build", 1, 1)).toMatchObject({
      status: "open",
      delivery: "ambiguous",
      reconciliation: { seq: 5, resolution: "delivered", evidence: "observed_activity" },
    });
    expect(snapshot.counters["reconciliations"]).toEqual({ delivered: 1, abandoned: 0 });
  });

  it("carries the termination seq on the outcome", () => {
    const snapshot = snapshotOf(
      opened(),
      assigned("builder"),
      terminated("exhausted", "maxFormatRepairs"),
    );
    expect(snapshot.outcome).toEqual({
      outcome: "exhausted",
      reason: "test",
      limit: "maxFormatRepairs",
      at: expect.any(String),
      seq: 3,
    });
  });
});

describe("deriveSnapshot liveness and recorded configuration (p4)", () => {
  const fixture = (name: string): Json[] =>
    readFileSync(join(repoRoot, "test", "fixtures", name), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const parsed = parse(line);
        if (typeof parsed === "string") throw new Error(`${name}: ${parsed}`);
        return parsed;
      });

  it("derives p1, p2 and p3-shaped journals as unhosted with no host and no configuration", () => {
    for (const records of [
      fixture("p1-journal.jsonl"),
      fixture("p2-journal.jsonl"),
      journalOf(parse, opened(), assigned("builder")),
    ]) {
      const derived = deriveSnapshot(records);
      expect(derived.ok).toBe(true);
      const snapshot = (derived as unknown as { snapshot: Snapshot & { config: unknown } })
        .snapshot;
      expect(snapshot.liveness).toEqual({ owner: "unhosted", runtime: "not_observed", host: null });
      expect(snapshot.config).toBeNull();
    }
  });

  it("carries the config digest from run.opened and refuses a malformed one", () => {
    const config = { path: "config.json", sha256: HEX, bytes: 12 };
    const snapshot = snapshotOf({ ...opened(), config }) as Snapshot & { config: unknown };
    expect(snapshot.config).toEqual(config);
    const line = (body: Json) =>
      JSON.stringify({
        schemaVersion: 1,
        seq: 1,
        ts: "2026-09-14T10:00:00.000Z",
        ...opened(),
        ...body,
      });
    expect(parse(line({ config: { ...config, path: "other.json" } }))).toContain(
      "config.path is not config.json",
    );
    expect(parse(line({ config: { ...config, sha256: "x" } }))).toContain("config.sha256");
  });
});

describe("host probe rules (p4, pure)", () => {
  type HostInfo = Json & { state: string; heartbeatAt: string | null };
  let parseHostInfo: (text: string, mtime: Date) => HostInfo | undefined;
  let ownerOf: (host: HostInfo, options?: { now?: number; terminal?: boolean }) => string;
  beforeAll(async () => {
    ({ parseHostInfo, ownerOf } = await loadDist<{
      parseHostInfo: typeof parseHostInfo;
      ownerOf: typeof ownerOf;
    }>("host/probe.js"));
  });

  const beat = new Date("2026-09-15T10:00:00.000Z");
  const claim = (body: Json = {}) =>
    JSON.stringify({
      schemaVersion: 1,
      kind: "woof.host",
      state: "hosting",
      pid: 4242,
      hostname: "remote.invalid",
      startedAt: "2026-09-15T09:59:00.000Z",
      heartbeatMs: 2000,
      ...body,
    });

  it("parses a claim and takes the heartbeat from the mtime", () => {
    expect(parseHostInfo(claim({ paneId: "w1:p2" }), beat)).toEqual({
      state: "hosting",
      pid: 4242,
      hostname: "remote.invalid",
      paneId: "w1:p2",
      workspaceId: null,
      startedAt: "2026-09-15T09:59:00.000Z",
      heartbeatMs: 2000,
      heartbeatAt: beat.toISOString(),
      exitedAt: null,
      exitCode: null,
    });
  });

  it("rejects other kinds, versions, states and a hosting claim without a heartbeat interval", () => {
    for (const body of [
      { kind: "woof.launch" },
      { schemaVersion: 2 },
      { state: "running" },
      { heartbeatMs: 0 },
      // PR #6 (probe.ts:210): a hosting claim carries every field claimHost writes.
      { pid: null },
      { pid: 0 },
      { pid: "4242" },
      { hostname: null },
      { hostname: "" },
      { startedAt: null },
      { startedAt: "" },
      { heartbeatMs: null },
    ]) {
      expect(parseHostInfo(claim(body), beat), JSON.stringify(body)).toBeUndefined();
    }
    expect(parseHostInfo("[]", beat)).toBeUndefined();
  });

  it("is alive within five heartbeats, lost after, exited when terminal, and follows state", () => {
    const host = parseHostInfo(claim(), beat) as HostInfo;
    const at = beat.getTime();
    expect(ownerOf(host, { now: at + 10_000 })).toBe("alive");
    expect(ownerOf(host, { now: at + 10_001 })).toBe("lost");
    expect(ownerOf(host, { now: at + 10_001, terminal: true })).toBe("exited");
    expect(
      ownerOf(parseHostInfo(claim({ state: "exited" }), beat) as HostInfo, { now: at + 1e9 }),
    ).toBe("exited");
    expect(ownerOf(parseHostInfo(claim({ state: "abandoned" }), beat) as HostInfo)).toBe(
      "unhosted",
    );
  });
});
