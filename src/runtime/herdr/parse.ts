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
    // A success response names its request id and carries a result object.
    if (
      isPlainObject(value) &&
      typeof value["id"] === "string" &&
      value["id"] !== "" &&
      isPlainObject(value["result"])
    ) {
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

export type TabCreated =
  | { ok: true; tabId: string; paneId: string; workspaceId: string }
  | {
      ok: false;
      message: string;
      /** The tab Herdr did create, when the reply names exactly one; the caller closes it. */
      createdTabId: string | undefined;
    };

/**
 * Validates a whole `tab create` result (`.result`) before anyone records ownership: the tab id,
 * the root pane id, the root pane's tab id equal to the tab's, and one workspace id (the tab's,
 * when Herdr reports it, and the requested one must both agree with the root pane's). Herdr has
 * already created the tab when this runs, so a refusal names the tab to close whenever the reply
 * identifies it without contradiction.
 */
export function parseTabCreated(
  result: Record<string, unknown>,
  requestedWorkspaceId?: string,
): TabCreated {
  const tab = isPlainObject(result["tab"]) ? result["tab"] : {};
  const root = isPlainObject(result["root_pane"]) ? result["root_pane"] : {};
  const tabId = stringOrNull(tab["tab_id"]);
  const rootTabId = stringOrNull(root["tab_id"]);
  const paneId = stringOrNull(root["pane_id"]);
  const workspaceId = stringOrNull(root["workspace_id"]);
  const tabWorkspaceId = stringOrNull(tab["workspace_id"]);
  if (tabId !== null && rootTabId !== null && tabId !== rootTabId) {
    // Two different tabs are named: neither is positively the created one, so none is closed.
    return {
      ok: false,
      message: `tab create returned tab ${tabId} with a root pane of tab ${rootTabId}`,
      createdTabId: undefined,
    };
  }
  const createdTabId = tabId ?? rootTabId ?? undefined;
  const refuse = (message: string): TabCreated => ({ ok: false, message, createdTabId });
  if (tabId === null) return refuse("tab create returned no tab_id");
  if (paneId === null) return refuse("tab create returned no root pane_id");
  if (rootTabId === null) return refuse("tab create returned a root pane with no tab_id");
  if (workspaceId === null) return refuse("tab create returned a root pane with no workspace_id");
  if (tabWorkspaceId !== null && tabWorkspaceId !== workspaceId) {
    return refuse(
      `tab create returned tab workspace ${tabWorkspaceId} with a root pane of workspace ${workspaceId}`,
    );
  }
  if (requestedWorkspaceId !== undefined && requestedWorkspaceId !== workspaceId) {
    return refuse(
      `tab create was asked for workspace ${requestedWorkspaceId} and returned workspace ${workspaceId}`,
    );
  }
  return { ok: true, tabId, paneId, workspaceId };
}

/** The workspace a `pane get` result (`.result`) places the pane in, else undefined. */
export function paneWorkspaceId(result: Record<string, unknown>): string | undefined {
  const pane = result["pane"];
  return isPlainObject(pane) ? (stringOrNull(pane["workspace_id"]) ?? undefined) : undefined;
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

export type WorktreeCreated =
  | {
      ok: true;
      /** Absolute checkout path of the new worktree. */
      path: string;
      branch: string;
      workspaceId: string;
      /** The root pane of the worktree's workspace, and its tab. */
      rootPaneId: string;
      tabId: string;
    }
  | {
      ok: false;
      message: string;
      /** The workspace Herdr named, when it did: the worktree exists and can be removed by it. */
      workspaceId: string | undefined;
    };

/**
 * The `result` of `herdr worktree create` (herdr 0.9.1, docs/design/composition.md):
 * `worktree.path` and `worktree.branch`, `workspace.workspace_id` and the workspace's
 * `root_pane` with its `tab_id`. Every id must agree with the others.
 */
export function parseWorktreeCreated(result: Record<string, unknown>): WorktreeCreated {
  const worktree = isPlainObject(result["worktree"]) ? result["worktree"] : {};
  const workspace = isPlainObject(result["workspace"]) ? result["workspace"] : {};
  const root = isPlainObject(result["root_pane"]) ? result["root_pane"] : {};
  const workspaceId = stringOrNull(workspace["workspace_id"]) ?? stringOrNull(root["workspace_id"]);
  const refuse = (message: string): WorktreeCreated => ({
    ok: false,
    message,
    workspaceId: workspaceId ?? undefined,
  });
  if (result["type"] !== "worktree_created")
    return refuse(`worktree create returned ${String(result["type"])}, not worktree_created`);
  const path = stringOrNull(worktree["path"]);
  const branch = stringOrNull(worktree["branch"]);
  const rootPaneId = stringOrNull(root["pane_id"]);
  const tabId = stringOrNull(root["tab_id"]);
  if (workspaceId === null) return refuse("worktree create returned no workspace_id");
  if (path === null || !path.startsWith("/"))
    return refuse("worktree create returned no absolute worktree path");
  if (branch === null) return refuse("worktree create returned no branch");
  if (rootPaneId === null || tabId === null)
    return refuse("worktree create returned no root pane with a tab");
  const rootWorkspace = stringOrNull(root["workspace_id"]);
  if (rootWorkspace !== null && rootWorkspace !== workspaceId)
    return refuse(
      `worktree create returned workspace ${workspaceId} with a root pane of workspace ${rootWorkspace}`,
    );
  const opened = stringOrNull(worktree["open_workspace_id"]);
  if (opened !== null && opened !== workspaceId)
    return refuse(`worktree create opened workspace ${opened}, not ${workspaceId}`);
  return { ok: true, path, branch, workspaceId, rootPaneId, tabId };
}
