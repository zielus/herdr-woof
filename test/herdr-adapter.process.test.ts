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
  options: {
    herdrEnv?: string | undefined;
    bin?: string;
    graceMs?: number;
    workspaceId?: string;
  } = { herdrEnv: "1" },
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
        HERDR_WORKSPACE_ID: options.workspaceId,
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
        // What is left of the 7000 ms delivery deadline after the precondition read.
        expect.stringMatching(/^(6\d{3}|7000)$/),
      ],
      ["pane", "close", PANE],
      ["agent", "get", NAME],
    ]);
    expect(out["current"]).toEqual({ ok: true, value: { paneId: PANE, tabId: null } });
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

  it("opens a pane as a new unfocused tab and stops it by closing the tab it created", () => {
    const tabCreated = (tabId: string, paneId: string) =>
      `${JSON.stringify({
        id: "cli:tab:create",
        result: {
          root_pane: { pane_id: paneId, tab_id: tabId, terminal_id: "term_0", workspace_id: "w9" },
          tab: { tab_id: tabId, label: "woof:builder", number: 2, pane_count: 1 },
          type: "tab_created",
        },
      })}\n`;
    const { out, log } = runAdapter(
      [
        { match: ["tab", "create"], stdout: tabCreated("w9:t2", PANE) },
        { match: ["agent", "start"], stdout: agentJson("idle", 10, "agent_started") },
        {
          match: ["tab", "close"],
          stdout: `${JSON.stringify({ id: "cli:tab:close", result: { type: "ok" } })}\n`,
        },
        { match: ["agent", "get"], ...error("agent_not_found") },
      ],
      `
const opened = await runtime.openPane({ placement: "tab", label: "woof:builder", cwd: "/tmp/run", env: { WOOF_RUN_DIR: "/tmp/run" } });
const start = await runtime.startAgent({ runtimeName: handle.runtimeName, kind: "claude", paneId: ${JSON.stringify(PANE)}, timeoutMs: 30000 });
// A forged tab id on the handle is never what gets closed, and a pane this instance did not open is refused.
const foreign = await runtime.stop({ ...handle, paneId: "w9:p999", tabId: "w9:t2" }, { timeoutMs: 4000 });
const stopped = await runtime.stop({ ...handle, tabId: "w9:t777" }, { timeoutMs: 4000 });
const again = await runtime.stop(handle, { timeoutMs: 4000 });
out = { opened, start, foreign, stopped, again };`,
      { workspaceId: "w9" },
    );
    expect(log).toEqual([
      [
        "tab",
        "create",
        "--workspace",
        "w9",
        "--cwd",
        "/tmp/run",
        "--label",
        "woof:builder",
        "--no-focus",
        "--env",
        "WOOF_RUN_DIR=/tmp/run",
      ],
      expect.arrayContaining(["agent", "start", NAME, "--pane", PANE]),
      ["tab", "close", "w9:t2"],
      ["agent", "get", NAME],
    ]);
    expect(out["opened"]).toEqual({ ok: true, value: { paneId: PANE, tabId: "w9:t2" } });
    expect(out["start"]).toMatchObject({ ok: true, value: { paneOwned: true, tabId: "w9:t2" } });
    expect(out["foreign"]).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(out["stopped"]).toEqual({ ok: true, value: { paneClosed: true, tabClosed: true } });
    expect(out["again"]).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });

  it("creates the tab without --workspace when Herdr names none, and rejects a reply with no ids", () => {
    const reply = (result: unknown) => `${JSON.stringify({ id: "cli:tab:create", result })}\n`;
    const { out, log } = runAdapter(
      [
        {
          match: ["tab", "create"],
          call: 1,
          stdout: reply({ root_pane: { pane_id: PANE }, tab: { tab_id: "" } }),
        },
        { match: ["tab", "create"], call: 2, stdout: reply({ tab: { tab_id: "w9:t2" } }) },
        { match: ["tab", "create"], call: 3, stdout: `${JSON.stringify({ result: {} })}\n` },
      ],
      `
const noTab = await runtime.openPane({ placement: "tab", cwd: "/tmp/run" });
const noPane = await runtime.openPane({ placement: "tab", cwd: "/tmp/run" });
const noId = await runtime.openPane({ placement: "tab", cwd: "/tmp/run" });
// Nothing was recorded as owned: no tab is closed.
const stopped = await runtime.stop(handle, { timeoutMs: 1000 });
out = { noTab, noPane, noId, stopped };`,
    );
    expect(log).toEqual([
      ["tab", "create", "--cwd", "/tmp/run", "--no-focus"],
      ["tab", "create", "--cwd", "/tmp/run", "--no-focus"],
      ["tab", "create", "--cwd", "/tmp/run", "--no-focus"],
    ]);
    for (const key of ["noTab", "noPane", "noId"])
      expect(out[key], key).toMatchObject({ ok: false, error: { code: "protocol_error" } });
    expect(out["stopped"]).toMatchObject({ ok: false, error: { code: "unsupported" } });
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

  it("reports a failed precondition read as not_delivered precondition_failed, never runtime_unavailable", () => {
    const cases: Array<[Entry, string]> = [
      [{ match: ["agent", "get"], hangMs: 10_000, stdout: "" }, "timeout"],
      [{ match: ["agent", "get"], stdout: "garbage{" }, "protocol_error"],
      [{ match: ["agent", "get"], ...error("server_exploded") }, "runtime_error"],
    ];
    for (const [read, underlying] of cases) {
      const { out, log } = runAdapter([read], deliver(300), { herdrEnv: "1", graceMs: 100 });
      expect(out, underlying).toMatchObject({
        outcome: "not_delivered",
        error: { code: "precondition_failed" },
      });
      const message = (out["error"] as { message: string }).message;
      expect(message, underlying).toContain("precondition read failed");
      expect(message, underlying).toContain("nothing was sent");
      expect(
        log.filter((args) => args[1] === "prompt"),
        underlying,
      ).toEqual([]);
    }
  }, 30_000);

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

  it("refuses to wait for unknown or gone, alone or mixed, without spawning", () => {
    const { out, log } = runAdapter(
      [ready()],
      `out = {
  unknown: await runtime.waitFor(handle, ["unknown"], 1000),
  mixed: await runtime.waitFor(handle, ["ready", "unknown"], 1000),
  gone: await runtime.waitFor(handle, ["gone"], 1000),
  goneMixed: await runtime.waitFor(handle, ["ready", "gone"], 1000),
  goneWithWorking: await runtime.waitFor(handle, ["gone", "working", "blocked"], 1000),
};`,
    );
    expect(out).toMatchObject({
      unknown: { ok: false, error: { code: "unsupported" } },
      mixed: { ok: false, error: { code: "unsupported" } },
      gone: { ok: false, error: { code: "unsupported" } },
      goneMixed: { ok: false, error: { code: "unsupported" } },
      goneWithWorking: { ok: false, error: { code: "unsupported" } },
    });
    expect(log).toEqual([]);
  });

  it("retries agent start on agent_pane_busy only for a pane it just split", () => {
    const busyThenStarted: Entry[] = [
      splitReturning(PANE),
      { match: ["agent", "start"], call: 1, ...error("agent_pane_busy") },
      { match: ["agent", "start"], call: 2, ...error("agent_pane_busy") },
      { match: ["agent", "start"], call: 3, stdout: agentJson("idle", 10, "agent_started") },
    ];
    const owned = runAdapter(
      busyThenStarted,
      `await runtime.openPane({ near: "current", cwd: "/tmp/run" });
out = await runtime.startAgent({ runtimeName: handle.runtimeName, kind: "claude", paneId: ${JSON.stringify(PANE)}, paneOwned: true, timeoutMs: 30000 });`,
    );
    expect(owned.out).toMatchObject({ ok: true, value: { paneId: PANE, paneOwned: true } });
    expect(owned.log.filter((args) => args[1] === "start")).toHaveLength(3);
    expect(owned.elapsed).toBeGreaterThanOrEqual(1900);

    // A pane this instance did not split is not retried.
    const foreign = runAdapter(
      busyThenStarted.slice(1),
      `out = await runtime.startAgent({ runtimeName: handle.runtimeName, kind: "claude", paneId: ${JSON.stringify(PANE)}, paneOwned: true, timeoutMs: 30000 });`,
    );
    expect(foreign.out).toMatchObject({ ok: false, error: { runtimeCode: "agent_pane_busy" } });
    expect(foreign.log.filter((args) => args[1] === "start")).toHaveLength(1);
  }, 30_000);

  it("bounds deliver's precondition read and prompt by one deadline", () => {
    const hungRead = runAdapter(
      [{ match: ["agent", "get"], hangMs: 10_000, stdout: "" }],
      `const began = Date.now();
out = { delivered: await runtime.deliver(handle, "x", { timeoutMs: 300 }), took: Date.now() - began };`,
      { herdrEnv: "1", graceMs: 100 },
    );
    // F-003: a precondition read that ran out of time proves nothing was sent, not that the runtime
    // is down (intentional expectation change from runtime_unavailable).
    expect(hungRead.out["delivered"]).toMatchObject({
      outcome: "not_delivered",
      error: { code: "precondition_failed" },
    });
    expect(hungRead.out["took"]).toBeLessThan(1000);
    expect(hungRead.log.filter((args) => args[1] === "prompt")).toEqual([]);

    const hungPrompt = runAdapter(
      [
        { match: ["agent", "get"], stdout: agentJson("idle", 5) },
        { match: ["agent", "prompt"], hangMs: 10_000, stdout: "" },
      ],
      `const began = Date.now();
out = { delivered: await runtime.deliver(handle, "x", { timeoutMs: 800 }), took: Date.now() - began };`,
      { herdrEnv: "1", graceMs: 100 },
    );
    expect(hungPrompt.out["delivered"]).toMatchObject({
      outcome: "ambiguous",
      error: { code: "timeout" },
    });
    expect(hungPrompt.out["took"]).toBeLessThan(800 + 100 + 400);
    const prompt = hungPrompt.log.find((args) => args[1] === "prompt") ?? [];
    expect(Number(prompt[prompt.indexOf("--timeout") + 1])).toBeLessThanOrEqual(800);
  }, 30_000);

  it("bounds observe and pane split by a supplied timeout", () => {
    const { out } = runAdapter(
      [
        { match: ["agent", "get"], hangMs: 10_000, stdout: "" },
        { match: ["pane", "split"], hangMs: 10_000, stdout: "" },
      ],
      `let began = Date.now();
const observed = await runtime.observe(handle, { timeoutMs: 300 });
const observeMs = Date.now() - began;
began = Date.now();
const pane = await runtime.openPane({ near: "current", cwd: "/tmp/run", timeoutMs: 300 });
out = { observed, observeMs, pane, paneMs: Date.now() - began };`,
      { herdrEnv: "1", graceMs: 100 },
    );
    expect(out).toMatchObject({
      observed: { ok: false, error: { code: "timeout" } },
      pane: { ok: false, error: { code: "timeout" } },
    });
    expect(out["observeMs"]).toBeLessThan(1000);
    expect(out["paneMs"]).toBeLessThan(1000);
  }, 30_000);

  it("keeps start retries within the supplied timeout and returns the busy result, not a timeout", () => {
    const startBody = (timeoutMs: number) =>
      `await runtime.openPane({ near: "current", cwd: "/tmp/run" });
const began = Date.now();
out = { result: await runtime.startAgent({ runtimeName: handle.runtimeName, kind: "claude", paneId: ${JSON.stringify(PANE)}, paneOwned: true, timeoutMs: ${timeoutMs} }), took: Date.now() - began };`;
    const startTimeouts = (log: string[][]) =>
      log
        .filter((args) => args[1] === "start")
        .map((args) => Number(args[args.indexOf("--timeout") + 1]));

    // A persistently busy owned pane.
    const persistent = runAdapter(
      [splitReturning(PANE), { match: ["agent", "start"], ...error("agent_pane_busy") }],
      startBody(6000),
      { herdrEnv: "1", graceMs: 100 },
    );
    expect(persistent.out["result"]).toMatchObject({
      ok: false,
      error: { runtimeCode: "agent_pane_busy" },
    });
    expect(persistent.out["took"]).toBeLessThan(6000);
    const persistentTimeouts = startTimeouts(persistent.log);
    expect(persistentTimeouts.length).toBeGreaterThanOrEqual(2);
    expect(persistentTimeouts[0]).toBe(6000);
    for (const value of persistentTimeouts.slice(1)) {
      expect(value).toBeGreaterThan(3000);
      expect(value).toBeLessThan(6000);
    }

    // Busy, then a second start that never answers: bounded by the supplied timeout.
    const slow = runAdapter(
      [
        splitReturning(PANE),
        { match: ["agent", "start"], call: 1, ...error("agent_pane_busy") },
        { match: ["agent", "start"], call: 2, hangMs: 60_000, stdout: "" },
      ],
      startBody(5000),
      { herdrEnv: "1", graceMs: 100 },
    );
    expect(slow.out["result"]).toMatchObject({
      ok: false,
      error: { runtimeCode: "agent_pane_busy" },
    });
    expect(slow.out["took"]).toBeLessThan(5000 + 400);
    expect(startTimeouts(slow.log)).toHaveLength(2);
  }, 30_000);

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
