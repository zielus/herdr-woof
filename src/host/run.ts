import { writeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  admissionConfiguration,
  builtinWorkflowDefinition,
  recordConfiguration,
} from "../config/record.js";
import { resolveConfiguration, type ConfigFlags } from "../config/resolve.js";
import { INFRA_REASONS } from "../contracts/reasons.js";
import type { RunPlan } from "../domain/types.js";
import type { RuntimeAdapter } from "../runtime/adapter.js";
import { admitWorkflow, openAdmittedRun } from "../scheduler/admission.js";
import type { Action } from "../scheduler/core.js";
import { validateWorkflowDefinition, type WorkflowDefinition } from "../scheduler/definition.js";
import { runWorkflow } from "../scheduler/driver.js";
import { loadWorkflowDefinition } from "../scheduler/loader.js";
import { readSnapshot } from "../state/snapshot.js";
import { claimHost } from "./claim.js";
import { writeExclusiveFile } from "./files.js";
import { createCoalescer, createMetadataReporter } from "./metadata.js";

/**
 * Hosting one workflow run in this process (p4 §3.5, §3.7): resolve
 * configuration once, load the definition once, admit, record the resolved
 * configuration with the run, claim the run and drive the scheduler to the
 * end. `woof run host` (in a Herdr pane), `woof run start --host foreground`
 * and `woof run build-review` all use it. Nothing here reads `.woof/` after
 * the run opens: the scheduler reads only the journal snapshot.
 */

export const OUTCOME_FILE = "outcome.json";

export const OUTCOME_EXIT_CODES = { completed: 0, failed: 4, exhausted: 5, cancelled: 6 } as const;

/** Reasons that exit 3: the run directory, journal, runtime or host failed, not the request. */
const HOST_INFRA_REASONS: ReadonlySet<string> = new Set([
  ...INFRA_REASONS,
  "runtime_unavailable",
  "host_claim_failed",
  "host_not_started",
  "host_unresponsive",
  "host_pane_failed",
  "launch_invalid",
  "journal_unavailable",
  "engine_invariant",
  "runtime_cleanup_failed",
  "host_interrupted",
]);

export function isHostInfraReason(reason: string): boolean {
  return HOST_INFRA_REASONS.has(reason);
}

export interface RuntimeContext {
  runDir: string;
  runId: string;
  plan: RunPlan;
  repo: string;
}

export type RuntimeFactory = (
  context: RuntimeContext,
) => Promise<{ ok: true; runtime: RuntimeAdapter } | { ok: false; message: string }>;

export interface HostWorkflowOptions {
  /** Absolute run directory. */
  runDir: string;
  runId: string;
  /** Workflow name flag; configuration decides otherwise. */
  workflow?: string;
  /** Project directory for configuration discovery; null for no project scope. */
  projectDir: string | null;
  /** The caller's raw workflow input; admission validates it. */
  input: unknown;
  flags: ConfigFlags;
  createRuntime: RuntimeFactory;
  submitCommand: readonly string[];
  /**
   * Claim the run just before it opens (foreground). A pane host claims
   * before reading its launch request and passes `release` instead.
   */
  claimBeforeOpen: boolean;
  release?: (exitCode: number) => void;
  /** Write `outcome.json` (the printed line) before releasing the claim. */
  writeOutcome: boolean;
  paneId: string | null;
  workspaceId: string | null;
  /** Herdr metadata projection; null outside a Herdr pane. */
  metadata: { bin: string; env: NodeJS.ProcessEnv; hostPaneId: string } | null;
  homeDir?: string;
  log: (line: string) => void;
}

export interface HostWorkflowResult {
  code: number;
  output: Record<string, unknown>;
}

/**
 * Every exit path of a claimed host goes through one finalizer. The first
 * result is authoritative: `outcome.json` (pane host) and the returned result
 * both carry it, whatever happens after. Writing the outcome and releasing the
 * claim are separate one-time steps; a release that throws is logged, never
 * replaces the result, and is attempted once more on the way out. Signal
 * handlers are installed on entry, so a pane host (which claimed before
 * calling this) is covered from its first await. A first SIGINT/SIGTERM before
 * the run starts opening finalizes synchronously with `host_interrupted` (exit
 * code 130) and exits at once, since a pending load or runtime factory never
 * observes an abort. After the run starts opening, a first signal cancels and
 * the scheduler records the cancellation; a second signal finalizes
 * synchronously and exits without waiting for the runtime to settle.
 */
export async function hostWorkflow(options: HostWorkflowOptions): Promise<HostWorkflowResult> {
  const { runDir, runId, log } = options;
  let release = options.release;
  let result: HostWorkflowResult | undefined;
  let outcomeWritten = false;
  let released = false;
  let opening = false;
  let reportTimer: NodeJS.Timeout | undefined;
  const releaseClaim = (code: number) => {
    if (released || release === undefined) return;
    try {
      release(code);
      released = true;
    } catch (error) {
      log(`cannot release the run host claim: ${(error as Error).message}`);
    }
  };
  const finish = (code: number, output: Record<string, unknown>): HostWorkflowResult => {
    result ??= { code, output };
    if (options.writeOutcome && release !== undefined && !outcomeWritten) {
      outcomeWritten = true;
      try {
        writeExclusiveFile(
          join(runDir, OUTCOME_FILE),
          Buffer.from(`${JSON.stringify(result.output)}\n`, "utf8"),
          0o444,
        );
      } catch (error) {
        log(`cannot write ${OUTCOME_FILE}: ${(error as Error).message}`);
      }
    }
    releaseClaim(result.code);
    return result;
  };
  const interrupted = (message: string) =>
    finish(130, { outcome: "rejected", reason: "host_interrupted", message, details: [] });

  const controller = new AbortController();
  let signals = 0;
  const onSignal = () => {
    signals += 1;
    if (result !== undefined) return;
    if (!opening || signals > 1) {
      log(
        opening
          ? "second signal: exiting without waiting for the run to settle"
          : "signal before the run opened: exiting",
      );
      const final = interrupted(
        opening
          ? "the run host received a second signal and exited without waiting for the run to settle"
          : `the run host received a signal before run ${runId} opened; no run was started`,
      );
      // process.exit skips the caller's print: the result line is written here, synchronously.
      try {
        writeSync(1, `${JSON.stringify(final.output)}\n`);
      } catch {
        // stdout is gone; outcome.json and the exit code still carry the result.
      }
      process.exit(130);
    }
    log("cancelling the run (send the signal again to exit without waiting)");
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await host();
  } catch (error) {
    return finish(3, {
      outcome: "rejected",
      reason: "engine_invariant",
      message: `the run host failed: ${(error as Error).message}`,
      details: [],
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (reportTimer !== undefined) clearInterval(reportTimer);
    releaseClaim(result?.code ?? 3);
  }

  async function host(): Promise<HostWorkflowResult> {
    const reject = (reason: string, message: string, details: unknown[] = []) =>
      finish(isHostInfraReason(reason) ? 3 : 2, { outcome: "rejected", reason, message, details });

    const resolved = await resolveConfiguration({
      projectDir: options.projectDir,
      flags: {
        ...options.flags,
        ...(options.workflow !== undefined ? { workflow: options.workflow } : {}),
      },
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    });
    if (!resolved.ok) return reject(resolved.reason, resolved.message, resolved.details);
    const configuration = resolved.configuration;
    const workflow = configuration.workflow;
    if (workflow === null) return reject("workflow_not_found", "no workflow resolved");

    // The definition is loaded once, here; a project module's body runs only in this process.
    let definition: WorkflowDefinition<unknown>;
    if (workflow.source === "builtin") {
      const validated = validateWorkflowDefinition(builtinWorkflowDefinition(workflow.value.name));
      if (!validated.ok)
        return reject(
          "definition_invalid",
          "the built-in definition is invalid",
          validated.details,
        );
      definition = validated.definition;
    } else {
      const path = workflow.path as string;
      const loaded = await loadWorkflowDefinition(path);
      if (!loaded.ok) return reject(loaded.reason, loaded.message, loaded.details);
      if (loaded.definition.name !== workflow.value.name) {
        const message = `${path} defines workflow ${loaded.definition.name}, but its file name makes it ${workflow.value.name}`;
        return reject("config_invalid", message, [{ field: path, message }]);
      }
      definition = loaded.definition;
    }

    const admitted = await admitWorkflow({
      definition,
      input: options.input,
      runDir,
      configuration: admissionConfiguration(configuration),
    });
    if (!admitted.ok) return reject(admitted.reason, admitted.message, admitted.details);
    const recorded = recordConfiguration(configuration, admitted, {
      definitionVersion: definition.version,
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    });

    const runtime = await options.createRuntime({
      runDir,
      runId,
      plan: admitted.plan,
      repo: admitted.repository,
    });
    if (!runtime.ok) return reject("runtime_unavailable", runtime.message);

    if (options.claimBeforeOpen) {
      const claim = claimHost(runDir, { paneId: options.paneId, workspaceId: options.workspaceId });
      if (!claim.ok) {
        return finish(claim.reason === "run_host_claimed" ? 2 : 3, {
          outcome: "rejected",
          reason: claim.reason,
          message: claim.message,
          details: [],
        });
      }
      release = claim.release;
    }

    // From here a signal cancels through the scheduler: the journal may already be written.
    opening = true;
    const opened = await openAdmittedRun(admitted, { runDir, runId, configuration: recorded });
    if (opened.outcome === "rejected") return reject(opened.reason, opened.message, opened.details);
    for (const warning of recorded.warnings)
      log(
        `warning ${warning.code}: ${warning.message}${warning.path !== undefined ? ` (${warning.path})` : ""}`,
      );

    const pollMs = recorded.settings.pollMs.value;
    const reporter =
      options.metadata === null
        ? null
        : createMetadataReporter({
            ...options.metadata,
            workflow: definition.name,
            runId,
            log,
          });
    // At most one report is in flight; ticks meanwhile coalesce into one follow-up that reads the
    // latest snapshot, so a slow or unavailable Herdr never builds a queue (PR #6).
    const refresh =
      reporter === null
        ? null
        : createCoalescer(async () => {
            const snapshot = readSnapshot(runDir);
            if (snapshot.ok) await reporter.report(snapshot.snapshot);
          });
    refresh?.request();
    reportTimer =
      refresh === null ? undefined : setInterval(() => refresh.request(), Math.min(pollMs, 1000));
    reportTimer?.unref();

    log(`run ${runId} in ${runDir}`);
    let lastWait = "";
    const out = await runWorkflow({
      runDir,
      definition,
      input: admitted.input,
      repository: admitted.repository,
      runtime: runtime.runtime,
      submitCommand: options.submitCommand,
      signal: controller.signal,
      pollMs,
      keepPanes: recorded.settings.keepPanes.value,
      onAction: (action) => {
        const line = describeAction(action);
        if (action.type === "wait" && line === lastWait) return;
        lastWait = action.type === "wait" ? line : "";
        log(line);
      },
    });
    if (reportTimer !== undefined) clearInterval(reportTimer);
    if (reporter !== null) {
      // Bounded: the report in flight (each Herdr call is capped) and then the final one.
      await refresh?.drain();
      const final = readSnapshot(runDir);
      if (final.ok) await reporter.finish(final.snapshot);
    }

    if (out.error !== null || out.result === null) {
      return finish(3, {
        outcome: "rejected",
        reason: out.error?.reason ?? "engine_invariant",
        message: out.error?.message ?? "the run ended without a result",
        details: [],
        result: out.result,
      });
    }
    return finish(OUTCOME_EXIT_CODES[out.result.outcome], { outcome: "run", result: out.result });
  }
}

/** Waits for `predicate` in 100 ms steps up to `timeoutMs`; returns whether it held. */
export async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    // Polling a file-based condition is sequential by design.
    // oxlint-disable-next-line no-await-in-loop
    await delay(100);
  }
  return true;
}

export function describeAction(action: Action): string {
  switch (action.type) {
    case "wait":
      return `waiting (${action.reason}${action.observe !== null ? `, ${action.observe}` : ""})`;
    case "dispatch":
      return `dispatch ${action.stageId} visit ${action.visit} attempt ${action.attempt} (${action.cause}) to ${action.agentId}`;
    case "terminate":
      return `terminate ${action.outcome}${action.limit !== undefined ? ` (${action.limit})` : ""}: ${action.reason}`;
    case "record_gate":
      return `gate ${action.gate.gate} ${action.gate.decision} (${action.gate.reason})`;
    case "start_agent":
    case "block":
    case "unblock":
      return `${action.type.replace("_", " ")} ${action.agentId}`;
    case "run_check":
      return `check ${action.gate}: ${action.argv.join(" ")}`;
    case "compute_revision":
      return `revision for ${action.gate}`;
    case "reconcile":
      return `reconcile ${action.stageId} attempt ${action.attempt}: ${action.resolution}`;
    case "settle":
      return "run ended";
  }
}
