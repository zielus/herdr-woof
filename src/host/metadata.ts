import { execHerdr } from "../runtime/herdr/exec.js";
import type { RunSnapshot, SnapshotAgent } from "../state/snapshot.js";

/**
 * Herdr display projection (p4 D11): the run host reports run state as pane
 * metadata tokens on its own pane and on agent panes, and shows a notification
 * when the run blocks or ends. Display only: nothing in Woof reads it back, the
 * journal stays the source of truth, and a failed report is logged, never fatal.
 * Short TTLs make a killed host's tokens expire on their own.
 */

export const METADATA_SOURCE = "woof";
export const LIVE_TTL_MS = 30_000;
export const FINAL_TTL_MS = 600_000;
export const REFRESH_MS = 10_000;
const MAX_TOKEN_VALUE = 64;
const MAX_BODY = 200;
const MAX_TITLE_RUN_ID = 40;
const COMMAND_TIMEOUT_MS = 5000;

export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/** The host pane token: `starting`, `running <stage> v<n> a<m> r<round>`, `blocked <reason>`, or the outcome. */
export function hostTokenValue(snapshot: RunSnapshot): string {
  const outcome = snapshot.outcome;
  if (outcome !== null) {
    return clip(
      outcome.outcome === "exhausted" && outcome.limit !== null
        ? `exhausted ${outcome.limit}`
        : outcome.outcome,
      MAX_TOKEN_VALUE,
    );
  }
  if (snapshot.status === "created" || snapshot.status === "starting") return "starting";
  if (snapshot.status === "blocked") {
    const reason = snapshot.attention.blocked?.reason;
    return clip(reason === undefined ? "blocked" : `blocked ${reason}`, MAX_TOKEN_VALUE);
  }
  const active = latestOpenAttempt(snapshot);
  return clip(
    active === undefined
      ? "running"
      : `running ${active.stageId} v${active.visit} a${active.attempt} r${snapshot.counters.rounds}`,
    MAX_TOKEN_VALUE,
  );
}

/** An agent pane token: `<stage> v<n> a<m>` while the agent owns an open attempt, else `idle`. */
export function agentTokenValue(agent: SnapshotAgent): string {
  const active = agent.activeAttempt;
  return active === null
    ? "idle"
    : clip(`${active.stageId} v${active.visit} a${active.attempt}`, MAX_TOKEN_VALUE);
}

/** The most recently opened attempt that is still open. */
function latestOpenAttempt(
  snapshot: RunSnapshot,
): { stageId: string; visit: number; attempt: number } | undefined {
  let latest: { stageId: string; visit: number; attempt: number; seq: number } | undefined;
  for (const stage of snapshot.stages) {
    for (const visit of stage.visits) {
      for (const attempt of visit.attempts) {
        if (attempt.status === "open" && (latest === undefined || attempt.seq > latest.seq)) {
          latest = {
            stageId: stage.stageId,
            visit: visit.visit,
            attempt: attempt.attempt,
            seq: attempt.seq,
          };
        }
      }
    }
  }
  return latest;
}

export interface MetadataProjectorOptions {
  hostPaneId: string;
  workflow: string;
  runId: string;
  refreshMs?: number;
}

/**
 * Pure projection state: given each snapshot, the Herdr argv lists to send.
 * Tokens are re-sent when a value changes or `refreshMs` has passed; `final`
 * re-sends them with the long TTL. A new block and the termination each
 * produce one notification.
 */
export function createMetadataProjector(options: MetadataProjectorOptions) {
  const refreshMs = options.refreshMs ?? REFRESH_MS;
  const title = `woof ${options.workflow} ${clip(options.runId, MAX_TITLE_RUN_ID)}`;
  let lastKey: string | undefined;
  let lastSent = Number.NEGATIVE_INFINITY;
  let blockedSeq: number | null = null;
  let terminalNotified = false;
  return {
    next(snapshot: RunSnapshot, now: number, final = false): string[][] {
      const commands: string[][] = [];
      const hostValue = hostTokenValue(snapshot);
      const agents = snapshot.agents.flatMap((agent) =>
        agent.assignment === null
          ? []
          : [
              {
                paneId: agent.assignment.paneId,
                role: clip(agent.role ?? agent.agentId, MAX_TOKEN_VALUE),
                value: agentTokenValue(agent),
              },
            ],
      );
      const key = JSON.stringify([hostValue, agents]);
      if (final || key !== lastKey || now - lastSent >= refreshMs) {
        const ttl = String(final ? FINAL_TTL_MS : LIVE_TTL_MS);
        commands.push([
          "pane",
          "report-metadata",
          options.hostPaneId,
          "--source",
          METADATA_SOURCE,
          "--title",
          title,
          "--token",
          `woof=${hostValue}`,
          "--ttl-ms",
          ttl,
        ]);
        for (const agent of agents) {
          commands.push([
            "pane",
            "report-metadata",
            agent.paneId,
            "--source",
            METADATA_SOURCE,
            "--token",
            `woof=${agent.value}`,
            "--token",
            `woof-role=${agent.role}`,
            "--ttl-ms",
            ttl,
          ]);
        }
        lastKey = key;
        lastSent = now;
      }
      const blocked = snapshot.attention.blocked;
      if (blocked !== null && blocked.seq !== blockedSeq) {
        blockedSeq = blocked.seq;
        commands.push([
          "notification",
          "show",
          `Woof: ${options.runId} blocked`,
          "--body",
          clip(blocked.requiredAction, MAX_BODY),
        ]);
      }
      if (snapshot.outcome !== null && !terminalNotified) {
        terminalNotified = true;
        commands.push([
          "notification",
          "show",
          `Woof: ${options.runId} ${snapshot.outcome.outcome}`,
          "--body",
          clip(snapshot.outcome.reason, MAX_BODY),
        ]);
      }
      return commands;
    },
  };
}

export interface MetadataReporterOptions extends MetadataProjectorOptions {
  /** Herdr executable (`WOOF_HERDR_BIN` or `herdr`). */
  bin: string;
  env: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  clock?: () => number;
}

export interface MetadataReporter {
  report(snapshot: RunSnapshot): Promise<void>;
  finish(snapshot: RunSnapshot): Promise<void>;
}

export function createMetadataReporter(options: MetadataReporterOptions): MetadataReporter {
  const projector = createMetadataProjector(options);
  const log = options.log ?? ((message: string) => process.stderr.write(`woof: ${message}\n`));
  const clock = options.clock ?? Date.now;
  const send = async (commands: string[][]) => {
    for (const args of commands) {
      // Reports are sent in order so a final token never races an earlier one.
      // oxlint-disable-next-line no-await-in-loop
      const result = await execHerdr(args, {
        bin: options.bin,
        env: options.env,
        timeoutMs: COMMAND_TIMEOUT_MS,
        graceMs: 1000,
      });
      if (result.spawnErrorCode !== null || result.exitCode !== 0 || result.killed) {
        const detail =
          result.spawnErrorMessage ??
          (result.stderr.trim().split("\n")[0] ||
            `exit ${result.exitCode ?? result.signal ?? "unknown"}`);
        log(`metadata: herdr ${args.slice(0, 2).join(" ")} failed: ${detail}`);
      }
    }
  };
  return {
    report: (snapshot) => send(projector.next(snapshot, clock())),
    finish: (snapshot) => send(projector.next(snapshot, clock(), true)),
  };
}
