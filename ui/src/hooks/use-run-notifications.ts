import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { fetchRuns } from "@/lib/api";
import { notifyTransitions } from "@/lib/notifications";

/**
 * Watches every run for the transitions worth interrupting for.
 *
 * It lives at the root shell, not in the run list: the notification toggle is in
 * the header on every route, so an operator reading one run's page has it
 * switched on and would otherwise be told nothing when another run blocks or
 * fails. The list reads the same `["runs"]` cache entry, so this is one poll,
 * not two, and the list re-renders from it either way.
 */
export function useRunNotifications(enabled: boolean): void {
  const query = useQuery({
    queryKey: ["runs"],
    queryFn: fetchRuns,
    // A local file read; polling this often is cheap and keeps both the list
    // and the notifications live without a second event stream per run.
    refetchInterval: 4000,
  });
  const previous = useRef<ReadonlyMap<string, string> | null>(null);
  const runs = query.data?.runs;

  useEffect(() => {
    if (runs === undefined) return;
    if (!enabled) {
      // Record the statuses anyway, so turning the toggle on does not fire a
      // burst of notifications for transitions that happened while it was off.
      previous.current = new Map(runs.map((run) => [run.runId, run.status]));
      return;
    }
    previous.current = notifyTransitions(runs, previous.current);
  }, [runs, enabled]);
}
