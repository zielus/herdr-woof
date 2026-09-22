import type { Key } from "./types.js";

/**
 * Decodes raw-mode terminal input (p-tui): UTF-8 string chunks from stdin,
 * possibly split mid-sequence by the pty, become the `Key` values `state.ts`
 * consumes. Recognizes cursor keys (CSI `A`-`D` and SS3 `O` `A`-`D`),
 * Home/End (CSI `H`/`F`, CSI `1~`/`4~`/`7~`/`8~`, SS3 `H`/`F`), Page Up/Down
 * (CSI `5~`/`6~`), Shift+Tab (CSI `Z`), Tab, Enter, Backspace, ctrl letters
 * and printable code points (including surrogate-pair characters, kept whole).
 * A modifier prefix in a CSI sequence (`1;5A`) still decodes to the plain key:
 * the TUI has no modifier-specific bindings. Unknown CSI sequences are
 * consumed and dropped rather than surfaced as garbage characters.
 *
 * A lone ESC cannot be told apart from the start of a CSI/SS3 sequence until
 * either the next byte arrives or nothing more is coming. `feed` leaves it
 * pending; the caller (`terminal.ts`) resolves it by calling `flush` after a
 * short quiet period.
 */

export interface KeyDecoder {
  /** Feeds one chunk of decoded UTF-8 input, returning the keys it completes. */
  feed(chunk: string): Key[];
  /** True while a partial sequence (a lone ESC, or an unterminated CSI/SS3) is buffered. */
  pending(): boolean;
  /** Resolves a pending lone ESC as the Escape key; any other partial sequence is discarded. */
  flush(): Key[];
}

const CTRL_EXCLUDED = new Set([0x08, 0x09, 0x0a, 0x0d]); // \b \t \n \r have their own keys

function isCsiParamOrIntermediate(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  return (code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f);
}

function decodeCsi(params: string, final: string): Key | undefined {
  switch (final) {
    case "A":
      return { name: "up" };
    case "B":
      return { name: "down" };
    case "C":
      return { name: "right" };
    case "D":
      return { name: "left" };
    case "H":
      return { name: "home" };
    case "F":
      return { name: "end" };
    case "Z":
      return { name: "backtab" };
    case "~":
      switch (params.split(";")[0]) {
        case "1":
        case "7":
          return { name: "home" };
        case "4":
        case "8":
          return { name: "end" };
        case "5":
          return { name: "pageup" };
        case "6":
          return { name: "pagedown" };
        default:
          return undefined;
      }
    default:
      return undefined;
  }
}

function decodeSs3(letter: string): Key | undefined {
  switch (letter) {
    case "A":
      return { name: "up" };
    case "B":
      return { name: "down" };
    case "C":
      return { name: "right" };
    case "D":
      return { name: "left" };
    case "H":
      return { name: "home" };
    case "F":
      return { name: "end" };
    default:
      return undefined;
  }
}

export function createKeyDecoder(): KeyDecoder {
  let buffer = "";

  /** Consumes as much of `buffer` as decodes unambiguously, leaving any partial tail. */
  function drain(): Key[] {
    const keys: Key[] = [];
    while (buffer.length > 0) {
      const ch = buffer[0]!;
      if (ch === "\x1b") {
        if (buffer.length === 1) break; // lone ESC: wait for more input, or a flush
        const next = buffer[1]!;
        if (next === "[") {
          let i = 2;
          while (i < buffer.length && isCsiParamOrIntermediate(buffer[i]!)) i++;
          if (i >= buffer.length) break; // CSI not terminated yet
          const key = decodeCsi(buffer.slice(2, i), buffer[i]!);
          if (key) keys.push(key);
          buffer = buffer.slice(i + 1);
          continue;
        }
        if (next === "O") {
          if (buffer.length < 3) break; // SS3 letter not arrived yet
          const key = decodeSs3(buffer[2]!);
          if (key) keys.push(key);
          buffer = buffer.slice(3);
          continue;
        }
        // ESC not followed by a known introducer: it stands alone as Escape,
        // and the rest of the buffer is reprocessed from the next character.
        keys.push({ name: "escape" });
        buffer = buffer.slice(1);
        continue;
      }
      if (ch === "\t") {
        keys.push({ name: "tab" });
        buffer = buffer.slice(1);
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        keys.push({ name: "enter" });
        buffer = buffer.slice(1);
        continue;
      }
      if (ch === "\x7f" || ch === "\b") {
        keys.push({ name: "backspace" });
        buffer = buffer.slice(1);
        continue;
      }
      const code = ch.codePointAt(0)!;
      if (code >= 0x01 && code <= 0x1a && !CTRL_EXCLUDED.has(code)) {
        keys.push({ name: "char", char: String.fromCharCode(code + 96), ctrl: true });
        buffer = buffer.slice(1);
        continue;
      }
      // A printable code point: take it whole, so a surrogate pair (an emoji)
      // is one character, not two unmatched halves.
      const point = buffer.codePointAt(0)!;
      const text = String.fromCodePoint(point);
      keys.push({ name: "char", char: text });
      buffer = buffer.slice(text.length);
    }
    return keys;
  }

  return {
    feed(chunk: string): Key[] {
      buffer += chunk;
      return drain();
    },
    pending(): boolean {
      return buffer.length > 0;
    },
    flush(): Key[] {
      const wasLoneEscape = buffer === "\x1b";
      buffer = "";
      return wasLoneEscape ? [{ name: "escape" }] : [];
    },
  };
}

const NAMED_KEYS: Record<string, Key> = {
  up: { name: "up" },
  down: { name: "down" },
  left: { name: "left" },
  right: { name: "right" },
  home: { name: "home" },
  end: { name: "end" },
  pgup: { name: "pageup" },
  pgdn: { name: "pagedown" },
  enter: { name: "enter" },
  esc: { name: "escape" },
  tab: { name: "tab" },
  "shift-tab": { name: "backtab" },
  backspace: { name: "backspace" },
  "ctrl-c": { name: "char", char: "c", ctrl: true },
};

/** For the `--frames` script: a key by name, or a single printable character. */
export function parseKeyName(name: string): Key | undefined {
  const known = NAMED_KEYS[name];
  if (known) return known;
  if ([...name].length === 1) return { name: "char", char: name };
  return undefined;
}
