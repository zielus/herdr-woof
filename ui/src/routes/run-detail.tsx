import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ArrowLeftIcon } from "lucide-react";
import { useCallback } from "react";

import { CancelAction, UnsupportedButton } from "@/components/actions";
import { EventTimeline } from "@/components/event-timeline";
import { QueryFailure } from "@/components/query-failure";
import { OwnerChip, StateChip, StatusChip } from "@/components/state-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { useRunEvents } from "@/hooks/use-run-events";
import {
  fetchCapabilities,
  fetchRun,
  isTerminal,
  type RunSnapshot,
  type SnapshotAttempt,
} from "@/lib/api";
import { age, attemptLabel, clockTime, statusTone } from "@/lib/format";

/**
 * One run: what it is doing, what it needs, and what happened.
 *
 * The header and the stage state come from the snapshot (refetched on demand);
 * the timeline comes from the event stream. They are two views of the same
 * journal, so a resync drops the feed and refetches the snapshot rather than
 * patching either one.
 */

const ATTEMPT_TONE: Record<SnapshotAttempt["status"], Parameters<typeof StateChip>[0]["tone"]> = {
  open: "working",
  accepted: "pass",
  superseded: "idle",
  abandoned: "lost",
};

function Blocked({ snapshot }: { snapshot: RunSnapshot }) {
  const blocked = snapshot.attention.blocked;
  if (blocked === null) return null;
  return (
    <section className="bg-blocked-subtle text-blocked rounded-md p-3 text-sm">
      <p className="font-mono text-xs">
        run.blocked&#123;reason:&quot;{blocked.reason}&quot;&#125; · agent {blocked.agentId} · since{" "}
        {age(blocked.since)} ago
      </p>
      <p className="mt-1">{blocked.requiredAction}</p>
      <p className="text-muted-foreground mt-2 text-xs">
        Nothing here can answer it: the block clears when the runtime observes the agent leave
        blocked, when the run is cancelled, or when blockedWaitMs elapses into exhausted.
      </p>
    </section>
  );
}

function Agents({ snapshot }: { snapshot: RunSnapshot }) {
  return (
    <section className="bg-surface border-border rounded-md border">
      <h2 className="border-border border-b px-3 py-2 text-sm font-medium">Agents</h2>
      <ul className="divide-border/60 divide-y">
        {snapshot.agents.length === 0 ? (
          <li className="text-muted-foreground px-3 py-2 text-sm">No agent assigned yet.</li>
        ) : (
          snapshot.agents.map((agent) => (
            <li
              key={agent.agentId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 font-mono text-xs"
            >
              <span className="text-foreground">{agent.agentId}</span>
              <span className="text-muted-foreground">role {agent.role}</span>
              <span className="text-muted-foreground">kind {agent.kind}</span>
              <span className="text-muted-foreground">model {agent.model ?? "-"}</span>
              <span className="text-faint">pane {agent.assignment?.paneId ?? "-"}</span>
              {agent.activeAttempt === null ? null : (
                <StateChip label={attemptLabel(agent.activeAttempt)} tone="working" />
              )}
            </li>
          ))
        )}
      </ul>
    </section>
  );
}

function Stages({ snapshot }: { snapshot: RunSnapshot }) {
  return (
    <section className="bg-surface border-border rounded-md border">
      <h2 className="border-border border-b px-3 py-2 text-sm font-medium">Stages</h2>
      <ul className="divide-border/60 divide-y">
        {snapshot.stages.length === 0 ? (
          <li className="text-muted-foreground px-3 py-2 text-sm">No stage has opened yet.</li>
        ) : (
          snapshot.stages.map((stage) => (
            <li key={stage.stageId} className="px-3 py-2">
              <p className="flex items-center gap-2 font-mono text-xs">
                <span>{stage.stageId}</span>
                <span className="text-faint">agent {stage.agentId}</span>
                {stage.verdicts === null || stage.verdicts.length === 0 ? null : (
                  <span className="text-faint">verdicts {stage.verdicts.join("|")}</span>
                )}
              </p>
              <ul className="mt-1 space-y-1 pl-4">
                {stage.visits.flatMap((visit) =>
                  visit.attempts.map((attempt) => (
                    <li
                      key={`${visit.visit}-${attempt.attempt}`}
                      className="flex flex-wrap items-center gap-2 font-mono text-xs"
                    >
                      <span className="text-muted-foreground">
                        v{visit.visit} a{attempt.attempt}
                      </span>
                      <StateChip label={attempt.status} tone={ATTEMPT_TONE[attempt.status]} />
                      <span className="text-faint">{attempt.cause}</span>
                      <span className="text-faint">delivery {attempt.delivery}</span>
                      {attempt.accepted?.verdict == null ? null : (
                        <span className="text-secondary-text">
                          verdict {attempt.accepted.verdict}
                        </span>
                      )}
                      {attempt.rejectionLog.length === 0 ? null : (
                        <span className="text-fail">
                          {attempt.rejectionLog.length} rejected (
                          {attempt.rejectionLog.at(-1)?.reason})
                        </span>
                      )}
                    </li>
                  )),
                )}
              </ul>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}

function Gates({ snapshot }: { snapshot: RunSnapshot }) {
  if (snapshot.gates.length === 0) return null;
  return (
    <section className="bg-surface border-border rounded-md border">
      <h2 className="border-border border-b px-3 py-2 text-sm font-medium">Gates</h2>
      <ul className="divide-border/60 divide-y">
        {snapshot.gates.map((gate) => (
          <li
            key={gate.seq}
            className="flex flex-wrap items-center gap-2 px-3 py-1.5 font-mono text-xs"
          >
            <span className="text-faint tabular-nums">{clockTime(gate.at)}</span>
            <span>{gate.gate}</span>
            <StateChip label={gate.decision} tone={gate.decision === "pass" ? "pass" : "blocked"} />
            <span className="text-faint">r{gate.round}</span>
            <span className="text-secondary-text min-w-0 truncate">{gate.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RunDetail({ runId }: { runId: string }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["run", runId],
    queryFn: () => fetchRun(runId),
    refetchInterval: (q) =>
      q.state.data !== undefined && isTerminal(q.state.data.status.status) ? false : 4000,
  });
  const capabilities = useQuery({ queryKey: ["capabilities"], queryFn: fetchCapabilities });

  const onResync = useCallback(() => {
    void client.invalidateQueries({ queryKey: ["run", runId] });
  }, [client, runId]);
  const feed = useRunEvents(runId, onResync);

  if (query.isPending) return <Skeleton className="h-64 w-full" />;
  if (query.isError) {
    return (
      <div className="space-y-3">
        <Link to="/" className="text-muted-foreground inline-flex items-center gap-1 text-sm">
          <ArrowLeftIcon className="size-4" /> Runs
        </Link>
        <QueryFailure error={query.error} />
      </div>
    );
  }

  const { snapshot, status, result } = query.data;
  const ended = isTerminal(status.status);

  return (
    <div className="space-y-4">
      <Link
        to="/"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeftIcon className="size-4" /> Runs
      </Link>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-base break-all">{snapshot.runId}</h1>
          <StatusChip status={snapshot.status} />
          <OwnerChip owner={snapshot.liveness.owner} />
        </div>
        <p className="text-muted-foreground font-mono text-xs">
          {snapshot.workflow === null
            ? "no workflow"
            : `${snapshot.workflow.name}@${snapshot.workflow.version}`}{" "}
          · opened {age(snapshot.openedAt)} ago · updated {age(snapshot.updatedAt)} ago · revision{" "}
          {snapshot.revision}
        </p>
        <p className="text-faint font-mono text-xs break-all">{status.runDir}</p>
        {result === null ? null : (
          <p
            className={cn(
              "font-mono text-xs",
              // Tailwind only sees complete class names, never interpolated ones.
              statusTone(snapshot.status) === "pass" ? "text-pass" : "text-fail",
            )}
          >
            {result.outcome}
            {result.limit === null ? "" : ` (limit ${result.limit})`}: {result.reason}
          </p>
        )}
      </header>

      <Blocked snapshot={snapshot} />

      <div className="flex flex-wrap items-center gap-2">
        <CancelAction runId={snapshot.runId} disabled={ended} />
        {capabilities.data === undefined ? null : (
          <>
            <UnsupportedButton
              label="Answer block"
              action={capabilities.data.actions.answerBlocked}
            />
            <UnsupportedButton label="Retry" action={capabilities.data.actions.retry} />
          </>
        )}
      </div>

      <Agents snapshot={snapshot} />
      <Stages snapshot={snapshot} />
      <Gates snapshot={snapshot} />
      <EventTimeline feed={feed} />
    </div>
  );
}
