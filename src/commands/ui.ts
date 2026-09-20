import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { resolveConfiguration } from "../config/resolve.js";
import { DEFAULT_UI_PORT, startWebServer } from "../web/server.js";
import { MISSING_SPA_MESSAGE } from "../web/static.js";
import { milliseconds, rejected, UsageError, parse } from "./common.js";

export const UI_USAGE = `Usage: woof ui [--port <n>] [--host <addr>] [--runs-dir <dir>] [--token <secret>]
              [--allow-host <name>] [--allow-origin <origin>] [--poll-ms <n>] [--no-open]

Serves the run dashboard and its inspection API over the same runs directory
woof runs lists (--runs-dir, else the user setting defaults.runsDir, else
~/.woof/runs). Binds 127.0.0.1:${DEFAULT_UI_PORT} by default and opens a browser unless
--no-open.

The API is not read-only: every route but one is a read, and cancel records
run.terminated{outcome:"cancelled"} through the same call woof run cancel makes.

Every request must name an allowed Host, and every action must carry an Origin
equal to this server's own (scheme, host and port) or one given with
--allow-origin, which is repeatable and is how the Vite dev server on :5173 and
an HTTPS proxy in front of this server are admitted. --host beyond loopback is
refused without --token (at least 16 characters), which is then required on
every /api/ request as Authorization: Bearer or, for the event stream, ?token=.
The printed URL carries the token in the fragment, which is never sent to a
server. --allow-host adds a name requests may use, such as a Tailscale name in
front of the bind address.

Prints one JSON line once it is listening and then keeps running until it is
interrupted. Exits 0 on interrupt, 2 when the user configuration is invalid,
3 when the address cannot be bound or the bind was refused.`;

export async function uiCommand(args: string[]): Promise<number> {
  const { values } = parse(
    () =>
      parseArgs({
        args,
        strict: true,
        allowPositionals: false,
        options: {
          port: { type: "string" },
          host: { type: "string" },
          "runs-dir": { type: "string" },
          token: { type: "string" },
          "allow-host": { type: "string", multiple: true },
          "allow-origin": { type: "string", multiple: true },
          "poll-ms": { type: "string" },
          "no-open": { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      }),
    UI_USAGE,
  );
  if (values.help === true) {
    console.log(UI_USAGE);
    return 0;
  }
  const port = values.port === undefined ? DEFAULT_UI_PORT : portNumber(values.port);
  const pollMs =
    values["poll-ms"] === undefined
      ? 250
      : milliseconds(values["poll-ms"], "--poll-ms", 20, 60_000);
  if (values.token === "") throw new UsageError(`--token must not be empty\n\n${UI_USAGE}`);
  if (values.host === "") throw new UsageError(`--host must not be empty\n\n${UI_USAGE}`);

  let runsDir: string;
  if (values["runs-dir"] !== undefined) {
    runsDir = resolve(values["runs-dir"]);
  } else {
    // The runs directory is a user setting, exactly as woof runs resolves it.
    const resolved = await resolveConfiguration({ projectDir: null });
    if (!resolved.ok) {
      return rejected(resolved.reason, resolved.message, resolved.details, 2);
    }
    runsDir = resolved.configuration.settings.runsDir.value;
  }

  let server;
  try {
    server = await startWebServer({
      runsDir,
      port,
      pollMs,
      ...(values.host !== undefined ? { host: values.host } : {}),
      ...(values.token !== undefined ? { token: values.token } : {}),
      ...(values["allow-host"] !== undefined ? { allowHosts: values["allow-host"] } : {}),
      ...(values["allow-origin"] !== undefined ? { allowOrigins: values["allow-origin"] } : {}),
    });
  } catch (error) {
    return rejected("ui_listen_failed", (error as Error).message, [], 3);
  }

  console.log(
    JSON.stringify({
      outcome: "listening",
      url: server.url,
      host: server.host,
      port: server.port,
      runsDir: server.runsDir,
      distUiDir: server.distUiDir,
      spa: server.spa,
    }),
  );
  if (!server.spa) console.error(`woof ui: ${MISSING_SPA_MESSAGE}`);
  if (values["no-open"] !== true && server.spa) openBrowser(server.url);

  await new Promise<void>((done) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void server.close().then(done, done);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

function portNumber(value: string): number {
  if (!/^(0|[1-9][0-9]{0,4})$/.test(value) || Number(value) > 65_535) {
    throw new UsageError(`--port must be an integer between 0 and 65535\n\n${UI_USAGE}`);
  }
  return Number(value);
}

/** Opens the URL in the operator's browser. A failure is reported, never fatal. */
function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true });
    child.on("error", (error) => {
      console.error(`woof ui: cannot open a browser with ${command}: ${error.message}`);
    });
    child.unref();
  } catch (error) {
    console.error(`woof ui: cannot open a browser with ${command}: ${(error as Error).message}`);
  }
}
