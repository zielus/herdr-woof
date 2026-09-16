import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

type Json = Record<string, unknown>;
interface Handle {
  adapter: string;
  runtimeName: string;
  paneId: string;
  paneOwned: boolean;
  terminalId: string | null;
  sessionId: string | null;
  kind: string;
}
interface Observation {
  lifecycle: string;
  runtimeStatus: string | null;
  order: { terminalId: string | null; stateChangeSeq: number | null };
}
type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string } };
interface Runtime {
  openPane(input: Json): Promise<Result<{ paneId: string }>>;
  startAgent(input: Json): Promise<Result<Handle>>;
  observe(handle: Handle, options?: Json): Promise<Result<Observation>>;
  waitFor(handle: Handle, states: string[], timeoutMs: number): Promise<Result<Observation>>;
  deliver(
    handle: Handle,
    text: string,
    options: { timeoutMs: number },
  ): Promise<{ outcome: string; observation?: Observation; error?: { code: string } }>;
  stop(handle: Handle, options: { timeoutMs: number }): Promise<Result<{ paneClosed: true }>>;
  advance(runtimeName: string, steps?: number): void;
  emit(runtimeName: string, observation: Json): void;
  calls(): Array<{ method: string; runtimeName: string | null; args: Json }>;
}
interface Watch extends AsyncIterable<{ kind: string; observation: Observation }> {
  dropped: { stale: number; duplicate: number };
  tracker: { last(name: string): Observation | undefined };
}

let createScriptedRuntime: (options: { agents: Record<string, Json> }) => Runtime;
let watchAgent: (runtime: Runtime, handle: Handle, options: Json) => Watch;
let herdrRuntimeName: (runId: string, agentId: string) => string;
let isHerdrRuntimeName: (name: string) => boolean;

beforeAll(async () => {
  ({ createScriptedRuntime } = await loadDist<{
    createScriptedRuntime: typeof createScriptedRuntime;
  }>("runtime/scripted.js"));
  ({ watchAgent } = await loadDist<{ watchAgent: typeof watchAgent }>("runtime/tracker.js"));
  ({ herdrRuntimeName, isHerdrRuntimeName } = await loadDist<{
    herdrRuntimeName: typeof herdrRuntimeName;
    isHerdrRuntimeName: typeof isHerdrRuntimeName;
  }>("runtime/names.js"));
});

const NAME = "w-worker-abc123";

async function started(agent: Json): Promise<{ runtime: Runtime; handle: Handle }> {
  const runtime = createScriptedRuntime({ agents: { [NAME]: agent } });
  const pane = await runtime.openPane({ near: "current", cwd: "/tmp" });
  if (!pane.ok) throw new Error("openPane failed");
  const handle = await runtime.startAgent({
    runtimeName: NAME,
    kind: "claude",
    paneId: pane.value.paneId,
    paneOwned: true,
    timeoutMs: 1000,
  });
  if (!handle.ok) throw new Error("startAgent failed");
  return { runtime, handle: handle.value };
}

async function collect(watch: Watch): Promise<Array<{ kind: string; observation: Observation }>> {
  const items = [];
  for await (const item of watch) items.push(item);
  return items;
}

const seqs = (items: Array<{ observation: Observation }>) =>
  items.map((item) => item.observation.order.stateChangeSeq);

describe("scripted runtime observation ordering", () => {
  it("yields seq 5 then 7 and counts the late seq 6 as stale", async () => {
    const { runtime, handle } = await started({
      timeline: [
        { status: "working", stateChangeSeq: 5, terminalId: "t1" },
        { status: "idle", stateChangeSeq: 7, terminalId: "t1" },
        { status: "working", stateChangeSeq: 6, terminalId: "t1" },
      ],
      advanceOnObserve: true,
    });

    const watch = watchAgent(runtime, handle, { intervalMs: 0, maxPolls: 3 });
    const items = await collect(watch);

    expect(seqs(items)).toEqual([5, 7]);
    expect(items.map((item) => item.observation.lifecycle)).toEqual(["working", "ready"]);
    expect(watch.dropped).toEqual({ stale: 1, duplicate: 0 });
    expect(watch.tracker.last(NAME)?.lifecycle).toBe("ready");
  });

  it("never reports ready from an older sequence after working", async () => {
    const { runtime, handle } = await started({
      timeline: [{ status: "working", stateChangeSeq: 5, terminalId: "t1" }],
    });
    const first = watchAgent(runtime, handle, { intervalMs: 0, maxPolls: 1 });
    expect((await collect(first)).map((item) => item.observation.lifecycle)).toEqual(["working"]);

    runtime.emit(NAME, {
      lifecycle: "ready",
      runtimeStatus: "idle",
      order: { terminalId: "t1", stateChangeSeq: 4 },
    });
    const late = watchAgent(runtime, handle, {
      intervalMs: 0,
      maxPolls: 2,
      tracker: first.tracker,
    });

    expect(await collect(late)).toEqual([]);
    expect(late.dropped).toEqual({ stale: 1, duplicate: 1 });
    expect(late.tracker.last(NAME)?.lifecycle).toBe("working");
  });

  it("yields a repeated observation once and counts the repeats", async () => {
    const { runtime, handle } = await started({
      timeline: [{ status: "working", stateChangeSeq: 3, terminalId: "t1" }],
    });
    for (let index = 0; index < 3; index += 1) {
      runtime.emit(NAME, {
        lifecycle: "working",
        runtimeStatus: "working",
        order: { terminalId: "t1", stateChangeSeq: 3 },
      });
    }

    const watch = watchAgent(runtime, handle, { intervalMs: 0, maxPolls: 3 });
    const items = await collect(watch);

    expect(seqs(items)).toEqual([3]);
    expect(watch.dropped).toEqual({ stale: 0, duplicate: 2 });
  });

  it("surfaces a replaced pane occupant instead of merging it", async () => {
    const { runtime, handle } = await started({
      timeline: [{ status: "working", stateChangeSeq: 3, terminalId: "t1" }],
    });
    runtime.emit(NAME, {
      lifecycle: "working",
      runtimeStatus: "working",
      order: { terminalId: "t1", stateChangeSeq: 3 },
    });
    runtime.emit(NAME, {
      lifecycle: "ready",
      runtimeStatus: "idle",
      order: { terminalId: "t2", stateChangeSeq: 1 },
    });

    const items = await collect(watchAgent(runtime, handle, { intervalMs: 0, maxPolls: 2 }));

    expect(items.map((item) => [item.kind, item.observation.order.terminalId])).toEqual([
      ["new", "t1"],
      ["replaced", "t2"],
    ]);
  });

  it("stops when aborted", async () => {
    const { runtime, handle } = await started({ timeline: [{ status: "idle" }] });
    const controller = new AbortController();
    const watch = watchAgent(runtime, handle, { intervalMs: 5, signal: controller.signal });
    const items = [];
    for await (const item of watch) {
      items.push(item);
      controller.abort();
    }
    expect(items).toHaveLength(1);
  });
});

describe("scripted runtime adapter behaviour", () => {
  it("delivers per script and logs every call", async () => {
    const { runtime, handle } = await started({
      timeline: [{ status: "idle", stateChangeSeq: 1, terminalId: "t1" }],
      onDeliver: ["started", "not_delivered:agent_blocked", "ambiguous:stalled"],
      afterDeliver: [
        { status: "working", stateChangeSeq: 2, terminalId: "t1" },
        { status: "idle", stateChangeSeq: 3, terminalId: "t1" },
      ],
    });

    const first = await runtime.deliver(handle, "one", { timeoutMs: 100 });
    runtime.advance(NAME);
    const second = await runtime.deliver(handle, "two", { timeoutMs: 100 });
    const third = await runtime.deliver(handle, "three", { timeoutMs: 100 });

    expect(first).toMatchObject({
      outcome: "started",
      observation: { lifecycle: "working", order: { stateChangeSeq: 2 } },
    });
    expect(second).toMatchObject({ outcome: "not_delivered", error: { code: "agent_blocked" } });
    expect(third).toMatchObject({ outcome: "ambiguous", error: { code: "stalled" } });
    expect(
      runtime
        .calls()
        .filter((call) => call.method === "deliver")
        .map((call) => call.args["text"]),
    ).toEqual(["one", "two", "three"]);
    expect(
      runtime
        .calls()
        .filter((call) => call.method === "deliver")
        .map((call) => call.args["sent"]),
    ).toEqual([true, false, true]);
    expect(runtime.calls().map((call) => call.method)).toEqual([
      "openPane",
      "startAgent",
      "deliver",
      "deliver",
      "deliver",
    ]);
  });

  it("reports a started delivery not observed working or blocked as ambiguous protocol_error", async () => {
    for (const status of ["idle", "done", "unknown"]) {
      const { runtime, handle } = await started({
        timeline: [{ status: "idle", stateChangeSeq: 1, terminalId: "t1" }],
        afterDeliver: [{ status, stateChangeSeq: 2, terminalId: "t1" }],
      });
      const delivery = await runtime.deliver(handle, "hello", { timeoutMs: 10 });
      expect(delivery, status).toMatchObject({
        outcome: "ambiguous",
        error: { code: "protocol_error" },
      });
      expect(runtime.calls().find((call) => call.method === "deliver")?.args["sent"]).toBe(true);
    }
    const { runtime, handle } = await started({
      timeline: [{ status: "idle" }],
      afterDeliver: [{ status: "blocked" }],
    });
    expect(await runtime.deliver(handle, "hello", { timeoutMs: 10 })).toMatchObject({
      outcome: "started",
      observation: { lifecycle: "blocked" },
    });
  });

  it("refuses a non-integer or negative advance without moving the cursor", async () => {
    const { runtime, handle } = await started({
      timeline: [
        { status: "working", stateChangeSeq: 1, terminalId: "t1" },
        { status: "idle", stateChangeSeq: 2, terminalId: "t1" },
      ],
    });
    for (const steps of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "1"]) {
      expect(() => runtime.advance(NAME, steps as number), String(steps)).toThrow(TypeError);
    }
    expect(await runtime.observe(handle)).toMatchObject({
      ok: true,
      value: { lifecycle: "working", order: { stateChangeSeq: 1 } },
    });
    runtime.advance(NAME, 0);
    expect(await runtime.observe(handle)).toMatchObject({ value: { lifecycle: "working" } });
    runtime.advance(NAME, 1);
    expect(await runtime.observe(handle)).toMatchObject({ value: { lifecycle: "ready" } });
  });

  it("refuses an empty afterDeliver sequence at construction", () => {
    for (const afterDeliver of [[], [[]], [[{ status: "working" }], []]]) {
      expect(
        () =>
          createScriptedRuntime({
            agents: { [NAME]: { timeline: [{ status: "idle" }], afterDeliver } },
          }),
        JSON.stringify(afterDeliver),
      ).toThrow(TypeError);
    }
    for (const afterDeliver of [
      [{ status: "working" }],
      [[{ status: "working" }], [{ status: "idle" }]],
    ]) {
      expect(() =>
        createScriptedRuntime({
          agents: { [NAME]: { timeline: [{ status: "idle" }], afterDeliver } },
        }),
      ).not.toThrow();
    }
  });

  it("refuses a delivery script that crosses the delivery code sets", () => {
    const bad = [
      "not_delivered:timeout",
      "not_delivered:stalled",
      "not_delivered:protocol_error",
      "not_delivered:runtime_error",
      "ambiguous:not_found",
      "ambiguous:agent_busy",
      "ambiguous:runtime_unavailable",
      "ambiguous:precondition_failed",
      "not_delivered:bogus",
      "ambiguous:",
      "started:timeout",
      "delivered",
    ];
    for (const onDeliver of bad) {
      expect(
        () =>
          createScriptedRuntime({
            agents: { [NAME]: { timeline: [{ status: "idle" }], onDeliver } },
          }),
        onDeliver,
      ).toThrow(TypeError);
      expect(
        () =>
          createScriptedRuntime({
            agents: {
              [NAME]: { timeline: [{ status: "idle" }], onDeliver: ["started", onDeliver] },
            },
          }),
        onDeliver,
      ).toThrow(TypeError);
    }
    for (const onDeliver of [
      "not_delivered:not_found",
      "not_delivered:agent_blocked",
      "not_delivered:agent_busy",
      "not_delivered:invalid_request",
      "not_delivered:runtime_unavailable",
      "not_delivered:precondition_failed",
      "ambiguous:stalled",
      "ambiguous:timeout",
      "ambiguous:protocol_error",
      "ambiguous:runtime_error",
    ]) {
      expect(() =>
        createScriptedRuntime({
          agents: { [NAME]: { timeline: [{ status: "idle" }], onDeliver } },
        }),
      ).not.toThrow();
    }
  });

  it("never sends to a working or blocked agent and keeps the script for the next call", async () => {
    const { runtime, handle } = await started({
      timeline: [
        { status: "working", stateChangeSeq: 1, terminalId: "t1" },
        { status: "blocked", stateChangeSeq: 2, terminalId: "t1" },
        { status: "idle", stateChangeSeq: 3, terminalId: "t1" },
      ],
      onDeliver: ["ambiguous:stalled", "started"],
    });

    const busy = await runtime.deliver(handle, "while working", { timeoutMs: 10 });
    runtime.advance(NAME);
    const blocked = await runtime.deliver(handle, "while blocked", { timeoutMs: 10 });
    runtime.advance(NAME);
    const first = await runtime.deliver(handle, "when ready", { timeoutMs: 10 });

    expect(busy).toMatchObject({ outcome: "not_delivered", error: { code: "agent_busy" } });
    expect(blocked).toMatchObject({ outcome: "not_delivered", error: { code: "agent_blocked" } });
    expect(first).toMatchObject({ outcome: "ambiguous", error: { code: "stalled" } });
    expect(
      runtime
        .calls()
        .filter((call) => call.method === "deliver")
        .map((call) => [call.args["text"], call.args["sent"]]),
    ).toEqual([
      ["while working", false],
      ["while blocked", false],
      ["when ready", true],
    ]);
  });

  it("resolves waitFor from the timeline and times out without timers", async () => {
    const { runtime, handle } = await started({
      timeline: [
        { status: "working", stateChangeSeq: 2 },
        { status: "blocked", stateChangeSeq: 3 },
        { status: "done", stateChangeSeq: 4 },
      ],
    });
    const ready = await runtime.waitFor(handle, ["ready"], 50);
    expect(ready).toMatchObject({ ok: true, value: { lifecycle: "ready", runtimeStatus: "done" } });
    const never = await runtime.waitFor(handle, ["working"], 60_000);
    expect(never).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it("stops only panes it opened, whatever the handle claims, after which the agent is gone", async () => {
    const { runtime, handle } = await started({ timeline: [{ status: "idle" }] });
    expect(handle.paneOwned).toBe(true);
    const forged = { ...handle, paneId: "w9:p999", paneOwned: true };
    expect(await runtime.stop(forged, { timeoutMs: 10 })).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    const other = createScriptedRuntime({ agents: { [NAME]: { timeline: [{ status: "idle" }] } } });
    expect(await other.stop(handle, { timeoutMs: 10 })).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    const unopened = await other.startAgent({
      runtimeName: NAME,
      kind: "claude",
      paneId: handle.paneId,
      paneOwned: true,
      timeoutMs: 10,
    });
    expect(unopened).toMatchObject({ ok: true, value: { paneOwned: false } });
    expect((await runtime.observe(handle)).ok && (await runtime.observe(handle))).toMatchObject({
      ok: true,
      value: { lifecycle: "ready" },
    });
    expect(await runtime.stop(handle, { timeoutMs: 10 })).toEqual({
      ok: true,
      value: { paneClosed: true },
    });
    expect(await runtime.observe(handle)).toMatchObject({
      ok: true,
      value: { lifecycle: "gone", runtimeStatus: null },
    });
    expect(await runtime.deliver(handle, "late", { timeoutMs: 10 })).toMatchObject({
      outcome: "not_delivered",
      error: { code: "not_found" },
    });
  });

  it("delays observe by observeDelayMs and times out at a shorter observe timeout", async () => {
    const { runtime, handle } = await started({
      timeline: [{ status: "idle", stateChangeSeq: 1 }],
      observeDelayMs: 80,
    });
    const began = Date.now();
    expect(await runtime.observe(handle, { timeoutMs: 10 })).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    expect(Date.now() - began).toBeLessThan(70);
    expect(await runtime.observe(handle, { timeoutMs: 1000 })).toMatchObject({ ok: true });
    expect(await runtime.observe(handle)).toMatchObject({ ok: true });
    expect(() =>
      createScriptedRuntime({
        agents: { x: { timeline: [{ status: "idle" }], observeDelayMs: -1 } },
      }),
    ).toThrow(TypeError);
  });

  it("reports an unscripted agent as not found", async () => {
    const runtime = createScriptedRuntime({ agents: {} });
    expect(
      await runtime.startAgent({
        runtimeName: "w-nobody-000000",
        kind: "claude",
        paneId: "p",
        paneOwned: true,
        timeoutMs: 10,
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("herdrRuntimeName", () => {
  /** Deterministic generator of valid ids: mixed case, dots, dashes, underscores, up to 128 chars. */
  function* ids(count: number): Generator<string> {
    let state = 0x2545f491;
    const next = () => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state;
    };
    const first = "ABCXYZabcxyz0189";
    const rest = "ABCXYZabcxyz0189._-";
    for (let index = 0; index < count; index += 1) {
      const length = index % 10 === 0 ? 128 : 1 + (next() % 40);
      let id = first[next() % first.length] as string;
      while (id.length < length) id += rest[next() % rest.length];
      yield id;
    }
  }

  it("produces valid, deterministic, run-scoped names for 1000 generated ids", () => {
    let count = 0;
    for (const agentId of ids(1000)) {
      const name = herdrRuntimeName("run-a", agentId);
      expect(isHerdrRuntimeName(name), `${agentId} -> ${name}`).toBe(true);
      expect(name).toBe(herdrRuntimeName("run-a", agentId));
      expect(name).not.toBe(herdrRuntimeName("run-b", agentId));
      count += 1;
    }
    expect(count).toBe(1000);
  });

  it("keeps the readable agent part and rejects invalid names", () => {
    expect(herdrRuntimeName("run-1", "Pinger.One")).toMatch(/^w-pinger-one-[0-9a-f]{6}$/);
    for (const bad of ["", "W-upper", "1starts-with-digit", `w${"x".repeat(32)}`, "has space"]) {
      expect(isHerdrRuntimeName(bad), bad).toBe(false);
    }
  });
});
