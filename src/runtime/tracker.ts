import { setTimeout as delay } from "node:timers/promises";

import type { AgentHandle, LifecycleObservation, RuntimeAdapter, RuntimeError } from "./adapter.js";

export type TrackKind = "new" | "duplicate" | "stale" | "replaced";

export interface TrackResult {
  kind: TrackKind;
  observation: LifecycleObservation;
}

/**
 * Classifies `next` against the last accepted observation of the same agent.
 *
 * - no previous observation → new
 * - both carry a terminal id and they differ → replaced (the pane occupant
 *   changed; surfaced, never merged into the old occupant's lifecycle)
 * - same terminal and both carry stateChangeSeq: a lower seq → stale; equal
 *   seq, lifecycle and raw status → duplicate; equal seq with a lower
 *   revision → stale; anything else → new
 * - otherwise (a seq is unknown, for example `gone`): ordered by receipt within
 *   the tracker; same terminal, lifecycle and raw status → duplicate, else new
 *
 * Herdr's state_change_seq is compared only within one terminal.
 */
export function track(
  prev: LifecycleObservation | undefined,
  next: LifecycleObservation,
): TrackResult {
  if (prev === undefined) return { kind: "new", observation: next };
  const a = prev.order;
  const b = next.order;
  if (a.terminalId !== null && b.terminalId !== null && a.terminalId !== b.terminalId) {
    return { kind: "replaced", observation: next };
  }
  const sameState =
    a.terminalId === b.terminalId &&
    prev.lifecycle === next.lifecycle &&
    prev.runtimeStatus === next.runtimeStatus;
  if (a.stateChangeSeq !== null && b.stateChangeSeq !== null) {
    if (b.stateChangeSeq < a.stateChangeSeq) return { kind: "stale", observation: next };
    if (b.stateChangeSeq === a.stateChangeSeq) {
      if (a.revision !== null && b.revision !== null && b.revision < a.revision) {
        return { kind: "stale", observation: next };
      }
      if (sameState) return { kind: "duplicate", observation: next };
    }
    return { kind: "new", observation: next };
  }
  return { kind: sameState ? "duplicate" : "new", observation: next };
}

/** In-memory tracker: keeps the last accepted observation per runtime name and counts drops. */
export class ObservationTracker {
  readonly dropped = { stale: 0, duplicate: 0 };
  readonly #last = new Map<string, LifecycleObservation>();

  accept(observation: LifecycleObservation): TrackResult {
    const result = track(this.#last.get(observation.runtimeName), observation);
    if (result.kind === "stale" || result.kind === "duplicate") {
      this.dropped[result.kind] += 1;
    } else {
      this.#last.set(observation.runtimeName, observation);
    }
    return result;
  }

  last(runtimeName: string): LifecycleObservation | undefined {
    return this.#last.get(runtimeName);
  }
}

export interface WatchOptions {
  intervalMs: number;
  signal?: AbortSignal;
  /** Stop after this many observe calls; omit to poll until aborted. */
  maxPolls?: number;
  tracker?: ObservationTracker;
}

export interface AgentWatch extends AsyncIterable<TrackResult> {
  readonly tracker: ObservationTracker;
  readonly dropped: { stale: number; duplicate: number };
  /** Set when an observe call failed; the watch ends there. */
  readonly error: RuntimeError | undefined;
}

/**
 * Polls `adapter.observe` and yields only `new` and `replaced` observations;
 * stale and duplicate ones are counted in `dropped`. Transitions between two
 * polls are not seen. The watch ends on abort, after `maxPolls`, or on the first
 * observe error (kept in `error`). It never writes the journal.
 */
export function watchAgent(
  adapter: RuntimeAdapter,
  handle: AgentHandle,
  options: WatchOptions,
): AgentWatch {
  const tracker = options.tracker ?? new ObservationTracker();
  let failure: RuntimeError | undefined;
  async function* poll(): AsyncGenerator<TrackResult> {
    for (let polls = 0; options.maxPolls === undefined || polls < options.maxPolls; polls += 1) {
      if (options.signal?.aborted === true) return;
      if (polls > 0) {
        try {
          // Polling is sequential by design: each wait precedes the next observe.
          // oxlint-disable-next-line no-await-in-loop
          await delay(
            options.intervalMs,
            undefined,
            options.signal ? { signal: options.signal } : {},
          );
        } catch {
          return;
        }
      }
      // oxlint-disable-next-line no-await-in-loop
      const observed = await adapter.observe(handle);
      if (!observed.ok) {
        failure = observed.error;
        return;
      }
      const result = tracker.accept(observed.value);
      if (result.kind === "new" || result.kind === "replaced") yield result;
    }
  }
  return {
    tracker,
    get dropped() {
      return tracker.dropped;
    },
    get error() {
      return failure;
    },
    [Symbol.asyncIterator]: poll,
  };
}
