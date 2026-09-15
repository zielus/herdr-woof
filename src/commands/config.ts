import { parseArgs } from "node:util";

import { resolveConfiguration } from "../config/resolve.js";
import { isId } from "../contracts/envelope.js";
import { UsageError, parse } from "./common.js";

export const CONFIG_SHOW_USAGE = `Usage: woof config show [--project <dir>] [--workflow <name>]

Prints the effective Woof configuration as one JSON line: every role, limit and
setting with its source (flag, project, user or builtin), the file that set it
and the values it shadows. The project is the git top level of --project (default:
the working directory); only <project>/.woof and ~/.woof are read. Workflow
modules are never loaded. Exits 0 with {"outcome":"config"}, 2 with a rejection
(config_invalid, config_conflict, setting_scope_invalid, role_invalid,
workflow_not_found), 1 on usage errors.`;

export async function configCommand(args: string[]): Promise<number> {
  if (args[0] !== "show") throw new UsageError(`expected "config show"\n\n${CONFIG_SHOW_USAGE}`);
  const { values } = parse(
    () =>
      parseArgs({
        args: args.slice(1),
        strict: true,
        allowPositionals: false,
        options: {
          project: { type: "string" },
          workflow: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      }),
    CONFIG_SHOW_USAGE,
  );
  if (values.help === true) {
    console.log(CONFIG_SHOW_USAGE);
    return 0;
  }
  if (values.workflow !== undefined && !isId(values.workflow))
    throw new UsageError(`--workflow must be a valid id\n\n${CONFIG_SHOW_USAGE}`);
  const resolved = await resolveConfiguration({
    ...(values.project !== undefined ? { projectDir: values.project } : {}),
    flags: values.workflow !== undefined ? { workflow: values.workflow } : {},
  });
  if (resolved.ok) {
    console.log(JSON.stringify({ outcome: "config", configuration: resolved.configuration }));
    return 0;
  }
  console.log(
    JSON.stringify({
      outcome: "rejected",
      reason: resolved.reason,
      message: resolved.message,
      details: resolved.details,
      ...(resolved.configuration !== undefined ? { configuration: resolved.configuration } : {}),
    }),
  );
  return 2;
}
