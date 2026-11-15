/**
 * `splitOutsideFences` (#118): where each removed fenced block was, with the
 * indentation of its opening fence (PR #289 review, note 3).
 */
import { describe, it, expect } from "vitest";
import { indentWidth, splitOutsideFences } from "../hard-output-rules/rules/fenced-blocks.js";

describe("splitOutsideFences (#118)", () => {
  it("names the line after a block with the indentation of its opening fence", () => {
    const { lines, afterBlock } = splitOutsideFences(["a", "    ```", "x", "```", "b"].join("\n"));
    expect(lines).toEqual(["a", "b"]);
    expect([...afterBlock]).toEqual([[1, 4]]);
  });

  it("keeps the least indentation of the fences of a run of blocks, and counts a tab as four columns (PR #292 review, Codex P2)", () => {
    expect([...splitOutsideFences(["a", "\t~~~", "~~~", "```", "```", "b"].join("\n")).afterBlock]).toEqual([[1, 0]]);
    expect([...splitOutsideFences(["a", "\t~~~", "~~~", "      ```", "```", "b"].join("\n")).afterBlock]).toEqual([[1, 4]]);
  });

  it("moves a tab to the next tab stop, a multiple of four columns (PR #292 review, note 3)", () => {
    expect(["\t", "  \t", "   \t", " \t ", "    \t", "\t\t", "  \t  "].map(indentWidth)).toEqual([4, 4, 4, 5, 8, 8, 6]);
    expect([...splitOutsideFences(["a", "  \t```", "x", "```", "b"].join("\n")).afterBlock]).toEqual([[1, 4]]);
  });
});
