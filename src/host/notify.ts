import { setTimeout as delay } from "node:timers/promises";

import type { NotifyEvent, NotifyOutcome, NotifyReason } from "../journal/notify-records.js";
import { readEvents, type RunEvent } from "../observe/events.js";
import { recordNotifyOutcome, recordNotifyTarget } from "../state/store.js";

/**
 * Caller notifications (the run host is the sender). The agent that started a run inside Herdr is
 * its notification target: the host pushes the events that need that agent's attention into its
 * pane with `herdr agent prompt`, so the caller neither polls nor follows a stream.
 *
 * Only five events produce a message, one each: `action_required` (run.blocked), `resumed`
 * (run.unblocked), `error` (the runtime became unavailable, or a worker agent is gone), and one
 * terminal message per top-level run: `limit_reached` when it ended exhausted, else `done`. Blocks,
 * resumptions and errors of a workflow step's child runs are followed too.
 *
 * A message is built from engine facts only — ids, enum values, the run directory, the worker's
 * Herdr agent name and tab — never from a record's free text (a gate or cancel reason, a required
 * action, an observation message): it arrives in the caller's pane with the human's authority, so
 * nothing a worker wrote may flow into it.
 */

/** The caller as `run start` captured it: its pane and the agent session there. */
export interface NotifyTarget {
  paneId: string;
  /** The Herdr agent name the host prompts. */
  agentName: string;
  /** The agent kind Herdr detected (`claude`, …). */
  agent: string;
  sessionId: string | null;
  terminalId: string | null;
}

/** Why a run has no notification target. */
export type NoTargetReason =
  | "foreground"
  | "outside_herdr"
  | "no_caller_pane"
  | "no_agent"
  | "agent_unnamed"
  | "no_session"
  | "caller_unreadable";

export type NotifySetting = { target: NotifyTarget } | { target: null; reason: NoTargetReason };

/** What Herdr reports for the target pane now. */
export type CallerRead =
  | {
      ok: true;
      agentName: string | null;
      sessionId: string | null;
      terminalId: string | null;
      /** Herdr's agent status: idle, done, working, blocked, unknown. */
      status: string;
    }
  | { ok: false; gone: boolean };

/** The Herdr access a notifier needs; built above the host from the Herdr runtime adapter. */
export interface NotifyChannel {
  read(): Promise<CallerRead>;
  /** One `herdr agent prompt`, classified as the runtime adapter classifies a delivery. */
  deliver(
    text: string,
    timeoutMs: number,
  ): Promise<{ outcome: "started" } | { outcome: "not_delivered" | "ambiguous"; code: string }>;
}

export interface Notification {
  event: NotifyEvent;
  /** `<runId>#<seq>` of the record it reports: one notification per record, never two. */
  key: string;
  text: string;
}

const HERDR_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PANE_OR_TAB = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;
const BLOCK_REASONS = new Set(["blocked_on_input", "startup_blocked"]);
const OUTCOMES = new Set(["completed", "failed", "exhausted", "cancelled"]);
const LIMIT = /^[a-zA-Z]{1,40}$/;
const MAX_PATH = 400;

/** A value that passes `pattern`, else `?`: nothing outside the allowlist reaches a message. */
function fact(value: unknown, pattern: RegExp): string {
  return typeof value === "string" && pattern.test(value) ? value : "?";
}

/** An engine-owned path, without control characters and bounded. */
function pathFact(value: string): string {
  // oxlint-disable-next-line no-control-regex
  const clean = value.replaceAll(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return clean.length > MAX_PATH ? `${clean.slice(0, MAX_PATH)}…` : clean;
}

/** One followed run: a top-level run gets a terminal message, a child run only the others. */
interface RunScope {
  runId: string;
  runDir: string;
  workflow: string;
  topLevel: boolean;
}

/**
 * Maps a run's events to notifications, in journal order. Pure: it keeps the worker roster it has
 * seen (agent.assigned) and reports each child run a workflow step opens, for the caller to follow.
 */
export function createEventMapper(scope: RunScope): {
  take(events: readonly RunEvent[]): { notifications: Notification[]; children: RunScope[] };
} {
  const workers = new Map<string, { name: string; tab: string | null }>();
  const run = `run ${fact(scope.runId, ID)} (${fact(scope.workflow, ID)})`;
  const dir = pathFact(scope.runDir);
  const status = `woof status ${dir}`;
  const worker = (agentId: unknown) => {
    const id = fact(agentId, ID);
    const known = workers.get(id);
    if (known === undefined) return `worker ${id}`;
    const tab = known.tab === null ? "" : `, tab ${known.tab}`;
    return `worker ${id} (herdr agent ${known.name}${tab})`;
  };
  const message = (event: NotifyEvent, head: string, lines: string[], next: string) =>
    [`[woof] ${event}: ${head}`, ...lines, `run dir: ${dir}`, `next: ${next}`].join("\n");

  return {
    take(events) {
      const notifications: Notification[] = [];
      const children: RunScope[] = [];
      for (const event of events) {
        const data = event.data;
        const key = `${fact(scope.runId, ID)}#${event.seq}`;
        const stage =
          event.subject.stageId === undefined ? "" : `, stage ${fact(event.subject.stageId, ID)}`;
        const push = (kind: NotifyEvent, text: string) =>
          notifications.push({ event: kind, key, text });
        switch (event.type) {
          case "agent.assigned": {
            const runtime = data["runtime"] as Record<string, unknown> | undefined;
            workers.set(fact(data["agentId"], ID), {
              name: fact(runtime?.["runtimeName"], HERDR_NAME),
              tab: typeof data["tabId"] === "string" ? fact(data["tabId"], PANE_OR_TAB) : null,
            });
            break;
          }
          case "run.blocked": {
            const known = workers.get(fact(data["agentId"], ID));
            const reason = BLOCK_REASONS.has(String(data["reason"])) ? String(data["reason"]) : "?";
            push(
              "action_required",
              message(
                "action_required",
                `${run}${stage}`,
                [`${worker(data["agentId"])} is blocked (${reason}) and waits for an answer.`],
                known === undefined
                  ? `${status}; ask the human before answering any permission prompt (Woof never answers one)`
                  : `herdr agent read ${known.name}; ask the human before answering any permission prompt (Woof never answers one)`,
              ),
            );
            break;
          }
          case "run.unblocked":
            push(
              "resumed",
              message(
                "resumed",
                run,
                [`${worker(data["agentId"])} is no longer blocked; the run continues.`],
                status,
              ),
            );
            break;
          case "observation.lost":
            // A lost observation is an error only when Herdr itself is unavailable to the run.
            if (data["code"] !== "runtime_unavailable") break;
            push(
              "error",
              message(
                "error",
                run,
                [`Herdr is unavailable to the run (observing ${worker(data["agentId"])} failed).`],
                `${status}; woof run cancel ${dir} to stop it`,
              ),
            );
            break;
          case "agent.lifecycle_changed":
            if (data["to"] !== "gone") break;
            push(
              "error",
              message(
                "error",
                run,
                [`${worker(data["agentId"])} is gone; the run cannot continue with it.`],
                status,
              ),
            );
            break;
          case "stage.child_opened": {
            const child = data["child"] as Record<string, unknown> | undefined;
            const workflow = child?.["workflow"] as Record<string, unknown> | undefined;
            if (typeof child?.["runDir"] === "string" && typeof child["runId"] === "string")
              children.push({
                runId: child["runId"],
                runDir: child["runDir"],
                workflow: String(workflow?.["name"] ?? "?"),
                topLevel: false,
              });
            break;
          }
          case "run.terminated": {
            if (!scope.topLevel) break;
            const outcome = OUTCOMES.has(String(data["outcome"])) ? String(data["outcome"]) : "?";
            if (outcome === "exhausted") {
              push(
                "limit_reached",
                message(
                  "limit_reached",
                  run,
                  [`The run ended exhausted: limit ${fact(data["limit"], LIMIT)} was reached.`],
                  `${status} for the result`,
                ),
              );
            } else {
              push(
                "done",
                message("done", run, [`The run ended: ${outcome}.`], `${status} for the result`),
              );
            }
            break;
          }
          default:
            break;
        }
      }
      return { notifications, children };
    },
  };
}

export interface NotifierOptions {
  runDir: string;
  runId: string;
  workflow: string;
  target: NotifyTarget;
  channel: NotifyChannel;
  log: (line: string) => void;
  /** How often queued notifications are retried and the journal is read (default 1000 ms). */
  retryMs?: number;
  /** How long one notification may wait for the caller while the run goes on (default 10 min). */
  maxWaitMs?: number;
  /** How long the host waits, after the run ended, for the queue to empty (default 60 s). */
  drainMs?: number;
  /** Bound on one `herdr agent prompt` (default 15 s). */
  deliverTimeoutMs?: number;
}

interface Queued extends Notification {
  since: number;
  /** A `queued` outcome is journaled once per notification. */
  queuedReason: NotifyReason | null;
}

export interface Notifier {
  /** Reads new events and tries the queue once; never throws. */
  tick(): Promise<void>;
  /** After the run ended: reads the last events, then retries until the queue is empty or the drain bound passes. */
  finish(): Promise<void>;
}

/**
 * Journals the target, then follows the run (and its child runs) and delivers each notification in
 * order. A notification is sent only while the caller's pane still hosts the same agent session and
 * that agent is idle: a working or blocked caller keeps it queued, so nothing is typed into a turn
 * in progress and nothing is lost or sent twice. An ambiguous delivery is journaled and never
 * resent. Every wait is bounded, and every outcome is journaled (`notify.outcome`).
 */
export async function createNotifier(options: NotifierOptions): Promise<Notifier> {
  const { runDir, target, channel, log } = options;
  const retryMs = options.retryMs ?? 1000;
  const maxWaitMs = options.maxWaitMs ?? 600_000;
  const drainMs = options.drainMs ?? 60_000;
  const deliverTimeoutMs = options.deliverTimeoutMs ?? 15_000;
  const journaled = await recordNotifyTarget({ runDir, ...target });
  if (journaled.outcome === "rejected")
    log(`cannot journal notify.target: ${journaled.reason}: ${journaled.message}`);

  const followed: Array<{
    scope: RunScope;
    mapper: ReturnType<typeof createEventMapper>;
    cursor?: string;
  }> = [];
  const follow = (scope: RunScope) => followed.push({ scope, mapper: createEventMapper(scope) });
  follow({ runId: options.runId, runDir, workflow: options.workflow, topLevel: true });
  const queue: Queued[] = [];
  const seen = new Set<string>();
  let stopped = false;
  let running: Promise<void> | undefined;

  const outcome = async (
    item: Pick<Notification, "event" | "key"> | null,
    kind: NotifyOutcome,
    reason: NotifyReason,
  ) => {
    log(`notify ${item === null ? "target" : `${item.event} ${item.key}`} ${kind} (${reason})`);
    try {
      const written = await recordNotifyOutcome({
        runDir,
        event: item?.event ?? null,
        key: item?.key ?? null,
        outcome: kind,
        reason,
      });
      if (written.outcome === "rejected")
        log(`cannot journal notify.outcome: ${written.reason}: ${written.message}`);
    } catch (error) {
      log(`cannot journal notify.outcome: ${(error as Error).message}`);
    }
  };

  const read = () => {
    for (let index = 0; index < followed.length; index += 1) {
      const entry = followed[index] as (typeof followed)[number];
      const events = readEvents(entry.scope.runDir, {
        ...(entry.cursor !== undefined ? { after: entry.cursor } : {}),
        limit: 10_000,
      });
      if (!events.ok) continue;
      entry.cursor = events.cursor;
      const { notifications, children } = entry.mapper.take(events.events);
      for (const child of children) follow(child);
      for (const item of notifications) {
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        queue.push({ ...item, since: Date.now(), queuedReason: null });
      }
    }
  };

  const stop = async (reason: "target_gone" | "target_changed") => {
    stopped = true;
    queue.length = 0;
    await outcome(null, "stopped", reason);
  };

  /** Tries the queue head until it waits; returns once nothing more can be done now. */
  /* oxlint-disable no-await-in-loop -- delivery is strictly in order, one notification at a time */
  const attempt = async () => {
    for (;;) {
      if (stopped || queue.length === 0) return;
      const head = queue[0] as Queued;
      if (Date.now() - head.since > maxWaitMs) {
        queue.shift();
        await outcome(head, "dropped", "wait_bound");
        continue;
      }
      const caller = await channel.read();
      if (!caller.ok) {
        if (caller.gone) return stop("target_gone");
        return wait(head, "caller_unreadable");
      }
      const same =
        caller.agentName === target.agentName &&
        (target.sessionId !== null
          ? caller.sessionId === target.sessionId
          : caller.terminalId === target.terminalId);
      if (!same) return stop("target_changed");
      if (caller.status === "working") return wait(head, "caller_working");
      if (caller.status === "blocked") return wait(head, "caller_blocked");
      if (caller.status !== "idle" && caller.status !== "done")
        return wait(head, "caller_unreadable");
      const sent = await channel.deliver(head.text, deliverTimeoutMs);
      if (sent.outcome === "started") {
        queue.shift();
        await outcome(head, "sent", "delivered");
        continue;
      }
      if (sent.outcome === "ambiguous") {
        // It may have arrived: never resend it.
        queue.shift();
        await outcome(head, "ambiguous", "delivery_ambiguous");
        continue;
      }
      if (sent.code === "not_found") return stop("target_gone");
      if (sent.code === "agent_busy") return wait(head, "caller_working");
      if (sent.code === "agent_blocked") return wait(head, "caller_blocked");
      if (sent.code === "invalid_request") {
        queue.shift();
        await outcome(head, "dropped", "not_delivered");
        continue;
      }
      // runtime_unavailable, precondition_failed: nothing was sent; try again later.
      return wait(head, "caller_unreadable");
    }
  };
  /* oxlint-enable no-await-in-loop */

  const wait = async (head: Queued, reason: NotifyReason) => {
    if (head.queuedReason !== null) return;
    head.queuedReason = reason;
    await outcome(head, "queued", reason);
  };

  const tick = async () => {
    // One pass at a time: a slow Herdr call never piles passes up.
    running ??= (async () => {
      try {
        read();
        await attempt();
      } catch (error) {
        log(`notify: ${(error as Error).message}`);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };

  return {
    tick,
    async finish() {
      const deadline = Date.now() + drainMs;
      for (;;) {
        // Each pass reads what the run journaled last and tries the queue again.
        // oxlint-disable-next-line no-await-in-loop
        await tick();
        if (stopped || queue.length === 0) return;
        if (Date.now() >= deadline) break;
        // oxlint-disable-next-line no-await-in-loop
        await delay(Math.max(1, Math.min(retryMs, deadline - Date.now())));
      }
      for (const item of queue.splice(0)) {
        // oxlint-disable-next-line no-await-in-loop
        await outcome(item, "dropped", "host_exiting");
      }
    },
  };
}
