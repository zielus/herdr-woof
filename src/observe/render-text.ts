import { painter, sanitize, text, type Style } from "./format.js";

/**
 * Text primitives shared by the human run view (pure): marks with their ASCII
 * fallback, restrained coloring, word wrapping under a column, durations, and
 * the `~` shortening of a run directory. Nothing here reads the process.
 */

export interface RenderOptions {
  /** SGR colors on the mark and the message only. */
  color: boolean;
  /** `+ -> v ~ ! .` instead of `+ → ✓ ↻ ! ·` (and `->` for every arrow in text). */
  ascii: boolean;
  /** Input preview: the task title with a criteria count, or indented JSON. */
  input: "summary" | "json";
  /** Terminal width the rows wrap to; 80 when unknown. */
  width: number;
  /** IANA time zone for row times; local time when omitted. */
  timeZone?: string;
  /** The home directory `~` stands for in the run directory line; none when omitted. */
  home?: string;
  /** Lines of the JSON input preview before it is cut; 24 by default. */
  jsonPreviewLines?: number;
}

export const DEFAULT_WIDTH = 80;
const MIN_WIDTH = 40;

/** Row marks: the design's symbols, or their ASCII stand-ins. */
export interface Marks {
  start: string;
  dispatch: string;
  ok: string;
  retry: string;
  alert: string;
  dot: string;
  received: string;
  /** Column width of a mark: 1, or 2 when the ASCII arrow is `->`. */
  width: number;
}

const UNICODE_MARKS: Marks = {
  start: "+",
  dispatch: "→",
  ok: "✓",
  retry: "↻",
  alert: "!",
  dot: "·",
  received: "↓",
  width: 1,
};

const ASCII_MARKS: Marks = {
  start: "+",
  dispatch: "->",
  ok: "v",
  retry: "~",
  alert: "!",
  dot: ".",
  received: ".",
  width: 2,
};

export function marksFor(ascii: boolean): Marks {
  return ascii ? ASCII_MARKS : UNICODE_MARKS;
}

/** Text arrows and separators in their ASCII spelling; the identity when ASCII is off. */
export function plainText(value: string, ascii: boolean): string {
  if (!ascii) return value;
  return value
    .replaceAll("→", "->")
    .replaceAll("↘", "->")
    .replaceAll("·", "-")
    .replaceAll("…", "...");
}

/** Whether the locale variables name a UTF-8 charset; unset variables do not deny Unicode. */
export function unicodeEnabled(env: Record<string, string | undefined>): boolean {
  const locale = [env["LC_ALL"], env["LC_CTYPE"], env["LANG"]].find(
    (value) => value !== undefined && value !== "",
  );
  if (locale === undefined) return true;
  return /utf-?8/i.test(locale);
}

export function clampWidth(width: number | undefined): number {
  if (width === undefined || !Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.floor(width));
}

export type Paint = (value: string, style: Style | undefined) => string;

export function paintFor(color: boolean): Paint {
  return painter(color);
}

/** Column geometry and painting shared by every part of the view. */
export interface Layout {
  marks: Marks;
  paint: Paint;
  options: RenderOptions;
  participantWidth: number;
  stageWidth: number;
  /** Characters before the message column. */
  prefixWidth: number;
  messageWidth: number;
}

export { sanitize, text, type Style };

/**
 * Wraps `message` into lines of at most `width` characters on spaces; a word
 * longer than the width is split. Never returns an empty list.
 */
export function wrap(message: string, width: number): string[] {
  const limit = Math.max(8, width);
  const lines: string[] = [];
  let current = "";
  for (const word of message.split(" ")) {
    if (word === "") continue;
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= limit) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
    while (current.length > limit) {
      lines.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }
  lines.push(current);
  return lines;
}

/** `snake_case_reason` → `snake case reason`. */
export function words(reason: unknown): string {
  return text(reason).replaceAll("_", " ");
}

export function capitalized(value: string): string {
  return value === "" ? value : value[0]!.toUpperCase() + value.slice(1);
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** `1h 2m`, `45m`, `1m 33s`, `12s`; whole units only, zero units omitted. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (hours === 0 && seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

/** The path with `home` (a directory) replaced by `~` when it lies under it. */
export function shortenHome(path: string, home: string | undefined): string {
  if (home === undefined || home === "" || home === "/") return path;
  const base = home.endsWith("/") ? home.slice(0, -1) : home;
  if (path === base) return "~";
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}

export function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
