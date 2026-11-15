/**
 * `measurable_requirements` (#118): a requirement that states an unbounded
 * quality ("fast", "user-friendly") with no number is a blocking,
 * non-critical finding of the document check.
 */
import { describe, it, expect } from "vitest";
import { isBlockingViolation } from "@prd-gen/core";
import { validateDocument } from "../index.js";
import { unboundedTermIn } from "../hard-output-rules/rules/measurable-requirement-rules.js";

const findings = (content: string) =>
  validateDocument([{ type: "requirements", content }]).violations.filter(
    (v) => v.rule === "measurable_requirements",
  );

const table = (...rows: string[]) =>
  ["## Requirements", "", "| ID | Requirement | Priority |", "|----|-------------|----------|", ...rows].join(
    "\n",
  );

describe("measurable_requirements (#118)", () => {
  it("flags a table requirement with an unbounded term and no number", () => {
    const found = findings(table("| FR-001 | Copying must be fast and user-friendly. | Must |"));
    expect(found.map((v) => v.message)).toEqual([
      '1 requirement(s) state an unbounded quality with no number: FR-001 ("fast")',
    ]);
    expect(isBlockingViolation(found[0]!)).toBe(true);
    expect(found[0]!.isCritical).toBe(false);
  });

  it("flags list-item requirements, NFRs and French, one finding per document", () => {
    const content = [
      "## Requirements",
      "",
      "- FR-001: The export is seamless.",
      "- **NFR-002**: Search stays responsive and efficient.",
      "### FR-003 L'interface est conviviale.",
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '3 requirement(s) state an unbounded quality with no number: FR-001 ("seamless"), NFR-002 ("efficient"), FR-003 ("conviviale")',
    ]);
  });

  it("reads a number in digits or in words as the bound", () => {
    expect(
      findings(
        table(
          "| NFR-001 | Search is fast: p95 under 200 ms. | Must |",
          "| NFR-002 | The confirmation is quick and lasts two seconds. | Should |",
          "| NFR-003 | L'import est rapide : moins de deux secondes. | Should |",
        ),
      ),
    ).toEqual([]);
  });

  it("reads every spelled-out number, EN and FR, as a bound (PR #275 review)", () => {
    for (const bound of ["thirteen", "seventeen", "ninety", "twenty-five", "zero", "treize", "seize", "dix-sept", "quatre-vingts"]) {
      expect(unboundedTermIn(`Search must be fast: under ${bound} seconds.`), bound).toBeNull();
    }
  });

  it("reads the lines that go on with a heading or list definition (PR #275 review)", () => {
    const bounded = [
      "## Requirements",
      "",
      "### NFR-001: Fast search",
      "",
      "Search completes in under 200 ms.",
      "",
      "- FR-002: Export is quick",
      "  and finishes within 5 s.",
    ].join("\n");
    expect(findings(bounded)).toEqual([]);
    const unbounded = [
      "## Requirements",
      "",
      "### NFR-001: Search",
      "",
      "Search must be fast.",
      "### Notes",
      "Fast is fine here.",
      "- FR-002: Export",
      "  - The export is seamless.",
      "- FR-003: Import",
      "",
      "The import is easy.",
    ].join("\n");
    expect(findings(unbounded).map((v) => v.message)).toEqual([
      '2 requirement(s) state an unbounded quality with no number: NFR-001 ("fast"), FR-002 ("seamless")',
    ]);
  });

  it("does not read a metadata column, an identifier or a priority code as the bound (PR #275 review, note 1)", () => {
    const content = [
      "## Requirements",
      "",
      "| ID | Requirement | Priority | Depends On | Story Points |",
      "|----|-------------|----------|------------|--------------|",
      "| FR-001 | Search must be fast. | P1 | FR-002 | 3 |",
      "| FR-002 | Export is seamless. | Must | — | — |",
      "",
      "- FR-003 (P2): Import is easy, after FR-001.",
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '3 requirement(s) state an unbounded quality with no number: FR-001 ("fast"), FR-002 ("seamless"), FR-003 ("easy")',
    ]);
  });

  it("still reads a number in a statement column other than the first (PR #275 review, note 1)", () => {
    const content = [
      "## Requirements",
      "",
      "| ID | Title | Acceptance | Priority |",
      "|----|-------|------------|----------|",
      "| NFR-001 | Fast search | p95 under 200 ms | P1 |",
    ].join("\n");
    expect(findings(content)).toEqual([]);
  });

  it("reads a bound stated inside quotes, but not inside a code span (PR #275 review, note 2)", () => {
    expect(unboundedTermIn('Search must be fast: "p95 under 2 s".')).toBeNull();
    expect(unboundedTermIn("Search must be fast, see `retry3`.")).toBe("fast");
  });

  it("does not read a list number or an identifier on a following line as the bound (PR #275 review, note 4)", () => {
    const content = [
      "## Requirements",
      "",
      "### NFR-001: Search",
      "",
      "1. Search must be fast.",
      "2. Results follow FR-2 and P1.",
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '1 requirement(s) state an unbounded quality with no number: NFR-001 ("fast")',
    ]);
  });

  it("reads a number alone on a following line as the bound, not as a list marker (PR #276 review, note 1)", () => {
    const content = [
      "## Requirements",
      "",
      "- NFR-001: The list is fast; the maximum entry count is",
      "  1000.",
      "- NFR-002: The list is fast; see the steps",
      "  1. open it.",
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '1 requirement(s) state an unbounded quality with no number: NFR-002 ("fast")',
    ]);
  });

  it("does not read the metadata columns of a table under a heading definition (PR #276 review, note 2)", () => {
    const content = [
      "## Requirements",
      "",
      "### FR-001: Search must be fast.",
      "",
      "| Priority | Story Points |",
      "|----------|--------------|",
      "| P1 | 3 |",
      "",
      "### FR-002: Export must be fast.",
      "",
      "| Acceptance | Priority |",
      "|------------|----------|",
      "| p95 under 200 ms | Must |",
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '1 requirement(s) state an unbounded quality with no number: FR-001 ("fast")',
    ]);
  });

  it("reads a wrapped number followed by more text as the bound, not as a list marker (PR #277 review, note 1)", () => {
    const content = [
      "## Requirements",
      "",
      "- NFR-001: The list is fast; the maximum entry count is",
      "  1000. Beyond that it pages.",
      "- NFR-002: The list is fast; see the steps",
      "  1. open it.",
      "  2. close it.",
      "### NFR-003: Search",
      "2. Search must be fast.",
      "",
      "### NFR-004: Export",
      "",
      "3. Export must be fast.",
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '3 requirement(s) state an unbounded quality with no number: NFR-002 ("fast"), NFR-003 ("fast"), NFR-004 ("fast")',
    ]);
  });

  it("does not read a key-value row of a metadata field under a heading definition (PR #277 review, note 2)", () => {
    const content = [
      "## Requirements",
      "",
      "### FR-001: Search must be fast.",
      "",
      "| Field | Value |",
      "|-------|-------|",
      "| Priority | P1 |",
      "| Story Points | 3 |",
      "",
      "### FR-002: Export must be fast.",
      "",
      "| Field | Value |",
      "|-------|-------|",
      "| Story Points | 3 |",
      "| Acceptance | p95 under 200 ms |",
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '1 requirement(s) state an unbounded quality with no number: FR-001 ("fast")',
    ]);
  });

  it("reads the next marker of a numbered list after a wrapped item (PR #278 review, note 1)", () => {
    const content = [
      "## Requirements",
      "",
      "### NFR-001: Search",
      "",
      "1. Search must be fast and",
      "   reliable.",
      "2. Results are listed.",
      "",
      "### NFR-002: Export",
      "",
      "1. Export must be fast.",
      "",
      "The archive size is at most",
      "2000. Larger ones are split.",
      "",
      "### NFR-003: Import",
      "",
      "1. Import must be fast and",
      "   the maximum entry count is",
      "   2000. Larger ones are split.",
      "",
      "### NFR-004: Sync",
      "",
      "  1. Sync must be fast and",
      "     reliable.",
      "2. Results are listed.",
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '2 requirement(s) state an unbounded quality with no number: NFR-001 ("fast"), NFR-004 ("fast")',
    ]);
  });

  it("opens no item from a marker 4 columns right of its container (PR #281 review, note 1)", () => {
    const content = [
      "## Requirements",
      "",
      "### NFR-001: Import",
      "",
      "Import must be fast and the steps are",
      "    - read the file, whose maximum size is",
      "  2000. Larger ones are split.",
      "",
      "### NFR-002: Export",
      "",
      "1. Export must be fast and the steps are",
      "       - write the file, whose maximum size is",
      "   2000. Larger ones are split.",
      "",
      "### NFR-003: Sync",
      "",
      "1. Sync must be fast and",
      "   reliable.",
      "   1. Retry it.",
      "2. Results are listed.",
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '1 requirement(s) state an unbounded quality with no number: NFR-003 ("fast")',
    ]);
  });

  it("measures a marker under a list-item definition from that item's content (PR #282 review, note 1)", () => {
    const content = [
      "## Requirements",
      "",
      "- NFR-001: Search must be fast and",
      "    1. stay reliable.",
      "    2. Retry on failure.",
      "- NFR-002: Import must be fast and the steps are",
      "      - read the file, whose maximum size is",
      "    2000. Larger ones are split.",
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '1 requirement(s) state an unbounded quality with no number: NFR-001 ("fast")',
    ]);
  });

  it("continues the list of an ordered list-item definition from a sibling left of its content (PR #283 review, note 3)", () => {
    const content = [
      "## Requirements",
      "",
      "1. NFR-001: Search must be fast.",
      " 2. Results are listed.",
      "",
      "100. NFR-002: Import must be fast.",
      " 101. Files are listed.",
      "",
      "  1. NFR-003: Export must be fast.",
      "   2. Files are written.",
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '3 requirement(s) state an unbounded quality with no number: NFR-001 ("fast"), NFR-002 ("fast"), NFR-003 ("fast")',
    ]);
  });

  it("measures a sibling of a nested defining item from the content of its parent item (PR #284 review, note 2)", () => {
    const content = [
      "## Requirements",
      "",
      "1. Group",
      "   1. NFR-001: Search must be fast and",
      "    2. Results are listed.",
      "10. Other",
      "    - NFR-002: Import must be fast.",
      "     2. Files are read.",
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '2 requirement(s) state an unbounded quality with no number: NFR-001 ("fast"), NFR-002 ("fast")',
    ]);
  });

  it("reads an ordered marker other than 1 right after a line of text as that text (PR #285 review, note 1)", () => {
    const content = [
      "## Requirements",
      "",
      "Text line",
      "2. note",
      "   - NFR-001: Export must be fast, at most",
      "    2. seconds per file.",
      "",
      "Text line",
      "1. note",
      "   - NFR-002: Import must be fast, at most",
      "    2. Files are read.",
      "",
      "---",
      "2. Group",
      "   - NFR-003: Search must be fast and",
      "    2. Results are listed.",
      "",
      "===",
      "2. Group",
      "   - NFR-004: Export must be fast, at most",
      "    2. seconds per file.",
      "",
      "Title",
      "===",
      "2. Group",
      "   - NFR-005: Search must be fast and",
      "    2. Results are listed.",
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '3 requirement(s) state an unbounded quality with no number: NFR-002 ("fast"), NFR-003 ("fast"), NFR-005 ("fast")',
    ]);
  });

  it("ends no paragraph at a `===` under a table row, a lazy one under a list item, and ends one at a fenced block (PR #288 review, notes 1 and 2)", () => {
    const content = [
      "## Requirements",
      "",
      "| ID | Note |",
      "|----|------|",
      "| X | y |",
      "===",
      "2. Group",
      "   - NFR-001: Export must be fast, at most",
      "    2. seconds per file.",
      "",
      "- Intro",
      "===",
      "  2. Group",
      "     - NFR-002: Export must be fast, at most",
      "      2. seconds per file.",
      "",
      "Text line",
      "```",
      "code",
      "```",
      "2. Group",
      "   - NFR-003: Search must be fast and",
      "    2. Results are listed.",
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '2 requirement(s) state an unbounded quality with no number: NFR-001 ("fast"), NFR-003 ("fast")',
    ]);
  });

  it("reads a line 4 columns right of a top-level defining item's container as text (PR #284 review, note 2)", () => {
    const content = [
      "## Requirements",
      "",
      "   1. NFR-001: Export must be fast, at most",
      "    2. seconds per file.",
    ].join("\n");
    expect(findings(content)).toEqual([]);
  });

  it("opens the numbered first line of a bold-line definition so its sibling is a marker (PR #284 review, note 3)", () => {
    const content = ["## Requirements", "", "**NFR-001** 1. Search must be fast.", " 2. Results are listed."].join(
      "\n",
    );
    expect(findings(content).map((v) => v.message)).toEqual([
      '1 requirement(s) state an unbounded quality with no number: NFR-001 ("fast")',
    ]);
  });

  it("closes the items left of a rejected marker after a blank line (PR #282 review, note 2)", () => {
    const content = [
      "## Requirements",
      "",
      "### NFR-001: Import",
      "",
      "   - Import must be fast",
      "",
      "    - code",
      "The maximum is",
      "  2000. Larger ones are split.",
    ].join("\n");
    expect(findings(content)).toEqual([]);
  });

  it("closes both open items at an outdented sibling, and keeps a bound at a nested item's content (PR #281 review, note 3)", () => {
    const content = [
      "## Requirements",
      "",
      "### NFR-001: Sync",
      "",
      "  1. Sync must be fast and",
      "     1. reliable, then",
      "2. Results are listed.",
      "",
      "### NFR-002: Import",
      "",
      "1. Import must be fast and",
      "   1. the maximum entry count is",
      "      2000. Larger ones are split.",
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '1 requirement(s) state an unbounded quality with no number: NFR-001 ("fast")',
    ]);
  });

  it("keeps a row of a non key-value table whose first cell names a metadata field (PR #278 review, note 2)", () => {
    const content = [
      "## Requirements",
      "",
      "### NFR-001: Recovery must be fast.",
      "",
      "| Metric | Target |",
      "|--------|--------|",
      "| State | restored within 2 s |",
      "",
      "### NFR-002: Search must be fast.",
      "",
      "| Champ | Valeur |",
      "|-------|--------|",
      "| Statut | 2 |",
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '1 requirement(s) state an unbounded quality with no number: NFR-002 ("fast")',
    ]);
  });

  it("reads a metadata row under a header that is not key-value as the bound, a known miss (PR #279 review, note 2)", () => {
    const content = [
      "## Requirements",
      "",
      "### FR-001: Search must be fast.",
      "",
      "| Attribute | Detail |",
      "|-----------|--------|",
      "| Story Points | 3 |",
      "",
      "### FR-002: Export must be fast.",
      "",
      "| Field | Value | Notes |",
      "|-------|-------|-------|",
      "| Story Points | 3 | estimate |",
    ].join("\n");
    expect(findings(content)).toEqual([]);
  });

  it("removes the marker that numbers a one-line statement right after its identifier (PR #278 review, note 3)", () => {
    const content = [
      "## Requirements",
      "",
      "| ID | Requirement | Priority |",
      "|----|-------------|----------|",
      "| FR-001 | 2. Search must be fast. | Must |",
      "| FR-002 | 3. Export must be fast; p95 under 2 s. | Must |",
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '1 requirement(s) state an unbounded quality with no number: FR-001 ("fast")',
    ]);
    expect(unboundedTermIn("2. Search must be fast.")).toBe("fast");
  });

  it("reads a number in a quoted label as the bound, a known miss (PR #276 review, note 3)", () => {
    expect(unboundedTermIn('The "Top 10" page must load fast.')).toBeNull();
  });

  it("does not read a term inside a quoted label or a code span, or a hyphenated word", () => {
    expect(
      findings(
        table(
          '| FR-001 | The toolbar shows a "Fast mode" toggle. | Must |',
          "| FR-002 | The list is ordered by `quickSort`. | Must |",
          "| FR-003 | Reviewers can fast-track a draft. | Should |",
          "| FR-004 | Breakfast orders are listed by table. | Should |",
        ),
      ),
    ).toEqual([]);
  });

  it("ignores text that does not define a requirement, and fenced blocks", () => {
    const content = [
      "## Requirements",
      "",
      "The team wants an easy and fast flow; see FR-001.",
      "- STORY-1: As a reader I copy quickly.",
      "```",
      "| FR-002 | Copying must be fast. |",
      "```",
      "| FR-001 | Each code block shows a Copy button. | Must |",
    ].join("\n");
    expect(findings(content)).toEqual([]);
  });

  it("names an identifier once even when it is defined twice", () => {
    const content = table("| FR-001 | Copy is fast. | Must |", "| FR-001 | Paste is easy. | Must |");
    expect(findings(content).map((v) => v.message)).toEqual([
      '1 requirement(s) state an unbounded quality with no number: FR-001 ("fast")',
    ]);
  });

  it("unboundedTermIn returns the first term, case-folded by the caller", () => {
    expect(unboundedTermIn("Must be Easy to use")).toBe("Easy");
    expect(unboundedTermIn("as   needed by the admin")).toBe("as   needed");
    expect(unboundedTermIn("Each block shows a button.")).toBeNull();
  });
});
