// Observer agreement for live acceptance gate 10 (p4 carry-over G10): compares
// Herdr agent-status samples with the journal snapshot taken at the same time.
//
// A sample row is { at, status, agents: { <agentId>: { herdr, activeAttempt } } }
// where `herdr` is Herdr's agent status ("working", "idle", "gone", or
// "error:<code>") and `activeAttempt` is the snapshot's open attempt or null.
// `records` are journal records; only `submission.accepted` ({ agentId, ts })
// is read.

import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

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

/**
 * The JSON form of a value, which is what a CLI line or a result file carries:
 * null-prototype records become plain objects and undefined members vanish.
 * `deriveRunResult` builds its per-key counters and `lastAcceptedByStage` as
 * null-prototype records, so an in-memory result never deep-strict-equals a
 * parsed one (LV-006); results are compared in this form.
 */
export function jsonForm(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Live gate L4: the `woof status` result and `outcome.json` both equal
 * `deriveRunResult` of the terminal snapshot, compared in JSON form. `read()`
 * returns fresh `{ status, outcome, derived, journal? }` reads, where `journal`
 * describes what that read saw (e.g. `{ records, lastSeq }`). A disagreement is
 * read again up to `attempts` times, `delayMs` apart, before it counts. Each
 * mismatch records the read's journal and, per differing read, the differing
 * top-level fields with both values.
 */
export async function settledResultAgreement(
  read,
  { attempts = 6, delayMs = 5000, sleep = delay } = {},
) {
  const mismatches = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Each read settles before the next one; sequential by design.
    // oxlint-disable-next-line no-await-in-loop
    const { status, outcome, derived, journal = null } = await read();
    const expected = jsonForm(derived);
    const differs = [];
    if (expected === null || expected === undefined) {
      differs.push({ read: "derived", fields: [] });
    } else {
      for (const [name, value] of [
        ["status", status],
        ["outcome.json", outcome],
      ]) {
        const actual = jsonForm(value);
        if (!isDeepStrictEqual(actual, expected))
          differs.push({ read: name, fields: differingFields(actual, expected) });
      }
    }
    if (differs.length === 0) return { pass: true, attempts: attempt, mismatches };
    mismatches.push({ attempt, journal, differs });
    // oxlint-disable-next-line no-await-in-loop
    if (attempt < attempts) await sleep(delayMs);
  }
  return { pass: false, attempts, mismatches };
}

function differingFields(value, expected) {
  if (value === null || value === undefined || typeof value !== "object")
    return [{ field: "(whole value)", value: value ?? null, expected }];
  const keys = new Set([...Object.keys(value), ...Object.keys(expected)]);
  return [...keys]
    .filter((key) => !isDeepStrictEqual(value[key], expected[key]))
    .toSorted()
    .map((field) => ({ field, value: value[field] ?? null, expected: expected[field] ?? null }));
}
