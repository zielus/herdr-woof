import type { HostView } from "../host/run.js";
import { MAX_EVENTS_LIMIT, readEvents } from "../observe/events.js";
import type { RunRenderer } from "../observe/render.js";
import { paintFor, sanitize } from "../observe/render-text.js";
import { streamEvents, type EventsSink } from "../observe/stream.js";
import { rendererFor, type DefinitionResolver, type RunViewOptions } from "./run-view.js";
import { readRunStatus } from "./status.js";

/**
 * The human view a run host prints to its own stdout (docs/design/run-output.md): the opening
 * block once the run is open, one history row per journal record as it lands, and the outcome
 * summary when the run ends. The host follows its OWN journal through the observe stream — the
 * same lock-free read `woof watch --follow` uses — not the driver's callbacks, so the host's pane
 * and a separate `woof watch` print the same rows from the same facts. It is built here, above
 * the host, from the same inspection reads `woof watch` uses, and handed to the host as a
 * `HostView`.
 *
 * The follow never delays the host's exit: `finish` aborts it, prints whatever rows it had not
 * read yet from one more direct read, and renders the summary from the final snapshot.
 *
 * A journal the host's own follower cannot read (corrupt, replaced, resync required) is reported
 * once, as one subdued diagnostic line in the view and one line in the technical log, and the
 * follow stops. The view is presentation only: whatever it meets, it never throws into the host,
 * so the run's outcome and exit code come from the scheduler alone.
 */

export interface HostViewOptions extends RunViewOptions {
  runDir: string;
  pollMs: number;
  write: (line: string) => void;
  /** The technical log; a journal problem the view meets is logged there as well. */
  log?: (line: string) => void;
  /** Resolves the run's workflow definition for the stage map; absent, the plan's stages are listed. */
  definitionFor?: DefinitionResolver;
}

export function createHostView(options: HostViewOptions): HostView {
  const { runDir, write, definitionFor } = options;
  const paint = paintFor(options.color);
  const controller = new AbortController();
  let renderer: RunRenderer | undefined;
  let following: Promise<unknown> | undefined;
  let cursor: string | undefined;
  let finished = false;
  let reported = false;

  /** One diagnostic per view: the pane learns why its rows stopped, and where the outcome is. */
  const problem = (reason: string, message: string) => {
    controller.abort();
    if (reported) return;
    reported = true;
    const line = `view: ${sanitize(reason)}: ${sanitize(message)}; the run's outcome is in the result line and outcome.json`;
    try {
      options.log?.(line);
      write(paint(`-- ${line}`, "dim"));
    } catch {
      // The pane and the log are both gone; the outcome still reaches the result line.
    }
  };

  const sink: EventsSink = {
    event: (event) => {
      cursor = event.cursor;
      if (renderer === undefined) return;
      for (const line of renderer.row(event)) write(line);
    },
    problem: (item) => problem(item.reason, item.message),
    end: () => {},
    stats: () => {},
  };

  return {
    start() {
      if (following !== undefined || controller.signal.aborted) return;
      const read = readRunStatus(runDir);
      if (read.ok) {
        renderer = rendererFor(runDir, read, options, definitionFor);
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
      ).catch((error: unknown) => problem("view_failed", (error as Error).message));
    },

    async finish() {
      if (finished) return;
      finished = true;
      controller.abort();
      try {
        await following;
        catchUp();
      } catch (error) {
        problem("view_failed", (error as Error).message);
      }
    },

    close() {
      finished = true;
      controller.abort();
    },
  };

  /** Rows the follow had not read when it was stopped (the renderer drops any repeat by seq), then the summary. */
  function catchUp(): void {
    for (;;) {
      const read = readEvents(runDir, {
        ...(cursor !== undefined ? { after: cursor } : {}),
        limit: MAX_EVENTS_LIMIT,
      });
      if (!read.ok) {
        problem(read.reason, read.message);
        break;
      }
      for (const event of read.events) sink.event(event);
      if (read.events.length < MAX_EVENTS_LIMIT) break;
    }
    const final = readRunStatus(runDir);
    if (!final.ok) {
      problem(final.reason, final.message);
      return;
    }
    if (renderer === undefined) {
      renderer = rendererFor(runDir, final, options, definitionFor);
      for (const line of renderer.opening()) write(line);
    }
    for (const line of renderer.summary({
      status: final.status,
      result: final.result,
      snapshot: final.snapshot,
    }))
      write(line);
  }
}
