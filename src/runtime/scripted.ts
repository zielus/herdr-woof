import {
  AMBIGUOUS_CODES,
  NOT_DELIVERED_CODES,
  lifecycleFromStatus,
  runtimeError,
  type AgentHandle,
  type AmbiguousCode,
  type DeliveryResult,
  type Lifecycle,
  type LifecycleObservation,
  type NotDeliveredCode,
  type OpenPaneInput,
  type RuntimeAdapter,
  type RuntimeResult,
  type StartAgentInput,
} from "./adapter.js";

/**
 * Scripted runtime: a deterministic in-memory RuntimeAdapter for tests and
 * synthetic workflows (exported from `herdr-woof/testing`, not the main
 * entry). Each agent follows a scripted timeline of raw statuses; tests move
 * it with `advance`, delivery triggers, or injected observations. It uses no
 * timers and performs no journal writes.
 */

export interface TimelineEntry {
  /** Raw runtime status: "idle", "done", "working", "blocked" or "unknown". */
  status: string;
  stateChangeSeq?: number;
  terminalId?: string;
}

/**
 * "started", "not_delivered:<code>" or "ambiguous:<code>", each code from its
 * own delivery set. `createScriptedRuntime` throws a TypeError for any other
 * value, so a double cannot report a timeout as not delivered.
 */
export type DeliverScript =
  "started" | `not_delivered:${NotDeliveredCode}` | `ambiguous:${AmbiguousCode}`;

export interface ScriptedAgent {
  timeline: TimelineEntry[];
  /** Outcome per deliver call, in order; the last one repeats. Default "started". */
  onDeliver?: DeliverScript | DeliverScript[];
  /** Entries appended after the cursor per deliver call, in order; the last repeats. Default [{status: "working"}]. */
  afterDeliver?: TimelineEntry[] | TimelineEntry[][];
  /** Each observe returns the entry at the cursor, then moves the cursor forward. */
  advanceOnObserve?: boolean;
  sessionId?: string;
}

export interface ScriptedCall {
  method: "openPane" | "startAgent" | "observe" | "waitFor" | "deliver" | "stop";
  runtimeName: string | null;
  args: Record<string, unknown>;
}

export interface ScriptedRuntime extends RuntimeAdapter {
  readonly adapter: "scripted";
  /**
   * Moves an agent's timeline cursor forward (clamped to the last entry).
   * `steps` must be a non-negative safe integer; anything else throws a
   * TypeError and leaves the cursor unchanged.
   */
  advance(runtimeName: string, steps?: number): void;
  /** Queues an arbitrary observation, returned by the next observe of that agent. */
  emit(
    runtimeName: string,
    observation: Partial<LifecycleObservation> & { lifecycle: Lifecycle },
  ): void;
  /** Ordered log of adapter calls. */
  calls(): ScriptedCall[];
}

interface AgentState {
  script: ScriptedAgent;
  timeline: TimelineEntry[];
  cursor: number;
  queue: LifecycleObservation[];
  delivers: number;
  started: AgentHandle | undefined;
  stopped: boolean;
}

export function createScriptedRuntime(options: {
  agents: Record<string, ScriptedAgent>;
  /** Milliseconds since the epoch for observedAt; defaults to a counter from 2026-01-01. */
  clock?: () => number;
}): ScriptedRuntime {
  let ticks = 0;
  const clock = options.clock ?? (() => Date.UTC(2026, 0, 1) + ticks++);
  const log: ScriptedCall[] = [];
  const agents = new Map<string, AgentState>();
  for (const [name, script] of Object.entries(options.agents)) {
    if (script.timeline.length === 0)
      throw new TypeError(`scripted agent ${name} needs a timeline entry`);
    const onDeliver = script.onDeliver ?? [];
    for (const value of Array.isArray(onDeliver) ? onDeliver : [onDeliver]) {
      if (!isDeliverScript(value)) {
        throw new TypeError(
          `scripted agent ${name} has onDeliver ${JSON.stringify(value)}; use "started", "not_delivered:<${NOT_DELIVERED_CODES.join("|")}>" or "ambiguous:<${AMBIGUOUS_CODES.join("|")}>"`,
        );
      }
    }
    const afterDeliver = script.afterDeliver;
    if (
      afterDeliver !== undefined &&
      (afterDeliver.length === 0 ||
        (isNested(afterDeliver) && afterDeliver.some((entries) => entries.length === 0)))
    ) {
      throw new TypeError(
        `scripted agent ${name} has an empty afterDeliver sequence; give at least one timeline entry per deliver call`,
      );
    }
    agents.set(name, {
      script,
      timeline: [...script.timeline],
      cursor: 0,
      queue: [],
      delivers: 0,
      started: undefined,
      stopped: false,
    });
  }
  let panes = 0;
  /** Panes this instance opened; the only panes `stop` may close. */
  const ownedPanes = new Set<string>();

  const record = (
    method: ScriptedCall["method"],
    runtimeName: string | null,
    args: Record<string, unknown>,
  ) => log.push({ method, runtimeName, args });

  const observation = (
    state: AgentState,
    handle: AgentHandle,
    entry: TimelineEntry,
  ): LifecycleObservation => ({
    runtimeName: handle.runtimeName,
    paneId: handle.paneId,
    lifecycle: lifecycleFromStatus(entry.status),
    runtimeStatus: entry.status,
    sessionId: state.script.sessionId ?? handle.sessionId,
    order: {
      terminalId: entry.terminalId ?? handle.terminalId,
      stateChangeSeq: entry.stateChangeSeq ?? null,
      revision: null,
    },
    observedAt: new Date(clock()).toISOString(),
  });

  const gone = (handle: AgentHandle): LifecycleObservation => ({
    runtimeName: handle.runtimeName,
    paneId: handle.paneId,
    lifecycle: "gone",
    runtimeStatus: null,
    sessionId: null,
    order: { terminalId: null, stateChangeSeq: null, revision: null },
    observedAt: new Date(clock()).toISOString(),
  });

  return {
    adapter: "scripted",

    async openPane(input: OpenPaneInput): Promise<RuntimeResult<{ paneId: string }>> {
      record("openPane", null, { near: input.near, cwd: input.cwd });
      panes += 1;
      const paneId = `scripted:p${panes}`;
      ownedPanes.add(paneId);
      return { ok: true, value: { paneId } };
    },

    async startAgent(input: StartAgentInput): Promise<RuntimeResult<AgentHandle>> {
      record("startAgent", input.runtimeName, { kind: input.kind, paneId: input.paneId });
      const state = agents.get(input.runtimeName);
      if (state === undefined) return { ok: false, error: notFound(input.runtimeName) };
      const first = state.timeline[0] as TimelineEntry;
      const handle: AgentHandle = {
        adapter: "scripted",
        runtimeName: input.runtimeName,
        kind: input.kind,
        paneId: input.paneId,
        paneOwned: ownedPanes.has(input.paneId),
        terminalId: first.terminalId ?? `term-${input.runtimeName}`,
        sessionId: state.script.sessionId ?? `session-${input.runtimeName}`,
      };
      state.started = handle;
      return { ok: true, value: handle };
    },

    async observe(handle: AgentHandle): Promise<RuntimeResult<LifecycleObservation>> {
      record("observe", handle.runtimeName, {});
      const state = agents.get(handle.runtimeName);
      if (state === undefined || state.stopped) return { ok: true, value: gone(handle) };
      const queued = state.queue.shift();
      if (queued !== undefined) return { ok: true, value: queued };
      const value = observation(state, handle, state.timeline[state.cursor] as TimelineEntry);
      if (state.script.advanceOnObserve === true) {
        state.cursor = Math.min(state.cursor + 1, state.timeline.length - 1);
      }
      return { ok: true, value };
    },

    async waitFor(handle: AgentHandle, states: Lifecycle[], timeoutMs: number) {
      record("waitFor", handle.runtimeName, { states, timeoutMs });
      const state = agents.get(handle.runtimeName);
      if (state === undefined || state.stopped) {
        return states.includes("gone")
          ? { ok: true as const, value: gone(handle) }
          : { ok: false as const, error: notFound(handle.runtimeName) };
      }
      for (let index = state.cursor; index < state.timeline.length; index += 1) {
        const entry = state.timeline[index] as TimelineEntry;
        if (states.includes(lifecycleFromStatus(entry.status))) {
          state.cursor = index;
          return { ok: true as const, value: observation(state, handle, entry) };
        }
      }
      ticks += timeoutMs;
      return {
        ok: false as const,
        error: runtimeError(
          "timeout",
          `scripted agent ${handle.runtimeName} did not reach ${states.join("|")}`,
        ),
      };
    },

    async deliver(
      handle: AgentHandle,
      text: string,
      delivery: { timeoutMs: number },
    ): Promise<DeliveryResult> {
      // `sent` tells tests whether the prompt may have reached the agent.
      const args: Record<string, unknown> = { text, timeoutMs: delivery.timeoutMs, sent: false };
      record("deliver", handle.runtimeName, args);
      const state = agents.get(handle.runtimeName);
      if (state === undefined || state.stopped) {
        return { outcome: "not_delivered", error: notFound(handle.runtimeName) };
      }
      // Precondition, as in the Herdr adapter: a working or blocked agent gets
      // nothing, and the per-call script is not consumed.
      const current = lifecycleFromStatus((state.timeline[state.cursor] as TimelineEntry).status);
      if (current === "working") {
        return {
          outcome: "not_delivered",
          error: runtimeError(
            "agent_busy",
            `scripted agent ${handle.runtimeName} is working; the prompt was not sent`,
          ),
        };
      }
      if (current === "blocked") {
        return {
          outcome: "not_delivered",
          error: runtimeError(
            "agent_blocked",
            `scripted agent ${handle.runtimeName} is blocked; the prompt was not sent`,
          ),
        };
      }
      const index = state.delivers;
      state.delivers += 1;
      const onDeliver = state.script.onDeliver ?? "started";
      const script = (Array.isArray(onDeliver) ? nth(onDeliver, index) : onDeliver) ?? "started";
      if (script.startsWith("not_delivered:")) {
        const code = script.slice("not_delivered:".length) as NotDeliveredCode;
        return { outcome: "not_delivered", error: runtimeError(code, `scripted ${code}`) };
      }
      args["sent"] = true;
      const afterDeliver = state.script.afterDeliver;
      const after: TimelineEntry[] = (afterDeliver === undefined
        ? undefined
        : isNested(afterDeliver)
          ? nth(afterDeliver, index)
          : afterDeliver) ?? [{ status: "working" }];
      state.timeline.splice(state.cursor + 1, 0, ...after);
      if (script.startsWith("ambiguous:")) {
        const code = script.slice("ambiguous:".length) as AmbiguousCode;
        return { outcome: "ambiguous", error: runtimeError(code, `scripted ${code}`) };
      }
      state.cursor += 1;
      const entry = state.timeline[state.cursor] as TimelineEntry;
      return { outcome: "started", observation: observation(state, handle, entry) };
    },

    async stop(handle: AgentHandle, stopping: { timeoutMs: number }) {
      record("stop", handle.runtimeName, { timeoutMs: stopping.timeoutMs });
      // The handle's paneOwned flag is caller data and is never trusted.
      if (!ownedPanes.has(handle.paneId)) {
        return {
          ok: false as const,
          error: runtimeError(
            "unsupported",
            `stop closes only panes this adapter opened; ${handle.paneId} was not opened by it`,
          ),
        };
      }
      ownedPanes.delete(handle.paneId);
      const state = agents.get(handle.runtimeName);
      if (state !== undefined) state.stopped = true;
      return { ok: true as const, value: { paneClosed: true as const } };
    },

    advance(runtimeName: string, steps = 1): void {
      if (!Number.isSafeInteger(steps) || steps < 0) {
        throw new TypeError(
          `advance steps must be a non-negative safe integer, not ${String(steps)}`,
        );
      }
      const state = agents.get(runtimeName);
      if (state === undefined) throw new TypeError(`scripted agent ${runtimeName} does not exist`);
      state.cursor = Math.min(state.cursor + steps, state.timeline.length - 1);
    },

    emit(runtimeName, partial): void {
      const state = agents.get(runtimeName);
      if (state === undefined) throw new TypeError(`scripted agent ${runtimeName} does not exist`);
      const handle = state.started;
      state.queue.push({
        runtimeName,
        paneId: partial.paneId ?? handle?.paneId ?? "scripted:p0",
        lifecycle: partial.lifecycle,
        runtimeStatus: partial.runtimeStatus ?? null,
        sessionId: partial.sessionId ?? handle?.sessionId ?? null,
        order: {
          terminalId: partial.order?.terminalId ?? handle?.terminalId ?? null,
          stateChangeSeq: partial.order?.stateChangeSeq ?? null,
          revision: partial.order?.revision ?? null,
        },
        observedAt: partial.observedAt ?? new Date(clock()).toISOString(),
      });
    },

    calls(): ScriptedCall[] {
      return structuredClone(log);
    },
  };
}

function notFound(runtimeName: string) {
  return runtimeError("not_found", `scripted agent ${runtimeName} does not exist`, {
    runtimeCode: "agent_not_found",
  });
}

function isDeliverScript(value: unknown): value is DeliverScript {
  if (value === "started") return true;
  if (typeof value !== "string") return false;
  const [category, code, ...rest] = value.split(":");
  if (rest.length > 0 || code === undefined) return false;
  if (category === "not_delivered")
    return (NOT_DELIVERED_CODES as readonly string[]).includes(code);
  if (category === "ambiguous") return (AMBIGUOUS_CODES as readonly string[]).includes(code);
  return false;
}

/** The entry for call `index` of a per-call script; the last entry repeats. */
function nth<T>(values: readonly T[], index: number): T | undefined {
  return values[Math.min(index, values.length - 1)];
}

function isNested(
  value: TimelineEntry[] | TimelineEntry[][] | undefined,
): value is TimelineEntry[][] {
  return Array.isArray(value) && value.length > 0 && Array.isArray(value[0]);
}
