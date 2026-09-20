import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { QueryFailure } from "@/components/query-failure";
import { OwnerChip, StatusChip } from "@/components/state-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchRuns, isTerminal, type RunListEntry } from "@/lib/api";
import { age, stageSummary } from "@/lib/format";

/**
 * The landing page: every run that has not ended plus the twenty most recent
 * that have, newest first — exactly what `woof runs` lists.
 *
 * Phone width gets a card per run; from `md` up the same rows become a table.
 */

function needsAttention(run: RunListEntry): boolean {
  return (
    run.status === "blocked" ||
    run.status === "exhausted" ||
    (!isTerminal(run.status) && (run.owner === "lost" || run.owner === "exited")) ||
    (run.attention?.ambiguousDeliveries.length ?? 0) > 0
  );
}

function RunCard({ run }: { run: RunListEntry }) {
  return (
    <Link
      to="/runs/$runId"
      params={{ runId: run.runId }}
      className="bg-surface border-border hover:bg-inset block rounded-md border p-3 transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-sm">{run.runId}</span>
        <StatusChip status={run.status} />
      </div>
      <dl className="text-muted-foreground mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
        <dt className="text-faint">workflow</dt>
        <dd className="truncate">
          {run.workflow === null ? "—" : `${run.workflow.name}@${run.workflow.version}`}
        </dd>
        <dt className="text-faint">stage</dt>
        <dd className="truncate">{stageSummary(run.activeAttempts)}</dd>
        <dt className="text-faint">age</dt>
        <dd>
          {age(run.openedAt)} · updated {age(run.updatedAt)} ago
        </dd>
      </dl>
      {run.attention?.blocked == null ? null : (
        <p className="bg-blocked-subtle text-blocked mt-2 rounded-sm p-2 text-xs">
          {run.attention.blocked.requiredAction}
        </p>
      )}
    </Link>
  );
}

export function RunList() {
  // The same `["runs"]` entry the root shell polls for notifications: one
  // request, and this view renders from the shared cache. The interval lives
  // there, so it keeps running on the detail route too.
  const query = useQuery({ queryKey: ["runs"], queryFn: fetchRuns });

  if (query.isPending) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-20 w-full" />
        ))}
      </div>
    );
  }
  if (query.isError) return <QueryFailure error={query.error} />;

  const listed = query.data;
  if (!listed.exists) {
    return (
      <p className="text-muted-foreground text-sm">
        No runs directory at <span className="font-mono">{listed.runsDir}</span> yet. It is created
        by the first run; start one with{" "}
        <span className="font-mono">woof run start --input &lt;path&gt;</span>.
      </p>
    );
  }
  if (listed.runs.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No runs under <span className="font-mono">{listed.runsDir}</span>.
      </p>
    );
  }

  const attention = listed.runs.filter(needsAttention);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-medium">Runs</h1>
        <p className="text-faint font-mono text-xs">
          {listed.runs.length} listed · {listed.runsDir}
        </p>
      </div>

      {attention.length === 0 ? null : (
        <p className="bg-blocked-subtle text-blocked rounded-md p-2 text-sm">
          {attention.length} {attention.length === 1 ? "run needs" : "runs need"} you:{" "}
          <span className="font-mono">{attention.map((run) => run.runId).join(", ")}</span>
        </p>
      )}

      <div className="space-y-2 md:hidden">
        {listed.runs.map((run) => (
          <RunCard key={run.runDir} run={run} />
        ))}
      </div>

      <div className="bg-surface border-border hidden overflow-hidden rounded-md border md:block">
        <table className="w-full text-sm">
          <thead className="bg-inset text-faint text-left font-mono text-xs">
            <tr>
              <th className="px-3 py-2 font-normal">status</th>
              <th className="px-3 py-2 font-normal">run</th>
              <th className="px-3 py-2 font-normal">workflow</th>
              <th className="px-3 py-2 font-normal">stage</th>
              <th className="px-3 py-2 font-normal">owner</th>
              <th className="px-3 py-2 text-right font-normal">age</th>
            </tr>
          </thead>
          <tbody>
            {listed.runs.map((run) => (
              <tr key={run.runDir} className="border-border/60 hover:bg-inset border-t">
                <td className="px-3 py-1.5">
                  <StatusChip status={run.status} />
                </td>
                <td className="max-w-56 truncate px-3 py-1.5 font-mono text-xs">
                  <Link
                    to="/runs/$runId"
                    params={{ runId: run.runId }}
                    className="hover:text-foreground text-secondary-text underline-offset-4 hover:underline"
                  >
                    {run.runId}
                  </Link>
                </td>
                <td className="text-muted-foreground px-3 py-1.5 font-mono text-xs">
                  {run.workflow === null ? "—" : `${run.workflow.name}@${run.workflow.version}`}
                </td>
                <td className="text-muted-foreground max-w-48 truncate px-3 py-1.5 font-mono text-xs">
                  {stageSummary(run.activeAttempts)}
                </td>
                <td className="px-3 py-1.5">
                  <OwnerChip owner={run.owner} />
                </td>
                <td className="text-muted-foreground px-3 py-1.5 text-right font-mono text-xs tabular-nums">
                  {age(run.openedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {listed.skipped.length === 0 ? null : (
        <p className="text-faint font-mono text-xs">
          skipped {listed.skipped.length}:{" "}
          {listed.skipped.map((entry) => `${entry.path} (${entry.reason})`).join(", ")}
        </p>
      )}
    </div>
  );
}
