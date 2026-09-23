import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  admissionConfiguration,
  builtinWorkflowDefinition,
  recordConfiguration,
} from "../config/record.js";
import { resolveConfiguration, type ConfigFlags } from "../config/resolve.js";
import { isId } from "../contracts/envelope.js";
import { admitWorkflow, openAdmittedRun } from "../scheduler/admission.js";
import type { ChildEnd } from "../scheduler/core.js";
import { validateWorkflowDefinition, type WorkflowDefinition } from "../scheduler/definition.js";
import {
  runWorkflow,
  type ChildHost,
  type ChildOpened,
  type ChildRequest,
} from "../scheduler/driver.js";
import { loadWorkflowDefinition } from "../scheduler/loader.js";
import { recordHostExited } from "../state/store.js";
import { claimHost } from "./claim.js";
import { createHostLog } from "./log.js";
import { readHostInfo } from "./probe.js";
import type { RuntimeFactory } from "./run.js";

/**
 * Child runs of workflow stages, hosted in the parent's process (docs/design/composition.md):
 * one host, one liveness story. A child is an ordinary run in a sibling directory of its
 * parent's (`<runs>/<parentRunId>.<stageId>.<visit>`), with its own journal, locator,
 * `config.json`, `input.json`, `host.log` and host claim held by this same process, so every
 * inspection surface sees it as a run; `run.opened.parent` links it back. It resolves the child
 * workflow through the same configuration layers as `--workflow` (project, user, built-in), is
 * admitted into the parent's checkout (its own checkout handling off), and drives its own
 * scheduler, whose child runs this host hosts in turn.
 */

export interface ChildHostContext {
  /** The parent's project directory and configuration flags: the child resolves the same layers. */
  projectDir: string | null;
  flags: ConfigFlags;
  homeDir?: string;
  createRuntime: RuntimeFactory;
  submitCommand: readonly string[];
  /** The host's pane and workspace, recorded on each child's claim. */
  paneId: string | null;
  workspaceId: string | null;
  /**
   * The workspace of the top run's worktree, where every child's agent tabs go too; null when the
   * run made none (then the runtime uses its own pane's workspace, as for the top run).
   */
  checkoutWorkspaceId: string | null;
  /** The parent host's technical log; each child also writes its own `host.log`. */
  log: (line: string) => void;
}

const JOURNAL_FILE = "journal.jsonl";

function refuse(reason: string, message: string): ChildOpened {
  return { ok: false, reason, message: message.slice(0, 1000) };
}

export function createChildHost(context: ChildHostContext): ChildHost {
  const host: ChildHost = { open: (request) => openChild(context, host, request) };
  return host;
}

async function openChild(
  context: ChildHostContext,
  host: ChildHost,
  request: ChildRequest,
): Promise<ChildOpened> {
  const { parent } = request;
  const runId = `${parent.runId}.${parent.stageId}.${parent.visit}`;
  if (!isId(runId))
    return refuse("input_invalid", `the child run id ${runId} is longer than an id may be`);
  // A sibling of the parent's run directory, so the parent's runs directory lists it too.
  const runDir = join(dirname(parent.runDir), runId);
  if (existsSync(join(runDir, JOURNAL_FILE)))
    return refuse("run_exists", `${runDir} already holds a run`);

  const resolved = await resolveConfiguration({
    projectDir: context.projectDir,
    flags: { ...context.flags, workflow: request.workflow },
    ...(context.homeDir !== undefined ? { homeDir: context.homeDir } : {}),
  });
  if (!resolved.ok) return refuse(resolved.reason, resolved.message);
  const configuration = resolved.configuration;
  const workflow = configuration.workflow;
  if (workflow === null) return refuse("workflow_not_found", `no workflow ${request.workflow}`);
  let definition: WorkflowDefinition<unknown>;
  if (workflow.source === "builtin") {
    const validated = validateWorkflowDefinition(builtinWorkflowDefinition(workflow.value.name));
    if (!validated.ok) return refuse("definition_invalid", "the built-in definition is invalid");
    definition = validated.definition;
  } else {
    const loaded = await loadWorkflowDefinition(workflow.path as string);
    if (!loaded.ok) return refuse(loaded.reason, loaded.message);
    definition = loaded.definition;
  }

  // The checkout is resolved once, at the top: the child works in its parent's.
  const admitted = await admitWorkflow({
    definition,
    input: request.input,
    runDir,
    configuration: admissionConfiguration(configuration),
    checkout: { inherit: { path: request.repository } },
  });
  if (!admitted.ok) {
    const fields = admitted.details.map((detail) => `${detail.field}: ${detail.message}`);
    return refuse(
      admitted.reason,
      `${admitted.message}${fields.length > 0 ? ` (${fields.join("; ")})` : ""}`,
    );
  }
  const recorded = recordConfiguration(configuration, admitted, {
    definitionVersion: definition.version,
    ...(context.homeDir !== undefined ? { homeDir: context.homeDir } : {}),
  });
  const runtime = await context.createRuntime({
    runDir,
    runId,
    plan: admitted.plan,
    repo: admitted.repository,
    workspaceId: context.checkoutWorkspaceId,
  });
  if (!runtime.ok) return refuse("runtime_unavailable", runtime.message);

  const claim = claimHost(runDir, { paneId: context.paneId, workspaceId: context.workspaceId });
  if (!claim.ok) return refuse(claim.reason, claim.message);
  const info = readHostInfo(runDir);
  const opened = await openAdmittedRun(admitted, {
    runDir,
    runId,
    configuration: recorded,
    parent: { ...parent },
    ...(info?.pid === process.pid &&
    info.hostname !== null &&
    info.startedAt !== null &&
    info.heartbeatMs !== null
      ? {
          host: {
            pid: info.pid,
            hostname: info.hostname,
            startedAt: info.startedAt,
            heartbeatMs: info.heartbeatMs,
            paneId: info.paneId,
            workspaceId: info.workspaceId,
          },
        }
      : {}),
  });
  if (opened.outcome === "rejected") {
    claim.release(3);
    return refuse(opened.reason, opened.message);
  }
  const input = opened.record.input;
  const log = createHostLog(runDir, { echo: false });
  context.log(`child run ${runId} (${definition.name} v${definition.version}) in ${runDir}`);
  log(
    `run ${runId} in ${runDir}, a workflow step of run ${parent.runId} (${parent.stageId} visit ${parent.visit})`,
  );

  const done = (async (): Promise<ChildEnd> => {
    let end: ChildEnd;
    let exitCode = 3;
    try {
      const out = await runWorkflow({
        runDir,
        definition,
        input: admitted.input,
        repository: admitted.repository,
        runtime: runtime.runtime,
        submitCommand: context.submitCommand,
        signal: request.signal,
        pollMs: recorded.settings.pollMs.value,
        keepPanes: recorded.settings.keepPanes.value,
        children: host,
        onAction: (action) => {
          if (action.type !== "wait")
            log(`${action.type}${"stageId" in action ? ` ${action.stageId}` : ""}`);
        },
        onWarning: (warning) =>
          log(`warning: ${warning.record}: ${warning.reason}: ${warning.message}`),
      });
      end = {
        result: out.result,
        error: out.error === null ? null : `${out.error.reason}: ${out.error.message}`,
      };
      // An infrastructure error (an unstopped pane) exits 3 like a top-level host, whatever the outcome.
      if (out.result !== null && out.error === null)
        exitCode = { completed: 0, failed: 4, exhausted: 5, cancelled: 6 }[out.result.outcome];
    } catch (error) {
      end = { result: null, error: `engine_invariant: ${(error as Error).message}` };
    }
    try {
      await recordHostExited({
        runDir,
        pid: process.pid,
        exitCode,
        reason: (end.result?.outcome ?? `rejected:${end.error ?? "unknown"}`).slice(0, 500),
      });
    } catch (error) {
      log(`cannot journal host.exited: ${(error as Error).message}`);
    }
    claim.release(exitCode);
    log(`run ended: ${end.result?.outcome ?? end.error ?? "unknown"}`);
    return end;
  })();

  return {
    ok: true,
    runId,
    runDir,
    workflow: { name: definition.name, version: definition.version },
    input: { sha256: input?.sha256 ?? "", bytes: input?.bytes ?? 0 },
    done,
  };
}
