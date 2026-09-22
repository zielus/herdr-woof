import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

// The pure raw-mode key decoder behind `woof tui` (keys.ts). Table-driven over
// every sequence in its contract (TUI-PLAN.md), split across feed() calls at
// every boundary to prove chunking never changes the result.
interface Key {
  name:
    | "up"
    | "down"
    | "left"
    | "right"
    | "home"
    | "end"
    | "pageup"
    | "pagedown"
    | "enter"
    | "escape"
    | "tab"
    | "backtab"
    | "backspace"
    | "char";
  char?: string;
  ctrl?: boolean;
}
interface KeyDecoder {
  feed(chunk: string): Key[];
  pending(): boolean;
  flush(): Key[];
}
interface KeysModule {
  createKeyDecoder: () => KeyDecoder;
  parseKeyName: (name: string) => Key | undefined;
}

let createKeyDecoder: KeysModule["createKeyDecoder"];
let parseKeyName: KeysModule["parseKeyName"];

beforeAll(async () => {
  ({ createKeyDecoder, parseKeyName } = await loadDist<KeysModule>("tui/keys.js"));
});

// Arrows (CSI and SS3), Home/End (CSI direct, CSI ~, SS3), Page Up/Down, Shift+Tab,
// Tab, Enter, Backspace, and CSI arrows/Home/End with an ignored modifier prefix.
const SEQUENCES: Array<[string, Key]> = [
  ["\x1b[A", { name: "up" }],
  ["\x1b[B", { name: "down" }],
  ["\x1b[C", { name: "right" }],
  ["\x1b[D", { name: "left" }],
  ["\x1bOA", { name: "up" }],
  ["\x1bOB", { name: "down" }],
  ["\x1bOC", { name: "right" }],
  ["\x1bOD", { name: "left" }],
  ["\x1b[H", { name: "home" }],
  ["\x1b[F", { name: "end" }],
  ["\x1bOH", { name: "home" }],
  ["\x1bOF", { name: "end" }],
  ["\x1b[1~", { name: "home" }],
  ["\x1b[7~", { name: "home" }],
  ["\x1b[4~", { name: "end" }],
  ["\x1b[8~", { name: "end" }],
  ["\x1b[5~", { name: "pageup" }],
  ["\x1b[6~", { name: "pagedown" }],
  ["\x1b[Z", { name: "backtab" }],
  ["\t", { name: "tab" }],
  ["\r", { name: "enter" }],
  ["\n", { name: "enter" }],
  ["\x7f", { name: "backspace" }],
  ["\b", { name: "backspace" }],
  // A modifier prefix (here: Shift) still decodes to the plain key.
  ["\x1b[1;5A", { name: "up" }],
  ["\x1b[1;2D", { name: "left" }],
];

// Every ctrl letter (\x01-\x1a) except the four with their own key: \b \t \n \r.
const CTRL_LETTERS: Array<[string, Key]> = [];
for (let code = 1; code <= 26; code++) {
  if ([8, 9, 10, 13].includes(code)) continue;
  CTRL_LETTERS.push([
    String.fromCharCode(code),
    { name: "char", char: String.fromCharCode(96 + code), ctrl: true },
  ]);
}

const PRINTABLE: Array<[string, Key]> = [
  ["a", { name: "char", char: "a" }],
  ["Z", { name: "char", char: "Z" }],
  ["5", { name: "char", char: "5" }],
  [" ", { name: "char", char: " " }],
];

const ALL: Array<[string, Key]> = [...SEQUENCES, ...CTRL_LETTERS, ...PRINTABLE];

describe("createKeyDecoder: contract sequences", () => {
  it.each(ALL)("%j decodes to %o in one feed", (seq, expected) => {
    const decoder = createKeyDecoder();
    expect(decoder.feed(seq)).toEqual([expected]);
    expect(decoder.pending()).toBe(false);
  });

  it.each(ALL)("%j decodes to %o however it is split across feed calls", (seq, expected) => {
    for (let i = 1; i < seq.length; i++) {
      const decoder = createKeyDecoder();
      expect(decoder.feed(seq.slice(0, i))).toEqual([]);
      expect(decoder.pending()).toBe(true);
      expect(decoder.feed(seq.slice(i))).toEqual([expected]);
      expect(decoder.pending()).toBe(false);
    }
  });

  it("a chunk carrying several keys decodes all of them, in order", () => {
    const decoder = createKeyDecoder();
    expect(decoder.feed("ab\r\x1b[A\x03")).toEqual([
      { name: "char", char: "a" },
      { name: "char", char: "b" },
      { name: "enter" },
      { name: "up" },
      { name: "char", char: "c", ctrl: true },
    ]);
  });
});

describe("createKeyDecoder: a lone ESC is ambiguous until flushed or completed", () => {
  it("feed keeps a lone ESC pending; flush resolves it as Escape", () => {
    const decoder = createKeyDecoder();
    expect(decoder.feed("\x1b")).toEqual([]);
    expect(decoder.pending()).toBe(true);
    expect(decoder.flush()).toEqual([{ name: "escape" }]);
    expect(decoder.pending()).toBe(false);
  });

  it("ESC followed by [A in a later chunk decodes as up, not as two keys", () => {
    const decoder = createKeyDecoder();
    expect(decoder.feed("\x1b")).toEqual([]);
    expect(decoder.pending()).toBe(true);
    expect(decoder.feed("[A")).toEqual([{ name: "up" }]);
    expect(decoder.pending()).toBe(false);
  });

  it("flush on a decoder with nothing pending returns no keys", () => {
    const decoder = createKeyDecoder();
    expect(decoder.flush()).toEqual([]);
    expect(decoder.pending()).toBe(false);
  });

  it("flush discards an incomplete CSI sequence rather than inventing a key", () => {
    const decoder = createKeyDecoder();
    expect(decoder.feed("\x1b[")).toEqual([]);
    expect(decoder.pending()).toBe(true);
    expect(decoder.flush()).toEqual([]);
    expect(decoder.pending()).toBe(false);
  });

  it("an ESC not followed by [ or O stands alone, and the next byte is reprocessed", () => {
    const decoder = createKeyDecoder();
    expect(decoder.feed("\x1ba")).toEqual([{ name: "escape" }, { name: "char", char: "a" }]);
  });
});

describe("createKeyDecoder: unknown CSI sequences are consumed and dropped", () => {
  it.each([
    "\x1b[9~", // tilde code with no assigned key
    "\x1b[3;3R", // cursor position report
    "\x1b[200~", // bracketed-paste start marker
    "\x1b[?1;2c", // device attributes response (intermediate '?', unmapped final)
  ])("%j decodes to no keys", (seq) => {
    const decoder = createKeyDecoder();
    expect(decoder.feed(seq)).toEqual([]);
    expect(decoder.pending()).toBe(false);
  });

  it("dropping an unknown sequence does not disturb what follows it", () => {
    const decoder = createKeyDecoder();
    expect(decoder.feed("\x1b[9~a")).toEqual([{ name: "char", char: "a" }]);
  });
});

describe("createKeyDecoder: UTF-8 characters wider than one UTF-16 code unit", () => {
  it("é (U+00E9) decodes as one char key", () => {
    expect(createKeyDecoder().feed("é")).toEqual([{ name: "char", char: "é" }]);
  });

  it("✓ (U+2713) decodes as one char key", () => {
    expect(createKeyDecoder().feed("✓")).toEqual([{ name: "char", char: "✓" }]);
  });

  it("an emoji (a surrogate pair) decodes as one char key, not two", () => {
    const emoji = "\u{1F600}"; // 😀, two UTF-16 code units, one code point
    expect(emoji).toHaveLength(2);
    expect(createKeyDecoder().feed(emoji)).toEqual([{ name: "char", char: emoji }]);
  });

  it("mixed single- and multi-unit characters in one chunk decode in order", () => {
    const emoji = "\u{1F600}";
    expect(createKeyDecoder().feed(`a${emoji}é`)).toEqual([
      { name: "char", char: "a" },
      { name: "char", char: emoji },
      { name: "char", char: "é" },
    ]);
  });
});

describe("parseKeyName", () => {
  const NAMES: Array<[string, Key]> = [
    ["up", { name: "up" }],
    ["down", { name: "down" }],
    ["left", { name: "left" }],
    ["right", { name: "right" }],
    ["home", { name: "home" }],
    ["end", { name: "end" }],
    ["pgup", { name: "pageup" }],
    ["pgdn", { name: "pagedown" }],
    ["enter", { name: "enter" }],
    ["esc", { name: "escape" }],
    ["tab", { name: "tab" }],
    ["shift-tab", { name: "backtab" }],
    ["backspace", { name: "backspace" }],
    ["ctrl-c", { name: "char", char: "c", ctrl: true }],
  ];

  it.each(NAMES)("%s -> %o", (name, expected) => {
    expect(parseKeyName(name)).toEqual(expected);
  });

  it("a single printable character parses as a char key", () => {
    expect(parseKeyName("a")).toEqual({ name: "char", char: "a" });
    expect(parseKeyName("✓")).toEqual({ name: "char", char: "✓" });
    expect(parseKeyName("\u{1F600}")).toEqual({ name: "char", char: "\u{1F600}" });
  });

  it("an unrecognized or empty name is undefined", () => {
    expect(parseKeyName("nonsense")).toBeUndefined();
    expect(parseKeyName("")).toBeUndefined();
  });
});
