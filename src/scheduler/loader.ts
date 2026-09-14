import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { RejectionDetail } from "../contracts/envelope.js";
import { validateWorkflowDefinition, type WorkflowDefinition } from "./definition.js";

/**
 * Loads an ES module's default export: compiled `.js`/`.mjs`, or `.ts` through
 * Node's built-in type stripping (erasable syntax only; Node does not strip
 * files under node_modules). Loading executes the module's code.
 */

export type LoadReason =
  | "definition_not_found"
  | "definition_syntax_unsupported"
  | "definition_load_failed"
  | "definition_invalid";

export type LoadModuleResult =
  | { ok: true; value: unknown; path: string }
  | { ok: false; reason: Exclude<LoadReason, "definition_invalid">; message: string };

export type LoadDefinitionResult<Input = unknown> =
  | { ok: true; definition: WorkflowDefinition<Input>; path: string }
  | { ok: false; reason: LoadReason; message: string; details: RejectionDetail[] };

export async function loadModuleDefault(path: string): Promise<LoadModuleResult> {
  const absolute = resolve(path);
  try {
    if (!statSync(absolute).isFile()) {
      return { ok: false, reason: "definition_not_found", message: `${absolute} is not a file` };
    }
  } catch (error) {
    return {
      ok: false,
      reason: "definition_not_found",
      message: `${absolute} cannot be read: ${(error as Error).message}`,
    };
  }
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX" ||
      code === "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING"
    ) {
      return {
        ok: false,
        reason: "definition_syntax_unsupported",
        message: `${absolute}: ${(error as Error).message} (definitions may use only erasable TypeScript syntax)`,
      };
    }
    return {
      ok: false,
      reason: "definition_load_failed",
      message: `${absolute} failed to load: ${code !== undefined ? `${code}: ` : ""}${(error as Error).message}`,
    };
  }
  return { ok: true, value: loaded["default"], path: absolute };
}

export async function loadWorkflowDefinition<Input = unknown>(
  path: string,
): Promise<LoadDefinitionResult<Input>> {
  const loaded = await loadModuleDefault(path);
  if (!loaded.ok) return { ...loaded, details: [] };
  if (loaded.value === undefined) {
    return {
      ok: false,
      reason: "definition_invalid",
      message: `${loaded.path} has no default export`,
      details: [
        { field: "default", message: "the module must export a workflow definition as default" },
      ],
    };
  }
  const validated = validateWorkflowDefinition<Input>(loaded.value);
  if (!validated.ok) {
    return {
      ok: false,
      reason: "definition_invalid",
      message: `${loaded.path} does not export a valid workflow definition`,
      details: validated.details,
    };
  }
  return { ok: true, definition: validated.definition, path: loaded.path };
}
