import { isTerminal, type RunListEntry } from "./api";

/**
 * In-tab notifications for the transitions worth interrupting for: a run that
 * became blocked, failed, exhausted or completed. The engine's own guidance is
 * "attention should focus on blocks, failures and completion rather than every
 * activity change", so nothing else notifies.
 *
 * This is the foreground Notification API only. There is no service worker and
 * no Web Push: those need a secure context, which `http://<LAN-IP>` is not, and
 * on iOS additionally a home-screen install. Permission is requested when the
 * operator turns the toggle on, never on load.
 */

const NOTIFIED: ReadonlySet<string> = new Set(["blocked", "failed", "exhausted", "completed"]);

export const STORAGE_KEY = "woof.notifications";

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationsPermission(): NotificationPermission | "unsupported" {
  return notificationsSupported() ? Notification.permission : "unsupported";
}

/** Asks for permission; returns what the operator chose. Only ever called from a click. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}

function body(run: RunListEntry): string {
  if (run.status === "blocked" && run.attention?.blocked != null) {
    return run.attention.blocked.requiredAction;
  }
  const workflow = run.workflow === null ? "no workflow" : run.workflow.name;
  return `${workflow} · ${run.status}`;
}

/**
 * Notifies for every run whose status entered a notified state since the last
 * call, and returns the statuses to compare against next time. The first call
 * only records: a page load is not a transition.
 */
export function notifyTransitions(
  runs: readonly RunListEntry[],
  previous: ReadonlyMap<string, string> | null,
): Map<string, string> {
  const current = new Map(runs.map((run) => [run.runId, run.status] as const));
  if (previous === null || notificationsPermission() !== "granted") return current;
  for (const run of runs) {
    const before = previous.get(run.runId);
    if (before === undefined || before === run.status) continue;
    if (!NOTIFIED.has(run.status)) continue;
    try {
      const shown = new Notification(`woof: ${run.runId} ${run.status}`, {
        body: body(run),
        tag: `woof-${run.runId}-${run.status}`,
        // A terminal run needs no further attention; a block does.
        requireInteraction: !isTerminal(run.status),
      });
      shown.addEventListener("click", () => window.focus());
    } catch {
      // A browser that refuses to construct one (iOS Safari without an install)
      // must not break the dashboard; the state is visible on the page anyway.
    }
  }
  return current;
}
