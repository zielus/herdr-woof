import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

// frameString (terminal.ts): the pure part of the terminal I/O layer, building
// the exact bytes of one full-frame redraw. Real raw-mode/alt-screen behavior
// is exercised by the lead through a PTY, not here. Lines use plain spans only
// (no tone/bold/reverse), so the expected string does not depend on text.ts's
// SGR choices.
interface Span {
  text: string;
}
type Line = Span[];
interface TerminalSize {
  columns: number;
  rows: number;
}
interface TerminalModule {
  frameString: (lines: readonly Line[], size: TerminalSize, color: boolean) => string;
}

let frameString: TerminalModule["frameString"];

beforeAll(async () => {
  ({ frameString } = await loadDist<TerminalModule>("tui/terminal.js"));
});

const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const HOME = "\x1b[H";

describe("frameString", () => {
  it("wraps the frame in a synchronized-update block starting at cursor home", () => {
    const result = frameString([[{ text: "hi" }]], { columns: 2, rows: 1 }, false);
    expect(result.startsWith(`${SYNC_BEGIN}${HOME}`)).toBe(true);
    expect(result.endsWith(SYNC_END)).toBe(true);
  });

  it("pads a short line to the column count and a missing row to a blank one", () => {
    const result = frameString([[{ text: "hi" }]], { columns: 5, rows: 2 }, false);
    expect(result).toBe(`${SYNC_BEGIN}${HOME}hi   \r\n     ${SYNC_END}`);
  });

  it("clips a line wider than the columns with an ellipsis, still exactly the column count", () => {
    const result = frameString([[{ text: "hello world" }]], { columns: 5, rows: 1 }, false);
    expect(result).toBe(`${SYNC_BEGIN}${HOME}hell…${SYNC_END}`);
  });

  it("joins multiple spans on a row and separates rows with \\r\\n, never after the last row", () => {
    const result = frameString(
      [[{ text: "a" }, { text: "bc" }], [{ text: "xyz" }]],
      { columns: 3, rows: 3 },
      false,
    );
    expect(result).toBe(`${SYNC_BEGIN}${HOME}abc\r\nxyz\r\n   ${SYNC_END}`);
  });

  it("zero rows produces no line content, only the synchronized-update markers", () => {
    expect(frameString([[{ text: "x" }]], { columns: 5, rows: 0 }, false)).toBe(
      `${SYNC_BEGIN}${HOME}${SYNC_END}`,
    );
  });

  it("color true or false makes no difference for plain spans (no tone, bold or reverse)", () => {
    const lines = [[{ text: "a" }, { text: "bc" }], [{ text: "xyz" }]];
    const size = { columns: 4, rows: 2 };
    expect(frameString(lines, size, true)).toBe(frameString(lines, size, false));
  });
});
