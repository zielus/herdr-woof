import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

interface Exec {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  spawnErrorCode: string | null;
  spawnErrorMessage: string | null;
  killed: boolean;
}
type Outcome =
  | { ok: true; result: Record<string, unknown> }
  | {
      ok: false;
      error: {
        code: string;
        runtimeCode: string | null;
        command: string[];
        exitCode: number | null;
      };
    };
interface ParseModule {
  parseHerdrOutput(command: string[], exec: Exec): Outcome;
  parseAgentInfo(value: unknown): Record<string, unknown> | undefined;
  observationFromAgent(
    runtimeName: string,
    paneId: string,
    info: Record<string, unknown>,
    observedAt: string,
  ): Record<string, unknown> & {
    lifecycle: string;
    runtimeStatus: string;
    order: Record<string, unknown>;
  };
}

let parse: ParseModule;
let lifecycleFromStatus: (status: string) => string;

beforeAll(async () => {
  parse = await loadDist<ParseModule>("runtime/herdr/parse.js");
  ({ lifecycleFromStatus } = await loadDist<{ lifecycleFromStatus: typeof lifecycleFromStatus }>(
    "runtime/adapter.js",
  ));
});

const exec = (overrides: Partial<Exec>): Exec => ({
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  spawnErrorCode: null,
  spawnErrorMessage: null,
  killed: false,
  ...overrides,
});

// Shape captured from `herdr agent get` on herdr 0.9.0.
const AGENT = {
  agent: "claude",
  agent_session: {
    agent: "claude",
    kind: "id",
    source: "herdr:claude",
    value: "e425e736-4647-461a-b379-6eeb68f3fb55",
  },
  agent_status: "done",
  cwd: "/tmp/project",
  focused: true,
  name: "lead",
  pane_id: "w8D:p1",
  revision: 47,
  state_change_seq: 633,
  tab_id: "w8D:t1",
  terminal_id: "term_65b55864df6d6e",
  workspace_id: "w8D",
};

describe("lifecycle mapping", () => {
  it("maps Herdr statuses to lifecycles", () => {
    expect(
      ["idle", "done", "working", "blocked", "unknown", "starting"].map((status) => [
        status,
        lifecycleFromStatus(status),
      ]),
    ).toEqual([
      ["idle", "ready"],
      ["done", "ready"],
      ["working", "working"],
      ["blocked", "blocked"],
      ["unknown", "unknown"],
      ["starting", "unknown"],
    ]);
  });
});

describe("parseAgentInfo and observationFromAgent", () => {
  it("keeps the raw status, ordering keys and session, tolerating unknown fields", () => {
    const info = parse.parseAgentInfo({ ...AGENT, tokens: { a: "b" }, future_field: [1, 2] });
    expect(info).toEqual({
      status: "done",
      paneId: "w8D:p1",
      terminalId: "term_65b55864df6d6e",
      sessionId: "e425e736-4647-461a-b379-6eeb68f3fb55",
      stateChangeSeq: 633,
      revision: 47,
    });
    const observation = parse.observationFromAgent(
      "w-lead-000000",
      "fallback",
      info as Record<string, unknown>,
      "2026-09-14T10:00:00.000Z",
    );
    expect(observation).toMatchObject({
      paneId: "w8D:p1",
      lifecycle: "ready",
      runtimeStatus: "done",
      order: { terminalId: "term_65b55864df6d6e", stateChangeSeq: 633, revision: 47 },
    });
  });

  it("reports a missing state_change_seq and session as null", () => {
    const { state_change_seq: _seq, agent_session: _session, ...rest } = AGENT;
    expect(parse.parseAgentInfo(rest)).toMatchObject({ stateChangeSeq: null, sessionId: null });
  });

  it("refuses an object without an agent status", () => {
    expect(parse.parseAgentInfo({ name: "x" })).toBeUndefined();
    expect(parse.parseAgentInfo(null)).toBeUndefined();
  });
});

describe("parseHerdrOutput", () => {
  const command = ["agent", "get", "w-x-000000"];

  it("returns the result object on exit 0", () => {
    const outcome = parse.parseHerdrOutput(
      command,
      exec({
        stdout: JSON.stringify({
          id: "cli:agent:get",
          result: { agent: AGENT, type: "agent_info" },
        }),
      }),
    );
    expect(outcome).toMatchObject({ ok: true, result: { type: "agent_info" } });
  });

  it("parses error JSON from stderr (observed) and from stdout", () => {
    const payload = JSON.stringify({
      error: { code: "agent_not_found", message: "agent target x not found" },
      id: "cli:agent:get",
    });
    for (const streams of [{ stderr: `${payload}\n` }, { stdout: payload }]) {
      expect(parse.parseHerdrOutput(command, exec({ exitCode: 1, ...streams }))).toEqual({
        ok: false,
        error: {
          code: "not_found",
          runtimeCode: "agent_not_found",
          message: "agent target x not found",
          command,
          exitCode: 1,
        },
      });
    }
  });

  it("maps Herdr error codes", () => {
    const codes = [
      ["pane_not_found", "not_found"],
      ["agent_not_ready", "agent_not_ready"],
      ["agent_blocked", "agent_blocked"],
      ["agent_prompt_stalled", "stalled"],
      ["timeout", "timeout"],
      ["server_gone", "runtime_error"],
    ];
    for (const [herdrCode, code] of codes) {
      const outcome = parse.parseHerdrOutput(
        command,
        exec({ exitCode: 1, stderr: JSON.stringify({ error: { code: herdrCode, message: "m" } }) }),
      );
      expect(outcome.ok === false && [outcome.error.code, outcome.error.runtimeCode]).toEqual([
        code,
        herdrCode,
      ]);
    }
  });

  it("classifies usage errors, spawn failures, kills and garbage", () => {
    const cases: Array<[Partial<Exec>, string]> = [
      [{ exitCode: 2, stderr: "usage: herdr agent get <target>\n" }, "invalid_request"],
      [
        { exitCode: null, spawnErrorCode: "ENOENT", spawnErrorMessage: "spawn herdr ENOENT" },
        "runtime_unavailable",
      ],
      [{ exitCode: null, signal: "SIGKILL", killed: true }, "timeout"],
      [{ exitCode: 0, stdout: "not json" }, "protocol_error"],
      [{ exitCode: 0, stdout: JSON.stringify({ id: "x" }) }, "protocol_error"],
      [{ exitCode: 0, stdout: JSON.stringify({ result: { type: "ok" } }) }, "protocol_error"],
      [
        { exitCode: 0, stdout: JSON.stringify({ id: "", result: { type: "ok" } }) },
        "protocol_error",
      ],
      [
        { exitCode: 0, stdout: JSON.stringify({ id: 7, result: { type: "ok" } }) },
        "protocol_error",
      ],
      [{ exitCode: 0, stdout: JSON.stringify({ id: null, result: {} }) }, "protocol_error"],
      [{ exitCode: 1, stderr: "panic: something" }, "protocol_error"],
      [{ exitCode: 137, signal: "SIGKILL" }, "protocol_error"],
    ];
    for (const [overrides, code] of cases) {
      const outcome = parse.parseHerdrOutput(command, exec(overrides));
      expect(outcome.ok === false && outcome.error.code, JSON.stringify(overrides)).toBe(code);
    }
  });
});
