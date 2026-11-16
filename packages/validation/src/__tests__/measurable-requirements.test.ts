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

  it("reads no lazy line after a fenced block, and no fence 4 columns right of its container (PR #289 review, notes 1 to 3)", () => {
    // NFR-001 and NFR-004: `2. Group` goes on with the paragraph above it, so
    // NFR-00n is not nested in it and the `2` of `    2.` is a lazy
    // continuation that bounds it. NFR-002 and NFR-003: `2. Group` opens a
    // list after a list item or a block quote, and `    2.` is a marker under
    // it, so both are reported; the line scanner read `2. Group` as lazy text
    // there, which the CommonMark reference implementation (commonmark.js
    // 0.31) does not, and a pipe line with no delimiter row is no table.
    const content = [
      "## Requirements",
      "",
      "- Setup",
      "  ```",
      "  code",
      "  ```",
      "Notes follow",
      "2. Group",
      "   - NFR-001: Export must be fast, at most",
      "    2. seconds per file.",
      "",
      "| X | y |",
      "- Item",
      "  | a |",
      "Left",
      "2. Group",
      "   - NFR-002: Export must be fast, at most",
      "    2. seconds per file.",
      "",
      "| X | y |",
      "> quote",
      "2. Group",
      "   - NFR-003: Export must be fast, at most",
      "    2. seconds per file.",
      "",
      "Text line",
      "    ```",
      "    code",
      "    ```",
      "2. Group",
      "   - NFR-004: Search must be fast and",
      "    2. Results are listed.",
      "",
      "- Item",
      "  Text line",
      "  ```",
      "  code",
      "  ```",
      "  2. Group",
      "     - NFR-005: Search must be fast and",
      "      2. Results are listed.",
    ].join("\n");
    // NFR-005: a fence at its item's content (column 2) ends the paragraph,
    // so `  2. Group` opens an item and the rule reports it.
    expect(findings(content).map((v) => v.message)).toEqual([
      '3 requirement(s) state an unbounded quality with no number: NFR-002 ("fast"), NFR-003 ("fast"), NFR-005 ("fast")',
    ]);
  });

  it("ends a paragraph at a later fence of a run of blocks, and at a block quote that holds no paragraph (PR #292 review, Codex P2)", () => {
    // In each case `2. Group` opens an item, NFR-00n is nested in it, the `2.`
    // of `    2.` is a marker, and the requirement is reported, as on `main`.
    const tail = (n: number) => ["2. Group", `   - NFR-00${n}: Search must be fast and`, "    2. Results are listed.", ""];
    const content = [
      "## Requirements",
      "",
      "Text line",
      "    ```",
      "    x",
      "    ```",
      "```",
      "y",
      "```",
      ...tail(1),
      ...["| a | b |", "|---|---|", "| X | y |", ">", ...tail(2)],
      ...["| a | b |", "|---|---|", "| X | y |", "> # Note", ...tail(3)],
      ...["| a | b |", "|---|---|", "| X | y |", "> ---", ...tail(4)],
      ...["| a | b |", "|---|---|", "| X | y |", "> quote", ...tail(5)],
    ].join("\n");
    // NFR-005: `2. Group` is no lazy line of `> quote` either: a list item
    // cannot be one (CommonMark 0.31.2 §5.1; commonmark.js 0.31 agrees), so
    // it opens a list and the requirement is reported too.
    expect(findings(content).map((v) => v.message)).toEqual([
      '5 requirement(s) state an unbounded quality with no number: NFR-001 ("fast"), NFR-002 ("fast"), NFR-003 ("fast"), NFR-004 ("fast"), NFR-005 ("fast")',
    ]);
  });

  it("measures a tab to the next tab stop, not as four columns (PR #292 review, note 3)", () => {
    // NFR-001: `  \t` is column 4, two columns right of `- Text line`'s
    // content, so the fence ends that paragraph, `  2. Group` opens an item,
    // and the `2.` of `      2.` is a marker. Six spaces (NFR-003) are 4
    // columns past that content: the fence interrupts nothing, as before.
    // NFR-002: `  \t2.` is column 4, left of the content of NFR-002's item
    // (column 5), so it is a marker, not the bound. Counted as six columns,
    // both tabs hid the finding.
    const group = (n: number) => ["  2. Group", `     - NFR-00${n}: Search must be fast and`, "      2. Results are listed.", ""];
    const content = [
      "## Requirements",
      "",
      ...["- Text line", "  \t```", "  x", "  ```", ...group(1)],
      ...["1. Group", "   - NFR-002: Search must be fast and", "  \t2. Results are listed.", ""],
      ...["- Text line", "      ```", "  x", "  ```", ...group(3)],
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '2 requirement(s) state an unbounded quality with no number: NFR-001 ("fast"), NFR-002 ("fast")',
    ]);
  });

  it("measures the content of an item from a tab after its marker to the next tab stop (PR #294 review, note 2)", () => {
    // `1.\t` puts NFR-001's content at column 4: `   2.` is left of it, a
    // sibling marker, so the requirement is reported; `    2.` is at that
    // content, a nested list that cannot start at 2 after text, so its `2`
    // bounds NFR-002 (CommonMark 0.31.2 §2.2, §5.2).
    const content = [
      "## Requirements",
      "",
      ...["1.\tNFR-001: Search must be fast and", "   2. Results are listed.", ""],
      ...["1.\tNFR-002: Search must be fast, at most", "    2. seconds per query.", ""],
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '1 requirement(s) state an unbounded quality with no number: NFR-001 ("fast")',
    ]);
  });

  it("goes on with a heading definition's body at a `#` line after a tab, as after four spaces (PR #294 review, note 2)", () => {
    // `\t# …` is column 4, not a heading (CommonMark 0.31.2 §4.2): the line
    // is body text and its `2` bounds the requirement.
    const body = (n: number, indent: string) => [`### NFR-00${n}`, "Search must be fast.", `${indent}# At most 2 seconds.`, ""];
    const content = ["## Requirements", "", ...body(1, "\t"), ...body(2, "    "), ...body(3, "   ")].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '1 requirement(s) state an unbounded quality with no number: NFR-003 ("fast")',
    ]);
  });

  it("reads a heading or a block quote after a tab inside a list item, measured from the item's content (PR #295 review, Codex P2)", () => {
    // Under `- Intro` (content at column 2), `\t# Note` and `    # Note` are
    // two columns past it: a heading in the item, which leaves no paragraph
    // open, so `  2. Group` opens an item, the `2.` under NFR-00n is a sibling
    // marker and each requirement is reported. `\t> # Note` is a quote there.
    const group = (n: number, line: string) => [
      "- Intro",
      line,
      "  2. Group",
      `     - NFR-00${n}: Search must be fast and`,
      "      2. Results are listed.",
      "",
    ];
    const content = [
      "## Requirements",
      "",
      ...group(1, "\t# Note"),
      ...group(2, "\t> # Note"),
      ...group(3, "    # Note"),
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '3 requirement(s) state an unbounded quality with no number: NFR-001 ("fast"), NFR-002 ("fast"), NFR-003 ("fast")',
    ]);
  });

  it("reads a `### NFR` line after a tab at top level as code, not a definition (PR #295 review, note 3)", () => {
    // `\t### NFR-001` is 4 columns in at top level: an indented code block
    // (CommonMark 0.31.2 §4.4), which defines nothing, as a fenced block does
    // not. As a heading (NFR-002), the body runs to the next heading and
    // holds the bound.
    const def = (head: string) => [head, "Search must be fast.", "", "At most 2 seconds.", ""];
    const content = ["## Requirements", "", ...def("\t### NFR-001"), ...def("### NFR-002")].join("\n");
    expect(findings(content)).toEqual([]);
  });

  it("reads a block quote indented past column 3 inside a list item, after a table (PR #296 review, Codex P2)", () => {
    // `    > # Note` is two columns past `- Intro`'s content: a quote holding a
    // heading, which ends the table and leaves no paragraph, so `  2. Group`
    // opens an item and the `2.` under NFR-001 is a sibling marker.
    const content = [
      "## Requirements",
      "",
      ...["- Intro", "", "  | a |", "  | --- |", "    > # Note", "  2. Group"],
      ...["     - NFR-001: Search must be fast and", "      2. Results are listed."],
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '1 requirement(s) state an unbounded quality with no number: NFR-001 ("fast")',
    ]);
  });

  it("measures the body of a heading definition nested in a list item from that item's content (PR #296 review, Codex P2)", () => {
    // `    ### NFR-001` is a heading in `- Intro`; its body is that item's
    // content, so `    2.` is a list marker there, not the bound.
    const content = ["## Requirements", "", "- Intro", "    ### NFR-001: Search must be fast.", "", "    2. Results are listed."].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '1 requirement(s) state an unbounded quality with no number: NFR-001 ("fast")',
    ]);
  });

  it("closes a list item at a block quote left of its content, so a later line is not measured from it (PR #296 review, note 1)", () => {
    // `> Note` at column 0 closes `- Intro`; `    # At most 2 seconds.` then
    // goes on with the quote's paragraph, text of NFR-001's heading body,
    // whose `2` bounds the requirement.
    const content = ["## Requirements", "", "### NFR-001: Search must be fast.", "- Intro", "> Note", "    # At most 2 seconds."].join("\n");
    expect(findings(content)).toEqual([]);
  });

  it("keeps a numbered bold-line definition in a list item opening its list, and closes a nested heading's item at a dedented body line (PR #297 review, Codex P2)", () => {
    // NFR-001: the bold line keeps column 0, so `1.` opens a list and `  2.`
    // is its sibling marker, not the bound. NFR-002: `The maximum …` right
    // under the heading is left of `- Intro`'s content and closes it, so the
    // `2.` after it goes on with that paragraph and is the bound.
    const content = [
      "## Requirements",
      "",
      ...["- Intro", "  **NFR-001** 1. Search must be fast.", "  2. Results are listed.", ""],
      ...["- Intro", "    ### NFR-002: Search must be fast.", "The maximum duration in seconds is", "2. Beyond that it times out."],
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '1 requirement(s) state an unbounded quality with no number: NFR-001 ("fast")',
    ]);
  });

  it("closes a nested definition's item at a column-0 line, and measures a heading two items deep from its own item (PR #297 review, notes 1 and 3)", () => {
    // NFR-001: the column-0 line closes the item, so `1000.` goes on with
    // that paragraph and bounds the requirement. NFR-002: ` 1000.` is left of
    // the item's content and opens a list (commonmark.js 0.31 renders
    // `<ol start="1000">`), so it bounds nothing and the requirement is
    // reported; the line scanner read it as a lazy line. NFR-003: the heading
    // is in `   1. Sub`, nested in `1. Group`, so `    2.` is a sibling marker
    // of `Sub` and the requirement is reported.
    const content = [
      "## Requirements",
      "",
      ...["- Overview", "  ### NFR-001: Search must be fast.", "The maximum result count is", "1000. Beyond that it pages.", ""],
      ...["- Intro", "  **NFR-002**: Search must be fast, at most", " 1000. results.", ""],
      ...["1. Group", "   1. Sub", "      ### NFR-003: Search must be fast.", "", "    2. Results are listed."],
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '2 requirement(s) state an unbounded quality with no number: NFR-002 ("fast"), NFR-003 ("fast")',
    ]);
  });

  it("reads the block tree of CommonMark/GFM, not a line scanner (PR #298 review, Codex P2)", () => {
    // NFR-001: `    1.` under a bold line in `- Intro` is a nested list
    // (1 may interrupt a paragraph), so `1` is a marker and the requirement
    // is reported. NFR-002: the list item after a table in the heading's item
    // ends the table and stays in the item, so `1` is a marker again. FR-003:
    // a pipe line with no delimiter row is paragraph text (GFM 0.29 §4.10), so
    // its `2` bounds the item. NFR-004: a fence at column 0 closes `- Setup`,
    // and the heading after it opens the body that holds its bound.
    const content = [
      "## Requirements",
      "",
      ...["- Intro", "  **NFR-001** Search must be fast.", "    1. Results are listed.", "", "## Next", ""],
      ...["- Intro", "  ### NFR-002: Search must be fast.", "  | Feature | Status |", "  | --- | --- |", "    1. Results are listed.", "", "## Next", ""],
      ...["- FR-003: Export must be fast, at most", "| 2 seconds per file |", ""],
      ...["- Setup", "```", "x", "```", "  ### NFR-004: Import must be fast.", "", "Within 3 seconds."],
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '2 requirement(s) state an unbounded quality with no number: NFR-001 ("fast"), NFR-002 ("fast")',
    ]);
  });

  it("ends a definition at the next one, reads an indented bold line, keeps a wrapped quantity of a numbered statement, and reads a bold line under an HTML tag (PR #299 review, Codex P2 and note 2)", () => {
    // FR-001: the nested FR-002 is a definition of its own, so its `2` does
    // not bound FR-001. FR-003: the heading body ends at the bold line below
    // it, so NFR-004's `3` does not bound it. NFR-005: an indented
    // continuation line is still a bold line. NFR-006: `2000.` is not the
    // next marker of the statement's list (`1.`), so it is the bound.
    const content = [
      "## Requirements",
      "",
      ...["- FR-001: Search must be fast.", "  - FR-002: Export finishes within 2 seconds.", ""],
      ...["### FR-003: Import must be fast.", "", "**NFR-004** Login within 3 seconds.", "", "## Next", ""],
      ...["Intro", "  **NFR-005** Search must be fast.", ""],
      ...["**NFR-006** 1. Search must be fast; the maximum count is", "    2000. Larger collections page.", "", "## Next", ""],
      // NFR-007: with no blank line, `<div>` and the bold line are one HTML
      // block, whose source is read again as markdown, so the bold line
      // defines it.
      ...["<div>", "**NFR-007** Search must be fast.", "", "## Next", ""],
      // FR-008: the table's rows above FR-009's row are its body and hold its
      // bound; FR-009 is a definition of its own (PR #300 review, Codex P2).
      ...["### FR-008: Search must be fast.", "", "| Metric | Target |", "|---|---|", "| Search latency | 200 ms |", "| FR-009 | Export must be easy. |", "", "## Next", ""],
      // FR-010: a definition inside an HTML comment is not read (PR #300
      // review, note 1). FR-011: `FR-011-AC1` is no identifier of its own, so
      // its 200 ms goes on with FR-011 and bounds it (PR #300 review, note 2).
      ...["<!--", "- FR-010: Offline mode should be seamless.", "-->", ""],
      ...["- FR-011: Search must be fast.", "  - FR-011-AC1: p95 under 200 ms.", "", "## Next", ""],
      // FR-012: the digit of `FR-012-AC1` is part of an identifier, not a
      // bound. FR-013 and FR-014: a list item or a heading right under an
      // HTML line is read as one (PR #301 review, Codex P2).
      ...["- FR-012: Search must be fast.", "  - FR-012-AC1: Results are listed.", ""],
      ...["<div>", "- FR-013: Search must be fast.", "", "<div>", "### FR-014: Import must be fast.", "", "## Next", ""],
      // FR-015: a comment inside an HTML block stays unread when the block
      // is parsed again (PR #302 review, Codex P2).
      ...["<div>", "<!--", "- FR-015: Search must be fast.", "-->", "</div>", ""],
      // FR-016: a raw-text block (`<pre>`) defines nothing. NFR-017: the
      // `500` of `NFR-017-500` is a number, so it bounds the requirement
      // (PR #302 review, notes 1 and 2).
      ...["<pre>", "- FR-016: Search must be fast.", "</pre>", ""],
      ...["- NFR-017: Search must be fast for NFR-017-500 rows."],
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '8 requirement(s) state an unbounded quality with no number: FR-001 ("fast"), FR-003 ("fast"), NFR-005 ("fast"), NFR-007 ("fast"), FR-009 ("easy"), FR-012 ("fast"), FR-013 ("fast"), FR-014 ("fast")',
    ]);
  });

  it("reads across a comment line, takes `<!-->` as a comment, reads the item above an unclosed `<!--`, skips a nested raw-text block and reads a line-leading sub-identifier as one (PR #303 review, notes 1 to 3)", () => {
    const content = [
      "## Requirements",
      "",
      // FR-001 and FR-002: a comment between two lines of the paragraph, at
      // the top level or inside an HTML block, does not cut it, so the bound
      // below it counts.
      ...["**FR-001** Search must be fast", "<!-- x -->", "within 2 seconds.", ""],
      ...["<div>", "**FR-002** Search must be fast", "<!-- x -->", "within 2 seconds.", "", "## Next", ""],
      // FR-003: `<!-->` is a whole comment, so the item under it is read.
      // FR-004: an unclosed `<!--` hides only what follows it in its
      // container, so the item above it is read.
      ...["<div>", "<!-->", "- FR-003: Search must be fast.", ""],
      ...["<div>", "- FR-004: Export must be easy.", "<!-- open", "", "## Next", ""],
      // FR-005: a `<pre>` nested in a `<div>` defines nothing.
      ...["<div>", "<pre>", "- FR-005: Search must be fast.", "</pre>", "</div>", ""],
      // FR-006: `FR-006-1:` names its line, so its `1` does not bound FR-006.
      ...["- FR-006: Search must be fast.", "  - FR-006-1: Results are listed."],
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '3 requirement(s) state an unbounded quality with no number: FR-003 ("fast"), FR-004 ("easy"), FR-006 ("fast")',
    ]);
  });

  it("skips comment and raw-text openings in a code block of an HTML block, reads across its comment lines without joining them, and hides what an unclosed top-level `<!--` covers (PR #304 review, Codex P2 and notes 1 to 3)", () => {
    const content = [
      "## Requirements",
      "",
      // FR-001 and FR-002: a `<pre>` or a `<!--` in a fenced block of an
      // HTML block is code, so the item under the fence is read.
      ...["<div>", "```html", "<pre>", "```", "- FR-001: Search must be fast.", "</div>", ""],
      ...["<div>", "```", "<!--", "```", "- FR-002: Import must be fast.", "-->", "</div>", ""],
      // FR-003: the item under the comment line goes on with the paragraph,
      // so its `2` bounds FR-003 (note 1).
      ...["<div>", "**FR-003** Search is fast.", "<!-- reviewed -->", "- Results load in 2 s.", ""],
      // FR-004: the `---` under the comment line is a thematic break, not a
      // setext underline, so FR-004 is still defined (note 2).
      ...["<div>", "**FR-004** Export is fast.", "<!-- end -->", "---", ""],
      // FR-005: at the top level an unclosed `<!--` opens a comment block
      // that runs to the section's end, so FR-005 is not read (note 3).
      ...["<!-- open", "- FR-005: Login must be easy."],
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '3 requirement(s) state an unbounded quality with no number: FR-001 ("fast"), FR-002 ("fast"), FR-004 ("fast")',
    ]);
  });

  it("opens a comment or raw-text block of an HTML block where the parser opens a block, so a fence inside it opens nothing and an item keeps it (PR #305 review, two Codex P2 findings and note 2)", () => {
    const fence = "```";
    const content = [
      "## Requirements",
      "",
      // FR-001: the fence inside the first comment opens no code block, so
      // the second `<!--` opens a comment and FR-001 stays hidden.
      ...["<div>", "<!--", fence, "-->", "<!--", "- FR-001: Search is fast.", "-->", "</div>", ""],
      // FR-002: the same with a fence inside a `<pre>` block.
      ...["<div>", "<pre>", fence, "</pre>", "<!--", "- FR-002: Import is fast.", "-->", "</div>", ""],
      // FR-003: a comment inside a list item stays in it, so the nested item
      // under it is a list item, not a code block, and defines FR-003.
      ...["<div>", "- Notes", "  <!-- reviewed -->", "    - FR-003: Export is fast.", "</div>", ""],
      // FR-004: the item's paragraph goes on under the comment, so `2`
      // bounds FR-004 (note 2).
      ...["<div>", "- **FR-004** Sync is fast.", "  <!-- x -->", "  within 2 s.", "</div>", ""],
      // FR-005: a comment in the middle of a line is text, as at the top
      // level, so FR-005 is defined.
      ...["<div>", "- FR-005: Login is fast. <!-- x --> More text.", "</div>", ""],
      // FR-006: an unclosed `<!--` hides the rest of its HTML block, as it
      // hides the rest of the section at the top level.
      ...["<div>", "<!-- open", "- FR-006: Upload is fast.", "", "- FR-007: Backup is fast."],
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '3 requirement(s) state an unbounded quality with no number: FR-003 ("fast"), FR-005 ("fast"), FR-007 ("fast")',
    ]);
  });

  it("closes a raw-text block of an HTML block on any raw-text end tag, whichever tag opened it (PR #306 review, note 1)", () => {
    const content = [
      "## Requirements",
      "",
      // FR-001: `</style>` closes the `<pre>` block (CommonMark 0.31.2
      // §4.6, end condition 1), so the item under it is read.
      ...["<div>", "<pre>", "</style>", "- FR-001: Search is fast.", "</div>", ""],
      // FR-002: the same, with the end tag in upper case after text.
      ...["<div>", "<textarea>", "draft </PRE>", "- FR-002: Import is fast.", "</div>", ""],
      // FR-003: a line with no raw-text end tag keeps the block open, so the
      // item under it stays hidden.
      ...["<div>", "<script>", "</div>", "- FR-003: Export is fast.", "</script>", "</div>", ""],
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '2 requirement(s) state an unbounded quality with no number: FR-001 ("fast"), FR-002 ("fast")',
    ]);
  });

  it("ends a comment of a list item at the first line left of the item's content, and closes a raw-text block on its opening line (PR #307 review, notes 1 and 2)", () => {
    const content = [
      "## Requirements",
      "",
      // FR-001: `<?note` opens an HTML block that a blank line does not end.
      // In a list item, the blank line is left of the item's content, so the
      // unclosed `<!--` ends there, as in markdown-it, and FR-001 is read.
      ...["<?note", "- Notes", "  <!-- open", "", "  - FR-001: Export is fast.", "?>", ""],
      // FR-002: at the HTML block's top level the same comment runs to the
      // block's end, so FR-002 stays hidden.
      ...["<?note", "<!-- open", "", "- FR-002: Import is fast.", "?>", ""],
      // FR-003: the opening line already holds a raw-text end tag, so the
      // block closes on it and the item under it is read (note 2).
      ...["<div>", "<pre></style>", "- FR-003: Search is fast.", "</div>", ""],
      // FR-004: with no end tag on the opening line, the block stays open.
      ...["<div>", "<pre>", "- FR-004: Login is fast.", "</div>"],
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '2 requirement(s) state an unbounded quality with no number: FR-001 ("fast"), FR-003 ("fast")',
    ]);
  });

  it("cuts a comment of a list item at a line left of the item's content, closed further down or not (PR #308 review, notes 1 and 2)", () => {
    const content = [
      "## Requirements",
      "",
      // FR-001: a line of one space is left of the item's content (2
      // columns), so the comment ends there and FR-001 is read.
      ...["<?note", "- Notes", "  <!-- open", " ", "  - FR-001: Export is fast.", "?>", ""],
      // FR-002: a line of two spaces is as deep as the content, so the
      // comment goes on over it and FR-002 stays hidden.
      ...["<?note", "- Notes", "  <!-- open", "  ", "  - FR-002: Import is fast.", "?>", ""],
      // FR-003: a dedented sibling item is left of the content too.
      ...["<?note", "- Notes", "  <!-- open", "- FR-003: Search is fast.", "?>", ""],
      // FR-004: the cut does not depend on the comment being unclosed; one
      // closed under the item is cut at the blank line as well.
      ...["<?note", "- Notes", "  <!--", "", "  - FR-004: Login is fast.", "  -->", "?>", ""],
      // FR-005: with no line left of the content, the closed comment hides it.
      ...["<?note", "- Notes", "  <!--", "  - FR-005: Upload is fast.", "  -->", "?>"],
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '3 requirement(s) state an unbounded quality with no number: FR-001 ("fast"), FR-003 ("fast"), FR-004 ("fast")',
    ]);
  });

  it("measures a line left of a list item's content in columns, so a tab counts as the columns it expands to (PR #309 review, note 2)", () => {
    const content = [
      "## Requirements",
      "",
      // FR-001: a line of one tab expands to 4 columns (`sCount` 4), deeper
      // than the item's content (2 columns), so the comment goes on over it
      // and FR-001 stays hidden, although the line holds a single character.
      ...["<?note", "- Notes", "  <!-- open", "\t", "  - FR-001: Export is fast.", "?>", ""],
      // FR-002: the same line of one tab under an item whose content is 5
      // columns deep is left of it, since the tab expands to 4 columns and no
      // more, so the comment ends there and FR-002 is read (PR #310 review,
      // note 3: a line of one space no longer repeats the #308 test's FR-001).
      ...["<?note", "   - Notes", "     <!-- open", "\t", "     - FR-002: Import is fast.", "?>", ""],
      // FR-003: the same line of one tab under an item whose content is 4
      // columns deep is not left of it, so the comment goes on and FR-003
      // stays hidden: with FR-002 this pins the tab to exactly 4 columns, not
      // to 2 to 4 (PR #311 review, note 2); FR-001 adds no bound to the two
      // (PR #312 review, note 3).
      ...["<?note", "  - Notes", "    <!-- open", "\t", "    - FR-003: Sync is fast.", "?>"],
    ].join("\n");
    expect(findings(content).map((v) => v.message)).toEqual([
      '1 requirement(s) state an unbounded quality with no number: FR-002 ("fast")',
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
