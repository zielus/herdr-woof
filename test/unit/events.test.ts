import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";
import {
  PLAN,
  REV,
  accepted,
  assigned,
  attempt,
  blocked,
  checkGate,
  dispatched,
  duplicate,
  gate,
  journalOf,
  opened,
  reconciled,
  rejected,
  terminated,
  unblocked,
} from "../helpers/records.js";

type Json = Record<string, unknown>;
interface Event {
  seq: number;
  type: string;
  cursor: string;
  runId: string;
  subject: Json;
  data: Json;
  kind: string;
  schemaVersion: number;
  ts: string;
}
interface Snapshot extends Json {
  cursor: string;
}
type Fold =
  | { ok: true; projection: { snapshot: Snapshot; records: Json[] } }
  | { ok: false; reason: string; message: string };

let parse: (line: string) => Json | string;
let replay: (records: Json[]) => { ok: true } | { ok: false; reason: string };
let deriveSnapshot: (records: Json[]) => { ok: true; snapshot: Snapshot };
let projectEvents: (records: Json[], anchor: string) => Event[];
let foldEvents: (base: { snapshot: Snapshot; records: Json[] } | null, events: Event[]) => Fold;
let checkCursor: (
  cursor: string,
  head: { revision: number; anchor: string },
) => { ok: true; seq: number } | { ok: false; reason: string };
let formatCursor: (seq: number, anchor: string) => string;
let parseCursor: (cursor: string) => { seq: number; anchor: string } | undefined;

beforeAll(async () => {
  ({ parseRecordLine: parse } = await loadDist<{ parseRecordLine: typeof parse }>(
    "journal/records.js",
  ));
  ({ replay } = await loadDist<{ replay: typeof replay }>("state/reducer.js"));
  ({ deriveSnapshot } = await loadDist<{ deriveSnapshot: typeof deriveSnapshot }>(
    "state/snapshot.js",
  ));
  ({ projectEvents, foldEvents } = await loadDist<{
    projectEvents: typeof projectEvents;
    foldEvents: typeof foldEvents;
  }>("observe/events.js"));
  ({ checkCursor, formatCursor, parseCursor } = await loadDist<{
    checkCursor: typeof checkCursor;
    formatCursor: typeof formatCursor;
    parseCursor: typeof parseCursor;
  }>("observe/cursor.js"));
});

const ANCHOR = "0123456789ab";

const anchorOf = (records: Json[]) =>
  deriveSnapshot(records).snapshot.cursor.split(".")[2] as string;

describe("cursor", () => {
  it("round-trips and rejects malformed cursors", () => {
    expect(parseCursor(formatCursor(42, ANCHOR))).toEqual({ seq: 42, anchor: ANCHOR });
    expect(parseCursor(formatCursor(0, ANCHOR))).toEqual({ seq: 0, anchor: ANCHOR });
    for (const bad of [
      "",
      "v2.1.0123456789ab",
      "v1.-1.0123456789ab",
      "v1.01.0123456789ab",
      "v1.1.0123456789AB",
      "v1.1.0123456789a",
      "v1.1.0123456789abc",
      "v1.9007199254740993.0123456789ab",
      "v1..0123456789ab",
    ]) {
      expect(parseCursor(bad), bad).toBeUndefined();
    }
  });

  it("checks a cursor against the journal head", () => {
    const head = { revision: 5, anchor: ANCHOR };
    expect(checkCursor(formatCursor(5, ANCHOR), head)).toEqual({ ok: true, seq: 5 });
    expect(checkCursor(formatCursor(0, ANCHOR), head)).toEqual({ ok: true, seq: 0 });
    expect(checkCursor(formatCursor(6, ANCHOR), head)).toMatchObject({
      ok: false,
      reason: "cursor_ahead",
    });
    expect(checkCursor(formatCursor(2, "ba9876543210"), head)).toMatchObject({
      ok: false,
      reason: "cursor_foreign",
    });
    expect(checkCursor("v1.x", head)).toMatchObject({ ok: false, reason: "cursor_malformed" });
  });
});

describe("projectEvents", () => {
  it("projects every record type 1:1 with subjects and data", () => {
    const records = journalOf(
      parse,
      opened(null),
      assigned("builder", "w1:p1"),
      attempt("build", "builder"),
      dispatched("build", "builder", 1, 1, "ambiguous", "stalled"),
      rejected("artifact_missing", {
        runId: "run-1",
        agentId: "builder",
        stageId: "build",
        visit: 1,
        attempt: 1,
      }),
      rejected("envelope_malformed"),
      accepted(7, "build", "builder", null),
      duplicate(7),
      gate(7, "build"),
      blocked("builder"),
      unblocked("builder"),
      blocked("builder", ["build", 1, 1]),
      reconciled(4, "build", "builder"),
      terminated("completed"),
    );
    const events = projectEvents(records, ANCHOR);

    expect(events.map((event) => [event.seq, event.type, event.cursor])).toEqual(
      records.map((record) => [
        record["seq"],
        record["type"],
        `v1.${String(record["seq"])}.${ANCHOR}`,
      ]),
    );
    const buildSubject = { agentId: "builder", stageId: "build", visit: 1, attempt: 1 };
    expect(events.map((event) => event.subject)).toEqual([
      {},
      { agentId: "builder" },
      buildSubject,
      buildSubject,
      buildSubject,
      {},
      buildSubject,
      buildSubject,
      { stageId: "build", visit: 1, attempt: 1 },
      { agentId: "builder" },
      { agentId: "builder" },
      buildSubject,
      buildSubject,
      {},
    ]);
    for (const [index, event] of events.entries()) {
      expect(event).toMatchObject({ schemaVersion: 1, kind: "woof.run.event", runId: "run-1" });
      const { schemaVersion: _v, seq: _s, ts: _t, type: _y, ...data } = records[index] as Json;
      expect(event.data).toEqual(data);
      expect(event.ts).toBe(records[index]?.["ts"]);
    }
  });
});

/** Xorshift32: deterministic pseudo-random numbers in [0, 1). */
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
}

/**
 * A valid journal built by proposing random records and keeping those the
 * reducer accepts. Some proposals are invalid by construction; the reason of
 * every refused proposal is added to `refusals`.
 */
function generateJournal(seed: number, refusals: Set<string>): Json[] {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const plan = next() < 0.5 ? PLAN : null;
  const records = journalOf(
    parse,
    opened(plan !== null && next() < 0.5 ? { ...PLAN, checks: ["verify"] } : plan),
  );
  const length = 5 + Math.floor(next() * 36);
  const ofType = (type: string) => records.filter((record) => record["type"] === type);
  for (let tries = 0; records.length < length && tries < 600; tries += 1) {
    const seq = records.length + 1;
    const agent = pick(["builder", "reviewer"]);
    const stage = agent === "builder" ? "build" : "review";
    const visit = 1 + Math.floor(next() * 2);
    const attemptNo = 1 + Math.floor(next() * 3);
    const roll = next();
    let body: Json;
    if (roll < 0.1) {
      body = assigned(agent, `w1:${agent}-${Math.floor(next() * 3)}`);
      if (next() < 0.5) body = { ...body, terminalId: pick(["term-a", "term-b"]) };
    } else if (roll < 0.28) {
      body = attempt(stage, agent, visit, attemptNo);
    } else if (roll < 0.4) {
      const [delivery, reason] = pick([
        ["started", "observed_working"],
        ["ambiguous", "timeout"],
        ["not_delivered", "not_found"],
      ] as const);
      body = dispatched(stage, agent, visit, attemptNo, delivery, reason);
      if (next() < 0.3) {
        const target = { terminalId: pick(["term-a", "term-b"]), sessionId: null };
        body = { ...body, target, revision: REV };
      }
    } else if (roll < 0.52) {
      body = accepted(
        seq,
        stage,
        agent,
        stage === "review" ? pick(["approve", "reject"]) : null,
        visit,
        attemptNo,
      );
    } else if (roll < 0.57) {
      const acceptances = ofType("submission.accepted");
      if (acceptances.length === 0) continue;
      body = duplicate(pick(acceptances)["seq"] as number);
    } else if (roll < 0.63) {
      body = rejected(pick(["artifact_missing", "attempt_stale", "run_closed"]), {
        runId: "run-1",
        agentId: agent,
        stageId: stage,
        visit,
        attempt: attemptNo,
      });
    } else if (roll < 0.72) {
      const acceptances = ofType("submission.accepted");
      if (acceptances.length === 0) continue;
      const target = pick(acceptances);
      const ref = [
        target["stageId"] as string,
        target["visit"] as number,
        target["attempt"] as number,
      ] as const;
      const overrides = {
        round: Math.floor(next() * 3),
        next: pick([
          { stageId: "review" },
          { stageId: "verify" },
          { stageId: "deploy" },
          { outcome: "completed" },
        ]),
      };
      body =
        next() < 0.6
          ? gate(target["seq"] as number, ...ref, { ...overrides, verdict: target["verdict"] })
          : checkGate(target["seq"] as number, pick(["verify", "lint"]), ...ref, overrides);
    } else if (roll < 0.76) {
      body = next() < 0.5 ? blocked(agent) : blocked(agent, [stage, visit, attemptNo]);
    } else if (roll < 0.79) {
      body = unblocked(agent);
    } else if (roll < 0.84) {
      const dispatches = ofType("request.dispatched");
      if (dispatches.length === 0) continue;
      const target = pick(dispatches);
      const [resolution, evidence] = pick([
        ["delivered", "observed_activity"],
        ["delivered", "submission_recorded"],
        ["abandoned", "no_evidence_before_deadline"],
      ] as const);
      body = reconciled(
        target["seq"] as number,
        target["stageId"] as string,
        next() < 0.9 ? (target["agentId"] as string) : agent,
        target["visit"] as number,
        target["attempt"] as number,
        resolution,
        evidence,
      );
    } else if (roll < 0.93) {
      // Invalid by construction (some only under a plan or a known terminal).
      const acceptance = ofType("submission.accepted").at(-1);
      const latest = ofType("attempt.opened").at(-1);
      const acceptedRef =
        acceptance === undefined
          ? undefined
          : ([
              acceptance["stageId"] as string,
              acceptance["visit"] as number,
              acceptance["attempt"] as number,
            ] as const);
      body = pick([
        opened(PLAN, "run-2"),
        attempt(stage, agent, visit, attemptNo, undefined, "run-2"),
        attempt("deploy", agent, visit, attemptNo),
        attempt(stage, agent === "builder" ? "reviewer" : "builder", visit, attemptNo),
        attempt("review", "reviewer", visit, attemptNo, ["approve"]),
        assigned("stranger"),
        duplicate(1),
        gate(1, stage, visit, attemptNo),
        latest === undefined
          ? duplicate(1)
          : {
              ...dispatched(
                latest["stageId"] as string,
                latest["agentId"] as string,
                latest["visit"] as number,
                latest["attempt"] as number,
              ),
              target: { terminalId: "term-z", sessionId: null },
            },
        acceptance === undefined || acceptedRef === undefined
          ? duplicate(1)
          : gate(acceptance["seq"] as number, ...acceptedRef, {
              gate: "other",
              verdict: acceptance["verdict"],
            }),
        acceptance === undefined || acceptedRef === undefined
          ? duplicate(1)
          : checkGate(
              acceptance["seq"] as number,
              acceptedRef[0] === "build" ? "review" : "build",
              ...acceptedRef,
            ),
      ]);
    } else {
      body = terminated(pick(["completed", "failed", "cancelled"]));
    }
    const record = parse(
      JSON.stringify({
        schemaVersion: 1,
        seq,
        ts: new Date(Date.UTC(2026, 8, 14, 11, 0, 0, seq)).toISOString(),
        ...body,
      }),
    );
    if (typeof record === "string") continue;
    const replayed = replay([...records, record]);
    if (!replayed.ok) {
      refusals.add(replayed.reason);
      continue;
    }
    records.push(record);
  }
  return records;
}

describe("snapshot and events consistency", () => {
  it("fold(snapshot@N, events after N) equals a fresh snapshot for 200 seeded journals at every split", () => {
    let checks = 0;
    const types = new Set<string>();
    const refusals = new Set<string>();
    for (let seed = 1; seed <= 200; seed += 1) {
      const records = generateJournal(seed, refusals);
      for (const record of records) types.add(record["type"] as string);
      const fresh = deriveSnapshot(records).snapshot;
      const events = projectEvents(records, anchorOf(records));
      for (let split = 1; split <= records.length; split += 1) {
        const prefix = records.slice(0, split);
        const base = { snapshot: deriveSnapshot(prefix).snapshot, records: prefix };
        const folded = foldEvents(base, events.slice(split));
        expect(folded.ok, `seed ${seed} split ${split}`).toBe(true);
        if (folded.ok) expect(folded.projection.snapshot).toEqual(fresh);
        // At-least-once delivery: replaying an already folded event changes nothing.
        const overlapping = foldEvents(base, events.slice(split - 1));
        if (overlapping.ok) expect(overlapping.projection.snapshot).toEqual(fresh);
        checks += 1;
      }
      const fromNothing = foldEvents(null, events);
      expect(fromNothing.ok && fromNothing.projection.snapshot).toEqual(fresh);
    }
    expect(checks).toBeGreaterThan(1000);
    // The generator exercises every record type the reducer knows.
    expect([...types].toSorted()).toEqual([
      "agent.assigned",
      "attempt.opened",
      "delivery.reconciled",
      "gate.recorded",
      "request.dispatched",
      "run.blocked",
      "run.opened",
      "run.terminated",
      "run.unblocked",
      "submission.accepted",
      "submission.duplicate",
      "submission.rejected",
    ]);
    // The refused proposals reach every reducer refusal reason (the closed ReducerReason set).
    expect([...refusals].toSorted()).toEqual([
      "agent_busy",
      "agent_unassigned",
      "agent_unknown",
      "assignment_mismatch",
      "assignment_unchanged",
      "attempt_open_conflict",
      "attempt_unknown",
      "dispatch_exists",
      "dispatch_not_ambiguous",
      "gate_exists",
      "gate_mismatch",
      "gate_subject_stale",
      "gate_subject_unknown",
      "invalid_transition",
      "not_blocked",
      "owner_mismatch",
      "reconcile_exists",
      "round_invalid",
      "run_blocked",
      "run_closed",
      "run_exists",
      "run_mismatch",
      "stage_unknown",
      "verdicts_mismatch",
    ]);
  });

  it("requires a resync for a gap, another run or nothing to fold, and fails closed on an invalid event", () => {
    const records = journalOf(
      parse,
      opened(),
      assigned("builder"),
      attempt("build", "builder"),
      terminated(),
    );
    const anchor = anchorOf(records);
    const events = projectEvents(records, anchor);
    const base = {
      snapshot: deriveSnapshot(records.slice(0, 1)).snapshot,
      records: records.slice(0, 1),
    };

    expect(foldEvents(base, events.slice(2))).toMatchObject({
      ok: false,
      reason: "resync_required",
    });
    const foreign = projectEvents(records, "ba9876543210");
    expect(foldEvents(base, foreign.slice(1))).toMatchObject({
      ok: false,
      reason: "resync_required",
    });
    expect(foldEvents(null, [])).toMatchObject({ ok: false, reason: "resync_required" });
    const invalid = {
      ...(events[1] as Event),
      data: { ...(events[1] as Event).data, agentId: "../x" },
    };
    expect(foldEvents(base, [invalid])).toMatchObject({ ok: false, reason: "journal_corrupt" });
  });

  it("fails closed on an envelope that is not a v1 woof.run.event, before reading its cursor", () => {
    const records = journalOf(parse, opened(), assigned("builder"));
    const events = projectEvents(records, anchorOf(records));
    const event = events[1] as Event;
    const base = {
      snapshot: deriveSnapshot(records.slice(0, 1)).snapshot,
      records: records.slice(0, 1),
    };
    for (const forged of [
      { ...event, schemaVersion: 2 },
      { ...event, kind: "woof.run.snapshot" },
      { ...event, kind: "woof.run.snapshot", cursor: "not-a-cursor" },
      { ...event, schemaVersion: 0, cursor: "v1.9.ba9876543210" },
    ]) {
      expect(foldEvents(base, [forged]), JSON.stringify(forged)).toMatchObject({
        ok: false,
        reason: "journal_corrupt",
      });
      expect(foldEvents(null, [events[0] as Event, forged])).toMatchObject({
        ok: false,
        reason: "journal_corrupt",
      });
    }
  });

  it("without a base, requires every event to name the run of the first run.opened event", () => {
    const records = journalOf(parse, opened(), assigned("builder"), attempt("build", "builder"));
    const events = projectEvents(records, anchorOf(records));
    expect(foldEvents(null, events)).toMatchObject({ ok: true });

    const envelope = events.map((event, index) =>
      index === 1 ? { ...event, runId: "run-2" } : event,
    );
    expect(foldEvents(null, envelope)).toMatchObject({ ok: false, reason: "journal_corrupt" });

    const attemptEvent = events[2] as Event;
    const data = [
      events[0] as Event,
      events[1] as Event,
      { ...attemptEvent, data: { ...attemptEvent.data, runId: "run-2" } },
    ];
    expect(foldEvents(null, data)).toMatchObject({ ok: false, reason: "journal_corrupt" });

    const openedEvent = events[0] as Event;
    const everyEnvelopeWrong: Event[] = [];
    for (const event of events) everyEnvelopeWrong.push({ ...event, runId: "run-2" });
    expect(openedEvent.data["runId"]).toBe("run-1");
    expect(foldEvents(null, everyEnvelopeWrong)).toMatchObject({
      ok: false,
      reason: "journal_corrupt",
    });
  });

  it("fails closed on an event whose subject differs from its record", () => {
    const records = journalOf(
      parse,
      opened(),
      attempt("build", "builder"),
      accepted(3, "build", "builder", null),
      duplicate(3),
    );
    const events = projectEvents(records, anchorOf(records));
    expect(foldEvents(null, events)).toMatchObject({ ok: true });

    const attemptEvent = events[1] as Event;
    const wrongAgent = {
      ...attemptEvent,
      subject: { ...attemptEvent.subject, agentId: "reviewer" },
    };
    expect(foldEvents(null, [events[0] as Event, wrongAgent])).toMatchObject({
      ok: false,
      reason: "journal_corrupt",
    });

    const duplicateEvent = events[3] as Event;
    for (const subject of [{}, { ...duplicateEvent.subject, attempt: 2 }]) {
      expect(
        foldEvents(null, [...events.slice(0, 3), { ...duplicateEvent, subject }]),
      ).toMatchObject({
        ok: false,
        reason: "journal_corrupt",
      });
    }
    const base = { snapshot: deriveSnapshot(records).snapshot, records };
    expect(foldEvents(base, [wrongAgent])).toMatchObject({ ok: false, reason: "journal_corrupt" });
  });

  it("fails closed on an event whose cursor is not positioned after its own seq", () => {
    const records = journalOf(parse, opened(), assigned("builder"));
    const anchor = anchorOf(records);
    const events = projectEvents(records, anchor);
    const base = {
      snapshot: deriveSnapshot(records.slice(0, 1)).snapshot,
      records: records.slice(0, 1),
    };
    const misplaced = { ...(events[1] as Event), cursor: formatCursor(1, anchor) };

    expect((events[1] as Event).seq).toBe(2);
    expect(foldEvents(base, [misplaced])).toMatchObject({ ok: false, reason: "journal_corrupt" });
    expect(foldEvents(base, [events[1] as Event])).toMatchObject({ ok: true });
  });

  it("treats the event envelope as authoritative and rejects data carrying envelope fields", () => {
    const records = journalOf(parse, opened(), assigned("builder"));
    const events = projectEvents(records, anchorOf(records));
    const base = {
      snapshot: deriveSnapshot(records.slice(0, 1)).snapshot,
      records: records.slice(0, 1),
    };
    const event = events[1] as Event;
    for (const extra of [
      { type: "run.terminated" },
      { seq: 7 },
      { ts: "2020-01-01T00:00:00.000Z" },
      { schemaVersion: 2 },
    ]) {
      const forged = { ...event, data: { ...event.data, ...extra } };
      expect(foldEvents(base, [forged]), JSON.stringify(extra)).toMatchObject({
        ok: false,
        reason: "journal_corrupt",
      });
    }
    const terminatedAsAssigned: Event = {
      ...event,
      type: "run.terminated",
      data: { outcome: "cancelled", reason: "x", type: "agent.assigned" },
    };
    expect(foldEvents(base, [terminatedAsAssigned])).toMatchObject({
      ok: false,
      reason: "journal_corrupt",
    });
  });

  it("accepts an identical duplicate as a no-op and fails closed on a conflicting one", () => {
    const records = journalOf(parse, opened(), assigned("builder"), attempt("build", "builder"));
    const events = projectEvents(records, anchorOf(records));
    const base = {
      snapshot: deriveSnapshot(records.slice(0, 2)).snapshot,
      records: records.slice(0, 2),
    };
    const fresh = deriveSnapshot(records).snapshot;

    const repeated = foldEvents(base, [events[1] as Event, events[0] as Event, events[2] as Event]);
    expect(repeated.ok).toBe(true);
    if (repeated.ok) expect(repeated.projection.snapshot).toEqual(fresh);

    const assignedEvent = events[1] as Event;
    const conflicting: Event = {
      ...assignedEvent,
      data: {
        ...assignedEvent.data,
        runtime: { adapter: "scripted", runtimeName: "w-builder", paneId: "w1:elsewhere" },
      },
    };
    expect(foldEvents(base, [conflicting, events[2] as Event])).toMatchObject({
      ok: false,
      reason: "journal_corrupt",
    });
    const invalidRepeat: Event = { ...assignedEvent, data: { agentId: "../x" } };
    expect(foldEvents(base, [invalidRepeat])).toMatchObject({
      ok: false,
      reason: "journal_corrupt",
    });
  });

  it("fails closed on a forged second run.opened instead of mixing two runs", () => {
    const records = journalOf(parse, opened(), assigned("builder"));
    const events = projectEvents(records, anchorOf(records));
    const base = { snapshot: deriveSnapshot(records).snapshot, records };
    const forged: Event = {
      ...(events[1] as Event),
      seq: 3,
      type: "run.opened",
      data: { runId: "run-1", plan: { ...PLAN, workflow: { name: "other", version: "9" } } },
    };

    expect(foldEvents(base, [forged])).toMatchObject({ ok: false, reason: "journal_corrupt" });
    expect(foldEvents(null, [...events, forged])).toMatchObject({
      ok: false,
      reason: "journal_corrupt",
    });
    const twoRuns = journalOf(parse, opened(PLAN, "run-one"), opened(null, "run-two"));
    expect(deriveSnapshot(twoRuns)).toMatchObject({ ok: false });
  });
});
