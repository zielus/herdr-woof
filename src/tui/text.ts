import type { Line, Span, Tone } from "./types.js";

/**
 * Terminal text primitives for the TUI (pure: no I/O, no process access). Handles
 * display-column width (East Asian wide/fullwidth and emoji count as two columns,
 * combining and zero-width marks count as zero), clipping and padding to a column
 * count, horizontal scrolling by column, making arbitrary file bytes safe to print
 * (caret notation, never an executed escape sequence), converting the observe
 * formatter's painted strings (`\x1b[<n>m…\x1b[0m`) into spans, and fitting and
 * serializing a `Line` for the terminal renderer.
 */

// C0 and C1 control characters, DEL included.
// oxlint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
const COMBINING_RE = /^[\p{Mn}\p{Me}]$/u;

/** Terminal columns a string occupies (multi-line input is not expected). */
export function displayWidth(s: string): number {
  let width = 0;
  for (const ch of s) width += codePointWidth(ch.codePointAt(0) ?? 0);
  return width;
}

function codePointWidth(cp: number): number {
  if (isZeroWidth(cp)) return 0;
  if (isWide(cp)) return 2;
  return 1;
}

function isZeroWidth(cp: number): boolean {
  if (cp >= 0x200b && cp <= 0x200f) return true;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true;
  return COMBINING_RE.test(String.fromCodePoint(cp));
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff)
  );
}

/** Clips `s` to fit within `width` columns, without splitting a code point. */
function clipPlain(s: string, width: number): string {
  if (width <= 0) return "";
  let out = "";
  let used = 0;
  for (const ch of s) {
    const w = displayWidth(ch);
    if (used + w > width) break;
    out += ch;
    used += w;
  }
  return out;
}

/** Cuts `s` to `width` columns, appending an ellipsis only when it was cut. */
export function clipToWidth(s: string, width: number, ascii = false): string {
  if (width <= 0) return "";
  if (displayWidth(s) <= width) return s;
  const ellipsis = ascii ? "..." : "…";
  if (displayWidth(ellipsis) > width) return clipPlain(ellipsis, width);
  return clipPlain(s, width - displayWidth(ellipsis)) + ellipsis;
}

/** Pads `s` on the right with spaces to `width` columns; never truncates. */
export function padToWidth(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

/**
 * The columns `[start, start + width)` of `s`. A wide character straddling
 * either edge of the window is replaced by spaces for the columns it exposes,
 * so the result never contains a split (garbled) wide character.
 */
export function sliceColumns(s: string, start: number, width: number): string {
  if (width <= 0) return "";
  const end = start + width;
  let out = "";
  let pos = 0;
  for (const ch of s) {
    const w = displayWidth(ch);
    const chEnd = pos + w;
    if (pos >= end) break;
    const overlap = Math.min(chEnd, end) - Math.max(pos, start);
    if (overlap > 0) out += overlap === w ? ch : " ".repeat(overlap);
    pos = chEnd;
  }
  return out;
}

/**
 * File content line made safe for the terminal: tabs expand to 8-column stops,
 * C0/DEL controls print in caret notation, C1 controls print as `<U+00xx>`, and
 * a trailing `\r` (from a CRLF line) is dropped. Nothing else is changed, so an
 * embedded escape sequence is shown, never executed.
 */
export function caretSafe(s: string): string {
  const body = s.endsWith("\r") ? s.slice(0, -1) : s;
  let out = "";
  let col = 0;
  for (const ch of body) {
    const c = ch.codePointAt(0) ?? 0;
    let rep: string;
    if (c === 0x09) {
      const next = (Math.floor(col / 8) + 1) * 8;
      rep = " ".repeat(next - col);
    } else if (c <= 0x1f) {
      rep = "^" + String.fromCharCode(c + 64);
    } else if (c === 0x7f) {
      rep = "^?";
    } else if (c >= 0x80 && c <= 0x9f) {
      rep = `<U+${c.toString(16).toUpperCase().padStart(4, "0")}>`;
    } else {
      rep = ch;
    }
    out += rep;
    col += displayWidth(rep);
  }
  return out;
}

// oxlint-disable-next-line no-control-regex
const SGR_RE = /\x1b\[([0-9;]*)m/g;

interface SgrState {
  bold: boolean;
  tone: Tone | undefined;
}

function applyCodes(codesStr: string, state: SgrState): void {
  for (const part of codesStr.split(";")) {
    const code = Number(part);
    switch (code) {
      case 0:
        state.bold = false;
        state.tone = undefined;
        break;
      case 1:
        state.bold = true;
        break;
      case 2:
        state.tone = "dim";
        break;
      case 31:
        state.tone = "red";
        break;
      case 32:
        state.tone = "green";
        break;
      case 33:
        state.tone = "amber";
        break;
      case 36:
        state.tone = "cyan";
        break;
      default:
        break; // unsupported code: ignored
    }
  }
}

function sanitizeControls(s: string): string {
  return s.replace(CONTROL_RE, " ");
}

function sameStyle(a: Span, b: Span): boolean {
  return (
    (a.bold ?? false) === (b.bold ?? false) &&
    a.tone === b.tone &&
    (a.reverse ?? false) === (b.reverse ?? false)
  );
}

function appendSpan(spans: Span[], span: Span): void {
  const prev = spans[spans.length - 1];
  if (prev !== undefined && sameStyle(prev, span)) {
    prev.text += span.text;
    return;
  }
  spans.push(span);
}

function pushText(spans: Span[], raw: string, state: SgrState): void {
  const cleaned = sanitizeControls(raw);
  if (cleaned.length === 0) return;
  const span: Span = { text: cleaned };
  if (state.bold) span.bold = true;
  if (state.tone !== undefined) span.tone = state.tone;
  appendSpan(spans, span);
}

/**
 * Converts a string painted by `painter(true)` (observe/format.ts) into spans:
 * `\x1b[<codes>m` sets style (`0` or empty resets; 1 bold, 2 dim, 31 red, 32
 * green, 33 amber, 36 cyan; other codes ignored), any other control character
 * becomes a space, and adjacent text with the same resulting style is merged.
 */
export function spansFromSgr(s: string): Line {
  const spans: Span[] = [];
  const state: SgrState = { bold: false, tone: undefined };
  let last = 0;
  SGR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_RE.exec(s)) !== null) {
    pushText(spans, s.slice(last, match.index), state);
    applyCodes(match[1] ?? "", state);
    last = SGR_RE.lastIndex;
  }
  pushText(spans, s.slice(last), state);
  return spans;
}

/** Total display width of a line's spans. */
export function lineWidth(line: Line): number {
  let width = 0;
  for (const span of line) width += displayWidth(span.text);
  return width;
}

/** Plain text of a line, styles dropped. */
export function lineText(line: Line): string {
  return line.map((span) => span.text).join("");
}

function padInPlace(out: Span[], width: number): void {
  const pad = width - lineWidth(out);
  if (pad > 0) out.push({ text: " ".repeat(pad) });
}

/**
 * Fits `line` to exactly `width` columns: clips across spans (the ellipsis
 * inherits the style of the span it cuts into) when too wide, then pads with a
 * trailing unstyled span when narrower, so `lineWidth(result) === width`.
 * `width <= 0` yields an empty line.
 */
export function fitLine(line: Line, width: number, ascii = false): Line {
  if (width <= 0) return [];
  const total = lineWidth(line);
  if (total <= width) {
    const out: Span[] = [];
    for (const span of line) if (span.text.length > 0) out.push({ ...span });
    padInPlace(out, width);
    return out;
  }
  const ellipsisRaw = ascii ? "..." : "…";
  const ellipsisText =
    displayWidth(ellipsisRaw) <= width ? ellipsisRaw : clipPlain(ellipsisRaw, width);
  const ellipsisWidth = displayWidth(ellipsisText);
  const budget = width - ellipsisWidth;
  const out: Span[] = [];
  let used = 0;
  let cutStyle: Span = { text: "" };
  for (const span of line) {
    if (span.text.length === 0) continue;
    const available = budget - used;
    if (available <= 0) {
      cutStyle = span;
      break;
    }
    const w = displayWidth(span.text);
    if (w <= available) {
      out.push({ ...span });
      used += w;
      continue;
    }
    const clipped = clipPlain(span.text, available);
    if (clipped.length > 0) out.push({ ...span, text: clipped });
    used += displayWidth(clipped);
    cutStyle = span;
    break;
  }
  out.push({ ...cutStyle, text: ellipsisText });
  padInPlace(out, width);
  return out;
}

const TONE_CODE: Record<Tone, string> = {
  cyan: "36",
  green: "32",
  amber: "33",
  red: "31",
  dim: "2",
};

/**
 * Serializes a line to a terminal string: a span gets an SGR prefix only when
 * it has an active attribute (with color: tone, then bold `1`, then reverse
 * `7`, joined by `;`, reset after; without color: bold and reverse only, tone
 * dropped since reverse — not color — carries selection). Unstyled spans are
 * emitted raw.
 */
export function serializeLine(line: Line, options: { color: boolean }): string {
  let out = "";
  for (const span of line) {
    const codes: string[] = [];
    if (options.color && span.tone !== undefined) codes.push(TONE_CODE[span.tone]);
    if (span.bold === true) codes.push("1");
    if (span.reverse === true) codes.push("7");
    out += codes.length === 0 ? span.text : `\x1b[${codes.join(";")}m${span.text}\x1b[0m`;
  }
  return out;
}
