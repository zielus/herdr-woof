import { createKeyDecoder } from "./keys.js";
import { fitLine, serializeLine } from "./text.js";
import type { Key, Line } from "./types.js";

/**
 * The terminal I/O layer for `woof tui`: owns raw mode, the alternate screen,
 * key decoding and full-frame drawing. Everything it renders is handed to it
 * as `Line[]` by `view.ts`; this module never derives what to show, only how
 * to put it on the screen. `frameString` is kept pure and exported so its
 * exact bytes can be unit tested without a real TTY.
 */

const ESC_FLUSH_MS = 30;

export interface TerminalSize {
  columns: number;
  rows: number;
}

export interface Terminal {
  size(): TerminalSize;
  onKey(callback: (key: Key) => void): void;
  onResize(callback: (size: TerminalSize) => void): void;
  draw(lines: Line[], options: { color: boolean }): void;
  close(): void;
}

/**
 * Builds one full-frame redraw: a synchronized-update block (so a slow
 * terminal never shows a half-painted frame), cursor home, then exactly
 * `rows` lines (a short `lines` pads with blanks), each fitted (padded) to
 * exactly `columns`, separated by `\r\n` (never a trailing one, so the frame
 * cannot scroll the alternate screen). No erase-to-end-of-line: after a full
 * row the cursor sits in the pending-wrap state, where some terminals erase
 * the last column on EL.
 */
export function frameString(lines: Line[], size: TerminalSize, color: boolean): string {
  const { columns, rows } = size;
  const parts: string[] = ["\x1b[?2026h", "\x1b[H"];
  for (let row = 0; row < rows; row++) {
    const fitted = fitLine(lines[row] ?? [], columns);
    parts.push(serializeLine(fitted, { color }));
    if (row < rows - 1) parts.push("\r\n");
  }
  parts.push("\x1b[?2026l");
  return parts.join("");
}

export function openTerminal(input: NodeJS.ReadStream, output: NodeJS.WriteStream): Terminal {
  const keyListeners: Array<(key: Key) => void> = [];
  const resizeListeners: Array<(size: TerminalSize) => void> = [];
  const decoder = createKeyDecoder();
  let escTimer: NodeJS.Timeout | null = null;
  let closed = false;

  function size(): TerminalSize {
    return { columns: output.columns || 80, rows: output.rows || 24 };
  }

  function clearEscTimer(): void {
    if (escTimer !== null) {
      clearTimeout(escTimer);
      escTimer = null;
    }
  }

  function emitKeys(keys: Key[]): void {
    for (const key of keys) for (const listener of keyListeners) listener(key);
  }

  function onData(chunk: string): void {
    emitKeys(decoder.feed(chunk));
    clearEscTimer();
    // A lone ESC is ambiguous with the start of a CSI/SS3 sequence; give the
    // rest of the sequence a short window to arrive before treating it as Escape.
    if (decoder.pending()) {
      escTimer = setTimeout(() => {
        escTimer = null;
        emitKeys(decoder.flush());
      }, ESC_FLUSH_MS);
    }
  }

  function onResize(): void {
    const current = size();
    for (const listener of resizeListeners) listener(current);
  }

  function restore(): void {
    if (input.isTTY) input.setRawMode(false);
    output.write("\x1b[?25h\x1b[?1049l");
    input.pause();
  }

  function onExit(): void {
    if (!closed) restore();
  }

  if (input.isTTY) input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  input.on("data", onData);
  output.on("resize", onResize);
  process.on("exit", onExit);

  // Alternate screen, hidden cursor, normal (non-application) cursor keys and
  // keypad, then a clear so the alternate screen starts blank.
  output.write("\x1b[?1049h\x1b[?25l\x1b[?1l\x1b>\x1b[2J\x1b[H");

  return {
    size,
    onKey(callback) {
      keyListeners.push(callback);
    },
    onResize(callback) {
      resizeListeners.push(callback);
    },
    draw(lines, options) {
      // A redraw scheduled before close must not paint the restored normal screen.
      if (closed) return;
      output.write(frameString(lines, size(), options.color));
    },
    close() {
      if (closed) return;
      closed = true;
      clearEscTimer();
      input.off("data", onData);
      output.off("resize", onResize);
      process.off("exit", onExit);
      restore();
    },
  };
}
