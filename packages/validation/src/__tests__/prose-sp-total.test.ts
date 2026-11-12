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
