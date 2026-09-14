import { posix } from "node:path";
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
  reconcileDelivery,
  recordDispatch,
  recordGate,
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
import { revisionOf } from "./revision.js";

/**
 * Effectful scheduler driver (D1): a foreground loop that reads the run
 * snapshot, asks the pure core for one action and executes it through the
 * runtime adapter, the state store and `openAttempt`. It never appends journal
 * records itself, never sends a second request for an attempt and never reads
 * terminal output. The run must already be opened with a plan.
 */

export interface RunWorkflowOptions<Input> {
  /** Run directory holding a journal opened with the workflow's plan. */
  runDir: string;
  definition: WorkflowDefinition<Input>;
  /** Input already validated by the definition. */
  input: Input;
  runtime: RuntimeAdapter;
  /** Command that runs `woof`, placed before `submit` in worker requests. */
  submitCommand: readonly string[];
  signal?: AbortSignal;
  /** Sleep between ticks that wait (default 1000 ms). */
  pollMs?: number;
  /** Leave agent panes open when the run ends. */
  keepPanes?: boolean;
  /** Pane to split for agents (default "current"). */
  paneNear?: string;
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
    reason: "journal_unavailable" | "journal_corrupt" | "engine_invariant";
    message: string;
  } | null;
  stats: { ticks: number; maxSnapshotMs: number; dropped: { stale: number; duplicate: number } };
}

const JOURNAL_ATTEMPTS = 3;
const STOP_TIMEOUT_MS = 10_000;
const HERDR_START_CAP_MS = 300_000;

type Written<T> =
  | { ok: true; value: T }
  | { ok: false; closed: true }
  | { ok: false; closed: false; reason: string; message: string };

export async function runWorkflow<Input>(
  options: RunWorkflowOptions<Input>,
): Promise<RunWorkflowResult> {
  const { runDir, definition, runtime } = options;
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
  let observeNext: string | null = null;
  let repository = "";
  let repositoryError: string | undefined;
  try {
    repository = definition.repository(options.input);
  } catch (error) {
    repositoryError =
      `definition_threw: repository: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        500,
      );
  }

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
    if (options.keepPanes !== true) {
      for (const view of Object.values(agents)) {
        if (view.handle === null) continue;
        // oxlint-disable-next-line no-await-in-loop
        await runtime.stop(view.handle, { timeoutMs: STOP_TIMEOUT_MS });
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
      result: deriveRunResult(final.snapshot, { runDir: posix.normalize(runDir), repository }),
      error: null,
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
  const capped = (snapshot: RunSnapshot, ms: number): number =>
    Math.max(1, Math.floor(Math.min(ms, remainingMs(snapshot))));
  /** A capped effect that reached the run deadline ends the run as run-timeout exhaustion. */
  const runTimedOut = (snapshot: RunSnapshot): Promise<Written<unknown>> =>
    end(
      "exhausted",
      `the run exceeded runTimeoutMs (${String(snapshot.limits?.runTimeoutMs)} ms)`,
      "runTimeoutMs",
    );

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
      const view = agents[observeNext];
      if (view?.handle != null) {
        const observed = await runtime.observe(view.handle);
        if (observed.ok) accept(view, observed.value);
        else view.readyStreak = 0;
      }
      observeNext = null;
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
          terminateRun({
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
        await sleep(pollMs, options.signal);
        return undefined;
      }

      case "start_agent": {
        const spec = snapshot.agents.find((agent) => agent.agentId === action.agentId);
        const planAgent = { kind: spec?.kind ?? "", args: spec?.args ?? [] };
        const limits = snapshot.limits as Limits;
        const pane = await runtime.openPane({
          near: options.paneNear ?? "current",
          cwd: repository,
          env: { WOOF_RUN_DIR: runDir },
        });
        const runtimeName = herdrRuntimeName(snapshot.runId, action.agentId);
        if (remainingMs(snapshot) <= 0) {
          if (pane.ok) {
            viewOf(action.agentId).handle = handleFor(
              runtime,
              runtimeName,
              planAgent.kind,
              pane.value.paneId,
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
            : handleFor(runtime, runtimeName, planAgent.kind, pane.value.paneId);
          written = await runTimedOut(snapshot);
          break;
        }
        if (!started.ok && started.error.code !== "agent_not_ready") {
          view.handle = handleFor(runtime, runtimeName, planAgent.kind, pane.value.paneId);
          written = await end(
            "failed",
            `agent_start_failed: ${action.agentId}: ${started.error.code}: ${started.error.message}`,
          );
          break;
        }
        const handle = started.ok
          ? started.value
          : handleFor(runtime, runtimeName, planAgent.kind, pane.value.paneId);
        view.handle = handle;
        written = await write(() =>
          assignAgent({
            runDir,
            agentId: action.agentId,
            runtime: { adapter: runtime.adapter, runtimeName, paneId: handle.paneId },
            terminalId: handle.terminalId,
            sessionId: handle.sessionId,
            ...lock,
          }),
        );
        if (written.ok && !started.ok) {
          written = await write(() =>
            blockRun({
              runDir,
              agentId: action.agentId,
              reason: "startup_blocked",
              requiredAction: `Agent ${action.agentId} (runtime agent ${runtimeName}) is blocked while starting in pane ${handle.paneId}. Answer its prompt in that pane, or cancel the run with: woof run cancel ${runDir}`,
              observed: { runtimeStatus: null, terminalId: null, stateChangeSeq: null },
              ...lock,
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
        const inputs: ResolvedInput[] = [];
        let altered: string | undefined;
        for (const ref of action.request?.inputs ?? []) {
          if ("stageId" in ref.from) {
            const latest = snapshot.outputs.latestAcceptedByStage[ref.from.stageId];
            const attempt = latest === undefined ? undefined : attemptOf(snapshot, latest);
            const accepted = attempt?.accepted;
            if (latest === undefined || accepted == null) continue;
            altered = acceptedCopyProblem(runDir, accepted.artifact);
            if (altered !== undefined) break;
            const acceptedRef = acceptedRefOf(snapshot, runDir, latest);
            if (acceptedRef === null) continue;
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
            if (found === null) continue;
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
        const revision = await revisionOf(repository);
        if (!revision.ok) {
          written = await end("failed", `repo_invalid: ${revision.message}`);
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
        const opened = await write(() =>
          openAttempt({
            runDir,
            runId: snapshot.runId,
            agentId: action.agentId,
            stageId: action.stageId,
            visit: action.visit,
            attempt: action.attempt,
            verdicts: stage.verdicts,
            paneId: agent.assignment?.paneId as string,
            ...lock,
          }),
        );
        if (!opened.ok) {
          written = opened;
          break;
        }
        const requestPath = `requests/${action.stageId}/visit-${action.visit}/attempt-${action.attempt}/request.md`;
        const file = engineFile(requestPath, Buffer.from(rendered.text, "utf8"));
        if (!file.ok) {
          // Nothing was sent: the attempt stays undelivered and the run fails.
          written = await end("failed", file.reason);
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
            ...lock,
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
        const revision = await revisionOf(repository);
        if (!revision.ok) {
          written = await end("failed", `repo_invalid: ${revision.message}`);
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
        const revision = await revisionOf(repository);
        if (!revision.ok) {
          written = await end("failed", `repo_invalid: ${revision.message}`);
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
          const fresh = await revisionOf(repository);
          if (!fresh.ok) {
            written = await end("failed", `repo_invalid: ${fresh.message}`);
            break;
          }
          if (fresh.revision.tree !== gate.revision.tree) {
            // The repository moved after the evidence was computed: decide again on the fresh tree.
            evidence = {
              gate: gate.gate,
              acceptedSeq: gate.subject.acceptedSeq,
              revision: fresh.revision,
            };
            return undefined;
          }
          revision = fresh.revision;
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
            ...lock,
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
            ...lock,
          }),
        );
        observeNext = action.agentId;
        break;

      case "unblock":
        written = await write(() =>
          unblockRun({ runDir, agentId: action.agentId, observed: action.observed, ...lock }),
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
            ...lock,
          }),
        );
        observeNext = action.agentId;
        break;
    }

    if (!written.ok) {
      if (written.closed) return undefined; // Terminated by someone else: the next tick settles.
      return fatal(written);
    }
    return undefined;
  };

  if (repositoryError !== undefined) {
    const ended = await end("failed", repositoryError);
    if (!ended.ok && !ended.closed) return fatal(ended);
    return settle();
  }
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

/** A handle for a pane whose agent did not report ready at start (its name stays addressable). */
function handleFor(
  runtime: RuntimeAdapter,
  runtimeName: string,
  kind: string,
  paneId: string,
): AgentHandle {
  return {
    adapter: runtime.adapter,
    runtimeName,
    kind,
    paneId,
    paneOwned: true,
    terminalId: null,
    sessionId: null,
  };
}

export { historyOf };
