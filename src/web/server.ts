import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listRuns, type RunListEntry } from "../inspect/runs.js";
import { readRunStatus } from "../inspect/status.js";
import { cancelRun } from "../state/store.js";
import {
  admit,
  isLoopback,
  LOOPBACK_HOSTS,
  MIN_TOKEN_LENGTH,
  parseOrigin,
  type SecurityPolicy,
} from "./security.js";
import { streamRunEvents } from "./sse.js";
import { bundleIndex, MISSING_SPA_MESSAGE, serveSpa } from "./static.js";

/**
 * The Web UI's HTTP surface (p9 base): a thin shell over the engine's own
 * read functions and its one operator action.
 *
 * Every GET is a passthrough to `listRuns` / `readRunStatus` / the event
 * stream, which take no journal lock and never contact Herdr, so the UI is
 * never a second journal writer or a parallel lock holder. The only mutating
 * route is cancel, which calls the same `cancelRun` that `woof run cancel`
 * calls. Actions the engine has no call for are reported as unsupported with
 * the engine's reason; they are never simulated.
 *
 * This module is deliberately not exported from `src/index.ts`: the SDK entry
 * stays free of server and CLI concerns.
 */

export const DEFAULT_UI_PORT = 4317;

/** Largest request body accepted on a mutating route. Cancel's body is one short reason. */
const MAX_BODY_BYTES = 1024;

/**
 * How long a mutating request may take to deliver its body. The server's own
 * `requestTimeout` is off, because it would cut the long-lived event streams;
 * this bounds the one route that reads a body.
 */
const BODY_TIMEOUT_MS = 5_000;

/** Concurrent event streams one server will hold open. */
const MAX_STREAMS = 64;

/** How long shutdown waits for open streams to send their `end` frame. */
const STREAM_DRAIN_MS = 1_000;

const distUiDefault = resolve(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "dist-ui");

export interface UnsupportedAction {
  supported: false;
  reason: string;
  message: string;
}

/**
 * What this server can actually do, so the UI disables an action because the
 * server said so rather than because the UI hard-codes the same list.
 */
export const CAPABILITIES = {
  schemaVersion: 1,
  kind: "woof.ui.capabilities",
  actions: {
    cancel: { supported: true, method: "POST", path: "/api/runs/{runId}/cancel" },
    answerBlocked: {
      supported: false,
      reason: "answer_blocked_unsupported",
      message:
        "the engine has no call that answers a blocked agent: a block clears when the runtime observes the agent leave blocked, when the run is cancelled, or when blockedWaitMs elapses into exhausted. Answer the prompt in the agent's Herdr pane; attention.blocked.requiredAction names what to do.",
    } satisfies UnsupportedAction,
    retry: {
      supported: false,
      reason: "retry_unsupported",
      message:
        "work retry and format repair are scheduler decisions, not operator actions. There is no call that retries an attempt, resumes a lost run or restarts a terminated one; a lost owner is reported and only ever cancelled.",
    } satisfies UnsupportedAction,
    start: {
      supported: false,
      reason: "start_unsupported",
      message:
        "starting a run hosts it in a Herdr pane, which the package does not export. Start runs with woof run start in a terminal.",
    } satisfies UnsupportedAction,
  },
} as const;

export interface WebServerOptions {
  /** Directory holding one subdirectory per run. */
  runsDir: string;
  host?: string;
  port?: number;
  /** Required on every request when set. A non-loopback host must set one. */
  token?: string | null;
  /** The built SPA. Defaults to `dist-ui/` beside the compiled `dist/`. */
  distUiDir?: string;
  /** Extra host names requests may name, e.g. a Tailscale name. */
  allowHosts?: readonly string[];
  /**
   * Extra origins admitted beside the request's own, e.g. the Vite dev server
   * or the HTTPS origin of a proxy in front of this server.
   */
  allowOrigins?: readonly string[];
  /** Journal poll interval for event streams. */
  pollMs?: number;
}

export interface WebServer {
  url: string;
  host: string;
  port: number;
  runsDir: string;
  distUiDir: string;
  /** True when the SPA bundle is present; false means API-only. */
  spa: boolean;
  server: Server;
  close(): Promise<void>;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(text)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(text);
}

function rejected(
  response: ServerResponse,
  status: number,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  send(response, status, { outcome: "rejected", reason, message, ...extra });
}

function unsupported(response: ServerResponse, action: UnsupportedAction): void {
  // 501: the route exists and is understood, the engine has no call behind it.
  send(response, 501, { outcome: "unsupported", reason: action.reason, message: action.message });
}

type BodyRead =
  | { ok: true; text: string }
  | { ok: false; reason: "body_too_large" | "body_timeout" | "body_aborted" };

/**
 * Reads a mutating request's body, bounded in both size and time. A client that
 * opens a request and then stalls mid-body would otherwise hold its socket for
 * the life of the process, because `requestTimeout` is off for the streams.
 */
async function readBody(request: IncomingMessage): Promise<BodyRead> {
  const read = (async (): Promise<BodyRead> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      size += buffer.byteLength;
      if (size > MAX_BODY_BYTES) return { ok: false, reason: "body_too_large" };
      chunks.push(buffer);
    }
    return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
  })().catch((): BodyRead => ({ ok: false, reason: "body_aborted" }));

  let timer: NodeJS.Timeout | undefined;
  // The read is raced rather than cut: destroying the request here would take
  // the socket with it, and the caller could not answer the client at all.
  const timeout = new Promise<BodyRead>((done) => {
    timer = setTimeout(() => done({ ok: false, reason: "body_timeout" }), BODY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The open event streams, so shutdown can end each one with its `end` frame
 * instead of destroying its socket, and so the 65th stream is refused rather
 * than accepted into an unbounded set of pollers.
 */
function afterMs(ms: number): Promise<void> {
  return new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
  });
}

class OpenStreams {
  private readonly open = new Map<AbortController, Promise<void>>();
  private closing = false;

  get count(): number {
    return this.open.size;
  }

  get full(): boolean {
    return this.open.size >= MAX_STREAMS;
  }

  run(body: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    // Closing the listener does not stop a request already in flight on an open
    // keep-alive connection. One that arrives mid-shutdown is registered and
    // ended at once, so it still writes its `end` frame instead of having its
    // socket destroyed under it.
    if (this.closing) controller.abort();
    const done = body(controller.signal).finally(() => this.open.delete(controller));
    this.open.set(controller, done);
    return done;
  }

  /**
   * Ends every open stream, waiting at most `STREAM_DRAIN_MS` in total. It loops
   * because a stream can still be admitted while the first round is draining;
   * an entry is removed before its promise settles, so a settled round leaves
   * behind only streams that joined during it.
   */
  async drain(): Promise<void> {
    this.closing = true;
    const deadline = Date.now() + STREAM_DRAIN_MS;
    for (;;) {
      const waiting = [...this.open.values()];
      if (waiting.length === 0) return;
      for (const controller of this.open.keys()) controller.abort();
      const left = deadline - Date.now();
      if (left <= 0) return;
      // oxlint-disable-next-line no-await-in-loop
      await Promise.race([Promise.allSettled(waiting), afterMs(left)]);
    }
  }
}

/**
 * The directory of the run named `runId`. Run directories are found by listing
 * the runs directory and matching the recorded run id, never by joining the
 * request path onto a filesystem path.
 */
function runDirOf(
  runsDir: string,
  runId: string,
): { ok: true; entry: RunListEntry } | { ok: false; reason: string; message: string } {
  let listed;
  try {
    // `all` matters: the default listing keeps only the 20 most recent terminal
    // runs, so an older finished run would be unreachable by id.
    listed = listRuns({ runsDir, all: true });
  } catch (error) {
    return {
      ok: false,
      reason: "runs_dir_unreadable",
      message: `cannot read ${runsDir}: ${(error as Error).message}`,
    };
  }
  const matches = listed.runs.filter((run) => run.runId === runId);
  const [entry, ...rest] = matches;
  if (entry === undefined) {
    return { ok: false, reason: "run_not_found", message: `no run ${runId} under ${runsDir}` };
  }
  if (rest.length > 0) {
    return {
      ok: false,
      reason: "run_id_ambiguous",
      message: `${matches.length} directories under ${runsDir} record the run id ${runId}`,
    };
  }
  return { ok: true, entry };
}

function handleRuns(response: ServerResponse, runsDir: string, url: URL): void {
  const project = url.searchParams.get("project");
  try {
    const listed = listRuns({
      runsDir,
      all: url.searchParams.get("all") === "true",
      ...(project !== null && project !== "" ? { project: resolve(project) } : {}),
    });
    // The list view names the stage a run is on and whether it needs the
    // operator. `listRuns` reports neither, so each entry is enriched from the
    // same read-only status document the detail view uses, rather than by the
    // browser fetching every run separately. An entry that cannot be read again
    // (a run removed between the two reads) reports nulls, never a guess.
    const runs = listed.runs.map((entry) => {
      const read = readRunStatus(entry.runDir);
      return {
        ...entry,
        activeAttempts: read.ok ? read.status.activeAttempts : null,
        attention: read.ok ? read.status.attention : null,
      };
    });
    send(response, 200, { outcome: "runs", ...listed, runs });
  } catch (error) {
    rejected(
      response,
      503,
      "runs_dir_unreadable",
      `cannot read ${runsDir}: ${(error as Error).message}`,
    );
  }
}

function handleRun(response: ServerResponse, entry: RunListEntry): void {
  const read = readRunStatus(entry.runDir);
  if (!read.ok) {
    rejected(response, 404, read.reason, read.message);
    return;
  }
  send(response, 200, {
    outcome: "run",
    status: read.status,
    result: read.result,
    snapshot: read.snapshot,
    project: entry.project,
  });
}

async function handleCancel(
  request: IncomingMessage,
  response: ServerResponse,
  entry: RunListEntry,
): Promise<void> {
  // A JSON content type is required, not merely accepted: it is the header that
  // forces a cross-origin request into a preflight this server never answers,
  // so a form post from another page cannot reach cancelRun at all.
  const contentType = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    rejected(
      response,
      415,
      "content_type_unsupported",
      `cancel requires content-type: application/json; it carried ${JSON.stringify(request.headers["content-type"] ?? "")}`,
    );
    return;
  }
  const body = await readBody(request);
  if (!body.ok) {
    if (body.reason === "body_aborted") {
      // Usually the client went away mid-body, and writing to a dead socket is
      // harmless. It is still named: a bare end() here would be an empty 200,
      // which the SPA would read as a cancel that landed while the journal has
      // nothing in it.
      rejected(response, 400, "body_incomplete", "the request body did not arrive in full");
      return;
    }
    if (body.reason === "body_timeout") {
      // Answered first, then the socket is released: a client still sending
      // gets the reason rather than a dropped connection.
      response.on("finish", () => request.destroy());
      rejected(
        response,
        408,
        "body_timeout",
        `the request body did not arrive within ${BODY_TIMEOUT_MS} ms`,
      );
      return;
    }
    rejected(response, 413, "body_too_large", `the request body exceeds ${MAX_BODY_BYTES} bytes`);
    return;
  }
  let reason = "cancelled from the woof web UI";
  if (body.text.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch (error) {
      rejected(response, 400, "body_invalid", `the request body is not JSON: ${String(error)}`);
      return;
    }
    const given =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)["reason"]
        : undefined;
    if (given !== undefined) {
      if (typeof given !== "string" || given.trim() === "") {
        rejected(response, 400, "body_invalid", "reason must be a non-empty string when given");
        return;
      }
      reason = given;
    }
  }
  // The same call `woof run cancel` makes: it takes the journal lock, replays
  // state and refuses an invalid transition, so cancelling a run a scheduler is
  // actively hosting is safe without any liveness check first.
  const outcome = await cancelRun({ runDir: entry.runDir, source: "web", reason });
  send(response, outcome.outcome === "recorded" ? 200 : 409, outcome);
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    runsDir: string;
    distUiDir: string;
    policy: SecurityPolicy;
    pollMs: number;
    streams: OpenStreams;
  },
): Promise<void> {
  const target = request.url ?? "/";
  let url: URL;
  try {
    url = new URL(target, "http://placeholder.invalid");
  } catch {
    rejected(response, 400, "request_invalid", `cannot parse the request target ${target}`);
    return;
  }
  const method = request.method ?? "GET";
  const segments = url.pathname.split("/").filter((part) => part !== "");
  const api = segments[0] === "api";
  const mutating = method !== "GET" && method !== "HEAD";

  // The token guards the API only: the bundle is public build output, and a
  // `<script src>` subresource carries neither a query token nor a header.
  const admitted = admit(request, url, options.policy, { api, mutating });
  if (!admitted.ok) {
    rejected(response, admitted.status, admitted.reason, admitted.message);
    return;
  }

  if (!api) {
    if (method !== "GET" && method !== "HEAD") {
      rejected(response, 405, "method_not_allowed", `${method} is not allowed on ${url.pathname}`);
      return;
    }
    const served = serveSpa(response, options.distUiDir, url.pathname);
    if (served === "bundle_missing") {
      rejected(response, 503, "ui_bundle_missing", MISSING_SPA_MESSAGE, {
        distUiDir: options.distUiDir,
      });
    } else if (served === "not_found") {
      rejected(response, 404, "asset_not_found", `the bundle has no ${url.pathname}`);
    }
    return;
  }

  if (segments.length === 2 && segments[1] === "capabilities" && method === "GET") {
    send(response, 200, CAPABILITIES);
    return;
  }
  if (segments[1] !== "runs") {
    rejected(response, 404, "route_not_found", `no route ${method} ${url.pathname}`);
    return;
  }
  if (segments.length === 2) {
    if (method === "GET") {
      handleRuns(response, options.runsDir, url);
      return;
    }
    if (method === "POST") {
      unsupported(response, CAPABILITIES.actions.start);
      return;
    }
    rejected(response, 405, "method_not_allowed", `${method} is not allowed on ${url.pathname}`);
    return;
  }

  const runId = segments[2] as string;
  const tail = segments[3];
  if (segments.length > 4) {
    rejected(response, 404, "route_not_found", `no route ${method} ${url.pathname}`);
    return;
  }
  // The unsupported actions are answered before the run is resolved: their
  // answer does not depend on the run, and a wrong id must not disguise the
  // fact that the engine has no such call.
  if (method === "POST" && tail === "answer") {
    unsupported(response, CAPABILITIES.actions.answerBlocked);
    return;
  }
  if (method === "POST" && tail === "retry") {
    unsupported(response, CAPABILITIES.actions.retry);
    return;
  }

  const found = runDirOf(options.runsDir, runId);
  if (!found.ok) {
    rejected(
      response,
      found.reason === "runs_dir_unreadable" ? 503 : 404,
      found.reason,
      found.message,
    );
    return;
  }

  if (tail === undefined && method === "GET") {
    handleRun(response, found.entry);
    return;
  }
  if (tail === "events" && method === "GET") {
    // Checked before any header is written: once the stream's 200 is sent there
    // is no way back to a refusal.
    if (options.streams.full) {
      rejected(
        response,
        503,
        "too_many_streams",
        `this server holds at most ${MAX_STREAMS} event streams open; close a tab and retry`,
      );
      return;
    }
    const after = url.searchParams.get("after") ?? request.headers["last-event-id"];
    await options.streams.run((signal) =>
      streamRunEvents(response, found.entry.runDir, {
        pollMs: options.pollMs,
        signal,
        ...(typeof after === "string" && after !== "" ? { after } : {}),
      }),
    );
    return;
  }
  if (tail === "cancel" && method === "POST") {
    await handleCancel(request, response, found.entry);
    return;
  }
  rejected(response, 404, "route_not_found", `no route ${method} ${url.pathname}`);
}

/**
 * Starts the Web UI server. Resolves once it is listening, with the URL to open.
 * Binding beyond loopback without a token is refused: the Host and Origin checks
 * alone do not authenticate anyone who can reach the port.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_UI_PORT;
  const token = options.token ?? null;
  const distUiDir = options.distUiDir ?? distUiDefault;
  const runsDir = resolve(options.runsDir);
  if (!isLoopback(host) && token === null) {
    throw new TypeError(
      `refusing to bind ${host}: a server reachable beyond loopback needs --token, because the Host and Origin checks do not authenticate whoever can reach the port`,
    );
  }
  if (token !== null && token.length < MIN_TOKEN_LENGTH) {
    throw new TypeError(
      `refusing to start: --token must be at least ${MIN_TOKEN_LENGTH} characters, and the one given is ${token.length}. It is the only thing between the port and whoever can reach it; generate one with: openssl rand -hex 16`,
    );
  }
  const allowedOrigins: string[] = [];
  for (const origin of options.allowOrigins ?? []) {
    const parsed = parseOrigin(origin);
    if (parsed === null) {
      throw new TypeError(
        `refusing to start: ${JSON.stringify(origin)} is not an origin; an origin is scheme://host[:port] with no path, such as http://127.0.0.1:5173`,
      );
    }
    allowedOrigins.push(parsed);
  }
  const policy: SecurityPolicy = {
    allowedHosts: [
      ...new Set(
        [...LOOPBACK_HOSTS, host, ...(options.allowHosts ?? [])].map((n) => n.toLowerCase()),
      ),
    ],
    allowedOrigins: [...new Set(allowedOrigins)],
    token,
  };
  const pollMs = options.pollMs ?? 250;
  const streams = new OpenStreams();

  const server = createServer((request, response) => {
    void route(request, response, { runsDir, distUiDir, policy, pollMs, streams }).catch(
      (error: unknown) => {
        if (response.headersSent) {
          response.end();
          return;
        }
        rejected(response, 500, "server_error", `${(error as Error).message}`);
      },
    );
  });
  // Event streams are long-lived by design; the request timeout would cut them.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;
  const authority = host.includes(":") ? `[${host}]` : host;
  // The same check a request makes, so `spa: true` cannot mean "an index.html is
  // there" while every request answers ui_bundle_missing.
  const spa = bundleIndex(distUiDir) !== null;

  return {
    // The token rides in the fragment, never the query: a fragment is not sent
    // to the server, so it stays out of access logs, proxies and Referer
    // headers. The SPA reads it once and moves it into sessionStorage.
    url: `http://${authority}:${bound}/${token === null ? "" : `#token=${encodeURIComponent(token)}`}`,
    host,
    port: bound,
    runsDir,
    distUiDir,
    spa,
    server,
    close: async () => {
      // The listener stops first, so no new connection joins behind the drain's
      // back; `server.close` resolves only once every connection has ended, so
      // it is started and awaited last. Then the streams: each writes its `end`
      // frame and ends its response, so a browser sees a finished stream rather
      // than a dropped connection it would immediately try to reconnect to.
      // Whatever is left — a half-sent asset, an idle keep-alive socket — is
      // what `closeAllConnections` clears, and without it the await never ends.
      const closed = new Promise<void>((done) => server.close(() => done()));
      await streams.drain();
      server.closeAllConnections();
      await closed;
    },
  };
}
