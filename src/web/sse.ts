import type { ServerResponse } from "node:http";

import { streamEvents, type EventsSink } from "../observe/stream.js";

/**
 * The run event stream as server-sent events.
 *
 * It is the same `streamEvents` loop `woof events --follow` uses, so terminal
 * detection, the resume-at-a-terminated-cursor shortcut, and resync/corruption
 * reporting have exactly one implementation. `subscribeEvents` on its own never
 * ends on `run.terminated`, so piping it straight into a response would hold
 * every connection open for the life of the process.
 *
 * Wire shape: each run event is a default `message` whose `id` is the event's
 * cursor, so a browser's automatic reconnect sends `Last-Event-ID` and the
 * server resumes after it. The stream ends with a named `end` event; a cursor
 * that cannot resume arrives as a named `resync` event, which means "take a
 * fresh snapshot", never "repair part of the stream".
 */

const KEEPALIVE_MS = 15_000;

function write(response: ServerResponse, chunk: string): void {
  if (!response.writableEnded) response.write(chunk);
}

function sseSink(response: ServerResponse): EventsSink {
  return {
    event(event) {
      write(response, `id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    problem(item) {
      const name = item.type === "resync_required" ? "resync" : "problem";
      write(response, `event: ${name}\ndata: ${JSON.stringify(item)}\n\n`);
    },
    end(cursor, terminal, reason) {
      const line = { kind: "woof.events.end", cursor, terminal, reason };
      write(response, `event: end\ndata: ${JSON.stringify(line)}\n\n`);
    },
    stats() {
      // Polling statistics are a CLI diagnostic; they are not part of the wire shape.
    },
  };
}

export interface StreamRunEventsOptions {
  after?: string;
  pollMs?: number;
  /** Ends the stream from outside, e.g. when the server is shutting down. */
  signal?: AbortSignal;
}

/**
 * Streams `runDir`'s events to `response` until the run terminates, the cursor
 * cannot resume, the journal is unreadable, or the client disconnects. Resolves
 * with the reason it stopped once the response is closed.
 */
export async function streamRunEvents(
  response: ServerResponse,
  runDir: string,
  options: StreamRunEventsOptions = {},
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  // A client that reconnects should back off a little; the engine polls the
  // journal at 250 ms and nothing is lost while the connection is down.
  write(response, "retry: 2000\n\n");
  response.flushHeaders?.();

  // The generator polls a file: without this the poll loop outlives every
  // browser reconnect for the life of the process. The same controller carries
  // the server's own shutdown, so a stream ends with an `end` frame rather than
  // with a destroyed socket.
  const controller = new AbortController();
  const stop = () => controller.abort();
  response.on("close", stop);
  if (options.signal?.aborted === true) controller.abort();
  else options.signal?.addEventListener("abort", stop, { once: true });

  const keepalive = setInterval(() => write(response, ": keepalive\n\n"), KEEPALIVE_MS);
  keepalive.unref?.();

  try {
    await streamEvents(
      runDir,
      {
        follow: true,
        pollMs: options.pollMs ?? 250,
        stats: false,
        signal: controller.signal,
        // One process-level SIGINT listener per stream is the CLI's contract,
        // not a server's: this server ends its streams through `signal`.
        handleSigint: false,
        ...(options.after !== undefined ? { after: options.after } : {}),
      },
      sseSink(response),
    );
  } finally {
    clearInterval(keepalive);
    response.off("close", stop);
    options.signal?.removeEventListener("abort", stop);
    if (!response.writableEnded) response.end();
  }
}
