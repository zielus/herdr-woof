import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";
import { assigned, attempt, dispatched, journalOf, opened } from "../helpers/records.js";

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
      herdrStatus: "done",
      observedAt: "2026-09-14T10:00:00.000Z",
      order: { terminalId: "t1", stateChangeSeq: 6, revision: null },
    });
    expect(overlaid.agents[1]?.runtime).toBeNull();
    expect(overlaid.liveness).toEqual({ owner: "unhosted", runtime: "observed" });
    // Everything journal-derived is identical; the input snapshot is not mutated.
    expect({ ...overlaid, agents: undefined, liveness: undefined }).toEqual({
      ...(JSON.parse(before) as Json),
      agents: undefined,
      liveness: undefined,
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
    expect(overlaid.liveness).toEqual({ owner: "unhosted", runtime: "not_observed" });
  });
});
