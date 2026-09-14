import {
  isNotDeliveredCode,
  runtimeError,
  type AgentHandle,
  type DeliveryResult,
  type Lifecycle,
  type LifecycleObservation,
  type OpenPaneInput,
  type RuntimeAdapter,
  type RuntimeError,
  type RuntimeResult,
  type StartAgentInput,
} from "../adapter.js";
import { isHerdrRuntimeName } from "../names.js";
import { execHerdr } from "./exec.js";
import {
  observationFromAgent,
  parseAgentInfo,
  parseHerdrOutput,
  type HerdrOutcome,
} from "./parse.js";

export interface HerdrCliRuntimeOptions {
  /** Herdr executable. Required, so no caller reaches a server through PATH by accident. */
  bin: string;
  env?: NodeJS.ProcessEnv;
  /** Refuse to spawn unless env.HERDR_ENV is "1" (default true). */
  requireHerdrEnv?: boolean;
  /** Deadline for pane split, get and close commands (default 10000). */
  commandTimeoutMs?: number;
  /** Extra time before a child that ignores its own --timeout is killed (default 2000). */
  spawnGraceMs?: number;
}

export interface HerdrCliRuntime extends RuntimeAdapter {
  readonly adapter: "herdr";
  /**
   * Runs one read-only inspection command (for example `agent list`) through
   * the adapter's exec and parser. Terminal reads and input (`read`,
   * `send-keys`, `run`, `explain`) are refused without spawning.
   */
  inspect(args: readonly string[], timeoutMs?: number): Promise<HerdrOutcome>;
}

const FORBIDDEN_SUBCOMMANDS = new Set(["read", "send-keys", "run", "explain"]);

/**
 * Runtime adapter over the Herdr CLI (`herdr agent` / `herdr pane` JSON
 * commands). Observation is pull-based and lossy: transitions between two reads
 * are not seen. The adapter never reads terminal text, sends keys or resends a
 * prompt, and never writes the run journal. Construction does not spawn.
 */
export function createHerdrCliRuntime(options: HerdrCliRuntimeOptions): HerdrCliRuntime {
  const env = options.env ?? process.env;
  const requireHerdrEnv = options.requireHerdrEnv ?? true;
  const commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
  const graceMs = options.spawnGraceMs ?? 2000;
  /** Panes this instance split; the only panes `stop` may close. */
  const ownedPanes = new Set<string>();

  async function run(args: string[], timeoutMs: number): Promise<HerdrOutcome> {
    if (FORBIDDEN_SUBCOMMANDS.has(args[1] ?? "")) {
      return {
        ok: false,
        error: runtimeError(
          "unsupported",
          `herdr ${args[0]} ${args[1]} is not used by the adapter`,
          {
            command: args,
          },
        ),
      };
    }
    if (requireHerdrEnv && env["HERDR_ENV"] !== "1") {
      return {
        ok: false,
        error: runtimeError("runtime_unavailable", "HERDR_ENV is not 1; not running inside Herdr", {
          command: args,
        }),
      };
    }
    const exec = await execHerdr(args, { bin: options.bin, env, timeoutMs, graceMs });
    return parseHerdrOutput(args, exec);
  }

  async function observe(handle: AgentHandle): Promise<RuntimeResult<LifecycleObservation>> {
    const bad = invalidName(handle.runtimeName);
    if (bad !== undefined) return { ok: false, error: bad };
    const got = await run(["agent", "get", handle.runtimeName], commandTimeoutMs);
    if (got.ok) {
      const info = parseAgentInfo(got.result["agent"]);
      if (info === undefined)
        return protocol(["agent", "get", handle.runtimeName], "agent get has no agent status");
      return {
        ok: true,
        value: observationFromAgent(handle.runtimeName, handle.paneId, info, now()),
      };
    }
    if (got.error.runtimeCode !== "agent_not_found") return got;
    const pane = await run(["pane", "get", handle.paneId], commandTimeoutMs);
    if (!pane.ok && pane.error.runtimeCode !== "pane_not_found") return pane;
    return {
      ok: true,
      value: {
        runtimeName: handle.runtimeName,
        paneId: handle.paneId,
        lifecycle: "gone",
        runtimeStatus: null,
        sessionId: null,
        order: { terminalId: null, stateChangeSeq: null, revision: null },
        observedAt: now(),
      },
    };
  }

  return {
    adapter: "herdr",

    inspect: (args, timeoutMs = commandTimeoutMs) => run([...args], timeoutMs),

    async openPane(input: OpenPaneInput): Promise<RuntimeResult<{ paneId: string }>> {
      const args = [
        "pane",
        "split",
        ...(input.near === "current" ? ["--current"] : [input.near]),
        "--direction",
        input.direction ?? "down",
        "--cwd",
        input.cwd,
        "--no-focus",
        ...Object.entries(input.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      ];
      const split = await run(args, commandTimeoutMs);
      if (!split.ok) return split;
      const pane = split.result["pane"];
      const paneId =
        typeof pane === "object" && pane !== null
          ? (pane as Record<string, unknown>)["pane_id"]
          : undefined;
      if (typeof paneId !== "string" || paneId === "")
        return protocol(args, "pane split returned no pane_id");
      ownedPanes.add(paneId);
      return { ok: true, value: { paneId } };
    },

    async startAgent(input: StartAgentInput): Promise<RuntimeResult<AgentHandle>> {
      const bad = invalidName(input.runtimeName);
      if (bad !== undefined) return { ok: false, error: bad };
      const args = [
        "agent",
        "start",
        input.runtimeName,
        "--kind",
        input.kind,
        "--pane",
        input.paneId,
        "--timeout",
        String(input.timeoutMs),
        ...(input.args !== undefined && input.args.length > 0 ? ["--", ...input.args] : []),
      ];
      const started = await run(args, input.timeoutMs);
      if (!started.ok) return started;
      const info = parseAgentInfo(started.result["agent"]);
      if (info === undefined) return protocol(args, "agent start returned no agent");
      const paneId = info.paneId ?? input.paneId;
      return {
        ok: true,
        value: {
          adapter: "herdr",
          runtimeName: input.runtimeName,
          kind: input.kind,
          paneId,
          paneOwned: ownedPanes.has(paneId),
          terminalId: info.terminalId,
          sessionId: info.sessionId,
        },
      };
    },

    observe,

    async waitFor(handle: AgentHandle, states: Lifecycle[], timeoutMs: number) {
      const bad = invalidName(handle.runtimeName);
      if (bad !== undefined) return { ok: false as const, error: bad };
      const untils = [...new Set(states.flatMap(herdrStatuses))];
      if (untils.length === 0) {
        return {
          ok: false as const,
          error: runtimeError(
            "unsupported",
            `herdr agent wait cannot wait for ${states.join("|")}`,
          ),
        };
      }
      const args = [
        "agent",
        "wait",
        handle.runtimeName,
        ...untils.flatMap((status) => ["--until", status]),
        "--timeout",
        String(timeoutMs),
      ];
      // agent wait's own success payload is not relied on; the follow-up read is the observation.
      const waited = await run(args, timeoutMs);
      if (!waited.ok) return waited;
      return observe(handle);
    },

    async deliver(
      handle: AgentHandle,
      text: string,
      delivery: { timeoutMs: number },
    ): Promise<DeliveryResult> {
      const bad = invalidName(handle.runtimeName);
      if (bad !== undefined) return { outcome: "not_delivered", error: bad };
      // Precondition read: nothing is sent yet, so every failure here is not_delivered.
      // The read and the prompt are not atomic; a human typing in between is not detected.
      const before = await observe(handle);
      if (!before.ok) {
        const error = before.error;
        return {
          outcome: "not_delivered",
          error: isNotDeliveredCode(error.code)
            ? { ...error, code: error.code }
            : {
                ...error,
                code: "runtime_unavailable",
                message: `precondition read failed: ${error.message}`,
              },
        };
      }
      const lifecycle = before.value.lifecycle;
      if (lifecycle === "gone") {
        return {
          outcome: "not_delivered",
          error: runtimeError("not_found", `agent ${handle.runtimeName} is gone`, {
            runtimeCode: "agent_not_found",
          }),
        };
      }
      if (lifecycle === "working") {
        return {
          outcome: "not_delivered",
          error: runtimeError(
            "agent_busy",
            `agent ${handle.runtimeName} is working; the prompt was not sent`,
          ),
        };
      }
      if (lifecycle === "blocked") {
        return {
          outcome: "not_delivered",
          error: runtimeError(
            "agent_blocked",
            `agent ${handle.runtimeName} is blocked; the prompt was not sent`,
          ),
        };
      }
      const args = [
        "agent",
        "prompt",
        handle.runtimeName,
        text,
        "--wait",
        "--until",
        "working",
        "--until",
        "blocked",
        "--timeout",
        String(delivery.timeoutMs),
      ];
      const prompted = await run(args, delivery.timeoutMs);
      if (!prompted.ok) {
        const error = prompted.error;
        if (
          error.code === "runtime_unavailable" ||
          error.code === "not_found" ||
          error.code === "agent_blocked" ||
          error.code === "invalid_request"
        ) {
          return { outcome: "not_delivered", error: { ...error, code: error.code } };
        }
        return {
          outcome: "ambiguous",
          error:
            error.code === "stalled" || error.code === "timeout" || error.code === "protocol_error"
              ? { ...error, code: error.code }
              : { ...error, code: "runtime_error" },
        };
      }
      const info = parseAgentInfo(prompted.result["agent"]);
      if (info === undefined || (info.status !== "working" && info.status !== "blocked")) {
        return {
          outcome: "ambiguous",
          error: runtimeError(
            "protocol_error",
            `agent prompt returned status ${info?.status ?? "(none)"}, not working or blocked`,
            { command: args, exitCode: 0 },
          ),
        };
      }
      return {
        outcome: "started",
        observation: observationFromAgent(handle.runtimeName, handle.paneId, info, now()),
      };
    },

    async stop(handle: AgentHandle, stopping: { timeoutMs: number }) {
      // The handle's paneOwned flag is caller data and is never trusted.
      if (!ownedPanes.has(handle.paneId)) {
        return {
          ok: false as const,
          error: runtimeError(
            "unsupported",
            `stop closes only panes this adapter opened; ${handle.paneId} was not opened by it`,
          ),
        };
      }
      const bad = invalidName(handle.runtimeName);
      if (bad !== undefined) return { ok: false as const, error: bad };
      const closed = await run(["pane", "close", handle.paneId], stopping.timeoutMs);
      if (!closed.ok) return closed;
      const after = await run(["agent", "get", handle.runtimeName], commandTimeoutMs);
      if (!after.ok && after.error.runtimeCode === "agent_not_found") {
        ownedPanes.delete(handle.paneId);
        return { ok: true as const, value: { paneClosed: true as const } };
      }
      return {
        ok: false as const,
        error: after.ok
          ? runtimeError(
              "runtime_error",
              `agent ${handle.runtimeName} is still reported after pane close`,
              {
                command: ["agent", "get", handle.runtimeName],
                exitCode: 0,
              },
            )
          : after.error,
      };
    },
  };
}

function invalidName(name: string): (RuntimeError & { code: "invalid_request" }) | undefined {
  return isHerdrRuntimeName(name)
    ? undefined
    : runtimeError(
        "invalid_request",
        `runtime name ${JSON.stringify(name)} is not a valid Herdr agent name`,
      );
}

/** Herdr --until statuses for a lifecycle; `gone` has none. */
function herdrStatuses(lifecycle: Lifecycle): string[] {
  switch (lifecycle) {
    case "ready":
      return ["idle", "done"];
    case "working":
    case "blocked":
    case "unknown":
      return [lifecycle];
    case "gone":
      return [];
  }
}

function protocol(command: string[], message: string): { ok: false; error: RuntimeError } {
  return { ok: false, error: runtimeError("protocol_error", message, { command, exitCode: 0 }) };
}

function now(): string {
  return new Date().toISOString();
}
