import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";
import {
  accepted,
  assigned,
  attempt,
  blocked,
  cancelRequested,
  checkGate,
  dispatched,
  duplicate,
  gate,
  hostClaimed,
  hostExited,
  hostLost,
  journalOf,
  observationLost,
  observationRecovered,
  opened,
  reconciled,
  rejected,
  terminated,
  unblocked,
} from "../helpers/records.js";

// The human formatter behind woof watch, woof events --pretty and woof status --pretty (pure).
type Json = Record<string, unknown>;
interface Event {
  seq: number;
  ts: string;
  type: string;
  subject: Json;
  data: unknown;
}
interface Options {
  color: boolean;
  timeZone?: string;
}
interface Format {
  colorEnabled: (input: {
    isTTY: boolean | undefined;
    env: Record<string, string | undefined>;
  }) => boolean;
  formatEventLine: (event: Event, options: Options) => string;
  formatHeader: (input: Json, options: Options) => string[];
  formatEnd: (cursor: string | null, reason: string, options: Options) => string;
  formatProblem: (
    item: { type: string; reason: string; message: string },
    options: Options,
  ) => string;
  formatHostOutcome: (hostOutcome: unknown, options: Options) => string;
}

let format: Format;
let parse: (line: string) => Json | string;
let projectEvents: (records: Json[], anchor: string) => Event[];
let deriveSnapshot: (records: Json[]) => {
  ok: true;
  snapshot: Json & { agents: Json[]; outcome: Json | null };
};
let runStatusOf: (snapshot: Json, runDir: string) => Json;

const PLAIN: Options = { color: false, timeZone: "UTC" };
const ANCHOR = "0123456789ab";
// oxlint-disable-next-line no-control-regex
const SGR = /\u001B\[[0-9;]*m/g;

beforeAll(async () => {
  format = await loadDist<Format>("observe/format.js");
  ({ parseRecordLine: parse } = await loadDist<{ parseRecordLine: typeof parse }>(
    "journal/records.js",
  ));
  ({ projectEvents } = await loadDist<{ projectEvents: typeof projectEvents }>(
    "observe/events.js",
  ));
  ({ deriveSnapshot } = await loadDist<{ deriveSnapshot: typeof deriveSnapshot }>(
    "state/snapshot.js",
  ));
  ({ runStatusOf } = await loadDist<{ runStatusOf: typeof runStatusOf }>("inspect/status.js"));
});

/** The formatted line of the last record in a journal built from `bodies`. */
function lastLine(...bodies: Json[]): string {
  const events = projectEvents(journalOf(parse, ...bodies), ANCHOR);
  return format.formatEventLine(events.at(-1) as Event, PLAIN);
}

const time = (index: number) => `10:00:00 #${index + 1}`;

describe("formatEventLine", () => {
  it("run.opened: run id and workflow, or plan-less", () => {
    expect(lastLine(opened())).toBe(`${time(0)} run.opened           -  run-1 build-review@1`);
    expect(lastLine(opened(null, "bare"))).toBe(
      `${time(0)} run.opened           -  bare plan-less`,
    );
  });

  it("agent.assigned: runtime name and pane", () => {
    expect(lastLine(opened(), assigned("builder", "w1:p4"))).toBe(
      `${time(1)} agent.assigned       builder  runtime w-builder pane w1:p4`,
    );
  });

  it("agent.assigned: names the journaled tab; a journal without one reads as before", () => {
    expect(lastLine(opened(), { ...assigned("builder", "w1:p4"), tabId: "w1:t3" })).toBe(
      `${time(1)} agent.assigned       builder  runtime w-builder pane w1:p4 tab w1:t3`,
    );
  });

  it("attempt.opened: the artifact directory", () => {
    expect(lastLine(opened(), attempt("build", "builder"))).toBe(
      `${time(1)} attempt.opened       builder build v1 a1  artifacts artifacts/build/visit-1/attempt-1`,
    );
  });

  it("request.dispatched: delivery and reason", () => {
    expect(
      lastLine(
        opened(),
        attempt("build", "builder"),
        dispatched("build", "builder", 1, 1, "ambiguous", "timeout"),
      ),
    ).toBe(`${time(2)} request.dispatched   builder build v1 a1  delivery ambiguous (timeout)`);
  });

  it("submission.accepted: status, verdict (or -) and receipt", () => {
    expect(
      lastLine(opened(), attempt("build", "builder"), accepted(3, "build", "builder", null)),
    ).toBe(
      `${time(2)} submission.accepted  builder build v1 a1  completed verdict - receipt rcpt-3-aaaaaaaaaaaa`,
    );
    expect(
      lastLine(
        opened(),
        attempt("review", "reviewer"),
        accepted(3, "review", "reviewer", "approve"),
      ),
    ).toBe(
      `${time(2)} submission.accepted  reviewer review v1 a1  completed verdict approve receipt rcpt-3-aaaaaaaaaaaa`,
    );
  });

  it("submission.rejected: reason and message, with the identity as subject when present", () => {
    expect(lastLine(opened(), rejected("envelope_invalid"))).toBe(
      `${time(1)} submission.rejected  -  envelope_invalid: envelope_invalid`,
    );
    expect(
      lastLine(
        opened(),
        attempt("build", "builder"),
        rejected("artifact_missing", {
          runId: "run-1",
          agentId: "builder",
          stageId: "build",
          visit: 1,
          attempt: 1,
        }),
      ),
    ).toBe(
      `${time(2)} submission.rejected  builder build v1 a1  artifact_missing: artifact_missing`,
    );
  });

  it("submission.duplicate: the acceptance it repeats, with that acceptance's subject", () => {
    expect(
      lastLine(
        opened(),
        attempt("build", "builder"),
        accepted(3, "build", "builder", null),
        duplicate(3),
      ),
    ).toBe(
      `${time(3)} submission.duplicate builder build v1 a1  duplicate of #3 receipt rcpt-3-aaaaaaaaaaaa`,
    );
  });

  it("gate.recorded: kind, gate, decision, reason, round and the next stage or outcome", () => {
    const base = [opened(), attempt("build", "builder"), accepted(3, "build", "builder", null)];
    expect(lastLine(...base, gate(3, "build"))).toBe(
      `${time(3)} gate.recorded        build v1 a1  stage build pass (built) round 0 -> review`,
    );
    expect(
      lastLine(
        ...base,
        checkGate(3, "verify", "build", 1, 1, {
          decision: "reject",
          reason: "checks_failed",
          round: 1,
          next: { stageId: "build" },
        }),
      ),
    ).toBe(
      `${time(3)} gate.recorded        build v1 a1  check verify reject (checks_failed) round 1 -> build`,
    );
    expect(lastLine(...base, gate(3, "build", 1, 1, { next: { outcome: "completed" } }))).toBe(
      `${time(3)} gate.recorded        build v1 a1  stage build pass (built) round 0 -> completed`,
    );
  });

  it("run.terminated: outcome and reason, with the limit when present", () => {
    expect(lastLine(opened(), terminated("cancelled"))).toBe(
      `${time(1)} run.terminated       -  cancelled: test`,
    );
    expect(lastLine(opened(), terminated("exhausted", "maxRounds"))).toBe(
      `${time(1)} run.terminated       -  exhausted: test (limit maxRounds)`,
    );
  });

  it("run.blocked, run.unblocked and delivery.reconciled", () => {
    const base = [
      opened(),
      assigned("builder"),
      attempt("build", "builder"),
      dispatched("build", "builder"),
    ];
    expect(lastLine(...base, blocked("builder", ["build", 1, 1]))).toBe(
      `${time(4)} run.blocked          builder build v1 a1  blocked_on_input: answer the prompt in the pane of builder`,
    );
    expect(lastLine(...base, blocked("builder"), unblocked("builder"))).toBe(
      `${time(5)} run.unblocked        builder  observed_unblocked`,
    );
    expect(lastLine(...base, reconciled(4, "build", "builder"))).toBe(
      `${time(4)} delivery.reconciled  builder build v1 a1  delivered (observed_activity) dispatch #4`,
    );
  });

  it("host lifecycle, cancellation request and observation loss/recovery", () => {
    expect(lastLine(opened(), hostClaimed())).toBe(
      `${time(1)} host.claimed         -  pid 4242 on test-host pane w1:host heartbeat 2000 ms`,
    );
    expect(lastLine(opened(), hostExited(4242, 6, "cancelled"))).toBe(
      `${time(1)} host.exited          -  pid 4242 exit 6 (cancelled)`,
    );
    expect(lastLine(opened(), hostLost())).toBe(
      `${time(1)} host.lost            -  pid 4242 host_process_gone, last heartbeat 2026-09-14T10:00:05.000Z (found by cli)`,
    );
    expect(lastLine(opened(), cancelRequested("web", "stop"))).toBe(
      `${time(1)} run.cancel_requested -  by web: stop`,
    );
    expect(lastLine(opened(), observationLost("builder"))).toBe(
      `${time(1)} observation.lost     builder  timeout: timeout observing builder`,
    );
    expect(lastLine(opened(), observationRecovered("builder", 2))).toBe(
      `${time(1)} observation.recovered builder  after loss #2`,
    );
  });

  it("an unknown type prints its type and compact data, and never throws", () => {
    const event = {
      seq: 9,
      ts: "2026-09-14T10:00:00.000Z",
      type: "future.thing",
      subject: {},
      data: { a: 1 },
    };
    expect(format.formatEventLine(event, PLAIN)).toBe(
      `10:00:00 #9 future.thing         -  {"a":1}`,
    );
    expect(format.formatEventLine({ ...event, data: { big: 1n } }, PLAIN)).toBe(
      `10:00:00 #9 future.thing         -  ?`,
    );
    const long = format.formatEventLine({ ...event, data: { text: "x".repeat(500) } }, PLAIN);
    expect(long.length).toBeLessThan(260);
  });

  it("a malformed known record renders ? for the missing fields and never throws", () => {
    const line = format.formatEventLine(
      { seq: 2, ts: "not a time", type: "gate.recorded", subject: {}, data: {} },
      PLAIN,
    );
    expect(line).toBe(`??:??:?? #2 gate.recorded        -  ? ? ? (?) round ? -> ?`);
  });

  it("control characters in journal strings never break the line or reach the terminal", () => {
    const line = format.formatEventLine(
      {
        seq: 3,
        ts: "2026-09-14T10:00:00.000Z",
        type: "submission.rejected",
        subject: {},
        data: { reason: "artifact_invalid", message: "bad\n\u001B[31mred\r" },
      },
      { color: false, timeZone: "UTC" },
    );
    expect(line).toBe(`10:00:00 #3 submission.rejected  -  artifact_invalid: bad  [31mred `);
    expect(line).not.toContain("\u001B");
    expect(line).not.toContain("\n");
  });

  it("colors are SGR codes around fields: stripping them gives the plain line", () => {
    const events = projectEvents(
      journalOf(
        parse,
        opened(),
        attempt("build", "builder"),
        accepted(3, "build", "builder", null),
        gate(3, "build"),
        terminated("failed"),
      ),
      ANCHOR,
    );
    for (const event of events) {
      const colored = format.formatEventLine(event, { color: true, timeZone: "UTC" });
      const plain = format.formatEventLine(event, PLAIN);
      expect(colored).toContain("\u001B[");
      expect(plain).not.toContain("\u001B");
      expect(colored.replaceAll(SGR, "")).toBe(plain);
    }
  });

  it("uses local time unless a time zone is given", () => {
    const event = {
      seq: 1,
      ts: "2026-09-14T23:30:05.000Z",
      type: "run.opened",
      subject: {},
      data: { runId: "r" },
    };
    expect(format.formatEventLine(event, { color: false, timeZone: "Asia/Tokyo" })).toMatch(
      /^08:30:05 #1 /,
    );
    expect(format.formatEventLine(event, { color: false, timeZone: "UTC" })).toMatch(
      /^23:30:05 #1 /,
    );
  });
});

describe("colorEnabled", () => {
  it("is on only for a terminal without a non-empty NO_COLOR", () => {
    const table: Array<[boolean | undefined, string | undefined, boolean]> = [
      [true, undefined, true],
      [true, "", true],
      [true, "1", false],
      [false, undefined, false],
      [false, "", false],
      [false, "1", false],
      [undefined, undefined, false],
      [undefined, "1", false],
    ];
    for (const [isTTY, noColor, expected] of table) {
      expect(
        format.colorEnabled({ isTTY, env: noColor === undefined ? {} : { NO_COLOR: noColor } }),
        `${String(isTTY)} ${String(noColor)}`,
      ).toBe(expected);
    }
  });
});

describe("formatHeader, formatEnd, formatProblem", () => {
  function headerOf(...bodies: Json[]): string[] {
    const derived = deriveSnapshot(journalOf(parse, ...bodies));
    expect(derived.ok).toBe(true);
    const { snapshot } = derived;
    return format.formatHeader(
      {
        status: runStatusOf(snapshot, "/runs/run-1"),
        agents: snapshot.agents,
        outcome: snapshot.outcome,
      },
      PLAIN,
    );
  }

  it("names the run, workflow, active attempts, owner and each agent", () => {
    expect(headerOf(opened(), assigned("builder", "w1:p4"), attempt("build", "builder"))).toEqual([
      "run      run-1  build-review@1  starting",
      "dir      /runs/run-1",
      "now      build v1 a1 (builder)",
      "owner    unhosted",
      "agent    builder  role builder kind claude model - pane w1:p4",
      "agent    reviewer  role reviewer kind claude model opus",
    ]);
  });

  it("names an agent's journaled tab next to its pane", () => {
    expect(
      headerOf(opened(), { ...assigned("builder", "w1:p4"), tabId: "w1:t3" }).filter((line) =>
        line.startsWith("agent    builder"),
      ),
    ).toEqual(["agent    builder  role builder kind claude model - pane w1:p4 tab w1:t3"]);
  });

  it("adds the outcome once the run ended", () => {
    const lines = headerOf(
      opened(),
      assigned("builder", "w1:p4"),
      attempt("build", "builder"),
      terminated("exhausted", "maxRounds"),
    );
    expect(lines[0]).toBe("run      run-1  build-review@1  exhausted");
    expect(lines[2]).toBe("now      -");
    expect(lines.at(-1)).toBe("outcome  exhausted: test (limit maxRounds)");
  });

  it("a plan-less run has no agents and says so", () => {
    expect(headerOf(opened(null))).toEqual([
      "run      run-1  plan-less  created",
      "dir      /runs/run-1",
      "now      -",
      "owner    unhosted",
    ]);
  });

  it("formats the end, problem and host outcome lines", () => {
    expect(format.formatEnd("v1.3.abc", "terminated", PLAIN)).toBe(
      "-- end (terminated) cursor v1.3.abc",
    );
    expect(format.formatEnd(null, "error", PLAIN)).toBe("-- end (error) cursor -");
    expect(
      format.formatProblem(
        { type: "resync_required", reason: "cursor_foreign", message: "another run" },
        PLAIN,
      ),
    ).toBe("!! resync_required cursor_foreign: another run");
    expect(
      format.formatHostOutcome(
        { outcome: "rejected", reason: "host_interrupted", message: "signal" },
        PLAIN,
      ),
    ).toBe("host     rejected host_interrupted: signal");
  });
});
