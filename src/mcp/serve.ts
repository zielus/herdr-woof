/**
 * Shared MCP stdio server loop for `woof-mcp` and `woof-agent-mcp`.
 *
 * Hand-rolled JSON-RPC over newline-delimited stdin/stdout, no SDK — the same
 * approach the previous iteration used (ADR-0009): four methods and a
 * notification are the whole surface a tool server needs, and the dependency
 * we would take for them is larger than this file.
 *
 * Nothing is written to stdout that is not a JSON-RPC message: stdout is the
 * transport, so every diagnostic goes to stderr.
 *
 * Both servers currently advertise zero tools. This is scaffolding for the
 * orchestration SDK, not orchestration logic.
 */
import type { Readable, Writable } from "node:stream";

/** The newest MCP revision this server claims. The client's wins if it names one. */
export const MCP_PROTOCOL_VERSION = "2025-11-25";

export interface ServeMcpOptions {
  readonly name: string;
  readonly version: string;
  readonly input: Readable;
  readonly output: Writable;
  /** Diagnostics; never stdout. */
  readonly log?: ((line: string) => void) | undefined;
}

interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

class MethodNotFoundError extends Error {}

/**
 * Serve until the input ends. Resolves when stdin closes, which is how Claude
 * Code stops an MCP server.
 */
export async function serveMcp(options: ServeMcpOptions): Promise<void> {
  const { input, output, name, version } = options;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let buffer = "";
  let pending = Promise.resolve();

  const send = (message: Record<string, unknown>): void => {
    output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  const handleLine = async (line: string): Promise<void> => {
    const text = line.trim();
    if (text === "") return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(text) as JsonRpcMessage;
    } catch {
      send({ id: null, error: { code: PARSE_ERROR, message: "Invalid JSON" } });
      return;
    }
    const id = message.id;
    const method = message.method;
    if (typeof method !== "string") {
      if (id !== undefined && id !== null) {
        send({ id, error: { code: INVALID_REQUEST, message: "A request needs a method" } });
      }
      return;
    }
    // A notification has no id and is never answered.
    const answerable = id !== undefined && id !== null;
    try {
      const result = await handle(method, message.params, name, version);
      if (result === undefined) return; // notification
      if (answerable) send({ id, result });
    } catch (error) {
      if (error instanceof MethodNotFoundError) {
        if (answerable) send({ id, error: { code: METHOD_NOT_FOUND, message: error.message } });
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      log(`${name}: ${method} failed: ${detail}`);
      if (answerable) send({ id, error: { code: INTERNAL_ERROR, message: detail } });
    }
  };

  await new Promise<void>((resolve) => {
    input.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        // Requests are answered in arrival order.
        pending = pending.then(() => handleLine(line));
      }
    });
    input.once("end", () => {
      void pending.then(resolve);
    });
    input.once("close", () => {
      void pending.then(resolve);
    });
  });
}

async function handle(
  method: string,
  params: unknown,
  name: string,
  version: string,
): Promise<Record<string, unknown> | undefined> {
  switch (method) {
    case "initialize": {
      const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return {
        protocolVersion: typeof asked === "string" ? asked : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name, version },
      };
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;
    case "ping":
      return {};
    case "tools/list":
      // No tools yet — the orchestration SDK fills this in.
      return { tools: [] };
    case "tools/call":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: "no_tools",
              reason: `${name} exposes no tools yet`,
            }),
          },
        ],
        isError: true,
      };
    default:
      throw new MethodNotFoundError(`${method} is not a method this server implements`);
  }
}
