import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  cliPath,
  distUrl,
  journal,
  ofType,
  openAttemptOk,
  openPlannedRun,
  repoRoot,
  runNode,
  runSdk,
  testPlan,
  woof,
} from "./helpers/process.js";

// The web UI server (p9) as a real process: `node dist/cli.js ui` against run
// directories written through the compiled store, driven over HTTP. Nothing
// here imports src/, and no assertion is made about a run the engine did not
// record.

type Json = Record<string, any>; // oxlint-disable-line no-explicit-any

/**
 * A token the server will accept: at least MIN_TOKEN_LENGTH characters, and
 * deliberately not shaped like a key — a high-entropy literal here trips the
 * release preflight's secret scan.
 */
const TOKEN = "woof-ui-test-token-not-a-secret";

const dirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGTERM");
    await delay(50);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

interface Server {
  origin: string;
  listening: Json;
  stderr: () => string;
}

/**
 * Starts `woof ui` on an ephemeral port and waits for the line it prints once
 * it is listening. `woof()` cannot be used: it is spawnSync, and this process
 * does not exit on its own.
 */
async function startUi(args: readonly string[], home: string): Promise<Server> {
  const child = spawn("node", [cliPath, "ui", "--port", "0", "--no-open", ...args], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, HERDR_PANE_ID: undefined, WOOF_RUN_DIR: undefined },
  }) as ChildProcessWithoutNullStreams;
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

  const deadline = Date.now() + 15_000;
  for (;;) {
    const line = stdout.split("\n")[0];
    if (line !== undefined && line.trim() !== "") {
      const listening = JSON.parse(line) as Json;
      expect(listening["outcome"], stdout + stderr).toBe("listening");
      return {
        origin: `http://127.0.0.1:${listening["port"]}`,
        listening,
        stderr: () => stderr,
      };
    }
    if (child.exitCode !== null) throw new Error(`woof ui exited: ${stdout}${stderr}`);
    if (Date.now() > deadline) throw new Error(`woof ui never listened: ${stdout}${stderr}`);
    // oxlint-disable-next-line no-await-in-loop
    await delay(25);
  }
}

/** A runs directory holding one planned run with an open attempt. */
function runsDirWithRun(runId = "run-1"): { runsDir: string; runDir: string; home: string } {
  const root = tempDir("woof-web-");
  const runsDir = join(root, "runs");
  const runDir = join(runsDir, runId);
  const home = join(root, "home");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(home);
  openPlannedRun(runDir);
  openAttemptOk(runDir);
  return { runsDir, runDir, home };
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: Json }> {
  const response = await fetch(url, init);
  return { status: response.status, body: (await response.json()) as Json };
}

/**
 * A request with headers `fetch` will not send. `Host` and `Origin` are
 * forbidden header names there, and those are exactly the two the admission
 * rules turn on, so the admission tests go through node:http directly.
 */
function rawRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Json }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        // node:http sends its own Host unless one is given here.
        headers: options.headers ?? {},
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () =>
          resolveRequest({
            status: response.statusCode ?? 0,
            body: JSON.parse(text === "" ? "null" : text) as Json,
          }),
        );
      },
    );
    request.on("error", rejectRequest);
    request.end();
  });
}

/** Reads a server-sent event stream to its end, or until `timeoutMs` elapses. */
async function readSse(url: string, timeoutMs = 15_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text = "";
  try {
    const response = await fetch(url, { signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes("\nevent: end\n")) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return text;
}

/** The `data:` payloads of the default (run event) messages in an SSE stream. */
function sseEvents(text: string): Json[] {
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("id: "))
    .map((frame) => JSON.parse(frame.split("data: ")[1] ?? "null") as Json);
}

function sseNamed(text: string, name: string): Json | undefined {
  const frame = text.split("\n\n").find((part) => part.startsWith(`event: ${name}\n`));
  return frame === undefined ? undefined : (JSON.parse(frame.split("data: ")[1] ?? "null") as Json);
}

describe("woof ui: reading runs", () => {
  it("lists runs with the stage each one is on and serves one run's status and snapshot", async () => {
    const { runsDir, runDir, home } = runsDirWithRun();
    const server = await startUi(["--runs-dir", runsDir], home);

    const listed = await getJson(`${server.origin}/api/runs`);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ outcome: "runs", runsDir, exists: true });
    expect(listed.body["runs"]).toHaveLength(1);
    expect(listed.body["runs"][0]).toMatchObject({
      runId: "run-1",
      runDir,
      status: "created",
      owner: "unhosted",
      workflow: { name: "report-review", version: "1" },
      // Added by the web server from the same status document, not by listRuns.
      activeAttempts: [
        { agentId: "worker", stageId: "report", visit: 1, attempt: 1, dispatchedAt: null },
      ],
      attention: { ambiguousDeliveries: [], blocked: null },
    });

    const run = await getJson(`${server.origin}/api/runs/run-1`);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({
      outcome: "run",
      status: { kind: "woof.run.status", runId: "run-1", status: "created" },
      result: null,
      snapshot: { kind: "woof.run.snapshot", runId: "run-1" },
    });
    // The compact view and the snapshot it came from agree; the UI reads both.
    expect(run.body["status"]["cursor"]).toBe(run.body["snapshot"]["cursor"]);

    const missing = await getJson(`${server.origin}/api/runs/nope`);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ outcome: "rejected", reason: "run_not_found" });
  });

  it("finds a terminal run past the default listing cap, which only lists twenty", async () => {
    const root = tempDir("woof-web-cap-");
    const runsDir = join(root, "runs");
    const home = join(root, "home");
    mkdirSync(runsDir, { recursive: true });
    mkdirSync(home);
    // 22 ended runs: the oldest are past DEFAULT_TERMINAL_RUNS and would be
    // unreachable if the id lookup used the default listing.
    for (let index = 0; index < 22; index += 1) {
      const runDir = join(runsDir, `ended-${String(index).padStart(2, "0")}`);
      mkdirSync(runDir);
      runSdk(
        runDir,
        `await store.openRun({ runDir, runId: input.runId, plan: input.plan });
out = await store.terminateRun({ runDir, outcome: "completed", reason: "fixture" });`,
        { runId: `ended-${String(index).padStart(2, "0")}`, plan: testPlan() },
      );
    }
    const server = await startUi(["--runs-dir", runsDir], home);

    const listed = await getJson(`${server.origin}/api/runs`);
    expect(listed.body["runs"]).toHaveLength(20);
    const oldest = "ended-00";
    expect(listed.body["runs"].map((run: Json) => run["runId"])).not.toContain(oldest);

    const found = await getJson(`${server.origin}/api/runs/${oldest}`);
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body["snapshot"]["runId"]).toBe(oldest);
  });
});

describe("woof ui: the event stream", () => {
  it("streams a terminated run's events, ends, and resumes after a cursor", async () => {
    const { runsDir, runDir, home } = runsDirWithRun();
    expect(woof(["run", "cancel", runDir]).status).toBe(0);
    const server = await startUi(["--runs-dir", runsDir], home);

    const whole = await readSse(`${server.origin}/api/runs/run-1/events`);
    const events = sseEvents(whole);
    expect(events.map((event) => event["type"])).toEqual([
      "run.opened",
      "attempt.opened",
      "run.terminated",
    ]);
    // Each event carries the cursor positioned after it, as the SSE id.
    for (const event of events) {
      expect(whole).toContain(`id: ${event["cursor"]}\ndata: `);
    }
    const end = sseNamed(whole, "end");
    expect(end).toMatchObject({
      kind: "woof.events.end",
      terminal: true,
      reason: "terminated",
      cursor: events.at(-1)?.["cursor"],
    });

    // Resuming after the first event replays only what follows it.
    const first = events[0]?.["cursor"] as string;
    const resumed = await readSse(
      `${server.origin}/api/runs/run-1/events?after=${encodeURIComponent(first)}`,
    );
    expect(sseEvents(resumed).map((event) => event["type"])).toEqual([
      "attempt.opened",
      "run.terminated",
    ]);

    // The same resume through Last-Event-ID, which is what a browser reconnect sends.
    const byHeader = await fetch(`${server.origin}/api/runs/run-1/events`, {
      headers: { "last-event-id": first },
    });
    const text = await byHeader.text();
    expect(sseEvents(text).map((event) => event["type"])).toEqual([
      "attempt.opened",
      "run.terminated",
    ]);

    // A cursor at the run's own last record ends at once rather than waiting.
    const atEnd = events.at(-1)?.["cursor"] as string;
    const started = Date.now();
    const nothing = await readSse(
      `${server.origin}/api/runs/run-1/events?after=${encodeURIComponent(atEnd)}`,
    );
    expect(sseEvents(nothing)).toEqual([]);
    expect(sseNamed(nothing, "end")).toMatchObject({ terminal: true, reason: "terminated" });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 40_000);

  it("reports a cursor from another run as resync, never as a partial replay", async () => {
    const { runsDir, home } = runsDirWithRun();
    const other = join(runsDir, "other");
    mkdirSync(other);
    // Terminated, so its own stream ends instead of following it forever.
    runSdk(
      other,
      `await store.openRun({ runDir, runId: "other", plan: input });
out = await store.terminateRun({ runDir, outcome: "cancelled", reason: "fixture" });`,
      testPlan(),
    );
    const server = await startUi(["--runs-dir", runsDir], home);

    const foreign = sseEvents(await readSse(`${server.origin}/api/runs/other/events`))[0]?.[
      "cursor"
    ] as string;
    const text = await readSse(
      `${server.origin}/api/runs/run-1/events?after=${encodeURIComponent(foreign)}`,
    );
    expect(sseEvents(text)).toEqual([]);
    expect(sseNamed(text, "resync")).toMatchObject({
      type: "resync_required",
      reason: "cursor_foreign",
    });
  }, 40_000);

  it("follows a live run and ends when it is cancelled from elsewhere", async () => {
    const { runsDir, runDir, home } = runsDirWithRun();
    const server = await startUi(["--runs-dir", runsDir, "--poll-ms", "25"], home);

    const following = readSse(`${server.origin}/api/runs/run-1/events`, 25_000);
    await delay(400);
    expect(woof(["run", "cancel", runDir, "--reason", "from the test"]).status).toBe(0);

    const text = await following;
    const events = sseEvents(text);
    expect(events.at(-1)).toMatchObject({
      type: "run.terminated",
      data: { outcome: "cancelled", reason: "from the test" },
    });
    expect(sseNamed(text, "end")).toMatchObject({ terminal: true, reason: "terminated" });
  }, 40_000);
});

describe("woof ui: actions", () => {
  it("cancels a run through the same call woof run cancel makes", async () => {
    const { runsDir, runDir, home } = runsDirWithRun();
    const server = await startUi(["--runs-dir", runsDir], home);

    const cancelled = await getJson(`${server.origin}/api/runs/run-1/cancel`, {
      method: "POST",
      headers: { origin: server.origin, "content-type": "application/json" },
      body: JSON.stringify({ reason: "cancelled from the test" }),
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body).toMatchObject({ outcome: "recorded" });

    const terminated = ofType(journal(runDir), "run.terminated");
    expect(terminated).toHaveLength(1);
    expect(terminated[0]).toMatchObject({ reason: "cancelled from the test" });
    expect(woof(["status", runDir]).json).toMatchObject({ status: { status: "cancelled" } });

    // A second cancel is refused by the reducer, not silently accepted.
    const again = await getJson(`${server.origin}/api/runs/run-1/cancel`, {
      method: "POST",
      headers: { origin: server.origin, "content-type": "application/json" },
      body: "{}",
    });
    expect(again.status).toBe(409);
    expect(again.body["outcome"]).toBe("rejected");
    expect(ofType(journal(runDir), "run.terminated")).toHaveLength(1);
  });

  it("answers the actions the engine cannot perform as unsupported, and says which", async () => {
    const { runsDir, home } = runsDirWithRun();
    const server = await startUi(["--runs-dir", runsDir], home);

    const capabilities = await getJson(`${server.origin}/api/capabilities`);
    expect(capabilities.body).toMatchObject({
      kind: "woof.ui.capabilities",
      actions: {
        cancel: { supported: true },
        answerBlocked: { supported: false, reason: "answer_blocked_unsupported" },
        retry: { supported: false, reason: "retry_unsupported" },
        start: { supported: false, reason: "start_unsupported" },
      },
    });

    for (const [path, reason] of [
      ["/api/runs/run-1/answer", "answer_blocked_unsupported"],
      ["/api/runs/run-1/retry", "retry_unsupported"],
      ["/api/runs", "start_unsupported"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const refused = await getJson(`${server.origin}${path}`, {
        method: "POST",
        headers: { origin: server.origin },
      });
      expect(refused.status, path).toBe(501);
      expect(refused.body, path).toMatchObject({ outcome: "unsupported", reason });
      expect(String(refused.body["message"]).length, path).toBeGreaterThan(40);
    }
  });

  it("shows a blocked run's required action without offering to answer it", async () => {
    const { runsDir, runDir, home } = runsDirWithRun();
    runSdk(
      runDir,
      `await store.assignAgent({ runDir, agentId: "worker", runtime: { adapter: "scripted", runtimeName: "w-worker", paneId: "w1:p1" }, terminalId: "term_1", sessionId: null });
out = await store.blockRun({ runDir, agentId: "worker", reason: "blocked_on_input", requiredAction: "answer the prompt in pane w1:p1", observed: { runtimeStatus: "blocked", terminalId: "term_1", stateChangeSeq: 7 } });`,
    );
    const server = await startUi(["--runs-dir", runsDir], home);

    const listed = await getJson(`${server.origin}/api/runs`);
    expect(listed.body["runs"][0]).toMatchObject({
      status: "blocked",
      attention: {
        blocked: {
          agentId: "worker",
          reason: "blocked_on_input",
          requiredAction: "answer the prompt in pane w1:p1",
        },
      },
    });
    const run = await getJson(`${server.origin}/api/runs/run-1`);
    expect(run.body["snapshot"]["attention"]["blocked"]).toMatchObject({
      requiredAction: "answer the prompt in pane w1:p1",
    });
  });
});

describe("woof ui: admission", () => {
  it("refuses a Host it does not know and a mutating request without a matching Origin", async () => {
    const { runsDir, runDir, home } = runsDirWithRun();
    const server = await startUi(["--runs-dir", runsDir], home);
    const port = server.listening["port"] as number;

    // What DNS rebinding looks like: the port is reachable, the name is not ours.
    const rebound = await rawRequest(port, "/api/runs", {
      headers: { host: "attacker.example" },
    });
    expect(rebound.status).toBe(403);
    expect(rebound.body).toMatchObject({ outcome: "rejected", reason: "host_not_allowed" });
    expect(await rawRequest(port, "/api/runs", { headers: { host: "localhost" } })).toMatchObject({
      status: 200,
    });

    for (const origin of [undefined, "https://attacker.example"]) {
      // oxlint-disable-next-line no-await-in-loop
      const refused = await rawRequest(port, "/api/runs/run-1/cancel", {
        method: "POST",
        headers: { host: "127.0.0.1", ...(origin === undefined ? {} : { origin }) },
      });
      expect(refused.status, String(origin)).toBe(403);
      expect(refused.body["reason"], String(origin)).toBe("origin_not_allowed");
    }
    // None of the refusals reached the journal.
    expect(ofType(journal(runDir), "run.terminated")).toHaveLength(0);

    // A cross-site Origin is refused on a read too.
    const read = await rawRequest(port, "/api/runs", {
      headers: { host: "127.0.0.1", origin: "https://attacker.example" },
    });
    expect(read.status).toBe(403);
  });

  it("compares the whole Origin, so another local port cannot cancel a run", async () => {
    const { runsDir, runDir, home } = runsDirWithRun();
    const server = await startUi(["--runs-dir", runsDir], home);
    const port = server.listening["port"] as number;
    const host = `127.0.0.1:${port}`;

    // Its own origin is the one that works.
    expect(
      await rawRequest(port, "/api/runs/run-1/cancel", {
        method: "POST",
        headers: { host, origin: `http://${host}`, "content-type": "application/json" },
      }),
    ).toMatchObject({ status: 200 });
    expect(ofType(journal(runDir), "run.terminated")).toHaveLength(1);

    // Any other local page — a dev server on 5173 is the everyday one — is a
    // different origin, whatever the hostname says.
    for (const origin of [
      `http://127.0.0.1:5173`,
      `http://localhost:5173`,
      `https://127.0.0.1:${port}`,
      `http://127.0.0.1:${port + 1}`,
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const refused = await rawRequest(port, "/api/runs/run-1/cancel", {
        method: "POST",
        headers: { host, origin, "content-type": "application/json" },
      });
      expect(refused.status, origin).toBe(403);
      expect(refused.body["reason"], origin).toBe("origin_not_allowed");
    }
    // The one admitted cancel above is still the only record.
    expect(ofType(journal(runDir), "run.terminated")).toHaveLength(1);
  });

  it("admits the dev server only when --allow-origin names it, and still requires JSON", async () => {
    const { runsDir, home } = runsDirWithRun();
    const server = await startUi(
      ["--runs-dir", runsDir, "--allow-origin", "http://127.0.0.1:5173"],
      home,
    );
    const port = server.listening["port"] as number;
    const host = `127.0.0.1:${port}`;

    // Admitted: it reaches terminateRun, which answers 200 on a live run.
    expect(
      await rawRequest(port, "/api/runs/run-1/cancel", {
        method: "POST",
        headers: { host, origin: "http://127.0.0.1:5173", "content-type": "application/json" },
      }),
    ).toMatchObject({ status: 200 });

    // A neighbouring port is not admitted by the entry for 5173.
    expect(
      await rawRequest(port, "/api/runs/run-1/cancel", {
        method: "POST",
        headers: { host, origin: "http://127.0.0.1:5174", "content-type": "application/json" },
      }),
    ).toMatchObject({ status: 403 });

    // A content type a form can send is refused: requiring JSON is what forces
    // a cross-origin request into a preflight this server never answers.
    for (const type of ["text/plain", "application/x-www-form-urlencoded", undefined]) {
      // oxlint-disable-next-line no-await-in-loop
      const refused = await rawRequest(port, "/api/runs/run-1/cancel", {
        method: "POST",
        headers: {
          host,
          origin: `http://${host}`,
          ...(type === undefined ? {} : { "content-type": type }),
        },
      });
      expect(refused.status, String(type)).toBe(415);
      expect(refused.body["reason"], String(type)).toBe("content_type_unsupported");
    }
  });

  it("requires the token on every API request once one is set, including the event stream", async () => {
    const { runsDir, home } = runsDirWithRun();
    const server = await startUi(["--runs-dir", runsDir, "--token", TOKEN], home);

    expect((await getJson(`${server.origin}/api/runs`)).status).toBe(401);
    expect((await getJson(`${server.origin}/api/runs?token=wrong`)).status).toBe(401);
    expect((await getJson(`${server.origin}/api/runs?token=${TOKEN}`)).status).toBe(200);
    expect(
      (
        await getJson(`${server.origin}/api/runs`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(200);
    // EventSource cannot set headers, so the query parameter has to work there.
    const stream = await fetch(`${server.origin}/api/runs/run-1/events?token=${TOKEN}`);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel();
    expect((await fetch(`${server.origin}/api/runs/run-1/events`)).status).toBe(401);
  });

  it("answers a client that stalls mid-body instead of holding its socket", async () => {
    const { runsDir, runDir, home } = runsDirWithRun();
    const server = await startUi(["--runs-dir", runsDir], home);
    const port = server.listening["port"] as number;

    // requestTimeout is off, because it would cut the long-lived event streams;
    // the body read has its own bound. The socket is answered, not dropped.
    const answered = await new Promise<{ status: number; reason: string }>((done, fail) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/api/runs/run-1/cancel",
          method: "POST",
          headers: {
            host: `127.0.0.1:${port}`,
            origin: `http://127.0.0.1:${port}`,
            "content-type": "application/json",
            "content-length": "40",
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (text += chunk));
          response.on("end", () =>
            done({
              status: response.statusCode ?? 0,
              reason: (JSON.parse(text) as Json)["reason"] as string,
            }),
          );
        },
      );
      request.on("error", fail);
      // A body that starts and never finishes.
      request.write('{"reason":"');
    });
    expect(answered).toMatchObject({ status: 408, reason: "body_timeout" });
    expect(ofType(journal(runDir), "run.terminated")).toHaveLength(0);
  }, 20_000);

  it("refuses to start with a token shorter than the minimum", () => {
    const { runsDir, home } = runsDirWithRun();
    const refused = woof(
      ["ui", "--port", "0", "--no-open", "--runs-dir", runsDir, "--token", "a"],
      {
        env: { HOME: home },
        timeoutMs: 20_000,
      },
    );
    expect(refused.status, refused.stdout + refused.stderr).toBe(3);
    expect(refused.json).toMatchObject({ outcome: "rejected", reason: "ui_listen_failed" });
    expect(String(refused.json?.message)).toContain("16 characters");
  });

  it("prints the token in the fragment, which a browser never sends to a server", async () => {
    const { runsDir, home } = runsDirWithRun();
    const server = await startUi(["--runs-dir", runsDir, "--token", TOKEN], home);
    const url = String(server.listening["url"]);
    expect(url).toContain(`#token=${TOKEN}`);
    expect(url).not.toContain(`?token=`);
    // What the browser would actually request: the part before the `#`.
    const [beforeHash] = url.split("#");
    const page = await fetch(String(beforeHash));
    expect(page.status).not.toBe(401);
  });

  it("refuses to bind beyond loopback without a token", () => {
    const { runsDir, home } = runsDirWithRun();
    const refused = woof(["ui", "--host", "0.0.0.0", "--port", "0", "--runs-dir", runsDir], {
      env: { HOME: home },
      timeoutMs: 20_000,
    });
    expect(refused.status, refused.stdout + refused.stderr).toBe(3);
    expect(refused.json).toMatchObject({ outcome: "rejected", reason: "ui_listen_failed" });
    expect(String(refused.json?.message)).toContain("--token");
  });
});

describe("woof ui: event streams under load", () => {
  /** Opens a stream and waits for its first frame, so it is provably live. */
  async function openStream(url: string): Promise<{
    status: number;
    text: () => string;
    controller: AbortController;
    done: Promise<void>;
  }> {
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    let text = "";
    if (response.status !== 200 || response.body === null) {
      return { status: response.status, text: () => "", controller, done: Promise.resolve() };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    text += decoder.decode(first.value, { stream: true });
    const done = (async () => {
      try {
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop
          const chunk = await reader.read();
          if (chunk.done === true) break;
          text += decoder.decode(chunk.value, { stream: true });
        }
      } catch {
        // An aborted read is how this test ends a stream.
      }
    })();
    return { status: response.status, text: () => text, controller, done };
  }

  it("holds more streams than Node's listener limit without warning, and caps them", async () => {
    const { runsDir, home } = runsDirWithRun();
    const server = await startUi(["--runs-dir", runsDir, "--poll-ms", "50"], home);
    const url = `${server.origin}/api/runs/run-1/events`;

    // Twelve is past Node's default limit of ten: the follow loop used to add a
    // process SIGINT listener per stream, which `woof ui` papered over with a
    // global limit. The server passes handleSigint: false instead.
    const open = await Promise.all(Array.from({ length: 12 }, () => openStream(url)));
    expect(open.every((stream) => stream.status === 200)).toBe(true);
    await delay(200);
    expect(server.stderr()).not.toContain("MaxListenersExceededWarning");

    for (const stream of open) stream.controller.abort();
    await Promise.all(open.map((stream) => stream.done));
    await delay(200);
    // The released streams are not counted against the cap.
    const again = await openStream(url);
    expect(again.status).toBe(200);
    again.controller.abort();
    await again.done;
    expect(server.stderr()).not.toContain("MaxListenersExceededWarning");
  }, 30_000);

  it("refuses the stream past the cap with a reason rather than accepting it", async () => {
    const { runsDir, home } = runsDirWithRun();
    const server = await startUi(["--runs-dir", runsDir, "--poll-ms", "50"], home);
    const url = `${server.origin}/api/runs/run-1/events`;

    const open: Awaited<ReturnType<typeof openStream>>[] = [];
    for (let index = 0; index < 64; index += 1) {
      // Serially: the cap is checked as each request is routed.
      // oxlint-disable-next-line no-await-in-loop
      open.push(await openStream(url));
    }
    expect(open.every((stream) => stream.status === 200)).toBe(true);

    const refused = await getJson(url);
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ outcome: "rejected", reason: "too_many_streams" });

    for (const stream of open) stream.controller.abort();
    await Promise.all(open.map((stream) => stream.done));
    await delay(300);
    // One closed, one admitted: the count follows the open streams, not a total.
    const after = await openStream(url);
    expect(after.status).toBe(200);
    after.controller.abort();
    await after.done;
  }, 60_000);

  it("ends open streams with an end frame when the server is interrupted", async () => {
    const { runsDir, home } = runsDirWithRun();
    const child = spawn(
      "node",
      [cliPath, "ui", "--port", "0", "--no-open", "--runs-dir", runsDir],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: home, HERDR_PANE_ID: undefined, WOOF_RUN_DIR: undefined },
      },
    ) as ChildProcessWithoutNullStreams;
    children.push(child);
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8");
    const deadline = Date.now() + 15_000;
    let listening: Json | null = null;
    while (listening === null) {
      const line = stdout.split("\n")[0];
      if (line !== undefined && line.trim() !== "") listening = JSON.parse(line) as Json;
      else if (Date.now() > deadline) throw new Error(`woof ui never listened: ${stdout}`);
      // oxlint-disable-next-line no-await-in-loop
      else await delay(25);
    }
    const origin = `http://127.0.0.1:${listening["port"]}`;
    const streams = await Promise.all(
      [0, 1, 2].map(() => openStream(`${origin}/api/runs/run-1/events`)),
    );
    expect(streams.every((stream) => stream.status === 200)).toBe(true);

    const exited = new Promise<number>((done) => child.once("exit", (code) => done(code ?? -1)));
    child.kill("SIGINT");
    await Promise.all(streams.map((stream) => stream.done));
    // Each stream was finished, not dropped: an EventSource that saw a dropped
    // connection would reconnect to a dead server instead of closing.
    for (const stream of streams) {
      expect(stream.text()).toContain("event: end");
    }
    expect(await exited).toBe(0);
  }, 30_000);

  it("gives a stream that arrives during shutdown an end frame or nothing at all", async () => {
    const { runsDir, home } = runsDirWithRun();
    const child = spawn(
      "node",
      [cliPath, "ui", "--port", "0", "--no-open", "--runs-dir", runsDir],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: home, HERDR_PANE_ID: undefined, WOOF_RUN_DIR: undefined },
      },
    ) as ChildProcessWithoutNullStreams;
    children.push(child);
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8");
    const deadline = Date.now() + 15_000;
    let listening: Json | null = null;
    while (listening === null) {
      const line = stdout.split("\n")[0];
      if (line !== undefined && line.trim() !== "") listening = JSON.parse(line) as Json;
      else if (Date.now() > deadline) throw new Error(`woof ui never listened: ${stdout}`);
      // oxlint-disable-next-line no-await-in-loop
      else await delay(25);
    }
    const url = `http://127.0.0.1:${listening["port"]}/api/runs/run-1/events`;
    const held = await openStream(url);
    expect(held.status).toBe(200);

    // The race the ordering exists for: a second stream asked for while
    // shutdown is already draining the first. Whatever it gets, it must not be
    // a 200 whose socket is then destroyed without the promised end frame.
    const exited = new Promise<number>((done) => child.once("exit", (code) => done(code ?? -1)));
    child.kill("SIGINT");
    const late = await openStream(url).catch(() => null);
    await Promise.all([held.done, late?.done]);

    expect(held.text()).toContain("event: end");
    if (late !== null && late.status === 200) {
      // Admitted mid-shutdown: it is registered and ended at once, so it still
      // closes with a frame rather than a dropped connection.
      expect(late.text()).toContain("event: end");
    }
    expect(await exited).toBe(0);
  }, 30_000);
});

describe("woof ui: the single-page app", () => {
  it("reports a missing bundle with the command that builds it, and still serves the API", () => {
    const { runsDir } = runsDirWithRun();
    const absent = join(tempDir("woof-web-nospa-"), "never-built");
    // The CLI has no flag for the bundle location, so the server is started
    // through the compiled module — still a real process, never an import of src/.
    const script = `
const { startWebServer } = await import(${JSON.stringify(distUrl("web/server.js"))});
const server = await startWebServer({ runsDir: process.argv[1], port: 0, distUiDir: process.argv[2] });
const page = await fetch(server.url);
const api = await fetch(new URL("/api/runs", server.url));
out = { spa: server.spa, page: { status: page.status, body: await page.json() }, api: api.status };
await server.close();
console.log(JSON.stringify(out));
`;
    const result = runNode(`let out;${script}`, [runsDir, absent]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const printed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null") as Json;
    expect(printed["spa"]).toBe(false);
    expect(printed["page"]["status"]).toBe(503);
    expect(printed["page"]["body"]).toMatchObject({ reason: "ui_bundle_missing" });
    expect(String(printed["page"]["body"]["message"])).toContain("bun run build:ui");
    // A checkout that has not built the bundle can still use the API.
    expect(printed["api"]).toBe(200);
  }, 30_000);

  it("serves the built bundle and falls back to it for a client-side route", async (context) => {
    const { runsDir, home } = runsDirWithRun();
    const server = await startUi(["--runs-dir", runsDir], home);
    if (server.listening["spa"] !== true) {
      // `bun run verify` builds the bundle before the suite; a bare `bun run
      // test` does not. Skipping says so out loud: a silent early return here
      // is a green result with nothing asserted.
      context.skip("dist-ui/ is absent; run bun run build:ui (bun run verify does)");
    }
    const page = await fetch(`${server.origin}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain('id="root"');

    const deep = await fetch(`${server.origin}/runs/run-1`);
    expect(deep.status).toBe(200);
    expect(deep.headers.get("content-type")).toContain("text/html");

    // A path that climbs out of the bundle never returns a repository file. It
    // names a file, so it is a 404: answering it with the app would surface in
    // the browser as a MIME error rather than as the miss it is.
    const escaped = await fetch(`${server.origin}/%2e%2e%2f%2e%2e%2fpackage.json`);
    expect(escaped.status).toBe(404);
    const body = await escaped.text();
    expect(body).not.toContain("herdr-woof");
    expect(JSON.parse(body)).toMatchObject({ reason: "asset_not_found" });

    // A stale hashed asset after a rebuild is a 404 too, for the same reason.
    expect((await fetch(`${server.origin}/assets/index-GONE12345.js`)).status).toBe(404);
    expect((await fetch(`${server.origin}/favicon.ico`)).status).toBe(404);

    // One level up, at a path that exists without the guard: the previous probe
    // climbs to a file two levels out, which a broken guard would miss anyway.
    const oneUp = await fetch(`${server.origin}/..%2fpackage.json`);
    expect(oneUp.status).toBe(404);
    expect(await oneUp.text()).not.toContain("herdr-woof");

    // Percent-encoding the dot must not hide the extension from the classifier:
    // the lookup decodes, so the classification has to decode too, or this is
    // the app shell with a JavaScript content type in front of it.
    for (const path of ["/assets/missing%2ejs", "/assets/missing%2Ejs", "/assets/missing.js"]) {
      // oxlint-disable-next-line no-await-in-loop
      const encoded = await fetch(`${server.origin}${path}`);
      expect(encoded.status, path).toBe(404);
      // oxlint-disable-next-line no-await-in-loop
      expect(JSON.parse(await encoded.text()), path).toMatchObject({ reason: "asset_not_found" });
    }

    // A path that cannot be decoded is not a client-side route either.
    expect((await fetch(`${server.origin}/%zz`)).status).toBe(404);
  });

  it("refuses an index.html that resolves outside the bundle, on every route", () => {
    const { runsDir } = runsDirWithRun();
    const root = tempDir("woof-web-symlink-");
    const bundle = join(root, "dist-ui");
    mkdirSync(bundle);
    // The bundle's own index is a symlink to a file outside it: the shape a
    // writable dist-ui/ gives an attacker, and the one file that used to skip
    // the containment check every asset goes through.
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "SECRET-OUTSIDE");
    symlinkSync(outside, join(bundle, "index.html"));

    const script = `
const { startWebServer } = await import(${JSON.stringify(distUrl("web/server.js"))});
const server = await startWebServer({ runsDir: process.argv[1], port: 0, distUiDir: process.argv[2] });
const read = async (path) => {
  const response = await fetch(new URL(path, server.url));
  return { status: response.status, body: await response.text() };
};
out = {
  spa: server.spa,
  root: await read("/"),
  route: await read("/runs/run-1"),
  index: await read("/index.html"),
};
await server.close();
console.log(JSON.stringify(out));
`;
    const result = runNode(`let out;${script}`, [runsDir, bundle]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const printed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null") as Json;
    // An index outside the bundle is the same answer as no index at all.
    expect(printed["spa"]).toBe(false);
    for (const route of ["root", "route", "index"] as const) {
      expect(printed[route]["body"], route).not.toContain("SECRET-OUTSIDE");
      expect(printed[route]["status"], route).toBe(503);
      expect(JSON.parse(printed[route]["body"] as string), route).toMatchObject({
        reason: "ui_bundle_missing",
      });
    }
  }, 30_000);

  it("serves the bundle without the token and the API only with it", async (context) => {
    const { runsDir, home } = runsDirWithRun();
    const server = await startUi(["--runs-dir", runsDir, "--token", TOKEN], home);
    if (server.listening["spa"] !== true) {
      context.skip("dist-ui/ is absent; run bun run build:ui (bun run verify does)");
    }
    // The sequence a browser actually performs, in order.
    // 1. The document, with no token: a subresource carries neither a query
    //    string nor an Authorization header, so gating the bundle would load
    //    the page and nothing else.
    const page = await fetch(`${server.origin}/`);
    expect(page.status).toBe(200);
    const html = await page.text();

    // 2. The hashed script the document names, with no token.
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(asset, html).toBeDefined();
    const script = await fetch(`${server.origin}${asset as string}`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    // The stylesheet too, when the bundle has one.
    const style = /href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1];
    if (style !== undefined) {
      expect((await fetch(`${server.origin}${style}`)).status).toBe(200);
    }

    // 3. The app's first API call, with no token: refused, and named.
    const denied = await getJson(`${server.origin}/api/runs`);
    expect(denied.status).toBe(401);
    expect(denied.body).toMatchObject({ reason: "token_invalid" });

    // 4. The same call the way the app makes it, with the token it read from
    //    the fragment.
    const allowed = await getJson(`${server.origin}/api/runs`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body["runs"]).toHaveLength(1);

    // 5. The event stream, which can only carry the token in the query.
    const stream = await fetch(`${server.origin}/api/runs/run-1/events?token=${TOKEN}`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel();
  });
});
