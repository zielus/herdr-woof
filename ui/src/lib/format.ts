import type { ActiveAttempt, HostOwner, RunStatusName } from "./api";

/**
 * Presentation rules from the Woof design system: five state colours, each
 * meaning exactly one thing (teal pass, rose fail, amber blocked, grey lost,
 * lavender working), engine vocabulary verbatim, sentence case, no emoji.
 *
 * `exhausted` deliberately maps to the fail colour rather than to amber: amber
 * means blocked and nothing else. Its own label carries the limit that was hit,
 * which is what tells it apart from a plain failure.
 */

export type Tone = "pass" | "fail" | "blocked" | "lost" | "working" | "idle";

const STATUS_TONES: Record<RunStatusName, Tone> = {
  created: "idle",
  starting: "working",
  running: "working",
  blocked: "blocked",
  completed: "pass",
  failed: "fail",
  cancelled: "lost",
  exhausted: "fail",
};

export function statusTone(status: string): Tone {
  return STATUS_TONES[status as RunStatusName] ?? "idle";
}

const OWNER_TONES: Record<HostOwner, Tone> = {
  unhosted: "idle",
  alive: "working",
  lost: "lost",
  exited: "lost",
};

export function ownerTone(owner: string): Tone {
  return OWNER_TONES[owner as HostOwner] ?? "idle";
}

export const TONE_CLASS: Record<Tone, string> = {
  pass: "bg-pass-subtle text-pass",
  fail: "bg-fail-subtle text-fail",
  blocked: "bg-blocked-subtle text-blocked",
  lost: "bg-lost-subtle text-lost",
  working: "bg-working-subtle text-working",
  idle: "bg-idle-subtle text-idle",
};

export const TONE_DOT: Record<Tone, string> = {
  pass: "bg-pass",
  fail: "bg-fail",
  blocked: "bg-blocked",
  lost: "bg-lost",
  working: "bg-working",
  idle: "bg-idle",
};

/** A short duration, largest unit only: the list is scanned, not measured. */
export function age(from: string, to: number = Date.now()): string {
  const ms = to - Date.parse(from);
  if (!Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function clockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString(undefined, { hour12: false });
}

/** The engine's own identifier format: `stage v<visit> a<attempt>`. */
export function attemptLabel(attempt: { stageId: string; visit: number; attempt: number }): string {
  return `${attempt.stageId} v${attempt.visit} a${attempt.attempt}`;
}

/** The stage column of the run list: every attempt the run is currently on. */
export function stageSummary(active: ActiveAttempt[] | null): string {
  if (active === null) return "—";
  if (active.length === 0) return "—";
  return active.map(attemptLabel).join(", ");
}
