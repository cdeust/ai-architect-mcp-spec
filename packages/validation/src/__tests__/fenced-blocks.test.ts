/**
 * `splitOutsideFences` (#118): where each removed fenced block was, with the
 * indentation of its opening fence (PR #289 review, note 3).
 */
import { describe, it, expect } from "vitest";
import { splitOutsideFences } from "../hard-output-rules/rules/fenced-blocks.js";

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
});
