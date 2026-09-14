import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { distUrl, repoRoot, runNode } from "./helpers/process.js";

// The Herdr adapter runs in a child `node` process against the fake herdr
// fixture, always by absolute path. No test resolves herdr from PATH, so a run
// inside a live Herdr session never reaches the real server.
const FAKE_HERDR = join(repoRoot, "test", "fixtures", "fake-herdr.mjs");
const NAME = "w-worker-abc123";
const PANE = "w9:p2";

let workDir: string;
const allLogs: string[][] = [];

beforeAll(() => {
  chmodSync(FAKE_HERDR, 0o755);
  workDir = mkdtempSync(join(tmpdir(), "woof-fake-herdr-"));
});

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

interface Entry {
  match: string[];
  call?: number;
  stdout?: string;
  stderr?: string;
  exit?: number;
  hangMs?: number;
}

const agentJson = (status: string, seq: number, type = "agent_info") =>
  `${JSON.stringify({
    id: "cli:agent",
    result: {
      agent: {
        agent: "claude",
        agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "session-1" },
        agent_status: status,
        name: NAME,
        pane_id: PANE,
        revision: seq,
        state_change_seq: seq,
        tab_id: "w9:t1",
        terminal_id: "term_1",
        workspace_id: "w9",
      },
      type,
    },
  })}\n`;

const error = (code: string, id = "cli:agent") =>
  ({
    stderr: `${JSON.stringify({ error: { code, message: `${code} message` }, id })}\n`,
    exit: 1,
  }) as const;

let runs = 0;

/** Runs `body` in a child with a HerdrCliRuntime over the fake binary; returns its `out` and the argv log. */
function runAdapter(
  scenario: Entry[],
  body: string,
  options: { herdrEnv?: string | undefined; bin?: string; graceMs?: number } = { herdrEnv: "1" },
): { out: Record<string, unknown>; log: string[][]; elapsed: number } {
  runs += 1;
  const scenarioPath = join(workDir, `scenario-${runs}.json`);
  const logPath = join(workDir, `log-${runs}.jsonl`);
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const script = `
const { createHerdrCliRuntime } = await import(${JSON.stringify(distUrl("runtime/herdr/adapter.js"))});
const input = JSON.parse(process.argv[1]);
const runtime = createHerdrCliRuntime({ bin: input.bin, env: process.env, spawnGraceMs: input.graceMs });
const handle = { adapter: "herdr", runtimeName: ${JSON.stringify(NAME)}, kind: "claude", paneId: ${JSON.stringify(PANE)}, paneOwned: true, terminalId: "term_1", sessionId: "session-1" };
const started = Date.now();
let out;
${body}
console.log(JSON.stringify({ out, elapsed: Date.now() - started }));
`;
  const result = runNode(
    script,
    [JSON.stringify({ bin: options.bin ?? FAKE_HERDR, graceMs: options.graceMs ?? 2000 })],
    {
      env: {
        HERDR_ENV: "herdrEnv" in options ? options.herdrEnv : "1",
        FAKE_HERDR_SCENARIO: scenarioPath,
        FAKE_HERDR_LOG: logPath,
      },
      timeoutMs: 30_000,
    },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  const log = existsSync(logPath)
    ? readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as string[])
    : [];
  allLogs.push(...log);
  const parsed = JSON.parse(result.stdout) as { out: Record<string, unknown>; elapsed: number };
  return { out: parsed.out, log, elapsed: parsed.elapsed };
}

describe("Herdr CLI adapter argv and results", () => {
  it("builds exact argv for every method and maps their results", () => {
    const { out, log } = runAdapter(
      [
        {
          match: ["pane", "split"],
          stdout: `${JSON.stringify({ id: "cli:pane:split", result: { pane: { pane_id: PANE, terminal_id: "term_0" }, type: "pane_info" } })}\n`,
        },
        { match: ["agent", "start"], stdout: agentJson("idle", 10, "agent_started") },
        { match: ["agent", "get"], call: 1, stdout: agentJson("idle", 10) },
        { match: ["agent", "wait"], stdout: agentJson("done", 12) },
        { match: ["agent", "get"], call: 2, stdout: agentJson("done", 12) },
        { match: ["agent", "get"], call: 3, stdout: agentJson("idle", 12) },
        { match: ["agent", "prompt"], stdout: agentJson("working", 13, "agent_prompted") },
        {
          match: ["pane", "close"],
          stdout: `${JSON.stringify({ id: "cli:pane:close", result: { type: "ok" } })}\n`,
        },
        { match: ["agent", "get"], call: 4, ...error("agent_not_found") },
      ],
      `
const current = await runtime.openPane({ near: "current", cwd: "/tmp/run", env: { WOOF_RUN_DIR: "/tmp/run" } });
const near = await runtime.openPane({ near: "w9:p1", cwd: "/tmp/run", direction: "right" });
const start = await runtime.startAgent({ runtimeName: handle.runtimeName, kind: "claude", paneId: ${JSON.stringify(PANE)}, paneOwned: true, args: ["--permission-mode", "auto"], timeoutMs: 30000 });
const observed = await runtime.observe(handle);
const waited = await runtime.waitFor(handle, ["ready"], 5000);
const delivered = await runtime.deliver(handle, "Reply with pong.", { timeoutMs: 7000 });
const stopped = await runtime.stop(handle, { timeoutMs: 4000 });
out = { current, near, start, observed, waited, delivered, stopped };`,
    );

    expect(log).toEqual([
      [
        "pane",
        "split",
        "--current",
        "--direction",
        "down",
        "--cwd",
        "/tmp/run",
        "--no-focus",
        "--env",
        "WOOF_RUN_DIR=/tmp/run",
      ],
      ["pane", "split", "w9:p1", "--direction", "right", "--cwd", "/tmp/run", "--no-focus"],
      [
        "agent",
        "start",
        NAME,
        "--kind",
        "claude",
        "--pane",
        PANE,
        "--timeout",
        "30000",
        "--",
        "--permission-mode",
        "auto",
      ],
      ["agent", "get", NAME],
      ["agent", "wait", NAME, "--until", "idle", "--until", "done", "--timeout", "5000"],
      ["agent", "get", NAME],
      ["agent", "get", NAME],
      [
        "agent",
        "prompt",
        NAME,
        "Reply with pong.",
        "--wait",
        "--until",
        "working",
        "--until",
        "blocked",
        "--timeout",
        "7000",
      ],
      ["pane", "close", PANE],
      ["agent", "get", NAME],
    ]);
    expect(out["current"]).toEqual({ ok: true, value: { paneId: PANE } });
    expect(out["start"]).toEqual({
      ok: true,
      value: {
        adapter: "herdr",
        runtimeName: NAME,
        kind: "claude",
        paneId: PANE,
        paneOwned: true,
        terminalId: "term_1",
        sessionId: "session-1",
      },
    });
    expect(out["observed"]).toMatchObject({
      ok: true,
      value: {
        lifecycle: "ready",
        runtimeStatus: "idle",
        order: { terminalId: "term_1", stateChangeSeq: 10, revision: 10 },
      },
    });
    expect(out["waited"]).toMatchObject({
      ok: true,
      value: { lifecycle: "ready", runtimeStatus: "done" },
    });
    expect(out["delivered"]).toMatchObject({
      outcome: "started",
      observation: { lifecycle: "working", order: { stateChangeSeq: 13 } },
    });
    expect(out["stopped"]).toEqual({ ok: true, value: { paneClosed: true } });
  });

  it("observes a vanished agent and pane as gone", () => {
    const { out, log } = runAdapter(
      [
        { match: ["agent", "get"], ...error("agent_not_found") },
        { match: ["pane", "get"], ...error("pane_not_found", "cli:pane:get") },
      ],
      `out = await runtime.observe(handle);`,
    );
    expect(out).toMatchObject({
      ok: true,
      value: { lifecycle: "gone", runtimeStatus: null, order: { stateChangeSeq: null } },
    });
    expect(log).toEqual([
      ["agent", "get", NAME],
      ["pane", "get", PANE],
    ]);
  });
});

describe("Herdr CLI adapter delivery certainty", () => {
  const ready = { match: ["agent", "get"], stdout: agentJson("idle", 5) };
  const deliver = (timeoutMs = 2000) =>
    `out = await runtime.deliver(handle, "hello", { timeoutMs: ${timeoutMs} });`;

  it("reports prompt errors as not_delivered or ambiguous", () => {
    const cases: Array<[Entry, string, string]> = [
      [{ match: ["agent", "prompt"], ...error("agent_prompt_stalled") }, "ambiguous", "stalled"],
      [{ match: ["agent", "prompt"], ...error("timeout") }, "ambiguous", "timeout"],
      [{ match: ["agent", "prompt"], stdout: "garbage{" }, "ambiguous", "protocol_error"],
      [
        { match: ["agent", "prompt"], stdout: agentJson("idle", 6, "agent_prompted") },
        "ambiguous",
        "protocol_error",
      ],
      [{ match: ["agent", "prompt"], ...error("server_exploded") }, "ambiguous", "runtime_error"],
      [{ match: ["agent", "prompt"], ...error("agent_blocked") }, "not_delivered", "agent_blocked"],
      [{ match: ["agent", "prompt"], ...error("agent_not_found") }, "not_delivered", "not_found"],
      [
        { match: ["agent", "prompt"], stderr: "usage: herdr agent prompt\n", exit: 2 },
        "not_delivered",
        "invalid_request",
      ],
      [
        { match: ["agent", "prompt"], stdout: agentJson("blocked", 6, "agent_prompted") },
        "started",
        "",
      ],
    ];
    for (const [prompt, outcome, code] of cases) {
      const { out, log } = runAdapter([ready, prompt], deliver());
      expect(out["outcome"], JSON.stringify(prompt)).toBe(outcome);
      if (code !== "") expect((out["error"] as { code: string }).code).toBe(code);
      expect(log.filter((args) => args[1] === "prompt")).toHaveLength(1);
    }
  });

  it("kills a prompt that hangs past its deadline and reports it ambiguous", () => {
    const { out, elapsed } = runAdapter(
      [ready, { match: ["agent", "prompt"], hangMs: 20_000, stdout: agentJson("working", 6) }],
      deliver(300),
      { herdrEnv: "1", graceMs: 200 },
    );
    expect(out).toMatchObject({ outcome: "ambiguous", error: { code: "timeout" } });
    expect(elapsed).toBeLessThan(300 + 200 + 1000);
  });

  it("never sends a prompt to a working or blocked agent", () => {
    for (const [status, code] of [
      ["working", "agent_busy"],
      ["blocked", "agent_blocked"],
    ]) {
      const { out, log } = runAdapter(
        [{ match: ["agent", "get"], stdout: agentJson(status as string, 8) }],
        deliver(),
      );
      expect(out).toMatchObject({ outcome: "not_delivered", error: { code } });
      expect(log).toEqual([["agent", "get", NAME]]);
    }
  });

  it("reports a gone agent as not_delivered without prompting", () => {
    const { out, log } = runAdapter(
      [
        { match: ["agent", "get"], ...error("agent_not_found") },
        { match: ["pane", "get"], ...error("pane_not_found") },
      ],
      deliver(),
    );
    expect(out).toMatchObject({ outcome: "not_delivered", error: { code: "not_found" } });
    expect(log.some((args) => args[1] === "prompt")).toBe(false);
  });
});

describe("Herdr CLI adapter boundaries", () => {
  it("refuses to spawn outside Herdr", () => {
    const { out, log } = runAdapter(
      [ready()],
      `out = { observed: await runtime.observe(handle), delivered: await runtime.deliver(handle, "x", { timeoutMs: 100 }), pane: await runtime.openPane({ near: "current", cwd: "/tmp" }) };`,
      { herdrEnv: undefined },
    );
    expect(out).toMatchObject({
      observed: { ok: false, error: { code: "runtime_unavailable" } },
      delivered: { outcome: "not_delivered", error: { code: "runtime_unavailable" } },
      pane: { ok: false, error: { code: "runtime_unavailable" } },
    });
    expect(log).toEqual([]);
  });

  it("reports a missing binary as runtime_unavailable and not_delivered", () => {
    const { out } = runAdapter(
      [],
      `out = { observed: await runtime.observe(handle), delivered: await runtime.deliver(handle, "x", { timeoutMs: 100 }) };`,
      { herdrEnv: "1", bin: join(workDir, "no-such-herdr") },
    );
    expect(out).toMatchObject({
      observed: { ok: false, error: { code: "runtime_unavailable", runtimeCode: "ENOENT" } },
      delivered: { outcome: "not_delivered", error: { code: "runtime_unavailable" } },
    });
  });

  it("maps a usage error to invalid_request", () => {
    const { out } = runAdapter(
      [{ match: ["agent", "get"], stderr: "usage: herdr agent get <target>\n", exit: 2 }],
      `out = await runtime.observe(handle);`,
    );
    expect(out).toMatchObject({ ok: false, error: { code: "invalid_request", exitCode: 2 } });
  });

  it("validates runtime names and pane ownership without spawning", () => {
    const { out, log } = runAdapter(
      [ready()],
      `const bad = { ...handle, runtimeName: "Bad Name" };
out = {
  observe: await runtime.observe(bad),
  deliver: await runtime.deliver(bad, "x", { timeoutMs: 100 }),
  start: await runtime.startAgent({ runtimeName: "UPPER", kind: "claude", paneId: "p", paneOwned: true, timeoutMs: 100 }),
  stopUnowned: await runtime.stop({ ...handle, paneOwned: false }, { timeoutMs: 100 }),
  stopForged: await runtime.stop({ ...handle, paneId: "w9:p999", paneOwned: true }, { timeoutMs: 100 }),
  inspectRead: await runtime.inspect(["agent", "read", handle.runtimeName]),
};`,
    );
    expect(out).toMatchObject({
      observe: { ok: false, error: { code: "invalid_request" } },
      deliver: { outcome: "not_delivered", error: { code: "invalid_request" } },
      start: { ok: false, error: { code: "invalid_request" } },
      stopUnowned: { ok: false, error: { code: "unsupported" } },
      stopForged: { ok: false, error: { code: "unsupported" } },
      inspectRead: { ok: false, error: { code: "invalid_request" } },
    });
    expect(log).toEqual([]);
  });

  it("fails stop when the agent is still reported after closing its pane", () => {
    const { out } = runAdapter(
      [
        splitReturning(PANE),
        {
          match: ["pane", "close"],
          stdout: `${JSON.stringify({ id: "cli:pane:close", result: {} })}\n`,
        },
        { match: ["agent", "get"], stdout: agentJson("idle", 3) },
      ],
      `await runtime.openPane({ near: "current", cwd: "/tmp" });
out = await runtime.stop(handle, { timeoutMs: 1000 });`,
    );
    expect(out).toMatchObject({ ok: false, error: { code: "runtime_error" } });
  });

  it("never closes a pane it did not open, even for a handle claiming ownership", () => {
    const { out, log } = runAdapter(
      [
        splitReturning(PANE),
        { match: ["agent", "start"], stdout: agentJson("idle", 10, "agent_started") },
        {
          match: ["pane", "close"],
          stdout: `${JSON.stringify({ id: "cli:pane:close", result: { type: "ok" } })}\n`,
        },
        { match: ["agent", "get"], ...error("agent_not_found") },
      ],
      `const forged = { ...handle, paneId: "w9:p999", paneOwned: true };
const fresh = await runtime.stop(forged, { timeoutMs: 1000 });
const startedUnopened = await runtime.startAgent({ runtimeName: handle.runtimeName, kind: "claude", paneId: ${JSON.stringify(PANE)}, paneOwned: true, timeoutMs: 1000 });
const before = await runtime.stop(handle, { timeoutMs: 1000 });
await runtime.openPane({ near: "current", cwd: "/tmp" });
const afterOpen = await runtime.stop(forged, { timeoutMs: 1000 });
const owned = await runtime.stop({ ...handle, paneOwned: false }, { timeoutMs: 1000 });
out = { fresh, startedUnopened, before, afterOpen, owned };`,
    );
    expect(out).toMatchObject({
      fresh: { ok: false, error: { code: "unsupported" } },
      startedUnopened: { ok: true, value: { paneOwned: false } },
      before: { ok: false, error: { code: "unsupported" } },
      afterOpen: { ok: false, error: { code: "unsupported" } },
      owned: { ok: true, value: { paneClosed: true } },
    });
    expect(log.filter((args) => args[1] === "close")).toEqual([["pane", "close", PANE]]);
  });

  it("inspects only allowlisted read-only commands and refuses the rest without spawning", () => {
    const refused = runAdapter(
      [],
      `const results = [];
for (const args of [
  ["pane", "close", "w1:p1"],
  ["pane", "split", "--current"],
  ["agent", "start", "w-x", "--kind", "claude"],
  ["agent", "prompt", "w-x", "hi"],
  ["agent", "wait", "w-x", "--until", "idle"],
  ["agent", "read", "w-x"],
  ["agent", "get"],
  ["agent", "get", "--help"],
  ["pane", "get", "w1:p1", "--extra"],
  ["agent", "list", "extra"],
  ["workspace", "list", "--all"],
  ["workspace", "close", "w1"],
  [],
]) results.push((await runtime.inspect(args)).error?.code ?? "spawned");
out = { results };`,
    );
    expect(refused.out["results"]).toEqual(Array.from({ length: 13 }, () => "invalid_request"));
    expect(refused.log).toEqual([]);

    const ok = `${JSON.stringify({ id: "cli:inspect", result: {} })}\n`;
    const allowed = runAdapter(
      [
        { match: ["agent", "list"], stdout: ok },
        { match: ["agent", "get"], stdout: ok },
        { match: ["pane", "get"], stdout: ok },
        { match: ["pane", "list"], stdout: ok },
        { match: ["workspace", "list"], stdout: ok },
      ],
      `out = { results: [
  await runtime.inspect(["agent", "list"]),
  await runtime.inspect(["agent", "get", handle.runtimeName]),
  await runtime.inspect(["pane", "get", ${JSON.stringify(PANE)}]),
  await runtime.inspect(["pane", "list", "--workspace", "w9"]),
  await runtime.inspect(["workspace", "list"]),
].map((result) => result.ok) };`,
    );
    expect(allowed.out["results"]).toEqual([true, true, true, true, true]);
    expect(allowed.log).toEqual([
      ["agent", "list"],
      ["agent", "get", NAME],
      ["pane", "get", PANE],
      ["pane", "list", "--workspace", "w9"],
      ["workspace", "list"],
    ]);
  });

  it("gives up pane ownership once pane close succeeds, even when verification still reports the agent", () => {
    const { out, log } = runAdapter(
      [
        splitReturning(PANE),
        {
          match: ["pane", "close"],
          stdout: `${JSON.stringify({ id: "cli:pane:close", result: { type: "ok" } })}\n`,
        },
        { match: ["agent", "get"], stdout: agentJson("idle", 3) },
      ],
      `await runtime.openPane({ near: "current", cwd: "/tmp" });
const first = await runtime.stop(handle, { timeoutMs: 1000 });
const second = await runtime.stop(handle, { timeoutMs: 1000 });
out = { first, second };`,
    );
    expect(out).toMatchObject({
      first: { ok: false, error: { code: "runtime_error" } },
      second: { ok: false, error: { code: "unsupported" } },
    });
    expect(log.filter((args) => args[1] === "close")).toEqual([["pane", "close", PANE]]);
  });

  it("refuses to wait for unknown (or only gone) without spawning", () => {
    const { out, log } = runAdapter(
      [ready()],
      `out = {
  unknown: await runtime.waitFor(handle, ["unknown"], 1000),
  mixed: await runtime.waitFor(handle, ["ready", "unknown"], 1000),
  gone: await runtime.waitFor(handle, ["gone"], 1000),
};`,
    );
    expect(out).toMatchObject({
      unknown: { ok: false, error: { code: "unsupported" } },
      mixed: { ok: false, error: { code: "unsupported" } },
      gone: { ok: false, error: { code: "unsupported" } },
    });
    expect(log).toEqual([]);
  });

  it("never invoked read, send-keys, run or explain across every scenario", () => {
    expect(allLogs.length).toBeGreaterThan(20);
    expect(
      allLogs.filter((args) => ["read", "send-keys", "run", "explain"].includes(args[1] ?? "")),
    ).toEqual([]);
  });
});

function splitReturning(paneId: string): Entry {
  return {
    match: ["pane", "split"],
    stdout: `${JSON.stringify({ id: "cli:pane:split", result: { pane: { pane_id: paneId }, type: "pane_info" } })}\n`,
  };
}

function ready(): Entry {
  return { match: ["agent", "get"], stdout: agentJson("idle", 5) };
}
