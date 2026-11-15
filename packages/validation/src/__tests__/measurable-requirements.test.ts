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
