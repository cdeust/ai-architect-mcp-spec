/**
 * `trackItems` (#118): the list items open at each line of a section, read
 * by `measurable_requirements`. Each case fails if the branch it names is
 * removed (PR #285 review, note 3).
 */
import { describe, it, expect } from "vitest";
import { paragraphAfter, trackItems } from "../hard-output-rules/rules/measurable-list-items.js";

/** `trackItems` on `line` after `before`, with the paragraph state `paragraphAfter` gives. */
const track = (open: number[], line: string, ...before: string[]): number =>
  trackItems(open, line, before.at(-1) ?? null, before.reduce((inParagraph, l) => paragraphAfter(l, inParagraph), false));

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
});
