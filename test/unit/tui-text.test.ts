import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

// Terminal text primitives (pure): display width, clipping/padding/scrolling by
// column, caret-safe file bytes, SGR-to-span parsing (the inverse of
// observe/format.ts's painter), and fitting/serializing a Line.
type Tone = "cyan" | "green" | "amber" | "red" | "dim";
interface Span {
  text: string;
  tone?: Tone;
  bold?: boolean;
  reverse?: boolean;
}
type Line = Span[];

interface TextModule {
  displayWidth(s: string): number;
  clipToWidth(s: string, width: number, ascii?: boolean): string;
  padToWidth(s: string, width: number): string;
  sliceColumns(s: string, start: number, width: number): string;
  caretSafe(s: string): string;
  spansFromSgr(s: string): Line;
  lineWidth(line: Line): number;
  fitLine(line: Line, width: number, ascii?: boolean): Line;
  lineText(line: Line): string;
  serializeLine(line: Line, options: { color: boolean }): string;
}

let mod: TextModule;

beforeAll(async () => {
  mod = await loadDist<TextModule>("tui/text.js");
});

describe("displayWidth", () => {
  const cases: Array<[string, string, number]> = [
    ["empty string", "", 0],
    ["ascii", "abc", 3],
    ["combining mark adds nothing", "é", 1],
    ["zero-width space", "​", 0],
    ["variation selector", "️", 0],
    ["CJK ideograph is wide", "中", 2],
    ["hangul syllable is wide", "가", 2],
    ["emoji is wide", "\u{1f600}", 2],
    ["mixed ascii and wide", "a中b", 4],
    ["box glyph", "│", 1],
    ["arrow glyph", "→", 1],
    ["down arrow glyph", "↓", 1],
    ["bullet glyph", "●", 1],
    ["middle dot glyph", "·", 1],
    ["ellipsis glyph", "…", 1],
    ["chevron glyph", "›", 1],
    ["triangle glyphs", "▸▾", 2],
    ["box corner glyph", "└", 1],
    ["check glyph", "✓", 1],
    ["reload glyph", "↻", 1],
    ["horizontal rule glyph", "─", 1],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => expect(mod.displayWidth(input)).toBe(expected));
  }
});

describe("clipToWidth", () => {
  const cases: Array<[string, string, number, boolean | undefined, string]> = [
    ["fits, unchanged", "hello", 10, undefined, "hello"],
    ["exact fit, unchanged", "hello", 5, undefined, "hello"],
    ["cut with unicode ellipsis", "hello world", 8, undefined, "hello w…"],
    ["cut with ascii ellipsis", "hello world", 8, true, "hello..."],
    ["width zero", "hello", 0, undefined, ""],
    ["negative width", "hello", -3, undefined, ""],
    ["width one, unicode ellipsis alone", "hello", 1, undefined, "…"],
    ["width one, ascii ellipsis truncated", "hello", 1, true, "."],
    ["width two, ascii ellipsis truncated", "hello", 2, true, ".."],
    ["wide chars cut before ellipsis", "中中中", 3, undefined, "中…"],
  ];
  for (const [name, s, width, ascii, expected] of cases) {
    it(name, () => {
      const result =
        ascii === undefined ? mod.clipToWidth(s, width) : mod.clipToWidth(s, width, ascii);
      expect(result).toBe(expected);
      expect(mod.displayWidth(result)).toBeLessThanOrEqual(Math.max(width, 0));
    });
  }
});

describe("padToWidth", () => {
  const cases: Array<[string, string, number, string]> = [
    ["pads with trailing spaces", "ab", 5, "ab   "],
    ["already at width, unchanged", "abcde", 5, "abcde"],
    ["already wider, unchanged", "abcde", 3, "abcde"],
    ["empty string padded fully", "", 3, "   "],
    ["wide char counted as two columns", "中", 5, "中   "],
  ];
  for (const [name, s, width, expected] of cases) {
    it(name, () => expect(mod.padToWidth(s, width)).toBe(expected));
  }
});

describe("sliceColumns", () => {
  const cases: Array<[string, string, number, number, string]> = [
    ["plain middle slice", "hello world", 6, 5, "world"],
    ["from start", "hello world", 0, 5, "hello"],
    ["width zero", "hello", 2, 0, ""],
    ["start past end", "ab", 5, 3, ""],
    ["window past string end returns only what exists", "ab", 1, 5, "b"],
    ["wide char straddles left edge of window", "中abc", 1, 3, " ab"],
    ["wide char straddles right edge of window", "abc中", 0, 4, "abc "],
    ["wide char fully inside window", "a中b", 1, 2, "中"],
  ];
  for (const [name, s, start, width, expected] of cases) {
    it(name, () => expect(mod.sliceColumns(s, start, width)).toBe(expected));
  }
});

describe("caretSafe", () => {
  const cases: Array<[string, string, string]> = [
    ["plain text unchanged", "hello", "hello"],
    ["trailing CR stripped", "hello\r", "hello"],
    ["embedded CR not at end is caret-escaped", "a\rb", "a^Mb"],
    ["tab at column zero expands to next stop", "\tX", "        X"],
    ["tab mid-line expands to next stop of 8", "a\tb", "a       b"],
    ["two tabs advance two stops", "\t\tX", "                X"],
    ["BEL", "\x07", "^G"],
    ["ESC", "\x1b", "^["],
    ["NUL", "\x00", "^@"],
    ["DEL", "\x7f", "^?"],
    ["C1 control", "\x9b", "<U+009B>"],
    ["C1 control at start of range", "\x80", "<U+0080>"],
    ["mixed content", "a\x1bB", "a^[B"],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => expect(mod.caretSafe(input)).toBe(expected));
  }
});

describe("spansFromSgr", () => {
  const cases: Array<[string, string, Line]> = [
    ["plain text, no styling", "hello", [{ text: "hello" }]],
    ["bold", "\x1b[1mBOLD\x1b[0m", [{ text: "BOLD", bold: true }]],
    ["dim tone", "\x1b[2mdim\x1b[0m", [{ text: "dim", tone: "dim" }]],
    ["red tone", "\x1b[31mred\x1b[0m", [{ text: "red", tone: "red" }]],
    ["green tone", "\x1b[32mgreen\x1b[0m", [{ text: "green", tone: "green" }]],
    ["amber tone (SGR 33)", "\x1b[33mamber\x1b[0m", [{ text: "amber", tone: "amber" }]],
    ["cyan tone", "\x1b[36mcyan\x1b[0m", [{ text: "cyan", tone: "cyan" }]],
    [
      "plain text around a styled span",
      "a \x1b[36mb\x1b[0m c",
      [{ text: "a " }, { text: "b", tone: "cyan" }, { text: " c" }],
    ],
    ["empty codes reset like 0", "\x1b[mtext", [{ text: "text" }]],
    ["unknown code ignored, stays unstyled", "\x1b[4munderline\x1b[0m", [{ text: "underline" }]],
    [
      "combined codes in one escape: bold and cyan",
      "\x1b[1;36mBoldCyan\x1b[0m",
      [{ text: "BoldCyan", bold: true, tone: "cyan" }],
    ],
    [
      "adjacent same-style spans merge across a no-op boundary",
      "\x1b[1ma\x1b[1mb\x1b[0m",
      [{ text: "ab", bold: true }],
    ],
    [
      "reset then plain text",
      "\x1b[31mred\x1b[0mplain",
      [{ text: "red", tone: "red" }, { text: "plain" }],
    ],
    ["other control chars become a space", "a\x07b", [{ text: "a b" }]],
    [
      "control char inside a styled span becomes a space",
      "\x1b[31ma\x07b\x1b[0m",
      [{ text: "a b", tone: "red" }],
    ],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => expect(mod.spansFromSgr(input)).toEqual(expected));
  }
});

describe("lineWidth and lineText", () => {
  it("lineWidth sums span display widths", () => {
    expect(mod.lineWidth([{ text: "ab" }, { text: "中" }])).toBe(4);
  });
  it("lineWidth of an empty line is zero", () => {
    expect(mod.lineWidth([])).toBe(0);
  });
  it("lineText concatenates span text, dropping style", () => {
    expect(
      mod.lineText([
        { text: "ab", bold: true },
        { text: "中", tone: "cyan" },
      ]),
    ).toBe("ab中");
  });
  it("lineText of an empty line is empty", () => {
    expect(mod.lineText([])).toBe("");
  });
});

describe("fitLine", () => {
  it("width zero yields an empty line", () => {
    expect(mod.fitLine([{ text: "abc" }], 0)).toEqual([]);
  });

  it("exact fit is returned unchanged, no padding span", () => {
    expect(mod.fitLine([{ text: "abc" }], 3)).toEqual([{ text: "abc" }]);
  });

  it("narrower content is padded with a trailing unstyled span", () => {
    const result = mod.fitLine([{ text: "ab" }], 5);
    expect(result).toEqual([{ text: "ab" }, { text: "   " }]);
    expect(mod.lineWidth(result)).toBe(5);
  });

  it("an empty line fitted to width becomes a single padding span", () => {
    expect(mod.fitLine([], 4)).toEqual([{ text: "    " }]);
  });

  it("wider content is clipped with an ellipsis span, exact width", () => {
    const result = mod.fitLine([{ text: "hello world" }], 8);
    expect(result).toEqual([{ text: "hello w" }, { text: "…" }]);
    expect(mod.lineWidth(result)).toBe(8);
  });

  it("ascii ellipsis when requested", () => {
    const result = mod.fitLine([{ text: "hello world" }], 8, true);
    expect(result).toEqual([{ text: "hello" }, { text: "..." }]);
    expect(mod.lineWidth(result)).toBe(8);
  });

  it("ellipsis inherits the style of the span it cuts into, mid-span", () => {
    const line: Line = [
      { text: "AAAA", tone: "red" },
      { text: "BBBB", tone: "green" },
    ];
    const result = mod.fitLine(line, 6);
    expect(result).toEqual([
      { text: "AAAA", tone: "red" },
      { text: "B", tone: "green" },
      { text: "…", tone: "green" },
    ]);
    expect(mod.lineWidth(result)).toBe(6);
  });

  it("ellipsis inherits the style of the next span even when it contributes no characters", () => {
    const line: Line = [
      { text: "AAAA", tone: "red" },
      { text: "BBBB", tone: "green" },
    ];
    const result = mod.fitLine(line, 5);
    expect(result).toEqual([
      { text: "AAAA", tone: "red" },
      { text: "…", tone: "green" },
    ]);
    expect(mod.lineWidth(result)).toBe(5);
  });

  it("drops empty spans", () => {
    expect(mod.fitLine([{ text: "" }, { text: "ab" }], 4)).toEqual([
      { text: "ab" },
      { text: "  " },
    ]);
  });
});

describe("serializeLine", () => {
  const cases: Array<[string, Line, boolean, string]> = [
    ["unstyled span is raw", [{ text: "hi" }], true, "hi"],
    ["bold, color on", [{ text: "x", bold: true }], true, "\x1b[1mx\x1b[0m"],
    ["tone, color on", [{ text: "x", tone: "cyan" }], true, "\x1b[36mx\x1b[0m"],
    [
      "tone, bold and reverse combine in order, color on",
      [{ text: "x", tone: "red", bold: true, reverse: true }],
      true,
      "\x1b[31;1;7mx\x1b[0m",
    ],
    ["tone dropped without color", [{ text: "x", tone: "cyan" }], false, "x"],
    ["dim tone dropped without color", [{ text: "x", tone: "dim" }], false, "x"],
    ["bold kept without color", [{ text: "x", bold: true }], false, "\x1b[1mx\x1b[0m"],
    ["reverse kept without color", [{ text: "x", reverse: true }], false, "\x1b[7mx\x1b[0m"],
    [
      "tone dropped but bold kept without color",
      [{ text: "x", tone: "green", bold: true }],
      false,
      "\x1b[1mx\x1b[0m",
    ],
    [
      "multiple spans concatenate",
      [{ text: "a" }, { text: "b", tone: "red" }],
      true,
      "a\x1b[31mb\x1b[0m",
    ],
  ];
  for (const [name, line, color, expected] of cases) {
    it(name, () => expect(mod.serializeLine(line, { color })).toBe(expected));
  }
});
