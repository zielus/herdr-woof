import { readRunStatus } from "../inspect/status.js";
import { MAX_EVENTS_LIMIT, readEvents } from "../observe/events.js";
import type { RunRenderer } from "../observe/render.js";
import { rendererFor, type RunViewOptions } from "../observe/run-view.js";
import { streamEvents, type EventsSink } from "../observe/stream.js";

/**
 * The human view a run host prints to its own stdout (docs/design/run-output.md): the opening
 * block once the run is open, one history row per journal record as it lands, and the outcome
 * summary when the run ends. The host follows its OWN journal through the observe stream — the
 * same lock-free read `woof watch --follow` uses — not the driver's callbacks, so the host's pane
 * and a separate `woof watch` print the same rows from the same facts.
 *
 * The follow never delays the host's exit: `finish` aborts it, prints whatever rows it had not
 * read yet from one more direct read, and renders the summary from the final snapshot.
 */

export interface HostView {
  /** Prints the opening block and starts following the journal. Call once the run is open. */
  start(): void;
  /** Stops the follow, prints the rows still unread and the outcome summary. Idempotent. */
  finish(): Promise<void>;
  /** Aborts the follow without printing anything more (a safety net for an aborted host). */
  close(): void;
}

export interface HostViewOptions extends RunViewOptions {
  runDir: string;
  pollMs: number;
  write: (line: string) => void;
}

export function createHostView(options: HostViewOptions): HostView {
  const { runDir, write } = options;
  const controller = new AbortController();
  let renderer: RunRenderer | undefined;
  let following: Promise<unknown> | undefined;
  let cursor: string | undefined;
  let finished = false;

  const sink: EventsSink = {
    event: (event) => {
      cursor = event.cursor;
      if (renderer === undefined) return;
      for (const line of renderer.row(event)) write(line);
    },
    // A read problem in the host's own journal is a host concern; the summary below still comes
    // from the snapshot, so nothing is printed here.
    problem: () => {},
    end: () => {},
    stats: () => {},
  };

  return {
    start() {
      if (following !== undefined || controller.signal.aborted) return;
      const read = readRunStatus(runDir);
      if (read.ok) {
        renderer = rendererFor(runDir, read, options);
        for (const line of renderer.opening()) write(line);
      }
      following = streamEvents(
        runDir,
        {
          follow: true,
          pollMs: options.pollMs,
          stats: false,
          signal: controller.signal,
          handleSigint: false,
        },
        sink,
      ).catch(() => undefined);
    },

    async finish() {
      if (finished) return;
      finished = true;
      controller.abort();
      await following;
      // Rows the follow had not read when it was stopped; the renderer drops any repeat by seq.
      for (;;) {
        const read = readEvents(runDir, {
          ...(cursor !== undefined ? { after: cursor } : {}),
          limit: MAX_EVENTS_LIMIT,
        });
        if (!read.ok) break;
        for (const event of read.events) sink.event(event);
        if (read.events.length < MAX_EVENTS_LIMIT) break;
      }
      const final = readRunStatus(runDir);
      if (!final.ok) return;
      if (renderer === undefined) {
        renderer = rendererFor(runDir, final, options);
        for (const line of renderer.opening()) write(line);
      }
      for (const line of renderer.summary({
        status: final.status,
        result: final.result,
        snapshot: final.snapshot,
      }))
        write(line);
    },

    close() {
      finished = true;
      controller.abort();
    },
  };
}
