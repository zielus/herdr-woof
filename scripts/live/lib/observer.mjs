// Observer agreement for live acceptance gate 10 (p4 carry-over G10): compares
// Herdr agent-status samples with the journal snapshot taken at the same time.
//
// A sample row is { at, status, agents: { <agentId>: { herdr, activeAttempt } } }
// where `herdr` is Herdr's agent status ("working", "idle", "gone", or
// "error:<code>") and `activeAttempt` is the snapshot's open attempt or null.
// `records` are journal records; only `submission.accepted` ({ agentId, ts })
// is read.

export const DEFAULT_GRACE_MS = 15_000;

const TERMINAL = new Set(["completed", "failed", "cancelled", "exhausted"]);
const GONE = new Set(["gone", "error:not_found"]);

/**
 * Samples that disagree with the journal:
 * - hard: an agent with an open attempt that Herdr reports gone;
 * - soft: Herdr `working` while the agent has no open attempt, unless the
 *   agent's latest acceptance at or before the sample is at most `graceMs`
 *   earlier (the agent is still finishing the turn in which it submitted).
 * Rows of a terminated run are not compared.
 */
export function observerDisagreements(samples, records, { graceMs = DEFAULT_GRACE_MS } = {}) {
  const acceptances = new Map();
  for (const record of records) {
    if (record.type !== "submission.accepted") continue;
    const times = acceptances.get(record.agentId) ?? [];
    times.push(Date.parse(record.ts));
    acceptances.set(record.agentId, times);
  }
  const disagreements = [];
  for (const row of samples) {
    if (TERMINAL.has(row.status)) continue;
    const at = Date.parse(row.at);
    for (const [agentId, value] of Object.entries(row.agents ?? {})) {
      if (value.activeAttempt !== null && value.activeAttempt !== undefined) {
        if (GONE.has(value.herdr)) {
          disagreements.push({ at: row.at, agentId, kind: "hard", herdr: value.herdr });
        }
        continue;
      }
      if (value.herdr !== "working") continue;
      const earlier = (acceptances.get(agentId) ?? []).filter((time) => time <= at);
      const latest = earlier.length === 0 ? undefined : Math.max(...earlier);
      if (latest !== undefined && at - latest <= graceMs) continue;
      disagreements.push({
        at: row.at,
        agentId,
        kind: "soft",
        herdr: value.herdr,
        sinceAcceptedMs: latest === undefined ? null : at - latest,
      });
    }
  }
  return disagreements;
}

/** Whether at least one sample shows the agent `working` with an open attempt. */
export function workingWhileActive(samples, agentId) {
  return samples.some(
    (row) =>
      row.agents?.[agentId]?.herdr === "working" &&
      row.agents[agentId].activeAttempt !== null &&
      row.agents[agentId].activeAttempt !== undefined,
  );
}
