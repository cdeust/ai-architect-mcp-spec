/**
 * `trackItems` (#118): the list items open at each line of a section, read
 * by `measurable_requirements`. Each case fails if the branch it names is
 * removed (PR #285 review, note 3).
 */
import { describe, it, expect } from "vitest";
import { trackItems } from "../hard-output-rules/rules/measurable-list-items.js";

describe("trackItems (#118)", () => {
  it("closes the items a heading is left of, even right after a line of text", () => {
    const open = [3];
    expect(trackItems(open, "## Next", "   text")).toBe(0);
    expect(open).toEqual([]);
  });

  it("closes the items a table row is left of, even right after a line of text", () => {
    const open = [3];
    expect(trackItems(open, "| FR-001 | Copy. |", "   text")).toBe(0);
    expect(open).toEqual([]);
  });

  it("keeps the items open at a line of text right after another (a lazy continuation)", () => {
    const open = [3];
    expect(trackItems(open, "more text", "   text")).toBe(0);
    expect(open).toEqual([3]);
  });

  it("opens no item from a marker 4 columns right of its container", () => {
    const open = [3];
    expect(trackItems(open, "       - code", "   text")).toBe(0);
    expect(open).toEqual([3]);
  });

  it("returns the parent of an item nested at depth 3, not the outermost item", () => {
    const open = [3, 6];
    expect(trackItems(open, "      - NFR-001: Search must be fast.", "   1. text")).toBe(6);
    expect(open).toEqual([3, 6, 8]);
  });

  it("opens an ordered item other than 1 after a line of text only as a sibling left of the open item's content", () => {
    const none: number[] = [];
    expect(trackItems(none, "2. note", "Text line")).toBe(0);
    expect(none).toEqual([]);
    const one: number[] = [];
    trackItems(one, "1. note", "Text line");
    expect(one).toEqual([3]);
    const sibling = [4];
    trackItems(sibling, "2. next", "    wrapped text");
    expect(sibling).toEqual([3]);
    const nested = [3];
    trackItems(nested, "   2. not a list", "   wrapped text");
    expect(nested).toEqual([3]);
    const afterBlank: number[] = [];
    trackItems(afterBlank, "2. note", "");
    expect(afterBlank).toEqual([3]);
    const afterHeading: number[] = [];
    trackItems(afterHeading, "2. note", "## Heading");
    expect(afterHeading).toEqual([3]);
    const afterRow: number[] = [];
    trackItems(afterRow, "2. note", "| a | b |");
    expect(afterRow).toEqual([3]);
    for (const end of ["---", "***", "_ _ _", "==="]) {
      const afterBreak: number[] = [];
      trackItems(afterBreak, "2. note", end);
      expect(afterBreak).toEqual([3]);
    }
  });
});
