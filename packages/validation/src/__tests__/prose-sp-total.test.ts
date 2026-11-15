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

  it("reads a spaced subtotal and the plural or joined units the table rule reads (review of #271)", () => {
    // `- Sub total: 3 SP` was summed as a story, so a right total of 3 read
    // as wrong against 6; as a subtotal it makes two total lines, and nothing
    // is reported.
    expect(messages([...STORIES, "- Sub total: 3 SP", "Total: 3 SP"].join("\n"))).toEqual([]);
    expect(messages([...STORIES, "-  Sub \t total: 3 SP", "Total: 3 SP"].join("\n"))).toEqual([]);
    // `Sub task` and `Sub totality` are not totals: the item is a story, and
    // its amount is summed.
    expect(messages(["- STORY-1 — 2 SP", "- Sub task — 1 SP", "Total: 4 SP"].join("\n"))).toEqual([
      "SP total line shows 4 but the stories sum to 3",
    ]);
    expect(messages(["- STORY-1 — 2 SP", "- Sub totality — 1 SP", "Total: 4 SP"].join("\n"))).toEqual([
      "SP total line shows 4 but the stories sum to 3",
    ]);
    // A total in SPs, story-points or storypoints had no readable amount, so
    // the check abstained; a story in those units was unreadable too.
    for (const unit of ["SPs", "sps", "story-points", "storypoints", "Story-Point", "storypoint"]) {
      expect(messages([...STORIES, `Total: 5 ${unit}`].join("\n")), unit).toEqual([
        "SP total line shows 5 but the stories sum to 3",
      ]);
      const stories = [`- STORY-1 — 2 ${unit}`, `- STORY-2 — 1 ${unit}`];
      expect(messages([...stories, "Total: 3 SP"].join("\n")), unit).toEqual([]);
      expect(messages([...stories, "Total: 4 SP"].join("\n")), unit).toEqual([
        "SP total line shows 4 but the stories sum to 3",
      ]);
    }
    // A unit glued to more letters is not a unit, and a bare `points` is not
    // read: a story that counts other points stays unreadable.
    for (const total of ["Total: 5 SPsx", "Total: 5 storypointsx", "Total: 5 points"]) {
      expect(messages([...STORIES, total].join("\n")), total).toEqual([]);
    }
    // Read as an amount, `3 points` would make the sum 5 against 9 and be
    // reported; unread, the story has no amount and the check abstains
    // (review of #273: in `3 edge points` no unit follows the number, so the
    // case passed whether or not a bare `points` was read).
    expect(messages(["- STORY-1 — 2 SP", "- STORY-2: 3 points of failure", "Total: 9 SP"].join("\n"))).toEqual([]);
    expect(messages(["- STORY-1 — 2 SP", "- STORY-2: 3 pts of failure", "Total: 9 SP"].join("\n"))).toEqual([]);
  });

  it("reads a plural subtotal or total, and a spaced subtotal alone as the total (review of #273)", () => {
    // `- Sub totals: 3 SP` and `- Subtotals: 3 SP` were summed as stories,
    // so a right total of 3 read as wrong against 6; as subtotals they make
    // two total lines, and nothing is reported.
    for (const subtotal of ["- Sub totals: 3 SP", "- Subtotals: 3 SP", "- Sub-totals: 3 SP"]) {
      expect(messages([...STORIES, subtotal, "Total: 3 SP"].join("\n")), subtotal).toEqual([]);
    }
    for (const total of ["Totals: 4 SP", "Grand Totals: 4 SP", "- Sub total: 4 SP", "- Sub totals: 4 SP"]) {
      expect(messages([...STORIES, total].join("\n")), total).toEqual([
        "SP total line shows 4 but the stories sum to 3",
      ]);
    }
    // `Totality` is still a story: its amount is summed.
    expect(messages(["- STORY-1 — 2 SP", "- Totality check — 1 SP", "Total: 4 SP"].join("\n"))).toEqual([
      "SP total line shows 4 but the stories sum to 3",
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

  it("table sp_arithmetic reads a total row with a no-break space after its pipe as the total", () => {
    // Review of #234: with a right total the test above passes even if the
    // total pattern stopped reading the space, since an unread total reports
    // nothing. A wrong total pins both patterns: unread by the total pattern,
    // nothing is reported; read as a data row, its 4 joins the sum.
    const table = ["| Story | SP |", "|---|---|", "| STORY-1 | 2 |", "| STORY-2 | 1 |", "|\u00a0 **Total** | 4 |"].join("\n");
    expect(checkSPArithmetic(table, "timeline").map((v) => v.message)).toEqual([
      "SP total row shows 4 but individual rows sum to 3",
    ]);
  });

  it("table sp_arithmetic does not join a line holding only a pipe to the next line", () => {
    // Review of #234: the first cell `[^|]+` crossed the line end, so a lone
    // `|` read the next line as the rest of its row (here 40 SP of prose),
    // and the lookahead that skips a separator or a total never saw that line.
    const table = ["| Story | SP |", "|---|---|", "| STORY-1 | 2 |", "| STORY-2 | 1 |", "|", "Note | 40 |", "| **Total** | 3 |"].join("\n");
    expect(checkSPArithmetic(table, "timeline")).toEqual([]);
    const total = ["| Story | SP |", "|---|---|", "| STORY-1 | 2 |", "| STORY-2 | 1 |", "|", "Total | 9 |", "| **Total** | 3 |"].join("\n");
    expect(checkSPArithmetic(total, "timeline")).toEqual([]);
    // Nor does "Grand Total" span two lines: `\s+` between the words did.
    const grand = ["| Story | SP |", "|---|---|", "| STORY-1 | 2 |", "| STORY-2 | 1 |", "| Grand", "Total | 9 |"].join("\n");
    expect(checkSPArithmetic(grand, "timeline")).toEqual([]);
    const sameLine = ["| Story | SP |", "|---|---|", "| STORY-1 | 2 |", "| STORY-2 | 1 |", "| **Grand\u00a0 Total** | 9 |"].join("\n");
    expect(checkSPArithmetic(sameLine, "timeline").map((v) => v.message)).toEqual([
      "SP total row shows 9 but individual rows sum to 3",
    ]);
  });

  it("table sp_arithmetic does not join a first cell without a closing pipe to the next line, whatever ends the line", () => {
    // Review of #242: every table test above ends its lines with `\n`, so a first
    // cell of `[^|\n]+` still passed them. A lone `\r`, U+2028 or U+2029 ends a
    // line for the `m` flag too; a first cell that crossed it read `Note | 40 |`
    // as 40 SP (`rows sum to 43` against a right total of 3).
    const rows = ["| Story | SP |", "|---|---|", "| STORY-1 | 2 |", "| STORY-2 | 1 |", "| draft", "Note | 40 |", "| **Total** | 3 |"];
    for (const eol of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
      expect(checkSPArithmetic(rows.join(eol), "timeline")).toEqual([]);
    }
    // The rows are still read across those line ends: a wrong total is reported.
    const wrong = ["| Story | SP |", "|---|---|", "| STORY-1 | 2 |", "| STORY-2 | 1 |", "| **Total** | 4 |"];
    for (const eol of ["\r\n", "\r", "\u2028", "\u2029"]) {
      expect(checkSPArithmetic(wrong.join(eol), "timeline").map((v) => v.message)).toEqual([
        "SP total row shows 4 but individual rows sum to 3",
      ]);
    }
  });

  it("table sp_arithmetic counts a row whose first cell only starts with a total label", () => {
    // Review of #242: the data row's lookahead skipped any first cell that
    // starts with a label, so `Summary task` and `Totals carried` were left out
    // of the sum and a right total of 10 was reported as wrong. A label inside
    // a longer word, or followed by a word, is data.
    const table = ["| Item | SP |", "|---|---|", "| STORY-1 | 3 |", "| Summary task | 5 |", "| Totals carried | 2 |", "| **Total** | 10 |"].join("\n");
    expect(checkSPArithmetic(table, "timeline")).toEqual([]);
    // A real total row is still skipped from the sum, bold or not.
    const total = ["| Item | SP |", "|---|---|", "| STORY-1 | 3 |", "| Sum | 3 |", "| **Grand Total** | 3 |"].join("\n");
    expect(checkSPArithmetic(total, "timeline")).toEqual([]);
  });

  it("table sp_arithmetic reads a plural total row as a total and not as data", () => {
    // Review of #246: `| Totals | 10 |` was counted as a story and never read
    // as a total, so beside a grand total of 10 the rows summed to 20.
    const table = ["| Item | SP |", "|---|---|", "| STORY-1 | 3 |", "| STORY-2 | 7 |", "| Totals | 10 |", "| **Grand Total** | 10 |"].join("\n");
    expect(checkSPArithmetic(table, "timeline")).toEqual([]);
    const wrong = ["| Item | SP |", "|---|---|", "| STORY-1 | 3 |", "| STORY-2 | 7 |", "| **Totals** | 11 |", "| Grand Totals | 10 |"].join("\n");
    expect(checkSPArithmetic(wrong, "timeline").map((v) => v.message)).toEqual([
      "SP total row shows 11 but individual rows sum to 10",
    ]);
  });

  it("table sp_arithmetic counts every row that is not a total row", () => {
    // Review of #246: the data row skipped `Sum-up task` as a total row (`\b`
    // stops at the hyphen), while the total row did not read it. A label
    // joined to a letter by a hyphen, or inside a longer word in any script,
    // is data. Review of #250: a first cell that starts with a hyphen and is
    // not a separator (`-STORY-3`) is data too.
    const table = ["| Item | SP |", "|---|---|", "| STORY-1 | 1 |", "| -STORY-3 | 2 |", "| Sum-up task | 3 |", "| Totalité | 4 |", "| **Total** | 10 |"].join("\n");
    expect(checkSPArithmetic(table, "timeline")).toEqual([]);
    const wrong = table.replace("| **Total** | 10 |", "| **Total** | 1 |");
    expect(checkSPArithmetic(wrong, "timeline").map((v) => v.message)).toEqual([
      "SP total row shows 1 but individual rows sum to 10",
    ]);
    // An aligned separator row is still skipped.
    const aligned = ["| Item | SP |", "| :--- | ---: |", "| STORY-1 | 3 |", "| **Total** | 3 |"].join("\n");
    expect(checkSPArithmetic(aligned, "timeline")).toEqual([]);
  });

  it("table sp_arithmetic counts a row whose first cell is a placeholder hyphen", () => {
    // Issue #118: the lookahead read the first cell alone, so `| - | 3 |` (a
    // story without an id) was skipped as a separator and a right total of 5
    // was reported as `sum to 2`. A row is a separator only when every cell
    // holds hyphens and colons alone.
    const table = ["| Item | SP |", "|---|---|", "| STORY-1 | 2 |", "| - | 3 |", "| **Total** | 5 |"].join("\n");
    expect(checkSPArithmetic(table, "timeline")).toEqual([]);
    const wrong = table.replace("| **Total** | 5 |", "| **Total** | 2 |");
    expect(checkSPArithmetic(wrong, "timeline").map((v) => v.message)).toEqual([
      "SP total row shows 2 but individual rows sum to 5",
    ]);
    // A hyphen in a later cell does not make a separator either.
    const later = ["| Item | Sprint | SP |", "|---|---|---|", "| STORY-1 | - | 2 |", "| :- | -- | 3 |", "| **Total** | | 5 |"].join("\n");
    expect(checkSPArithmetic(later, "timeline")).toEqual([]);
    // Separator rows are still skipped: aligned, spaced, without the last
    // pipe, with spaces after it, and with a digit-free hyphen run in each cell.
    for (const separator of ["|---|---|", "| :--- | ---: |", "|:-:|-", "| - | - |  ", "|\u00a0---\t|---|"]) {
      const rows = ["| Item | SP |", separator, "| STORY-1 | 3 |", "| **Total** | 3 |"].join("\n");
      expect(checkSPArithmetic(rows, "timeline")).toEqual([]);
    }
    // A separator row followed by a lone `\r`, U+2028 or U+2029 ends there.
    for (const eol of ["\r\n", "\r", "\u2028", "\u2029"]) {
      const rows = ["| Item | SP |", "|---|---|", "| - | 3 |", "| **Total** | 3 |"].join(eol);
      expect(checkSPArithmetic(rows, "timeline")).toEqual([]);
    }
  });

  it("table sp_arithmetic reads a label followed by a unit or punctuation as a total", () => {
    // Review of #250: with the label alone as the total cell, `**Total SP**`,
    // `Total:` and `Total (committed)` were summed as stories, so beside a
    // grand total of 22 a right total was reported as `sum to 44`.
    for (const cell of ["**Total SP**", "Total:", "Total (committed)", "Total story points", "Sum — all"]) {
      const table = ["| Item | SP |", "|---|---|", "| STORY-1 | 20 |", "| STORY-2 | 2 |", `| ${cell} | 22 |`, "| **Grand Total** | 22 |"].join("\n");
      expect(checkSPArithmetic(table, "timeline")).toEqual([]);
      const wrong = table.replace(`| ${cell} | 22 |`, `| ${cell} | 23 |`);
      expect(checkSPArithmetic(wrong, "timeline").map((v) => v.message)).toEqual([
        "SP total row shows 23 but individual rows sum to 22",
      ]);
    }
  });

  it("table sp_arithmetic reads the closing bold of a label apart from the rest of the cell", () => {
    // Codex review of #254: the closing `**` of a bold label was read as the
    // punctuation that starts the rest of the cell, so `**Totals** carried`
    // and `**Sum**-up task` were read as totals while their plain forms are
    // data. A bold label or unit followed by nothing, a unit or punctuation
    // is still a total.
    const table = ["| Item | SP |", "|---|---|", "| STORY-1 | 3 |", "| **Totals** carried | 7 |", "| **Sum**-up task | 2 |", "| **Grand Total** | 12 |"].join("\n");
    expect(checkSPArithmetic(table, "timeline")).toEqual([]);
    const wrong = table.replace("| **Grand Total** | 12 |", "| **Grand Total** | 3 |");
    expect(checkSPArithmetic(wrong, "timeline").map((v) => v.message)).toEqual([
      "SP total row shows 3 but individual rows sum to 12",
    ]);
    for (const cell of ["**Totals**", "Total **SP**", "**Total** SP", "**Total**:", "**Total:**"]) {
      const total = ["| Item | SP |", "|---|---|", "| STORY-1 | 20 |", "| STORY-2 | 2 |", `| ${cell} | 22 |`, "| **Grand Total** | 22 |"].join("\n");
      expect(checkSPArithmetic(total, "timeline")).toEqual([]);
      const off = total.replace(`| ${cell} | 22 |`, `| ${cell} | 23 |`);
      expect(checkSPArithmetic(off, "timeline").map((v) => v.message)).toEqual([
        "SP total row shows 23 but individual rows sum to 22",
      ]);
    }
  });

  it("table sp_arithmetic reads an italic rest after a space as part of a total cell", () => {
    // Review of #255: the rest of a total cell refused `*` even after a space,
    // so `Total *(committed)*` and `**Total** *(all)*` were summed as stories
    // and a right total of 22 was reported as `sum to 44`.
    for (const cell of ["Total *(committed)*", "**Total** *(all)*", "Total **(all)**", "Total SP *(sprint 1)*"]) {
      const table = ["| Item | SP |", "|---|---|", "| STORY-1 | 20 |", "| STORY-2 | 2 |", `| ${cell} | 22 |`, "| **Grand Total** | 22 |"].join("\n");
      expect(checkSPArithmetic(table, "timeline")).toEqual([]);
      const wrong = table.replace(`| ${cell} | 22 |`, `| ${cell} | 23 |`);
      expect(checkSPArithmetic(wrong, "timeline").map((v) => v.message)).toEqual([
        "SP total row shows 23 but individual rows sum to 22",
      ]);
    }
    // An italic word after the label is data, as a plain word is; stars with
    // no space before them are still the closing bold.
    const data = ["| Item | SP |", "|---|---|", "| STORY-1 | 3 |", "| Total *carried* | 4 |", "| **Totals** *carried* | 5 |", "| **Sum**-up task | 2 |", "| **Grand Total** | 14 |"].join("\n");
    expect(checkSPArithmetic(data, "timeline")).toEqual([]);
    const off = data.replace("| **Grand Total** | 14 |", "| **Grand Total** | 3 |");
    expect(checkSPArithmetic(off, "timeline").map((v) => v.message)).toEqual([
      "SP total row shows 3 but individual rows sum to 14",
    ]);
  });

  it("table sp_arithmetic reads a bold-italic or underscore emphasis after a space as part of a total cell", () => {
    // Review of #256: the emphasis run after a space took one or two `*`, so
    // the bold-italic `Total ***(all)***` was summed as a story and a right
    // total of 22 was reported as `sum to 44`; and the rest could start with
    // `_`, so `Total _carried_` was read as a total and left out of the sum.
    for (const cell of ["Total ***(all)***", "**Total** ***(all)***", "Total _(committed)_", "**Total** __(all)__", "Total SP _(sprint 1)_"]) {
      const table = ["| Item | SP |", "|---|---|", "| STORY-1 | 20 |", "| STORY-2 | 2 |", `| ${cell} | 22 |`, "| **Grand Total** | 22 |"].join("\n");
      expect(checkSPArithmetic(table, "timeline")).toEqual([]);
      const wrong = table.replace(`| ${cell} | 22 |`, `| ${cell} | 23 |`);
      expect(checkSPArithmetic(wrong, "timeline").map((v) => v.message)).toEqual([
        "SP total row shows 23 but individual rows sum to 22",
      ]);
    }
    // A word in underscore emphasis after the label is data, as `*carried*` is.
    const data = ["| Item | SP |", "|---|---|", "| STORY-1 | 3 |", "| Total _carried_ | 4 |", "| **Totals** __carried__ | 5 |", "| Total ***carried*** | 1 |", "| **Grand Total** | 13 |"].join("\n");
    expect(checkSPArithmetic(data, "timeline")).toEqual([]);
    const off = data.replace("| **Grand Total** | 13 |", "| **Grand Total** | 3 |");
    expect(checkSPArithmetic(off, "timeline").map((v) => v.message)).toEqual([
      "SP total row shows 3 but individual rows sum to 13",
    ]);
  });

  it("table sp_arithmetic reads a lone or long marker run, or an emphasis glued to a closing bold, as data", () => {
    // Review of #257: `Total _` and `Total ____` were totals with #256 and
    // became data with #257, and `**Total**_(all)_` is data while
    // `**Total**(x)` is a total, with no test on either. They are data, as
    // their `*` forms already were: emphasis starts the rest of a total cell
    // only after a space, and only as one to three markers followed by a
    // character that is neither a letter, a space, `*`, `_` nor a pipe
    // (punctuation, a digit or a symbol), so a marker followed by a space or a
    // pipe, a run of four, or markers right after the closing bold do not.
    // A run of four followed by punctuation (`Total ****(all)****`) pins the
    // bound of three: `Total ****` and `Total ____` end their run on a space,
    // so they stay data even with an unbounded run (review of #258).
    for (const cell of ["Total _", "Total *", "Total ____", "Total ****", "Total ****(all)****", "Total ____(all)____", "**Total**_(all)_", "**Total***(all)*"]) {
      const table = ["| Item | SP |", "|---|---|", "| STORY-1 | 20 |", "| STORY-2 | 2 |", `| ${cell} | 22 |`, "| **Grand Total** | 22 |"].join("\n");
      expect(checkSPArithmetic(table, "timeline").map((v) => v.message)).toEqual([
        "SP total row shows 22 but individual rows sum to 44",
      ]);
    }
    const total = ["| Item | SP |", "|---|---|", "| STORY-1 | 20 |", "| STORY-2 | 2 |", "| **Total**(x) | 22 |", "| **Grand Total** | 22 |"].join("\n");
    expect(checkSPArithmetic(total, "timeline")).toEqual([]);
  });

  it("table sp_arithmetic reads a unit then words, or a hyphenated unit, as a total, and a subtotal row as neither", () => {
    // Issue #118: `Total SP delivered` and `Total story-points` were summed as
    // stories, so beside a grand total of 22 a right total was reported as
    // `sum to 44`.
    for (const cell of ["Total SP delivered", "**Total SP** delivered", "Total story-points", "Total story points delivered", "Grand Total pts (sprint 1)"]) {
      const table = ["| Item | SP |", "|---|---|", "| STORY-1 | 20 |", "| STORY-2 | 2 |", `| ${cell} | 22 |`, "| **Grand Total** | 22 |"].join("\n");
      expect(checkSPArithmetic(table, "timeline")).toEqual([]);
      const wrong = table.replace(`| ${cell} | 22 |`, `| ${cell} | 23 |`);
      expect(checkSPArithmetic(wrong, "timeline").map((v) => v.message)).toEqual([
        "SP total row shows 23 but individual rows sum to 22",
      ]);
    }
    // A word after the label with no unit between is still data.
    const data = ["| Item | SP |", "|---|---|", "| STORY-1 | 3 |", "| Total carried | 4 |", "| Total story | 1 |", "| **Grand Total** | 8 |"].join("\n");
    expect(checkSPArithmetic(data, "timeline")).toEqual([]);
    // A subtotal row is neither summed nor checked against the whole table:
    // each one is right for its epic, the grand total for the table.
    for (const cell of ["Subtotal", "**Subtotal**", "Sub-total", "Subtotals", "Subtotal SP", "Subtotal (epic A)", "**Sub-total SP** delivered"]) {
      const table = ["| Item | SP |", "|---|---|", "| STORY-1 | 2 |", "| STORY-2 | 3 |", `| ${cell} | 5 |`, "| STORY-3 | 4 |", `| ${cell} | 4 |`, "| **Total** | 9 |"].join("\n");
      expect(checkSPArithmetic(table, "timeline")).toEqual([]);
      const wrong = table.replace("| **Total** | 9 |", "| **Total** | 18 |");
      expect(checkSPArithmetic(wrong, "timeline").map((v) => v.message)).toEqual([
        "SP total row shows 18 but individual rows sum to 9",
      ]);
    }
    // A word that only starts with `Sub` stays data.
    const sub = ["| Item | SP |", "|---|---|", "| Subtask A | 2 |", "| Subtotality | 1 |", "| **Total** | 3 |"].join("\n");
    expect(checkSPArithmetic(sub, "timeline")).toEqual([]);
  });

  it("table sp_arithmetic reads a spaced subtotal, a plural unit and a joined unit as the label they spell", () => {
    // Review of #270: `| Sub total |` (with a space) did not match the
    // subtotal label, and `Total SPs` and `Total storypoints` did not match a
    // unit, so each was summed as a story and none of them was pinned by a
    // test. Beside a grand total of 22, a right total was reported as
    // `sum to 44`; a right subtotal doubled its stories.
    for (const cell of ["Total SPs", "**Total SPs** delivered", "Total storypoints", "Total story-point", "Grand Total Story Points"]) {
      const table = ["| Item | SP |", "|---|---|", "| STORY-1 | 20 |", "| STORY-2 | 2 |", `| ${cell} | 22 |`, "| **Grand Total** | 22 |"].join("\n");
      expect(checkSPArithmetic(table, "timeline"), cell).toEqual([]);
      const wrong = table.replace(`| ${cell} | 22 |`, `| ${cell} | 23 |`);
      expect(checkSPArithmetic(wrong, "timeline").map((v) => v.message), cell).toEqual([
        "SP total row shows 23 but individual rows sum to 22",
      ]);
    }
    for (const cell of ["Sub total", "**Sub total**", "Sub totals", "Sub total SPs", "Sub\ttotal (epic A)"]) {
      const table = ["| Item | SP |", "|---|---|", "| STORY-1 | 2 |", "| STORY-2 | 3 |", `| ${cell} | 5 |`, "| STORY-3 | 4 |", `| ${cell} | 4 |`, "| **Total** | 9 |"].join("\n");
      expect(checkSPArithmetic(table, "timeline"), cell).toEqual([]);
      const wrong = table.replace("| **Total** | 9 |", "| **Total** | 18 |");
      expect(checkSPArithmetic(wrong, "timeline").map((v) => v.message), cell).toEqual([
        "SP total row shows 18 but individual rows sum to 9",
      ]);
    }
    // A word after `Sub` that is not `total`, or a plural on a word that is
    // not a unit, stays data.
    const data = ["| Item | SP |", "|---|---|", "| Sub task | 2 |", "| Sub totality | 1 |", "| Total SPsx | 1 |", "| **Total** | 4 |"].join("\n");
    expect(checkSPArithmetic(data, "timeline")).toEqual([]);
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
