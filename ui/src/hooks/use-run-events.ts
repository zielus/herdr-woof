import { useEffect, useRef, useState } from "react";

import type { RunEvent } from "@/lib/api";
import { eventsUrl } from "@/lib/api";

/**
 * The run's event stream over SSE.
 *
 * Resumption is the engine's own contract: each event carries the cursor
 * positioned after it, the server sends it as the SSE `id`, and a dropped
 * connection reconnects with `Last-Event-ID` so the server resumes after it.
 * Delivery across a reconnect is at-least-once, so events are deduped by `seq`.
 *
 * A cursor that cannot resume arrives as a `resync` event. That never means
 * "repair part of the stream": the feed is dropped, the caller refetches the
 * snapshot, and a fresh stream is opened from the beginning.
 */

export type FeedState = "connecting" | "live" | "ended" | "resync" | "error";

export interface RunFeed {
  events: RunEvent[];
  state: FeedState;
  /** The engine's own message for a resync or an error, quoted verbatim. */
  message: string | null;
  /** Cursor of the last event received, for display. */
  cursor: string | null;
}

interface EndLine {
  cursor: string | null;
  terminal: boolean;
  reason: string;
}

export function useRunEvents(runId: string, onResync: () => void): RunFeed {
  const [feed, setFeed] = useState<RunFeed>({
    events: [],
    state: "connecting",
    message: null,
    cursor: null,
  });
  // A resync opens a new stream; the counter is what re-runs the effect.
  const [generation, setGeneration] = useState(0);
  const resync = useRef(onResync);
  resync.current = onResync;

  useEffect(() => {
    const seen = new Set<number>();
    setFeed({ events: [], state: "connecting", message: null, cursor: null });

    // `EventSource` cannot set an Authorization header, so a token server is
    // reached with ?token= here and only here.
    const source = new EventSource(eventsUrl(runId));

    source.addEventListener("message", (message: MessageEvent<string>) => {
      let event: RunEvent;
      try {
        event = JSON.parse(message.data) as RunEvent;
      } catch {
        return;
      }
      if (seen.has(event.seq)) return;
      seen.add(event.seq);
      setFeed((current) => ({
        events: [...current.events, event],
        state: "live",
        message: null,
        cursor: event.cursor,
      }));
    });

    source.addEventListener("end", (message) => {
      const line = JSON.parse((message as MessageEvent<string>).data) as EndLine;
      // The server ends the stream itself; closing here stops EventSource from
      // reconnecting into an immediately-ending stream forever.
      source.close();
      setFeed((current) => ({
        ...current,
        state: "ended",
        message: line.terminal ? null : `stream ended: ${line.reason}`,
        cursor: line.cursor ?? current.cursor,
      }));
    });

    source.addEventListener("resync", (message) => {
      const problem = JSON.parse((message as MessageEvent<string>).data) as {
        reason: string;
        message: string;
      };
      source.close();
      setFeed((current) => ({ ...current, state: "resync", message: problem.message }));
      resync.current();
      // A fresh stream from the beginning, which is the only allowed recovery.
      setTimeout(() => setGeneration((value) => value + 1), 1000);
    });

    source.addEventListener("problem", (message) => {
      const problem = JSON.parse((message as MessageEvent<string>).data) as {
        reason: string;
        message: string;
      };
      source.close();
      setFeed((current) => ({
        ...current,
        state: "error",
        message: `${problem.reason}: ${problem.message}`,
      }));
    });

    source.addEventListener("error", () => {
      // EventSource reconnects on its own, carrying Last-Event-ID; say so rather
      // than claiming the stream is dead.
      if (source.readyState !== EventSource.CLOSED) {
        setFeed((current) => ({ ...current, state: "connecting" }));
      }
    });

    return () => source.close();
  }, [runId, generation]);

  return feed;
}
