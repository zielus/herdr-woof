import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";
import { PLAN, assigned, attempt, dispatched, journalOf, opened } from "../helpers/records.js";

type Json = Record<string, unknown>;
interface Snapshot extends Json {
  agents: Array<Json & { agentId: string; runtime: Json | null }>;
  liveness: Json;
}
interface Tracker {
  accept(observation: Json): { kind: string };
}

let parse: (line: string) => Json | string;
let deriveSnapshot: (records: Json[]) => { ok: true; snapshot: Snapshot };
let overlayRuntime: (snapshot: Snapshot, tracker: Tracker) => Snapshot;
let ObservationTracker: new () => Tracker;

beforeAll(async () => {
  ({ parseRecordLine: parse } = await loadDist<{ parseRecordLine: typeof parse }>(
    "journal/records.js",
  ));
  ({ deriveSnapshot } = await loadDist<{ deriveSnapshot: typeof deriveSnapshot }>(
    "state/snapshot.js",
  ));
  ({ overlayRuntime } = await loadDist<{ overlayRuntime: typeof overlayRuntime }>(
    "runtime/overlay.js",
  ));
  ({ ObservationTracker } = await loadDist<{ ObservationTracker: typeof ObservationTracker }>(
    "runtime/tracker.js",
  ));
});

const observation = (paneId: string, status: string, seq: number): Json => ({
  runtimeName: "w-builder",
  paneId,
  lifecycle: status === "working" ? "working" : "ready",
  runtimeStatus: status,
  sessionId: null,
  order: { terminalId: "t1", stateChangeSeq: seq, revision: null },
  observedAt: "2026-09-14T10:00:00.000Z",
});

describe("overlayRuntime terminal identity and dictionaries", () => {
  const plan = {
    ...PLAN,
    agents: [{ agentId: "hasOwnProperty", role: "writer", kind: "claude", model: null }],
    stages: [{ stageId: "constructor", agentId: "hasOwnProperty", verdicts: [] }],
  };
  const sample = (terminalId: string | null, seq: number, status = "working"): Json => ({
    runtimeName: "w-hasOwnProperty",
    paneId: "w1:p1",
    lifecycle: status === "working" ? "working" : "ready",
    runtimeStatus: status,
    sessionId: null,
    order: { terminalId, stateChangeSeq: seq, revision: null },
    observedAt: "2026-09-14T10:00:00.000Z",
  });
  const snapshotWith = (terminalId: string | null) =>
    deriveSnapshot(
      journalOf(
        parse,
        opened(plan),
        {
          ...assigned("hasOwnProperty", "w1:p1"),
          ...(terminalId === null ? {} : { terminalId }),
        },
        attempt("constructor", "hasOwnProperty"),
      ),
    ).snapshot;

  it("keeps constructor-keyed counters in null-prototype dictionaries", () => {
    const snapshot = snapshotWith("t1");
    const tracker = new ObservationTracker();
    tracker.accept(sample("t1", 3));

    const overlaid = overlayRuntime(snapshot, tracker);
    const counters = overlaid["counters"] as Record<string, Record<string, number>>;

    expect(overlaid.agents[0]?.runtime).toMatchObject({ lifecycle: "working" });
    expect(overlaid.liveness).toEqual({ owner: "unhosted", runtime: "observed", host: null });
    for (const dictionary of [
      counters["visitsByStage"],
      counters["attemptsByVisit"],
      counters["rejectionsByReason"],
      counters["replacementsByAgent"],
      (overlaid["outputs"] as Json)["latestAcceptedByStage"],
    ]) {
      expect(Object.getPrototypeOf(dictionary)).toBeNull();
    }
    expect(counters["visitsByStage"]?.["constructor"]).toBe(1);
    expect(counters["attemptsByVisit"]?.["constructor/1"]).toBe(1);
    expect(overlaid["counters"]).not.toBe(snapshot["counters"]);
  });

  it("leaves runtime null and lists the agent in skipped when the observation names another terminal", () => {
    const snapshot = snapshotWith("t1");
    const tracker = new ObservationTracker();
    tracker.accept(sample("t1", 9));
    expect(tracker.accept(sample("t2", 1, "idle")).kind).toBe("replaced");

    const overlaid = overlayRuntime(snapshot, tracker);

    expect(overlaid.agents[0]?.runtime).toBeNull();
    expect(overlaid.liveness).toEqual({ owner: "unhosted", runtime: "not_observed", host: null });
    expect(overlaid["skipped"]).toEqual([
      {
        agentId: "hasOwnProperty",
        runtimeName: "w-hasOwnProperty",
        assignedTerminalId: "t1",
        observedTerminalId: "t2",
      },
    ]);

    // An assignment without a terminal id takes the observation whatever its terminal.
    const unpinned = overlayRuntime(snapshotWith(null), tracker);
    expect(unpinned.agents[0]?.runtime).toMatchObject({ order: { terminalId: "t2" } });
    expect(unpinned["skipped"]).toEqual([]);
  });
});

describe("overlayRuntime", () => {
  it("lays the last accepted observation over the assigned agent without changing journal facts", () => {
    const snapshot = deriveSnapshot(
      journalOf(
        parse,
        opened(),
        assigned("builder", "w1:p1"),
        attempt("build", "builder"),
        dispatched("build", "builder"),
      ),
    ).snapshot;
    const before = JSON.stringify(snapshot);
    const tracker = new ObservationTracker();
    tracker.accept(observation("w1:p1", "working", 4));
    tracker.accept(observation("w1:p1", "done", 6));
    tracker.accept(observation("w1:p1", "working", 5));

    const overlaid = overlayRuntime(snapshot, tracker);

    expect(overlaid.agents[0]?.runtime).toEqual({
      lifecycle: "ready",
      runtimeStatus: "done",
      observedAt: "2026-09-14T10:00:00.000Z",
      order: { terminalId: "t1", stateChangeSeq: 6, revision: null },
    });
    expect(overlaid.agents[1]?.runtime).toBeNull();
    expect(overlaid.liveness).toEqual({ owner: "unhosted", runtime: "observed", host: null });
    // Everything journal-derived is identical; the input snapshot is not mutated.
    expect(overlaid["skipped"]).toEqual([]);
    expect({ ...overlaid, agents: undefined, liveness: undefined, skipped: undefined }).toEqual({
      ...(JSON.parse(before) as Json),
      agents: undefined,
      liveness: undefined,
      skipped: undefined,
    });
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("ignores an observation from a pane other than the assignment's", () => {
    const snapshot = deriveSnapshot(
      journalOf(parse, opened(), assigned("builder", "w1:p1")),
    ).snapshot;
    const tracker = new ObservationTracker();
    tracker.accept(observation("w1:p9", "idle", 1));

    const overlaid = overlayRuntime(snapshot, tracker);

    expect(overlaid.agents[0]?.runtime).toBeNull();
    expect(overlaid.liveness).toEqual({ owner: "unhosted", runtime: "not_observed", host: null });
  });
});
