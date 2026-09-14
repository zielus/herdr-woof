import { formatCursor, parseCursor } from "../state/snapshot.js";

export { formatCursor, parseCursor };

/**
 * Why a stored cursor cannot resume against the current journal. Every reason
 * means "take a new snapshot". `cursor_expired` is reserved: p2 never compacts
 * the journal, so it is never produced yet.
 */
export type CursorProblem =
  "cursor_ahead" | "cursor_foreign" | "cursor_malformed" | "cursor_expired";

export type CursorCheck =
  { ok: true; seq: number } | { ok: false; reason: CursorProblem; message: string };

/**
 * Checks a cursor `v1.<seq>.<anchor>` against the journal head. A different
 * anchor is another run at this path (`cursor_foreign`); a seq beyond the head
 * means the journal was truncated or replaced (`cursor_ahead`).
 */
export function checkCursor(
  cursor: string,
  head: { revision: number; anchor: string },
): CursorCheck {
  const parsed = parseCursor(cursor);
  if (parsed === undefined) {
    return {
      ok: false,
      reason: "cursor_malformed",
      message: `cursor ${JSON.stringify(cursor)} is not v1.<seq>.<anchor>`,
    };
  }
  if (parsed.anchor !== head.anchor) {
    return {
      ok: false,
      reason: "cursor_foreign",
      message: `cursor belongs to run anchor ${parsed.anchor}, not ${head.anchor}`,
    };
  }
  if (parsed.seq > head.revision) {
    return {
      ok: false,
      reason: "cursor_ahead",
      message: `cursor seq ${parsed.seq} is beyond the journal head ${head.revision}`,
    };
  }
  return { ok: true, seq: parsed.seq };
}
