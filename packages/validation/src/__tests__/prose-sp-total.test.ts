/**
 * sp_arithmetic, prose total (#118): a user-story list whose stated total
 * differs from the sum of its stories is reported by the document check.
 */
import { describe, it, expect } from "vitest";
import type { SectionType } from "@prd-gen/core";
import { validateDocument } from "../index.js";
import {
  checkDocumentSPArithmetic,
  checkProseSPTotal,
  checkSPArithmetic,
} from "../hard-output-rules/rules/sp-rules.js";

const STORIES = [
  "- STORY-1: As a reader, I copy a sample. (FR-001, FR-002) — 2 SP",
  "- STORY-2: As a reader, I see the copy worked. (FR-003) — 1 SP",
];

const messages = (content: string): string[] =>
  checkProseSPTotal(content, "user_stories").map((v) => v.message);

describe("sp_arithmetic: prose total of a story list", () => {
  it("passes when the stated total is the sum of the stories", () => {
    expect(messages([...STORIES, "", "Total: 3 SP"].join("\n"))).toEqual([]);
  });

  it("reports a stated total that differs from the sum", () => {
    expect(messages([...STORIES, "", "Total: 5 SP"].join("\n"))).toEqual([
      "SP total line shows 5 but the stories sum to 3",
    ]);
  });

  it("reads bold, bulleted and spelled-out totals", () => {
    for (const total of ["**Total:** 5 SP", "- Total — 5 story points", "Grand total = 5 SP", "Sum: 5SP"]) {
      expect(messages([...STORIES, total].join("\n")), total).toEqual([
        "SP total line shows 5 but the stories sum to 3",
      ]);
    }
  });

  it("reads CRLF endings and ordered lists", () => {
    const content = ["1. STORY-1 — 2 SP", "2) STORY-2 — 1 SP", "Total: 4 SP"].join("\r\n");
    expect(messages(content)).toEqual(["SP total line shows 4 but the stories sum to 3"]);
  });

  it("sums only the shallowest items, so a story split into tasks counts once", () => {
    const content = [
      "- STORY-1: Copy button — 5 SP",
      "  - Task: render the button — 2 SP",
      "  - Task: write the clipboard — 3 SP",
      "- STORY-2: Confirmation — 1 SP",
      "",
      "Total: 6 SP",
    ].join("\n");
    expect(messages(content)).toEqual([]);
  });

  it("does not read a total without a story-point unit", () => {
    expect(messages([...STORIES, "Total: 2 stories"].join("\n"))).toEqual([]);
  });

  it("does not fire without a total line, or without any story amount", () => {
    expect(messages(STORIES.join("\n"))).toEqual([]);
    expect(messages(["- STORY-1: Copy", "Total: 5 SP"].join("\n"))).toEqual([]);
  });

  it("does not guess with several total lines (one subtotal per epic)", () => {
    // Each subtotal is right for its epic and wrong for the whole list, so a
    // check that compared either one with the sum of every story would fire.
    const content = [
      "- STORY-1 — 2 SP",
      "Total for epic A: 2 SP",
      "- STORY-2 — 1 SP",
      "Total for epic B: 1 SP",
    ].join("\n");
    expect(messages(content)).toEqual([]);
  });

  it("leaves table rows to the table check", () => {
    const content = [...STORIES, "| STORY-9 | 40 SP |", "| Total | 9 SP |", "Total: 3 SP"].join("\n");
    expect(messages(content)).toEqual([]);
  });

  it("skips fenced blocks; a shorter fence inside a block does not close it", () => {
    const content = [
      ...STORIES,
      "Total: 3 SP",
      "````markdown",
      "- STORY-9 — 40 SP",
      "```",
      "- STORY-8 — 7 SP",
      "````",
    ].join("\n");
    expect(messages(content)).toEqual([]);
  });

  it("does not count a list written under the total (review of #228)", () => {
    const content = [...STORIES, "Total: 3 SP", "", "### Deferred", "", "- STORY-3 — 5 SP"].join("\n");
    expect(messages(content)).toEqual([]);
  });

  it("counts a grand total over lists under several headings", () => {
    const content = ["### Epic A", "- STORY-1 — 2 SP", "### Epic B", "- STORY-2 — 1 SP", "", "Total: 4 SP"].join("\n");
    expect(messages(content)).toEqual(["SP total line shows 4 but the stories sum to 3"]);
  });

  it("reads a subtotal bullet and an ordinal total as totals, not stories (review of #228)", () => {
    // A subtotal makes two total lines, so nothing is reported.
    expect(messages([...STORIES, "- Subtotal: 3 SP", "Total: 3 SP"].join("\n"))).toEqual([]);
    expect(messages(["1. STORY-1 — 2 SP", "2. STORY-2 — 1 SP", "3. Total: 5 SP"].join("\n"))).toEqual([
      "SP total line shows 5 but the stories sum to 3",
    ]);
  });

  it("reads an emphasized amount (review of #228)", () => {
    // Unread, the amount would make the story unreadable and the check abstain.
    const content = ["- STORY-1 — 2 SP", "- STORY-2 — **1** SP", "Total: 4 SP"].join("\n");
    expect(messages(content)).toEqual(["SP total line shows 4 but the stories sum to 3"]);
    expect(messages(content.replace("Total: 4 SP", "Total: 3 SP"))).toEqual([]);
  });

  it("does not guess when a story's amount is not on its first line (review of #228)", () => {
    const content = ["- STORY-1 — 2 SP", "- STORY-2: confirmation", "  Estimate: 1 SP", "Total: 9 SP"].join("\n");
    expect(messages(content)).toEqual([]);
  });

  it("a total line without an amount closes nothing (review 2 of #228)", () => {
    // `Subtotal: 1 story` emptied the list, so STORY-1 was dropped and a right
    // total of 3 read as wrong against a sum of 1.
    const content = ["- STORY-1 — 2 SP", "Subtotal: 1 story", "- STORY-2 — 1 SP", "Total: 3 SP"].join("\n");
    expect(messages(content)).toEqual([]);
    expect(messages(content.replace("Total: 3 SP", "Total: 4 SP"))).toEqual([
      "SP total line shows 4 but the stories sum to 3",
    ]);
  });

  it("a total line states its own amount first (review 2 of #228)", () => {
    // The last amount read `Total: 3 SP of 5 SP capacity` as 5.
    expect(messages([...STORIES, "Total: 3 SP of 5 SP capacity"].join("\n"))).toEqual([]);
    expect(messages([...STORIES, "Total: 4 SP of 5 SP capacity"].join("\n"))).toEqual([
      "SP total line shows 4 but the stories sum to 3",
    ]);
  });

  it("a story still states its estimate last", () => {
    const content = ["- STORY-1: copy (8 SP if offline) — 2 SP", STORIES[1]!, "Total: 3 SP"].join("\n");
    expect(messages(content)).toEqual([]);
  });

  it("a fence line ending in a lone carriage return still closes its block", () => {
    // `.` does not match a lone `\r` (one not followed by `\n`, so not a CRLF
    // ending), and the old pattern did not read "```\r " as a fence. Left open,
    // the block would hide the total and the check would abstain.
    const content = [...STORIES, "```", "- STORY-9 — 40 SP", "```\r ", "Total: 4 SP"].join("\n");
    expect(messages(content)).toEqual(["SP total line shows 4 but the stories sum to 3"]);
  });

  it("reads a list of more items than a spread argument list holds", () => {
    // Math.min(...array) throws a RangeError beyond about 120k arguments.
    const n = 200_000;
    const content = [...Array.from({ length: n }, (_, i) => `- STORY-${i + 1} — 1 SP`), `Total: ${n + 1} SP`].join("\n");
    expect(messages(content)).toEqual([`SP total line shows ${n + 1} but the stories sum to ${n}`]);
  });

  it("reads decimal amounts and compares them exactly to three places", () => {
    const content = ["- STORY-1 — 0.5 SP", "- STORY-2 — 0.25 SP", "Total: 0.75 SP"].join("\n");
    expect(messages(content)).toEqual([]);
    expect(messages(content.replace("0.75", "0.8"))).toEqual([
      "SP total line shows 0.8 but the stories sum to 0.75",
    ]);
  });

  it("does not read a backtick line with a backtick in its info string as a fence", () => {
    // Review of #231: as in CommonMark, "```npm i``` installs" is a code span
    // in a paragraph. Read as a fence it opened a block that never closed and
    // hid the total below it, so the check abstained on a wrong total.
    const content = [...STORIES, "```npm i``` installs the tool.", "Total: 5 SP"].join("\n");
    expect(messages(content)).toEqual(["SP total line shows 5 but the stories sum to 3"]);
    // A tilde fence takes any info string, backticks included.
    const tilde = [...STORIES, "~~~ `sh`", "- STORY-9 — 40 SP", "~~~", "Total: 5 SP"].join("\n");
    expect(messages(tilde)).toEqual(["SP total line shows 5 but the stories sum to 3"]);
  });

  it("table sp_arithmetic still reads indented rows and rows after blank lines", () => {
    // Review of #231: the row patterns now read horizontal space only before
    // the leading pipe; a row on its own line, indented or not, is still read.
    const table = ["| Story | SP |", "|---|---|", "  | STORY-1 | 2 |", "", "", "| STORY-2 | 1 |", "\t| **Total** | 5 |"].join("\n");
    expect(checkSPArithmetic(table, "timeline").map((v) => v.message)).toEqual([
      "SP total row shows 5 but individual rows sum to 3",
    ]);
  });

  it("table sp_arithmetic reads a row indented with a no-break space, a form feed or a vertical tab", () => {
    // Review of #232: `\s*` read these indentations before #232 narrowed the
    // patterns to `[ \t]*`; the line-bounded space class reads them again.
    const table = ["| Story | SP |", "|---|---|", "\u00a0| STORY-1 | 2 |", "\f| STORY-2 | 1 |", "\v| **Total** | 5 |"].join("\n");
    expect(checkSPArithmetic(table, "timeline").map((v) => v.message)).toEqual([
      "SP total row shows 5 but individual rows sum to 3",
    ]);
  });

  it("table sp_arithmetic skips a separator or total row whatever the space after its pipe", () => {
    const table = ["| Story | SP |", "|   ---|---|", "| STORY-1 | 2 |", "| STORY-2 | 1 |", "|\u00a0 **Total** | 3 |"].join("\n");
    expect(checkSPArithmetic(table, "timeline")).toEqual([]);
  });

  it("the document check reads user_stories once and no other prose section", () => {
    const sections: { type: SectionType; content: string }[] = [
      { type: "overview", content: [...STORIES, "Total: 5 SP"].join("\n") },
      { type: "user_stories", content: [...STORIES, "Total: 5 SP"].join("\n") },
    ];
    expect(checkDocumentSPArithmetic(sections).map((v) => `${v.sectionType}: ${v.message}`)).toEqual([
      "user_stories: SP total line shows 5 but the stories sum to 3",
    ]);
    const blocking = validateDocument(sections).violations.filter(
      (v) => v.rule === "sp_arithmetic",
    );
    expect(blocking.length).toBe(1);
    expect(blocking[0]!.isAdvisory).not.toBe(true);
  });
});
