import { cn } from "cn";

import type { RunEvent } from "@/lib/api";
import { clockTime } from "@/lib/format";
import type { RunFeed } from "@/hooks/use-run-events";

/**
 * The journal as it arrives. One line per event, in the engine's own
 * vocabulary: the record type verbatim, the subject in `stage v<visit>
 * a<attempt>` form, and a short summary taken from the record's own fields.
 */

const TYPE_CLASS: Record<string, string> = {
  "run.opened": "text-working",
  "run.blocked": "text-blocked",
  "run.unblocked": "text-working",
  "run.terminated": "text-fail",
  "submission.accepted": "text-pass",
  "submission.rejected": "text-fail",
  "gate.recorded": "text-foreground",
};

function subjectOf(event: RunEvent): string {
  const { stageId, visit, attempt, agentId } = event.subject;
  if (stageId !== undefined && visit !== undefined && attempt !== undefined) {
    return `${stageId} v${visit} a${attempt}`;
  }
  return agentId ?? "";
}

/** A one-line summary from the record's own fields; nothing is inferred. */
function summaryOf(event: RunEvent): string {
  const data = event.data;
  const text = (key: string): string | null => {
    const value = data[key];
    return typeof value === "string" ? value : null;
  };
  switch (event.type) {
    case "run.opened":
      return text("runId") ?? "";
    case "run.terminated": {
      const outcome = text("outcome") ?? "";
      const limit = text("limit");
      return `${outcome}${limit === null ? "" : ` (limit ${limit})`}: ${text("reason") ?? ""}`;
    }
    case "gate.recorded": {
      const decision = text("decision") ?? "";
      const verdict = text("verdict");
      return `${text("gate") ?? ""} ${decision}${verdict === null ? "" : ` ${verdict}`}: ${text("reason") ?? ""}`;
    }
    case "run.blocked":
      return `${text("reason") ?? ""}: ${text("requiredAction") ?? ""}`;
    case "run.unblocked":
      return text("resolution") ?? "";
    case "submission.rejected":
      return `${text("reason") ?? ""}: ${text("message") ?? ""}`;
    case "agent.assigned":
      return text("agentId") ?? "";
    case "request.dispatched":
      return `${text("delivery") ?? ""} ${text("reason") ?? ""}`;
    default:
      return text("reason") ?? text("status") ?? "";
  }
}

function FeedState({ feed }: { feed: RunFeed }) {
  const label: Record<RunFeed["state"], string> = {
    connecting: "connecting…",
    live: "live",
    ended: "stream ended",
    resync: "resyncing",
    error: "stream error",
  };
  const tone =
    feed.state === "live"
      ? "text-working"
      : feed.state === "error"
        ? "text-fail"
        : feed.state === "resync"
          ? "text-blocked"
          : "text-muted-foreground";
  return (
    <span className={cn("font-mono text-xs", tone)}>
      {label[feed.state]}
      {feed.cursor === null ? "" : ` · ${feed.cursor}`}
    </span>
  );
}

export function EventTimeline({ feed }: { feed: RunFeed }) {
  return (
    <section className="bg-surface border-border rounded-md border">
      <header className="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-medium">Events</h2>
        <FeedState feed={feed} />
      </header>
      {feed.message === null ? null : (
        <p className="bg-blocked-subtle text-blocked border-border border-b px-3 py-2 text-xs">
          {feed.message}
        </p>
      )}
      <ol className="max-h-[28rem] overflow-y-auto">
        {feed.events.length === 0 ? (
          <li className="text-muted-foreground px-3 py-3 text-sm">
            {feed.state === "connecting"
              ? "Waiting for the first event."
              : "This run recorded no events."}
          </li>
        ) : (
          feed.events.map((event) => (
            <li
              key={event.seq}
              className="border-border/60 hover:bg-inset flex gap-2 border-b px-3 py-1.5 font-mono text-xs last:border-b-0"
            >
              <span className="text-faint tabular-nums">{clockTime(event.ts)}</span>
              <span className="text-faint w-10 shrink-0 text-right tabular-nums">#{event.seq}</span>
              <span
                className={cn("w-44 shrink-0", TYPE_CLASS[event.type] ?? "text-secondary-text")}
              >
                {event.type}
              </span>
              <span className="text-muted-foreground hidden w-32 shrink-0 truncate sm:inline">
                {subjectOf(event)}
              </span>
              <span
                className="text-secondary-text min-w-0 flex-1 truncate"
                title={summaryOf(event)}
              >
                {summaryOf(event)}
              </span>
            </li>
          ))
        )}
      </ol>
    </section>
  );
}
