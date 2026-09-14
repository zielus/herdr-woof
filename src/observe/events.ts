import { canonicalJson } from "../contracts/canonical-json.js";
import { readJournalPrefixSettled } from "../journal/journal.js";
import { parseRecordLine, type JournalRecord } from "../journal/records.js";
import { deriveSnapshot, type RunSnapshot } from "../state/snapshot.js";
import { checkCursor, formatCursor, parseCursor, type CursorProblem } from "./cursor.js";

/**
 * Run events (p2 contract, unstable until v1): one event per journal record,
 * with the same type name. There are no synthetic events. A consumer that
 * stores the cursor of the last event it handled can resume without missing a
 * transition; across reconnects delivery is at-least-once, so consumers dedupe
 * by `seq`.
 *
 * Not covered yet: gate evaluation, blocking/unblocking and delivery
 * reconciliation (phase-3 records), runtime lifecycle changes (in-memory
 * overlay only), format repair and work retry, cancellation requests distinct
 * from termination, and observation loss (needs a run owner).
 */

export interface RunEvent {
  schemaVersion: 1;
  kind: "woof.run.event";
  runId: string;
  seq: number;
  ts: string;
  type: JournalRecord["type"];
  /** Cursor positioned after this event. */
  cursor: string;
  subject: { agentId?: string; stageId?: string; visit?: number; attempt?: number };
  /** The record's fields other than schemaVersion, seq, ts and type. */
  data: Record<string, unknown>;
}

export const MAX_EVENTS_LIMIT = 10_000;
const DEFAULT_EVENTS_LIMIT = 1000;

/** Projects records to events; the subject of a duplicate comes from the acceptance it names. */
export function projectEvents(records: readonly JournalRecord[], anchor: string): RunEvent[] {
  const first = records[0];
  const runId = first?.type === "run.opened" ? first.runId : "";
  const acceptedBySeq = new Map<number, JournalRecord>();
  return records.map((record) => {
    if (record.type === "submission.accepted") acceptedBySeq.set(record.seq, record);
    const { schemaVersion: _version, seq, ts, type, ...data } = record;
    return {
      schemaVersion: 1,
      kind: "woof.run.event",
      runId,
      seq,
      ts,
      type,
      cursor: formatCursor(seq, anchor),
      subject: subjectOf(record, acceptedBySeq),
      data,
    };
  });
}

function subjectOf(
  record: JournalRecord,
  acceptedBySeq: Map<number, JournalRecord>,
): RunEvent["subject"] {
  switch (record.type) {
    case "run.opened":
    case "run.terminated":
      return {};
    case "agent.assigned":
      return { agentId: record.agentId };
    case "attempt.opened":
    case "submission.accepted":
    case "request.dispatched":
      return {
        agentId: record.agentId,
        stageId: record.stageId,
        visit: record.visit,
        attempt: record.attempt,
      };
    case "submission.rejected":
      return record.identity === undefined
        ? {}
        : {
            agentId: record.identity.agentId,
            stageId: record.identity.stageId,
            visit: record.identity.visit,
            attempt: record.identity.attempt,
          };
    case "submission.duplicate": {
      const accepted = acceptedBySeq.get(record.acceptedSeq);
      return accepted === undefined ? {} : subjectOf(accepted, acceptedBySeq);
    }
  }
}

/**
 * `run_dir_invalid`: the journal is missing or holds no records.
 * `journal_corrupt`: a complete line is invalid or impossible.
 * `journal_replaced`: the journal's line 1 changed during each of the bounded
 * consecutive reads (three), so there is no stable run to page.
 * A `CursorProblem` means the `after` cursor cannot resume here.
 */
export type ReadEventsResult =
  | { ok: true; events: RunEvent[]; cursor: string; tailPending: boolean }
  | {
      ok: false;
      reason: CursorProblem | "run_dir_invalid" | "journal_corrupt" | "journal_replaced";
      message: string;
    };

/**
 * Reads events after `after` (from the beginning when omitted), at most `limit`
 * (default 1000, at most 10000), without taking the journal lock. The returned
 * cursor is positioned after the last returned event. A journal whose line 1
 * changes while it is read is read again, at most three times in all.
 */
export function readEvents(
  runDir: string,
  options: { after?: string; limit?: number } = {},
): ReadEventsResult {
  const limit = options.limit ?? DEFAULT_EVENTS_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENTS_LIMIT) {
    throw new TypeError(`limit must be an integer between 1 and ${MAX_EVENTS_LIMIT}`);
  }
  const read = readJournalPrefixSettled(runDir);
  if (!read.ok) return { ok: false, reason: read.reason, message: read.message };
  if (read.records.length === 0 || read.anchor === null) {
    return { ok: false, reason: "run_dir_invalid", message: `${runDir} holds no run records` };
  }
  const anchor = read.anchor;
  let afterSeq = 0;
  if (options.after !== undefined) {
    const checked = checkCursor(options.after, { revision: read.records.length, anchor });
    if (!checked.ok) return checked;
    afterSeq = checked.seq;
  }
  const events = projectEvents(read.records, anchor).slice(afterSeq, afterSeq + limit);
  return {
    ok: true,
    events,
    cursor: events.at(-1)?.cursor ?? formatCursor(afterSeq, anchor),
    tailPending: read.tailPending,
  };
}

/** A snapshot together with the records it was derived from, so events can be folded onto it. */
export interface RunProjection {
  snapshot: RunSnapshot;
  records: JournalRecord[];
}

export type FoldEventsResult =
  | { ok: true; projection: RunProjection }
  | { ok: false; reason: "resync_required" | "journal_corrupt"; message: string };

/**
 * Folds events onto a projection (or onto nothing, starting from seq 1) by
 * extending the record list and deriving the snapshot again with the same
 * reducer; there is no second reducer. An event at or below the projection's
 * revision is skipped only when it is the same record already folded
 * (at-least-once delivery). A gap or another run's anchor or run id requires a
 * resync. An envelope that is not `schemaVersion: 1` / `kind: "woof.run.event"`
 * is `journal_corrupt` before its cursor is read. Without a base, the first
 * `run.opened` event's `data.runId` is the run: another envelope `runId`, or a
 * `data.runId` naming another run (with or without a base), is
 * `journal_corrupt`. An event that is not a valid record, whose cursor is not positioned
 * after its own seq, whose `data` carries an envelope field (`schemaVersion`,
 * `seq`, `ts`, `type`), or that conflicts with an already folded record is
 * `journal_corrupt`.
 */
export function foldEvents(
  base: RunProjection | null,
  events: readonly RunEvent[],
): FoldEventsResult {
  const records = base === null ? [] : [...base.records];
  let anchor = base === null ? undefined : parseCursor(base.snapshot.cursor)?.anchor;
  const runId = base?.snapshot.runId;
  // With no base, the stream's own run.opened event names the run every event must belong to.
  const expectedRunId = runId ?? openedRunId(events);
  for (const event of events) {
    if (event.schemaVersion !== 1 || event.kind !== "woof.run.event") {
      return {
        ok: false,
        reason: "journal_corrupt",
        message: `event ${String(event.seq)} is not a schemaVersion 1 woof.run.event envelope`,
      };
    }
    if (base === null && expectedRunId !== undefined && event.runId !== expectedRunId) {
      return {
        ok: false,
        reason: "journal_corrupt",
        message: `event ${event.seq} names run ${String(event.runId)}, not ${expectedRunId}`,
      };
    }
    const dataRunId = isObject(event.data) ? event.data["runId"] : undefined;
    if (expectedRunId !== undefined && dataRunId !== undefined && dataRunId !== expectedRunId) {
      return {
        ok: false,
        reason: "journal_corrupt",
        message: `event ${event.seq} data names run ${String(dataRunId)}, not ${expectedRunId}`,
      };
    }
    const cursor = parseCursor(event.cursor);
    anchor ??= cursor?.anchor;
    if (
      cursor === undefined ||
      cursor.anchor !== anchor ||
      (runId !== undefined && event.runId !== runId)
    ) {
      return {
        ok: false,
        reason: "resync_required",
        message: `event ${event.seq} belongs to another run`,
      };
    }
    if (cursor.seq !== event.seq) {
      return {
        ok: false,
        reason: "journal_corrupt",
        message: `event ${event.seq} carries cursor ${event.cursor}, which is not positioned after it`,
      };
    }
    const record = recordOf(event);
    if (typeof record === "string") {
      return { ok: false, reason: "journal_corrupt", message: `event ${event.seq}: ${record}` };
    }
    if (event.seq <= records.length) {
      // At-least-once delivery: a repeat must be the record already folded at that seq.
      const existing = records[event.seq - 1];
      if (existing === undefined || canonicalJson(existing) !== canonicalJson(record)) {
        return {
          ok: false,
          reason: "journal_corrupt",
          message: `event ${event.seq} conflicts with the record already folded at that seq`,
        };
      }
      continue;
    }
    if (event.seq !== records.length + 1) {
      return {
        ok: false,
        reason: "resync_required",
        message: `event ${event.seq} does not follow ${records.length}`,
      };
    }
    records.push(record);
  }
  if (anchor === undefined) {
    return { ok: false, reason: "resync_required", message: "no projection and no events to fold" };
  }
  const derived = deriveSnapshot(records, { anchor });
  if (!derived.ok) return { ok: false, reason: "journal_corrupt", message: derived.message };
  return { ok: true, projection: { snapshot: derived.snapshot, records } };
}

const ENVELOPE_FIELDS = ["schemaVersion", "seq", "ts", "type"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The run id carried by the first run.opened event, if any. */
function openedRunId(events: readonly RunEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== "run.opened" || !isObject(event.data)) continue;
    const runId = event.data["runId"];
    return typeof runId === "string" ? runId : undefined;
  }
  return undefined;
}

/** The journal record an event stands for; the event's envelope fields are authoritative. */
function recordOf(event: RunEvent): JournalRecord | string {
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return "data must be an object";
  }
  for (const field of ENVELOPE_FIELDS) {
    if (Object.hasOwn(data, field)) return `data must not carry the envelope field ${field}`;
  }
  return parseRecordLine(
    JSON.stringify({
      ...data,
      schemaVersion: 1,
      seq: event.seq,
      ts: event.ts,
      type: event.type,
    }),
  );
}
