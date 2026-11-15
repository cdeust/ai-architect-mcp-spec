/**
 * `trackItems` (#118): the list items open at each line of a section, read
 * by `measurable_requirements`. Each case fails if the branch it names is
 * removed (PR #285 review, note 3).
 */
import { describe, it, expect } from "vitest";
import { LIST_ITEM, blockAfter, trackItems, type BlockState } from "../hard-output-rules/rules/measurable-list-items.js";

/** The block `blockAfter` leaves open after `lines`, following their list items with `trackItems`. */
const blockOf = (lines: readonly string[]): { block: BlockState; open: number[] } => {
  const open: number[] = [];
  let block: BlockState = "none";
  for (const line of lines) {
    const depth = open.length;
    trackItems(open, line, block === "paragraph");
    block = blockAfter(line, block, open, !LIST_ITEM.test(line) && open.length < depth);
  }
  return { block, open };
};

/** `trackItems` on `line` after `before`, with the paragraph state `blockAfter` gives. */
const track = (open: number[], line: string, ...before: string[]): number =>
  trackItems(open, line, blockOf(before).block === "paragraph");

describe("trackItems (#118)", () => {
  it("closes the items a heading is left of, even right after a line of text", () => {
    const open = [3];
    expect(track(open, "## Next", "   text")).toBe(0);
    expect(open).toEqual([]);
  });

  it("closes the items a table row is left of, even right after a line of text", () => {
    const open = [3];
    expect(track(open, "| FR-001 | Copy. |", "   text")).toBe(0);
    expect(open).toEqual([]);
  });

  it("keeps the items open at a line of text right after another (a lazy continuation)", () => {
    const open = [3];
    expect(track(open, "more text", "   text")).toBe(0);
    expect(open).toEqual([3]);
  });

  it("opens no item from a marker 4 columns right of its container", () => {
    const open = [3];
    expect(track(open, "       - code", "   text")).toBe(0);
    expect(open).toEqual([3]);
  });

  it("returns the parent of an item nested at depth 3, not the outermost item", () => {
    const open = [3, 6];
    expect(track(open, "      - NFR-001: Search must be fast.", "   1. text")).toBe(6);
    expect(open).toEqual([3, 6, 8]);
  });

  it("opens an ordered item other than 1 after a line of text only as a sibling left of the open item's content", () => {
    const none: number[] = [];
    expect(track(none, "2. note", "Text line")).toBe(0);
    expect(none).toEqual([]);
    const one: number[] = [];
    track(one, "1. note", "Text line");
    expect(one).toEqual([3]);
    const sibling = [4];
    track(sibling, "2. next", "    wrapped text");
    expect(sibling).toEqual([3]);
    const nested = [3];
    track(nested, "   2. not a list", "   wrapped text");
    expect(nested).toEqual([3]);
    const afterBlank: number[] = [];
    track(afterBlank, "2. note", "");
    expect(afterBlank).toEqual([3]);
    const afterHeading: number[] = [];
    track(afterHeading, "2. note", "## Heading");
    expect(afterHeading).toEqual([3]);
    const afterRow: number[] = [];
    track(afterRow, "2. note", "| a | b |");
    expect(afterRow).toEqual([3]);
    for (const end of ["---", "***", "_ _ _"]) {
      const afterBreak: number[] = [];
      track(afterBreak, "2. note", "Text line", "", end);
      expect(afterBreak).toEqual([3]);
    }
    for (const underline of ["===", "---"]) {
      const underlined: number[] = [];
      track(underlined, "2. note", "Title", underline);
      expect(underlined).toEqual([3]);
    }
    for (const before of [["==="], ["Intro.", "", "==="], ["## Heading", "==="]]) {
      const equalsText: number[] = [];
      track(equalsText, "2. note", ...before);
      expect(equalsText).toEqual([]);
    }
  });

  it("closes the items a thematic break is left of, and reads `* * *` and `- - -` as breaks, not items (PR #288 review, note 3)", () => {
    for (const rule of ["---", "***", "* * *", "- - -"]) {
      const open = [2];
      expect(track(open, rule, "- Intro")).toBe(0);
      expect(open).toEqual([]);
    }
    const inside = [2];
    track(inside, "  ---", "- Intro");
    expect(inside).toEqual([2]);
  });
});

describe("trackItems where no paragraph is open (#118)", () => {
  it("closes the items a line is left of right after a table row (PR #289 review, note 2)", () => {
    const open = [2];
    expect(track(open, "Left", "- Item", "  | a |")).toBe(0);
    expect(open).toEqual([]);
  });

  it("keeps the items open at a lazy line right after paragraph text", () => {
    const open = [2];
    expect(track(open, "Left", "- Item", "  text")).toBe(0);
    expect(open).toEqual([2]);
  });
});

describe("blockAfter (#118)", () => {
  it("reads a line under a table row as a row of the table, `===` included (PR #288 review, note 1)", () => {
    expect(blockOf(["| ID | Note |", "|----|------|", "| X | y |", "==="]).block).toBe("table");
    expect(blockOf(["| X | y |", "text"]).block).toBe("table");
    expect(blockOf(["| X | y |", "2. Group"]).block).toBe("paragraph");
    expect(blockOf(["| X | y |", ""]).block).toBe("none");
  });

  it("ends a table at a block quote and at a line left of the item the table is in (PR #289 review, note 2)", () => {
    expect(blockOf(["| X | y |", "> quote"]).block).toBe("paragraph");
    expect(blockOf(["- Item", "  | a |", "Left"]).block).toBe("paragraph");
    expect(blockOf(["- Item", "  | a |", "  text"]).block).toBe("table");
  });

  it("leaves a paragraph open after a block quote only when it holds paragraph text (PR #292 review, Codex P2)", () => {
    expect(blockOf(["| X | y |", ">"]).block).toBe("none");
    expect(blockOf(["| X | y |", "> # Note"]).block).toBe("none");
    expect(blockOf(["| X | y |", "> > ---"]).block).toBe("none");
    expect(blockOf(["Text", "> quote"]).block).toBe("paragraph");
  });

  it("reads a lazy `===` under a list item as paragraph text, and one at the item's content as an underline (PR #288 review, note 2)", () => {
    expect(blockOf(["- Intro", "==="]).block).toBe("paragraph");
    expect(blockOf(["- Intro", "  ==="]).block).toBe("none");
    expect(blockOf(["Intro", "==="]).block).toBe("none");
    expect(blockOf(["Intro", "    ==="]).block).toBe("paragraph");
  });
});

