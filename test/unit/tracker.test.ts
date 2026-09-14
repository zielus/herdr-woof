import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

interface Observation {
  runtimeName: string;
  paneId: string;
  lifecycle: string;
  runtimeStatus: string | null;
  sessionId: string | null;
  order: { terminalId: string | null; stateChangeSeq: number | null; revision: number | null };
  observedAt: string;
}
interface TrackResult {
  kind: string;
  observation: Observation;
}
interface TrackerInstance {
  dropped: { stale: number; duplicate: number };
  accept(observation: Observation): TrackResult;
  last(runtimeName: string): Observation | undefined;
}
interface TrackerModule {
  track(prev: Observation | undefined, next: Observation): TrackResult;
  ObservationTracker: new () => TrackerInstance;
}

let tracker: TrackerModule;

beforeAll(async () => {
  tracker = await loadDist<TrackerModule>("runtime/tracker.js");
});

function obs(
  status: string | null,
  seq: number | null,
  terminalId: string | null = "term_1",
  revision: number | null = null,
): Observation {
  const lifecycle =
    status === null
      ? "gone"
      : status === "idle" || status === "done"
        ? "ready"
        : status === "working" || status === "blocked"
          ? status
          : "unknown";
  return {
    runtimeName: "w-worker-abc123",
    paneId: "w1:p1",
    lifecycle,
    runtimeStatus: status,
    sessionId: null,
    order: { terminalId, stateChangeSeq: seq, revision },
    observedAt: "2026-09-14T10:00:00.000Z",
  };
}

describe("track", () => {
  it("classifies against the previous observation", () => {
    const cases: Array<[string, Observation | undefined, Observation, string]> = [
      ["first observation", undefined, obs("idle", 1), "new"],
      ["higher seq", obs("working", 5), obs("idle", 6), "new"],
      ["higher seq with the same lifecycle", obs("working", 5), obs("working", 6), "new"],
      ["lower seq on the same terminal", obs("working", 5), obs("idle", 4), "stale"],
      ["identical seq, lifecycle and status", obs("working", 5), obs("working", 5), "duplicate"],
      [
        "same seq, older revision",
        obs("working", 5, "term_1", 9),
        obs("idle", 5, "term_1", 8),
        "stale",
      ],
      ["another terminal in the pane", obs("working", 9), obs("idle", 1, "term_2"), "replaced"],
      ["gone after working", obs("working", 5), obs(null, null, null), "new"],
      ["gone twice", obs(null, null, null), obs(null, null, null), "duplicate"],
      ["unsequenced repeat", obs("idle", null), obs("idle", null), "duplicate"],
      ["unsequenced change", obs("idle", null), obs("done", null), "new"],
    ];
    for (const [name, prev, next, kind] of cases) {
      expect(tracker.track(prev, next).kind, name).toBe(kind);
    }
  });

  it("compares sequence numbers only within the same known terminal", () => {
    const cases: Array<[string, Observation, Observation, string]> = [
      ["lower seq, both terminals unknown", obs("working", 5, null), obs("idle", 4, null), "new"],
      ["lower seq, previous terminal unknown", obs("working", 5, null), obs("idle", 4), "new"],
      ["lower seq, next terminal unknown", obs("working", 5), obs("idle", 4, null), "new"],
      [
        "older revision, next terminal unknown",
        obs("working", 5, "term_1", 9),
        obs("idle", 5, null, 8),
        "new",
      ],
      ["lower seq on another terminal", obs("working", 5), obs("idle", 4, "term_2"), "replaced"],
      ["higher seq on another terminal", obs("working", 5), obs("idle", 6, "term_2"), "replaced"],
      [
        "repeat with both terminals unknown",
        obs("working", 5, null),
        obs("working", 5, null),
        "duplicate",
      ],
    ];
    for (const [name, prev, next, kind] of cases) {
      expect(tracker.track(prev, next).kind, name).toBe(kind);
    }
    const instance = new tracker.ObservationTracker();
    instance.accept(obs("working", 5, null));
    expect(instance.accept(obs("idle", 1, null)).kind).toBe("new");
    expect(instance.dropped).toEqual({ stale: 0, duplicate: 0 });
  });

  it("keeps done and idle apart as raw statuses of the same ready lifecycle", () => {
    const result = tracker.track(obs("idle", 3), obs("done", 3));
    expect(result.kind).toBe("new");
    expect(result.observation.lifecycle).toBe("ready");
  });
});

describe("ObservationTracker", () => {
  it("never lets an older ready replace a newer working observation", () => {
    const instance = new tracker.ObservationTracker();
    expect(instance.accept(obs("working", 5)).kind).toBe("new");
    expect(instance.accept(obs("idle", 4)).kind).toBe("stale");
    expect(instance.accept(obs("working", 5)).kind).toBe("duplicate");
    expect(instance.last("w-worker-abc123")?.lifecycle).toBe("working");
    expect(instance.dropped).toEqual({ stale: 1, duplicate: 1 });
  });

  it("follows a replaced occupant without merging the old one", () => {
    const instance = new tracker.ObservationTracker();
    instance.accept(obs("working", 9, "term_1"));
    expect(instance.accept(obs("idle", 1, "term_2")).kind).toBe("replaced");
    expect(instance.last("w-worker-abc123")?.order.terminalId).toBe("term_2");
    // The old occupant's later sequence number is another replacement, not a continuation.
    expect(instance.accept(obs("idle", 10, "term_1")).kind).toBe("replaced");
    expect(instance.dropped).toEqual({ stale: 0, duplicate: 0 });
  });
});
