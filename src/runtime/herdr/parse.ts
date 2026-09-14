import { isPlainObject } from "../../contracts/envelope.js";
import {
  lifecycleFromStatus,
  runtimeError,
  type LifecycleObservation,
  type RuntimeError,
  type RuntimeErrorCode,
} from "../adapter.js";
import type { ExecResult } from "./exec.js";

/**
 * Pure parsing of Herdr CLI output (herdr 0.9.0 shapes). Success is exit 0 with
 * `{"id", "result"}` JSON on stdout. Server errors are `{"error": {"code",
 * "message"}}` JSON with exit 1, observed on stderr; stdout is also accepted.
 * Usage errors exit 2. Anything else is a protocol error.
 */

export type HerdrOutcome =
  { ok: true; result: Record<string, unknown> } | { ok: false; error: RuntimeError };

export interface HerdrAgentInfo {
  status: string;
  paneId: string | null;
  terminalId: string | null;
  sessionId: string | null;
  stateChangeSeq: number | null;
  revision: number | null;
}

export function parseHerdrOutput(command: readonly string[], exec: ExecResult): HerdrOutcome {
  const details = { command: [...command], exitCode: exec.exitCode };
  if (exec.spawnErrorCode !== null) {
    return fail(
      runtimeError(
        "runtime_unavailable",
        `cannot run herdr: ${exec.spawnErrorMessage ?? exec.spawnErrorCode}`,
        { ...details, runtimeCode: exec.spawnErrorCode },
      ),
    );
  }
  if (exec.killed) {
    return fail(
      runtimeError("timeout", "herdr did not exit before its deadline and was killed", details),
    );
  }
  if (exec.exitCode === 0) {
    const value = parseJson(exec.stdout);
    if (isPlainObject(value) && isPlainObject(value["result"])) {
      return { ok: true, result: value["result"] };
    }
    return fail(
      runtimeError("protocol_error", `unexpected herdr output: ${excerpt(exec.stdout)}`, details),
    );
  }
  if (exec.exitCode === 2) {
    return fail(
      runtimeError("invalid_request", firstLine(exec.stderr) ?? "herdr usage error", details),
    );
  }
  if (exec.exitCode === 1) {
    for (const stream of [exec.stderr, exec.stdout]) {
      const error = errorPayload(stream);
      if (error !== undefined) {
        return fail(
          runtimeError(mapHerdrErrorCode(error.code), error.message, {
            ...details,
            runtimeCode: error.code,
          }),
        );
      }
    }
  }
  return fail(
    runtimeError(
      "protocol_error",
      `unexpected herdr exit ${String(exec.exitCode)}${exec.signal !== null ? ` (${exec.signal})` : ""}: ${excerpt(exec.stderr || exec.stdout)}`,
      details,
    ),
  );
}

export function mapHerdrErrorCode(code: string): RuntimeErrorCode {
  switch (code) {
    case "agent_not_found":
    case "pane_not_found":
      return "not_found";
    case "agent_not_ready":
      return "agent_not_ready";
    case "agent_blocked":
      return "agent_blocked";
    case "agent_prompt_stalled":
      return "stalled";
    case "timeout":
      return "timeout";
    default:
      return "runtime_error";
  }
}

/** Reads an AgentInfo object (`.result.agent`); unknown fields are ignored. */
export function parseAgentInfo(value: unknown): HerdrAgentInfo | undefined {
  if (!isPlainObject(value) || typeof value["agent_status"] !== "string") return undefined;
  const session = value["agent_session"];
  return {
    status: value["agent_status"],
    paneId: stringOrNull(value["pane_id"]),
    terminalId: stringOrNull(value["terminal_id"]),
    sessionId: isPlainObject(session) ? stringOrNull(session["value"]) : null,
    stateChangeSeq: integerOrNull(value["state_change_seq"]),
    revision: integerOrNull(value["revision"]),
  };
}

export function observationFromAgent(
  runtimeName: string,
  fallbackPaneId: string,
  info: HerdrAgentInfo,
  observedAt: string,
): LifecycleObservation {
  return {
    runtimeName,
    paneId: info.paneId ?? fallbackPaneId,
    lifecycle: lifecycleFromStatus(info.status),
    runtimeStatus: info.status,
    sessionId: info.sessionId,
    order: {
      terminalId: info.terminalId,
      stateChangeSeq: info.stateChangeSeq,
      revision: info.revision,
    },
    observedAt,
  };
}

function errorPayload(stream: string): { code: string; message: string } | undefined {
  for (const line of stream.trim().split("\n").toReversed()) {
    const value = parseJson(line);
    if (isPlainObject(value) && isPlainObject(value["error"])) {
      const { code, message } = value["error"];
      if (typeof code === "string") {
        return { code, message: typeof message === "string" ? message : code };
      }
    }
  }
  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function firstLine(text: string): string | undefined {
  const line = text.trim().split("\n")[0];
  return line === undefined || line === "" ? undefined : line;
}

function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed || "(empty)";
}

function fail(error: RuntimeError): HerdrOutcome {
  return { ok: false, error };
}
