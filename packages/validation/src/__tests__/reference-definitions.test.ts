/**
 * Link reference definitions in the text of a requirement definition
 * (CommonMark 0.31.2, section 4.7). A reference definition is not document
 * text: the parser consumes it, so it is absent from the text a bound is
 * looked for in, while a line that only looks like one stays in that text.
 * These cases pin the two boundaries the Codex review of PR #395
 * (markdown-it 14.3.3 to 15.0.3) named: a label of at most 999 code points,
 * and a title that goes on over several lines but not over a blank line.
 * Measured on 2026-11-23: markdown-it 14.3.3 and 15.0.3 give the same
 * tokens for every input below, so the upgrade changes none of them.
 */
import { describe, it, expect } from "vitest";
import { requirementDefinitions } from "../hard-output-rules/rules/requirement-definitions.js";

/** A label of `n` code points outside the Basic Multilingual Plane (2 UTF-16 code units each). */
const astralLabel = (n: number) => "\u{1D400}".repeat(n);

/** A heading definition whose body opens with `reference`: its body reads every block up to the next heading. */
const heading = (reference: string) => `### FR-001: Export\n${reference}\nmust be fast.`;

describe("reference definitions in a requirement's text (markdown-it 15)", () => {
  it("drops a reference definition whose label is 999 code points", () => {
    expect(requirementDefinitions(heading(`[${astralLabel(999)}]: /url`))).toEqual([
      { id: "FR-001", text: ": Export\nmust be fast." },
    ]);
  });

  it("keeps the line as text when the label is 1000 code points", () => {
    const line = `[${astralLabel(1000)}]: /url`;
    expect(requirementDefinitions(heading(line))).toEqual([
      { id: "FR-001", text: `: Export\n${line}\nmust be fast.` },
    ]);
  });

  it("drops a reference definition whose title goes on over several lines, indented or not", () => {
    for (const reference of [
      '[ref]: /url "first\nsecond"',
      '[ref]: /url "first\n  \t second  "',
      '[ref]: /url\n  "first\n  second"',
    ]) {
      expect(requirementDefinitions(heading(reference)), reference).toEqual([
        { id: "FR-001", text: ": Export\nmust be fast." },
      ]);
    }
  });

  it("keeps the lines as text when the title spans a blank line", () => {
    expect(requirementDefinitions(heading('[ref]: /url "first\n\nsecond"'))).toEqual([
      { id: "FR-001", text: ': Export\n[ref]: /url "first\nsecond"\nmust be fast.' },
    ]);
  });
});
