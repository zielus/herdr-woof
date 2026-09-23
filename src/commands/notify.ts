import type { NotifyChannel, NotifySetting, NotifyTarget } from "../host/notify.js";
import { createHerdrCliRuntime, type HerdrCliRuntime } from "../runtime/herdr/adapter.js";
import { isHerdrRuntimeName } from "../runtime/names.js";

/** Bound on reading the caller's pane when a run starts. */
const CAPTURE_TIMEOUT_MS = 5000;

/**
 * The run's notification target: the agent in the pane `woof run start` runs in, as Herdr reports
 * it (`herdr agent get <pane>`). A pane without an agent (a plain shell), an agent without a Herdr
 * name or any session identity, or a read that fails is recorded as no target, with the reason;
 * capturing never refuses or changes the launch.
 */
export async function captureCaller(
  paneId: string | undefined,
  herdr: { bin: string; env: NodeJS.ProcessEnv },
): Promise<NotifySetting> {
  if (herdr.env["HERDR_ENV"] !== "1") return { target: null, reason: "outside_herdr" };
  if (paneId === undefined) return { target: null, reason: "no_caller_pane" };
  const got = await runtimeOf(herdr).inspect(["agent", "get", paneId], CAPTURE_TIMEOUT_MS);
  if (!got.ok) {
    const missing =
      got.error.runtimeCode === "agent_not_found" || got.error.runtimeCode === "pane_not_found";
    return { target: null, reason: missing ? "no_agent" : "caller_unreadable" };
  }
  const agent = callerOf(got.result);
  if (agent === undefined || agent.agent === null) return { target: null, reason: "no_agent" };
  if (agent.name === null || !isHerdrRuntimeName(agent.name))
    return { target: null, reason: "agent_unnamed" };
  if (agent.sessionId === null && agent.terminalId === null)
    return { target: null, reason: "no_session" };
  const target: NotifyTarget = {
    paneId,
    agentName: agent.name,
    agent: agent.agent,
    sessionId: agent.sessionId,
    terminalId: agent.terminalId,
  };
  return { target };
}

/**
 * Reads and prompts the caller through the Herdr runtime adapter: the read is `agent get <pane>`
 * (so a pane now hosting another agent, or none, is noticed), and a prompt is the adapter's own
 * `deliver`, with its precondition read and its started / not_delivered / ambiguous taxonomy.
 */
export function herdrNotifyChannel(
  target: NotifyTarget,
  herdr: { bin: string; env: NodeJS.ProcessEnv },
): NotifyChannel {
  const runtime = runtimeOf(herdr);
  return {
    async read() {
      const got = await runtime.inspect(["agent", "get", target.paneId]);
      if (!got.ok) {
        const gone =
          got.error.runtimeCode === "agent_not_found" || got.error.runtimeCode === "pane_not_found";
        return { ok: false, gone };
      }
      const agent = callerOf(got.result);
      if (agent === undefined || agent.agent === null) return { ok: false, gone: true };
      return {
        ok: true,
        agentName: agent.name,
        sessionId: agent.sessionId,
        terminalId: agent.terminalId,
        status: agent.status,
      };
    },
    async deliver(message, timeoutMs) {
      const delivered = await runtime.deliver(
        {
          adapter: "herdr",
          runtimeName: target.agentName,
          kind: target.agent,
          paneId: target.paneId,
          paneOwned: false,
          terminalId: target.terminalId,
          sessionId: target.sessionId,
        },
        message,
        { timeoutMs },
      );
      return delivered.outcome === "started"
        ? { outcome: "started" }
        : { outcome: delivered.outcome, code: delivered.error.code };
    },
  };
}

/** Unstable test seams: how often a host retries notifications, and how long it drains them. */
export function notifyTimings(env: NodeJS.ProcessEnv): { retryMs?: number; drainMs?: number } {
  const ms = (name: string) => {
    const raw = env[name];
    return raw !== undefined && /^[1-9][0-9]{0,6}$/.test(raw) ? Number(raw) : undefined;
  };
  const retryMs = ms("WOOF_TEST_NOTIFY_RETRY_MS");
  const drainMs = ms("WOOF_TEST_NOTIFY_DRAIN_MS");
  return {
    ...(retryMs !== undefined ? { retryMs } : {}),
    ...(drainMs !== undefined ? { drainMs } : {}),
  };
}

function runtimeOf(herdr: { bin: string; env: NodeJS.ProcessEnv }): HerdrCliRuntime {
  return createHerdrCliRuntime({ bin: herdr.bin, env: herdr.env });
}

/** The agent fields of an `agent get` result; undefined when it names no agent. */
function callerOf(result: Record<string, unknown>):
  | {
      name: string | null;
      agent: string | null;
      sessionId: string | null;
      terminalId: string | null;
      status: string;
    }
  | undefined {
  const agent = result["agent"];
  if (typeof agent !== "object" || agent === null) return undefined;
  const value = agent as Record<string, unknown>;
  const session = value["agent_session"];
  return {
    name: text(value["name"]),
    agent: text(value["agent"]),
    sessionId:
      typeof session === "object" && session !== null
        ? text((session as Record<string, unknown>)["value"])
        : null,
    terminalId: text(value["terminal_id"]),
    status: text(value["agent_status"]) ?? "unknown",
  };
}

function text(field: unknown): string | null {
  return typeof field === "string" && field !== "" ? field : null;
}
