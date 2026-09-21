import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { Limits } from "../domain/types.js";
import { acceptedCopyProblem, hashFile } from "../journal/accepted-copy.js";
import type { LockOptions } from "../journal/lock.js";
import type { AgentHandle, LifecycleObservation, RuntimeAdapter } from "../runtime/adapter.js";
import { herdrRuntimeName } from "../runtime/names.js";
import { ObservationTracker } from "../runtime/tracker.js";
import { deriveRunResult, type RunResult } from "../state/result.js";
import { readSnapshot, type RunSnapshot } from "../state/snapshot.js";
import {
  assignAgent,
  blockRun,
  cancelRun,
  reconcileDelivery,
  recordDispatch,
  recordGate,
  recordObservationLost,
  recordObservationRecovered,
  terminateRun,
  unblockRun,
  type StoreOutcome,
} from "../state/store.js";
import { openAttempt } from "../submission/attempt.js";
import { runCheck } from "./check.js";
import {
  acceptedRefOf,
  attemptOf,
  decide,
  emptyRuntimeView,
  historyOf,
  latestCheckEvidence,
  type Action,
  type AgentRuntimeView,
  type GateEvidence,
} from "./core.js";
import { agentStageOf, type WorkflowDefinition } from "./definition.js";
import { writeEngineFile } from "./files.js";
import { renderRequest, type ResolvedInput } from "./request.js";
import { revisionOf, type RevisionResult } from "./revision.js";

/**
 * Effectful scheduler driver (D1): a foreground loop that reads the run
 * snapshot, asks the pure core for one action and executes it through the
 * runtime adapter, the state store and `openAttempt`. It never appends journal
 * records itself, never sends a second request for an attempt and never reads
 * terminal output. The run must already be opened with a plan.
 *
 * runTimeoutMs bounds waiting, not appending: every blocking runtime or check
 * call and every non-terminal journal-lock acquisition is capped to the
 * remaining budget, and an expired budget ends the run as
 * `exhausted{runTimeoutMs}` before the next write or delivery. A store append
 * whose lock was acquired within the budget is not interrupted and may complete
 * after the deadline; the driver re-checks the deadline after it returns (for
 * `openAttempt`, before the request file is created and before delivery). The
 * terminating record itself uses the full lock timeout.
 */

export interface RunWorkflowOptions<Input> {
  /** Run directory holding a journal opened with the workflow's plan. */
  runDir: string;
  definition: WorkflowDefinition<Input>;
  /** Input already validated by the definition. */
  input: Input;
  /** The repository admission resolved (`AdmissionResult.repository`, the git top level). */
  repository: string;
  runtime: RuntimeAdapter;
  /** Command that runs `woof`, placed before `submit` in worker requests. */
  submitCommand: readonly string[];
  signal?: AbortSignal;
  /**
   * What aborting `signal` stands for on the journaled `run.cancel_requested`
   * (default "abort_signal"); a run host that aborts on SIGINT/SIGTERM passes "signal".
   */
  cancelSource?: "signal" | "abort_signal";
  /** Sleep between ticks that wait (default 1000 ms). */
  pollMs?: number;
  /** Leave agent panes open when the run ends. */
  keepPanes?: boolean;
  clock?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called with every action before it runs (progress reporting). */
  onAction?: (action: Action) => void;
  lock?: LockOptions;
}

export interface RunWorkflowResult {
  /** The terminal outcome; null only when the journal could not be read or written. */
  result: RunResult | null;
  error: {
    /** `runtime_cleanup_failed`: the run ended, but an owned pane could not be stopped. */
    reason:
      "journal_unavailable" | "journal_corrupt" | "engine_invariant" | "runtime_cleanup_failed";
    message: string;
  } | null;
  stats: { ticks: number; maxSnapshotMs: number; dropped: { stale: number; duplicate: number } };
}

const JOURNAL_ATTEMPTS = 3;
/** The journal lock's own default acquisition timeout. */
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 10_000;
const HERDR_START_CAP_MS = 300_000;
/** Herdr refuses an `agent start --timeout` of 3000 ms or less. */
const HERDR_MIN_START_TIMEOUT_MS = 3001;
/** Upper bound for one observe or pane split, matching the Herdr adapter's default command timeout. */
const ADAPTER_COMMAND_CAP_MS = 10_000;
/** Consecutive observe timeouts that fail the run as a runtime error. */
const OBSERVE_TIMEOUT_LIMIT = 3;

type Written<T> =
  | { ok: true; value: T }
  | { ok: false; closed: true }
  | { ok: false; closed: false; reason: string; message: string };

export async function runWorkflow<Input>(
  options: RunWorkflowOptions<Input>,
): Promise<RunWorkflowResult> {
  const { definition, runtime } = options;
  // One absolute canonical run directory for every path the run produces (results, requests, env).
  const runDir = canonicalDirectory(options.runDir);
  const clock = options.clock ?? Date.now;
  const pollMs = options.pollMs ?? 1000;
  const sleep =
    options.sleep ??
    (async (ms: number, signal?: AbortSignal) => {
      try {
        await delay(ms, undefined, signal !== undefined ? { signal } : {});
      } catch {
        // Aborted: the next tick sees the signal.
      }
    });
  const lock = options.lock !== undefined ? { lock: options.lock } : {};
  const tracker = new ObservationTracker();
  const agents: Record<string, AgentRuntimeView> = Object.create(null);
  const stats = { ticks: 0, maxSnapshotMs: 0, dropped: tracker.dropped };
  let evidence: GateEvidence | null = null;
  /** Consecutive observe timeouts per agent; any successful observation resets it. */
  const observeTimeouts: Record<string, number> = Object.create(null);
  /** Seq of the unresolved observation.lost this scheduler journaled, per agent. */
  const observationLost: Record<string, number> = Object.create(null);
  /** openedAt + runTimeoutMs, known after the first snapshot read. */
  let deadlineAt: number | null = null;
  let observeNext: string | null = null;
  // Admission's resolved repository; the definition's `repository(input)` is never called again.
  const repository = options.repository;

  const read = (): { ok: true; snapshot: RunSnapshot } | { ok: false; message: string } => {
    const started = performance.now();
    const result = readSnapshot(runDir);
    stats.maxSnapshotMs = Math.max(stats.maxSnapshotMs, performance.now() - started);
    return result.ok ? result : { ok: false, message: `${result.reason}: ${result.message}` };
  };

  const viewOf = (agentId: string): AgentRuntimeView => {
    let view = agents[agentId];
    if (view === undefined) {
      view = emptyRuntimeView();
      agents[agentId] = view;
    }
    return view;
  };

  const accept = (view: AgentRuntimeView, observation: LifecycleObservation) => {
    const tracked = tracker.accept(observation);
    if (tracked.kind === "stale") return;
    if (tracked.kind === "replaced") view.replaced = true;
    const previous = view.last;
    if (observation.lifecycle === "ready") {
      view.readyStreak =
        previous?.lifecycle === "ready" &&
        previous.order.stateChangeSeq === observation.order.stateChangeSeq
          ? view.readyStreak + 1
          : 1;
    } else {
      view.readyStreak = 0;
    }
    if (
      (observation.lifecycle === "working" || observation.lifecycle === "blocked") &&
      (view.handle?.terminalId === null ||
        observation.order.terminalId === null ||
        observation.order.terminalId === view.handle?.terminalId)
    ) {
      view.activitySinceDispatch = true;
    }
    view.last = observation;
  };

  const write = async <T>(
    call: () => Promise<StoreOutcome<T> | { outcome: string; reason?: string; message?: string }>,
  ): Promise<Written<T>> => {
    let last: { reason: string; message: string } = {
      reason: "journal_busy",
      message: "journal busy",
    };
    for (let attempt = 0; attempt < JOURNAL_ATTEMPTS; attempt += 1) {
      // Retrying a refused write is not a resend: nothing was recorded.
      // oxlint-disable-next-line no-await-in-loop
      const outcome = await call();
      if (outcome.outcome !== "rejected") return { ok: true, value: outcome as unknown as T };
      const reason = String((outcome as { reason: string }).reason);
      const message = String((outcome as { message: string }).message);
      if (reason === "run_closed") return { ok: false, closed: true };
      last = { reason, message };
      if (reason !== "journal_busy") break;
    }
    return { ok: false, closed: false, ...last };
  };

  const settle = async (): Promise<RunWorkflowResult> => {
    const cleanup: string[] = [];
    if (options.keepPanes !== true) {
      for (const view of Object.values(agents)) {
        // An agent last observed gone has no pane left to close.
        if (view.handle === null || view.last?.lifecycle === "gone") continue;
        // oxlint-disable-next-line no-await-in-loop
        const stopped = await runtime.stop(view.handle, { timeoutMs: STOP_TIMEOUT_MS });
        if (!stopped.ok) {
          cleanup.push(
            `${view.handle.runtimeName} (pane ${view.handle.paneId}): ${stopped.error.code}: ${stopped.error.message}`,
          );
        }
      }
    }
    const final = read();
    if (!final.ok) {
      return { result: null, error: { reason: "journal_corrupt", message: final.message }, stats };
    }
    if (final.snapshot.outcome === null) {
      return {
        result: null,
        error: { reason: "engine_invariant", message: "the run ended without run.terminated" },
        stats,
      };
    }
    return {
      result: deriveRunResult(final.snapshot, { runDir, repository }),
      // The recorded outcome stands; a pane that could not be closed is an infrastructure error.
      error:
        cleanup.length === 0
          ? null
          : {
              reason: "runtime_cleanup_failed",
              message: `could not stop ${cleanup.join("; ")}`.slice(0, 2000),
            },
      stats,
    };
  };

  /** A refused write that is neither run_closed nor retryable ends the loop. */
  const fatal = async (failure: {
    reason: string;
    message: string;
  }): Promise<RunWorkflowResult> => {
    const unavailable =
      failure.reason === "journal_busy" || failure.reason === "journal_write_failed";
    const reason = unavailable ? "journal_unavailable" : "engine_invariant";
    await terminateRun({
      runDir,
      outcome: "failed",
      reason: `${reason}: ${failure.reason}: ${failure.message}`.slice(0, 500),
      ...lock,
    }).catch(() => undefined);
    const settled = await settle();
    return { ...settled, error: { reason, message: `${failure.reason}: ${failure.message}` } };
  };

  const end = async (
    outcome: "failed" | "exhausted",
    reason: string,
    limit?: keyof Limits,
  ): Promise<Written<unknown>> =>
    write(() =>
      terminateRun({
        runDir,
        outcome,
        reason: reason.slice(0, 500),
        ...(limit !== undefined ? { limit } : {}),
        ...lock,
      }),
    );

  /** Milliseconds left of runTimeoutMs; no blocking runtime or check call waits longer. */
  const remainingMs = (snapshot: RunSnapshot): number =>
    snapshot.limits === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(snapshot.openedAt) + snapshot.limits.runTimeoutMs - clock();
  /** Callers check `expired` first: an expired budget is never turned into a positive timeout. */
  const capped = (snapshot: RunSnapshot, ms: number): number =>
    Math.floor(Math.min(ms, remainingMs(snapshot)));
  const expired = (snapshot: RunSnapshot): boolean => remainingMs(snapshot) <= 0;
  /**
   * Lock options for the driver's non-terminal store writes: acquisition waits at
   * most the remaining run budget. Terminations keep the full lock timeout, so the
   * run-timeout outcome itself can still be recorded after the deadline.
   */
  const lockWithin = (snapshot: RunSnapshot): { lock: LockOptions } => ({
    lock: {
      ...options.lock,
      timeoutMs: Math.max(
        1,
        Math.floor(
          Math.min(options.lock?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, remainingMs(snapshot)),
        ),
      ),
    },
  });
  /** A capped effect that reached the run deadline ends the run as run-timeout exhaustion. */
  const runTimedOut = (snapshot: RunSnapshot): Promise<Written<unknown>> =>
    end(
      "exhausted",
      `the run exceeded runTimeoutMs (${String(snapshot.limits?.runTimeoutMs)} ms)`,
      "runTimeoutMs",
    );

  /** Repository fingerprint bounded by the remaining run budget and the cancel signal. */
  const fingerprint = async (snapshot: RunSnapshot): Promise<RevisionResult> => {
    if (expired(snapshot)) {
      return { ok: false, reason: "timeout", message: "the run budget is spent" };
    }
    const left = remainingMs(snapshot);
    return revisionOf(repository, {
      ...(Number.isFinite(left) ? { timeoutMs: Math.floor(left) } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  };
  /** A timed-out fingerprint is run-timeout exhaustion; an aborted one leaves cancellation to the next tick. */
  const fingerprintFailed = async (
    snapshot: RunSnapshot,
    failure: Extract<RevisionResult, { ok: false }>,
  ): Promise<Written<unknown> | undefined> => {
    if (failure.reason === "aborted") return undefined;
    if (failure.reason === "timeout") return runTimedOut(snapshot);
    return end("failed", `repo_invalid: ${failure.message}`);
  };

  /** A gate subject's canonical accepted copy must still match its acceptance before any gate uses it. */
  const subjectAltered = (
    snapshot: RunSnapshot,
    ref: { stageId: string; visit: number; attempt: number },
  ): string | undefined => {
    const accepted = attemptOf(snapshot, ref)?.accepted;
    if (accepted == null) {
      return `${ref.stageId} visit ${ref.visit} attempt ${ref.attempt} has no accepted artifact`;
    }
    return acceptedCopyProblem(runDir, accepted.artifact);
  };

  /** Engine files (requests, check evidence); a refused or failed write is a run failure, never a throw. */
  const engineFile = (
    relPath: string,
    bytes: Uint8Array,
  ): ({ ok: true } & ReturnType<typeof writeEngineFile>) | { ok: false; reason: string } => {
    try {
      return { ok: true, ...writeEngineFile(runDir, relPath, bytes) };
    } catch (error) {
      return {
        ok: false,
        reason: `engine_file_error: ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  const tick = async (): Promise<RunWorkflowResult | undefined> => {
    stats.ticks += 1;
    if (observeNext !== null) {
      const agentId = observeNext;
      const view = agents[agentId];
      observeNext = null;
      const left = deadlineAt === null ? Number.POSITIVE_INFINITY : deadlineAt - clock();
      // With the run budget gone the observation is skipped; this tick's decision records the timeout.
      if (view?.handle != null && left > 0) {
        const observed = await runtime.observe(view.handle, {
          timeoutMs: Math.floor(Math.min(ADAPTER_COMMAND_CAP_MS, left)),
        });
        if (observed.ok) {
          observeTimeouts[agentId] = 0;
          accept(view, observed.value);
          const lostSeq = observationLost[agentId];
          if (lostSeq !== undefined) {
            // The first successful observation after a journaled loss, never every sample.
            const recovered = await write(() =>
              recordObservationRecovered({
                runDir,
                agentId,
                lostSeq,
                terminalId: observed.value.order.terminalId,
                ...lock,
              }),
            );
            if (!recovered.ok && !recovered.closed) return fatal(recovered);
            delete observationLost[agentId];
          }
        } else {
          view.readyStreak = 0;
          const error = observed.error;
          const timeouts = error.code === "timeout" ? (observeTimeouts[agentId] ?? 0) + 1 : 0;
          observeTimeouts[agentId] = timeouts;
          if (observationLost[agentId] === undefined) {
            // Observation stops being current at the first failed observe of an outage: one record
            // per outage, whether it then recovers or fails the run below.
            const lost = await write<{ record: { seq: number } }>(() =>
              recordObservationLost({
                runDir,
                agentId,
                code: error.code,
                message: error.message.slice(0, 2000),
                terminalId: view.handle?.terminalId ?? null,
                ...lock,
              }),
            );
            if (!lost.ok && !lost.closed) return fatal(lost);
            if (lost.ok) observationLost[agentId] = lost.value.record.seq;
          }
          // A runtime error is a structured failure; a timeout only after consecutive repeats.
          if (error.code !== "timeout" || timeouts >= OBSERVE_TIMEOUT_LIMIT) {
            const ended = await end(
              "failed",
              `runtime_error: ${error.code}: agent ${agentId}: ${error.message}`,
            );
            if (!ended.ok && !ended.closed) return fatal(ended);
            return undefined;
          }
        }
      }
    }
    const snapshotRead = read();
    if (!snapshotRead.ok) {
      return {
        result: null,
        error: { reason: "journal_corrupt", message: snapshotRead.message },
        stats,
      };
    }
    const snapshot = snapshotRead.snapshot;
    if (deadlineAt === null && snapshot.limits !== null) {
      deadlineAt = Date.parse(snapshot.openedAt) + snapshot.limits.runTimeoutMs;
    }
    const action: Action = decide({
      snapshot,
      definition,
      input: options.input,
      runDir,
      agents,
      evidence,
      now: clock(),
      aborted: options.signal?.aborted === true,
    });
    options.onAction?.(action);

    let written: Written<unknown> = { ok: true, value: null };
    switch (action.type) {
      case "settle":
        return settle();

      case "terminate":
        written = await write(() =>
          action.outcome === "cancelled"
            ? // The request and its termination, under one lock. This scheduler is the live host.
              cancelRun({
                runDir,
                source: options.cancelSource ?? "abort_signal",
                reason: action.reason,
                probeHost: false,
                ...lock,
              })
            : terminateRun({
                runDir,
                outcome: action.outcome,
                reason: action.reason,
                ...(action.limit !== undefined ? { limit: action.limit } : {}),
                ...lock,
              }),
        );
        break;

      case "wait": {
        observeNext = action.observe;
        if (action.reason === "awaiting_ready" && action.observe !== null) {
          viewOf(action.observe).awaitingReadySince ??= clock();
        }
        try {
          await sleep(Math.max(0, Math.min(pollMs, remainingMs(snapshot))), options.signal);
        } catch (error) {
          // An abort during the sleep is cancellation, not an engine error: the next tick
          // decides with aborted: true.
          if (options.signal?.aborted !== true) throw error;
        }
        return undefined;
      }

      case "start_agent": {
        const spec = snapshot.agents.find((agent) => agent.agentId === action.agentId);
        const planAgent = { kind: spec?.kind ?? "", args: spec?.args ?? [] };
        const limits = snapshot.limits as Limits;
        if (expired(snapshot)) {
          written = await runTimedOut(snapshot);
          break;
        }
        const paneTimeoutMs = capped(snapshot, ADAPTER_COMMAND_CAP_MS);
        // Every workflow agent gets its own unfocused tab; the agent runs in that tab's root pane.
        const pane = await runtime.openPane({
          placement: "tab",
          label: `woof:${spec?.role ?? action.agentId}`,
          cwd: repository,
          env: { WOOF_RUN_DIR: runDir },
          timeoutMs: paneTimeoutMs,
        });
        const runtimeName = herdrRuntimeName(snapshot.runId, action.agentId);
        // A tab open that timed out on a budget-capped bound, or any open that returns after the
        // deadline, is the run timeout rather than a failed start.
        const paneBudgetTimeout =
          !pane.ok && pane.error.code === "timeout" && paneTimeoutMs < ADAPTER_COMMAND_CAP_MS;
        if (remainingMs(snapshot) <= 0 || paneBudgetTimeout) {
          if (pane.ok) {
            viewOf(action.agentId).handle = handleFor(
              runtime,
              runtimeName,
              planAgent.kind,
              pane.value,
            );
          }
          written = await runTimedOut(snapshot);
          break;
        }
        if (!pane.ok) {
          written = await end(
            "failed",
            `agent_start_failed: ${action.agentId}: ${pane.error.code}: ${pane.error.message}`,
          );
          break;
        }
        if (runtime.adapter === "herdr" && remainingMs(snapshot) < HERDR_MIN_START_TIMEOUT_MS) {
          // Herdr refuses a start timeout of 3000 ms or less: too little budget is a run timeout.
          viewOf(action.agentId).handle = handleFor(
            runtime,
            runtimeName,
            planAgent.kind,
            pane.value,
          );
          written = await runTimedOut(snapshot);
          break;
        }
        const started = await runtime.startAgent({
          runtimeName,
          kind: planAgent.kind,
          paneId: pane.value.paneId,
          args: [...planAgent.args],
          timeoutMs: capped(snapshot, Math.min(limits.readinessWaitMs, HERDR_START_CAP_MS)),
        });
        const view = viewOf(action.agentId);
        view.startedAt = clock();
        if (remainingMs(snapshot) <= 0) {
          view.handle = started.ok
            ? started.value
            : handleFor(runtime, runtimeName, planAgent.kind, pane.value);
          written = await runTimedOut(snapshot);
          break;
        }
        if (!started.ok && started.error.code !== "agent_not_ready") {
          view.handle = handleFor(runtime, runtimeName, planAgent.kind, pane.value);
          written = await end(
            "failed",
            `agent_start_failed: ${action.agentId}: ${started.error.code}: ${started.error.message}`,
          );
          break;
        }
        const handle = started.ok
          ? started.value
          : handleFor(runtime, runtimeName, planAgent.kind, pane.value);
        view.handle = handle;
        written = await write(() =>
          assignAgent({
            runDir,
            agentId: action.agentId,
            runtime: { adapter: runtime.adapter, runtimeName, paneId: handle.paneId },
            terminalId: handle.terminalId,
            sessionId: handle.sessionId,
            tabId: handle.tabId ?? pane.value.tabId ?? null,
            ...lockWithin(snapshot),
          }),
        );
        if (written.ok && !started.ok) {
          written = await write(() =>
            blockRun({
              runDir,
              agentId: action.agentId,
              reason: "startup_blocked",
              requiredAction: `Agent ${action.agentId} (runtime agent ${runtimeName}) is blocked while starting in pane ${handle.paneId}${handle.tabId != null ? ` (tab ${handle.tabId})` : ""}. Answer its prompt in that pane, or cancel the run with: woof run cancel ${runDir}`,
              observed: { runtimeStatus: null, terminalId: null, stateChangeSeq: null },
              ...lockWithin(snapshot),
            }),
          );
        }
        observeNext = action.agentId;
        break;
      }

      case "dispatch": {
        const stage = agentStageOf(definition, action.stageId);
        const view = viewOf(action.agentId);
        const agent = snapshot.agents.find((item) => item.agentId === action.agentId);
        const handle = view.handle;
        if (stage === undefined || handle === null || agent?.assignment == null) {
          return fatal({
            reason: "engine_invariant",
            message: `cannot dispatch ${action.stageId} to ${action.agentId}`,
          });
        }
        // The deadline is checked before any dispatch write and again after each slow step.
        if (expired(snapshot)) {
          written = await runTimedOut(snapshot);
          break;
        }
        const inputs: ResolvedInput[] = [];
        let altered: string | undefined;
        let unresolved: string | undefined;
        for (const ref of action.request?.inputs ?? []) {
          if ("stageId" in ref.from) {
            const latest = snapshot.outputs.latestAcceptedByStage[ref.from.stageId];
            const attempt = latest === undefined ? undefined : attemptOf(snapshot, latest);
            const accepted = attempt?.accepted;
            if (latest === undefined || accepted == null) {
              unresolved = `${ref.label}: stage ${ref.from.stageId} has no accepted artifact`;
              break;
            }
            altered = acceptedCopyProblem(runDir, accepted.artifact);
            if (altered !== undefined) break;
            const acceptedRef = acceptedRefOf(snapshot, runDir, latest);
            if (acceptedRef === null) {
              unresolved = `${ref.label}: stage ${ref.from.stageId} has no accepted artifact`;
              break;
            }
            inputs.push({
              label: ref.label,
              path: acceptedRef.acceptedPath,
              sha256: acceptedRef.sha256,
              accepted: {
                stageId: latest.stageId,
                visit: latest.visit,
                attempt: latest.attempt,
                receiptId: acceptedRef.receiptId,
              },
            });
          } else {
            const found = latestCheckEvidence(snapshot, runDir, ref.from.checkId);
            if (found === null) {
              unresolved = `${ref.label}: check ${ref.from.checkId} has no recorded evidence`;
              break;
            }
            let current: string | undefined;
            try {
              current = hashFile(found.path);
            } catch (error) {
              current = `unreadable: ${(error as Error).message}`;
            }
            if (current !== found.sha256) {
              altered = `check evidence ${found.path} no longer matches its gate record`;
              break;
            }
            inputs.push({
              label: ref.label,
              path: found.path,
              sha256: found.sha256,
              checkId: ref.from.checkId,
            });
          }
        }
        if (altered !== undefined) {
          written = await end("failed", `input_artifact_altered: ${altered}`);
          break;
        }
        if (unresolved !== undefined) {
          // A declared input is never silently dropped: nothing is opened or sent.
          written = await end("failed", `input_unresolved: ${unresolved}`);
          break;
        }
        const revision = await fingerprint(snapshot);
        if (!revision.ok) {
          const failed = await fingerprintFailed(snapshot, revision);
          if (failed === undefined) return undefined;
          written = failed;
          break;
        }
        const planAgent = snapshot.agents.find((item) => item.agentId === action.agentId);
        const rendered = renderRequest({
          runId: snapshot.runId,
          workflow: snapshot.workflow ?? { name: definition.name, version: definition.version },
          agentId: action.agentId,
          role: planAgent?.role ?? action.agentId,
          stageId: action.stageId,
          visit: action.visit,
          attempt: action.attempt,
          cause: action.cause,
          round: action.round,
          repository,
          revision: revision.revision,
          runDir,
          artifactFile: stage.artifactFile,
          verdicts: stage.verdicts,
          submitCommand: options.submitCommand,
          goal: action.request?.goal ?? "",
          instructions: action.request?.instructions ?? "",
          inputs,
          ...(action.request?.task !== undefined ? { task: action.request.task } : {}),
          ...(action.request?.roleInstructions !== undefined
            ? { roleInstructions: action.request.roleInstructions }
            : {}),
          ...(action.previous !== null ? { previous: action.previous } : {}),
        });
        if (!rendered.ok) {
          written = await end(
            "failed",
            `request_too_large: ${action.stageId} request is ${rendered.bytes} bytes`,
          );
          break;
        }
        if (expired(snapshot)) {
          written = await runTimedOut(snapshot);
          break;
        }
        const opened = await write(() =>
          openAttempt({
            runDir,
            runId: snapshot.runId,
            agentId: action.agentId,
            stageId: action.stageId,
            visit: action.visit,
            attempt: action.attempt,
            verdicts: stage.verdicts,
            ...(stage.artifactVerdictMarker !== undefined
              ? { artifactVerdictMarker: stage.artifactVerdictMarker }
              : {}),
            paneId: agent.assignment?.paneId as string,
            ...lockWithin(snapshot),
          }),
        );
        if (!opened.ok) {
          written = opened;
          break;
        }
        if (expired(snapshot)) {
          // The attempt append finished after the deadline: no request file, no delivery.
          written = await runTimedOut(snapshot);
          break;
        }
        const requestPath = `requests/${action.stageId}/visit-${action.visit}/attempt-${action.attempt}/request.md`;
        const file = engineFile(requestPath, Buffer.from(rendered.text, "utf8"));
        if (!file.ok) {
          // Nothing was sent: the attempt stays undelivered and the run fails.
          written = await end("failed", file.reason);
          break;
        }
        if (expired(snapshot)) {
          // Opened and persisted but never sent: nothing is delivered after the deadline.
          written = await runTimedOut(snapshot);
          break;
        }
        view.readyStreak = 0;
        view.activitySinceDispatch = false;
        view.awaitingReadySince = null;
        const limits = snapshot.limits as Limits;
        // Exactly one delivery per attempt; a retry is a new attempt.
        const delivery = await runtime.deliver(handle, rendered.text, {
          timeoutMs: capped(snapshot, limits.deliveryTimeoutMs),
        });
        const seen = delivery.outcome === "started" ? delivery.observation : view.last;
        if (delivery.outcome === "started") accept(view, delivery.observation);
        const dispatched = await write(() =>
          recordDispatch({
            runDir,
            agentId: action.agentId,
            stageId: action.stageId,
            visit: action.visit,
            attempt: action.attempt,
            delivery: delivery.outcome,
            reason:
              delivery.outcome === "started"
                ? delivery.observation.lifecycle === "blocked"
                  ? "observed_blocked"
                  : "observed_working"
                : delivery.error.code,
            paneId: agent.assignment?.paneId as string,
            request: { path: requestPath, sha256: file.sha256, bytes: file.bytes },
            target: {
              terminalId: seen?.order.terminalId ?? handle.terminalId,
              sessionId: seen?.sessionId ?? handle.sessionId,
            },
            revision: revision.revision,
            ...lockWithin(snapshot),
          }),
        );
        if (!dispatched.ok && !dispatched.closed && dispatched.reason === "attempt_unknown") {
          // A started delivery is still recorded for an accepted attempt (with its revision);
          // only a non-started delivery of an already accepted attempt is refused here, and
          // its acceptance is the evidence.
          const after = read();
          const attempt = after.ok ? attemptOf(after.snapshot, action) : undefined;
          if (attempt?.accepted != null) {
            observeNext = action.agentId;
            break;
          }
        }
        if (!dispatched.ok && !dispatched.closed && dispatched.reason === "assignment_mismatch") {
          written = await end("failed", `agent_replaced: ${dispatched.message}`);
          break;
        }
        written = dispatched;
        // The dispatch fact is recorded first; a delivery that used up the run budget then ends the run.
        if (dispatched.ok && remainingMs(snapshot) <= 0) written = await runTimedOut(snapshot);
        observeNext = action.agentId;
        break;
      }

      case "compute_revision": {
        const altered = subjectAltered(snapshot, action.subject);
        if (altered !== undefined) {
          written = await end("failed", `input_artifact_altered: ${altered}`);
          break;
        }
        const revision = await fingerprint(snapshot);
        if (!revision.ok) {
          const failed = await fingerprintFailed(snapshot, revision);
          if (failed === undefined) return undefined;
          written = failed;
          break;
        }
        evidence = {
          gate: action.gate,
          acceptedSeq: action.acceptedSeq,
          revision: revision.revision,
        };
        return undefined;
      }

      case "run_check": {
        const altered = subjectAltered(snapshot, action.subject);
        if (altered !== undefined) {
          written = await end("failed", `input_artifact_altered: ${altered}`);
          break;
        }
        if (expired(snapshot)) {
          written = await runTimedOut(snapshot);
          break;
        }
        const run = await runCheck({
          argv: action.argv,
          cwd: repository,
          timeoutMs: capped(snapshot, action.timeoutMs),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
        if (run.aborted) return undefined;
        if (remainingMs(snapshot) <= 0) {
          // The check was stopped by the run deadline, not by its own timeout.
          written = await runTimedOut(snapshot);
          break;
        }
        const subject = action.subject;
        const path = `checks/${action.gate}/${subject.stageId}-v${subject.visit}-a${subject.attempt}/output.log`;
        const file = engineFile(path, run.output);
        if (!file.ok) {
          written = await end("failed", file.reason);
          break;
        }
        const revision = await fingerprint(snapshot);
        if (!revision.ok) {
          const failed = await fingerprintFailed(snapshot, revision);
          if (failed === undefined) return undefined;
          written = failed;
          break;
        }
        evidence = {
          gate: action.gate,
          acceptedSeq: subject.acceptedSeq,
          revision: revision.revision,
          check: {
            argv: action.argv,
            exitCode: run.exitCode,
            signal: run.signal,
            timedOut: run.timedOut,
            evidence: { path, sha256: file.sha256, bytes: file.bytes },
          },
        };
        return undefined;
      }

      case "record_gate": {
        const gate = action.gate;
        const altered = subjectAltered(snapshot, gate.subject);
        if (altered !== undefined) {
          written = await end("failed", `input_artifact_altered: ${altered}`);
          break;
        }
        let revision = gate.revision;
        if (gate.kind === "stage" && agentStageOf(definition, gate.gate)?.bindsRevision === true) {
          // Fingerprint again immediately before appending a revision-bound gate.
          const fresh = await fingerprint(snapshot);
          if (!fresh.ok) {
            const failed = await fingerprintFailed(snapshot, fresh);
            if (failed === undefined) return undefined;
            written = failed;
            break;
          }
          const approvesCompletion =
            gate.decision === "pass" && "outcome" in gate.next && gate.next.outcome === "completed";
          if (fresh.revision.tree !== gate.revision.tree && approvesCompletion) {
            // The repository moved after the evidence was computed: only an approval of
            // completion is decided again on the fresh tree (the completion fence then rejects
            // it). Every other gate keeps its decision and `reviewed` revision and is appended
            // once with the fresh revision, so a repository that keeps moving still makes
            // journal progress and `next` is not asked again for the same subject.
            evidence = {
              gate: gate.gate,
              acceptedSeq: gate.subject.acceptedSeq,
              revision: fresh.revision,
            };
            return undefined;
          }
          revision = fresh.revision;
        }
        if (expired(snapshot)) {
          // The subject re-hash or fingerprint used up the budget: no gate after the deadline.
          written = await runTimedOut(snapshot);
          break;
        }
        written = await write(() =>
          recordGate({
            runDir,
            gate: gate.gate,
            kind: gate.kind,
            subject: gate.subject,
            decision: gate.decision,
            reason: gate.reason,
            round: gate.round,
            next: gate.next,
            revision,
            ...(gate.verdict !== undefined ? { verdict: gate.verdict } : {}),
            ...(gate.reviewed !== undefined ? { reviewed: gate.reviewed } : {}),
            ...(gate.check !== undefined ? { check: gate.check } : {}),
            ...lockWithin(snapshot),
          }),
        );
        if (written.ok) {
          evidence = null;
          if (action.exhausted !== null) {
            written = await end(
              "exhausted",
              `gate ${gate.gate} requires another round beyond maxRounds (${String(snapshot.limits?.maxRounds)})`,
              action.exhausted,
            );
          } else if ("outcome" in gate.next) {
            // End the run in the same effect, so nothing runs between the gate and its outcome.
            const outcome = gate.next.outcome;
            written = await write(() =>
              terminateRun({ runDir, outcome, reason: gate.reason.slice(0, 500), ...lock }),
            );
          }
        }
        break;
      }

      case "block":
        written = await write(() =>
          blockRun({
            runDir,
            agentId: action.agentId,
            reason: action.reason,
            requiredAction: action.requiredAction,
            observed: action.observed,
            ...(action.attempt !== null ? { attempt: action.attempt } : {}),
            ...lockWithin(snapshot),
          }),
        );
        observeNext = action.agentId;
        break;

      case "unblock":
        written = await write(() =>
          unblockRun({
            runDir,
            agentId: action.agentId,
            observed: action.observed,
            ...lockWithin(snapshot),
          }),
        );
        observeNext = action.agentId;
        break;

      case "reconcile":
        written = await write(() =>
          reconcileDelivery({
            runDir,
            agentId: action.agentId,
            stageId: action.stageId,
            visit: action.visit,
            attempt: action.attempt,
            dispatchSeq: action.dispatchSeq,
            resolution: action.resolution,
            evidence: action.evidence,
            ...lockWithin(snapshot),
          }),
        );
        observeNext = action.agentId;
        break;
    }

    if (!written.ok) {
      if (written.closed) return undefined; // Terminated by someone else: the next tick settles.
      if (written.reason === "journal_busy" && expired(snapshot)) {
        // The budget-capped lock wait ran into the run deadline: that is run-timeout exhaustion.
        const ended = await runTimedOut(snapshot);
        if (ended.ok || ended.closed) return undefined;
        return fatal(ended);
      }
      return fatal(written);
    }
    return undefined;
  };

  for (;;) {
    // Ticks are sequential by design: each reads the state the previous one wrote.
    let done: RunWorkflowResult | undefined;
    try {
      // oxlint-disable-next-line no-await-in-loop
      done = await tick();
    } catch (error) {
      // Last resort: an unexpected throw still ends the run with a recorded outcome.
      // oxlint-disable-next-line no-await-in-loop
      return fatal({
        reason: "engine_invariant",
        message: `unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (done !== undefined) return done;
  }
}

/** The absolute path with symlinks resolved; the absolute path when it cannot be resolved. */
function canonicalDirectory(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** A handle for a pane whose agent did not report ready at start (its name stays addressable). */
function handleFor(
  runtime: RuntimeAdapter,
  runtimeName: string,
  kind: string,
  pane: { paneId: string; tabId?: string | null },
): AgentHandle {
  return {
    adapter: runtime.adapter,
    runtimeName,
    kind,
    paneId: pane.paneId,
    paneOwned: true,
    // A runtime module written before tab placement may return no tabId.
    tabId: pane.tabId ?? null,
    terminalId: null,
    sessionId: null,
  };
}

export { historyOf };
