/**
 * A finding names the first identifiers it found and counts the rest (#125).
 *
 * source: measured 2026-11-13 on main @ a2c2fb6. A 23-char section holding
 * `AC-1` and `AC-20000` gave one `ac_numbering` violation of 189,076 chars; a
 * section holding `AC-1` and `AC-2000000`, one of 22.9 MB in 253 ms; with
 * `AC-2000000000` the rule threw `RangeError: Invalid array length`. The MCP
 * server declares a 100,000-char budget for a whole response.
 */
import { describe, expect, it } from "vitest";
import { validateDocument, validateSection } from "../hard-output-rules/index.js";
import { MAX_LISTED_IDS, listedIds, missingNumbers } from "../hard-output-rules/rules/listed-ids.js";

/** The serialized size of the largest violation of a report. */
function largestViolation(report: { violations: unknown[] }): number {
  return Math.max(0, ...report.violations.map((v) => JSON.stringify(v).length));
}

function messageOf(report: { violations: Array<{ rule: string; message: string }> }, rule: string): string {
  const found = report.violations.find((v) => v.rule === rule);
  expect(found, `no ${rule} violation`).toBeDefined();
  return found!.message;
}

describe("listedIds", () => {
  it("names every identifier of a short list, as before", () => {
    expect(listedIds(["FR-1", "FR-2", "FR-3"])).toBe("FR-1, FR-2, FR-3");
    const twenty = Array.from({ length: MAX_LISTED_IDS }, (_, i) => `FR-${i}`);
    expect(listedIds(twenty)).toBe(twenty.join(", "));
  });

  it("names the first ones of a long list and counts the rest", () => {
    const ids = Array.from({ length: MAX_LISTED_IDS + 5 }, (_, i) => `FR-${i}`);
    expect(listedIds(ids)).toBe(`${ids.slice(0, MAX_LISTED_IDS).join(", ")} and 5 more`);
  });

  it("counts against the total a caller states, when it holds only the first ones", () => {
    expect(listedIds(["AC-2", "AC-3"], 19_998)).toBe("AC-2, AC-3 and 19996 more");
  });

  it("is empty for an empty list", () => {
    expect(listedIds([])).toBe("");
  });
});

describe("missingNumbers", () => {
  it("finds what is missing between consecutive numbers", () => {
    expect(missingNumbers([1, 2, 5, 6, 9])).toEqual({ first: [3, 4, 7, 8], count: 4 });
    expect(missingNumbers([1, 2, 3])).toEqual({ first: [], count: 0 });
    expect(missingNumbers([7])).toEqual({ first: [], count: 0 });
    expect(missingNumbers([])).toEqual({ first: [], count: 0 });
  });

  it("counts a wide gap without walking it, and keeps the smallest numbers", () => {
    const missing = missingNumbers([1, 2_000_000_000, 2_000_000_003]);
    expect(missing.count).toBe(1_999_999_998 + 2);
    expect(missing.first).toEqual(Array.from({ length: MAX_LISTED_IDS }, (_, i) => i + 2));
  });

  it("takes the first numbers across several gaps, in order", () => {
    const missing = missingNumbers([1, 13, 30]);
    expect(missing.count).toBe(11 + 16);
    expect(missing.first).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
  });
});

describe("numbering rules on a wide gap", () => {
  it("ac_numbering names twenty missing numbers and counts the others", () => {
    const report = validateSection("- AC-1: a\n- AC-20000: b", "acceptance_criteria");
    expect(messageOf(report, "ac_numbering")).toBe(
      "AC numbering has gaps: missing AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, " +
        "AC-12, AC-13, AC-14, AC-15, AC-16, AC-17, AC-18, AC-19, AC-20, AC-21 and 19978 more",
    );
    expect(largestViolation(report)).toBeLessThan(1_000);
  });

  it("fr_numbering_gaps does the same", () => {
    const report = validateSection("- FR-1: a\n- FR-20000: b", "requirements");
    expect(messageOf(report, "fr_numbering_gaps")).toMatch(/^FR numbering has gaps: missing FR-2, .*FR-21 and 19978 more$/);
    expect(largestViolation(report)).toBeLessThan(1_000);
  });

  it("answers the widest gap an identifier can open", () => {
    // The range was walked number by number and every missing one stored:
    // a gap of two billion threw `RangeError: Invalid array length` after
    // about 2 s. Nine digits is the longest number read as an identifier.
    const report = validateSection("- AC-1: a\n- AC-999999999: b", "acceptance_criteria");
    expect(messageOf(report, "ac_numbering")).toMatch(/AC-21 and 999999977 more$/);
  });

  it("the document-level rule is bounded too", () => {
    const report = validateDocument([
      { type: "acceptance_criteria", content: "- AC-1: a\n- AC-20000: b" },
      { type: "requirements", content: "- FR-1: a\n- FR-20000: b" },
    ]);
    expect(report.violations.length).toBeGreaterThan(1);
    expect(largestViolation(report)).toBeLessThan(1_000);
  });

  it("names a short gap in full, as before", () => {
    const report = validateSection("- AC-1: a\n- AC-4: b", "acceptance_criteria");
    const violation = report.violations.find((v) => v.rule === "ac_numbering")!;
    expect(violation.message).toBe("AC numbering has gaps: missing AC-2, AC-3");
    expect(violation.offendingContent).toBe("Found: AC-1, AC-4");
  });
});

describe("identifier numbers past nine digits", () => {
  // Review of #236: past 2^53 a number cannot be told from its neighbour, so
  // these two named AC-9007199254740992, which is present, as missing twenty
  // times; a run of 309 digits read as Infinity ("and Infinity more").
  it("does not read a longer run of digits as an identifier", () => {
    const report = validateSection("- AC-9007199254740992: a\n- AC-9007199254740994: b", "acceptance_criteria");
    expect(report.violations.filter((v) => v.rule === "ac_numbering")).toEqual([]);
  });

  it("keeps the identifiers it can read when another is too long", () => {
    const report = validateSection(`- AC-1: a\n- AC-3: b\n- AC-${"9".repeat(309)}: c`, "acceptance_criteria");
    expect(messageOf(report, "ac_numbering")).toBe("AC numbering has gaps: missing AC-2");
  });

  it("still reads a nine-digit identifier", () => {
    const report = validateSection("- AC-999999998: a\n- AC-999999999: b\n- AC-999999990: c", "acceptance_criteria");
    expect(messageOf(report, "ac_numbering")).toMatch(/^AC numbering has gaps: missing AC-999999991, .*AC-999999997$/);
  });

  it("applies to requirements and to the document rule", () => {
    const section = validateSection("- FR-9007199254740992: a\n- FR-9007199254740994: b", "requirements");
    expect(section.violations.filter((v) => v.rule === "fr_numbering_gaps")).toEqual([]);
    const document = validateDocument([
      { type: "acceptance_criteria", content: "- AC-9007199254740992: a" },
      { type: "testing", content: "- AC-9007199254740994 is tested." },
    ]);
    expect(document.violations.filter((v) => v.rule === "ac_numbering")).toEqual([]);
  });
});

describe("lists of found identifiers", () => {
  it("names the first identifiers found and counts the rest", () => {
    // 300 consecutive ACs, then one far away: one gap finding, 301 found.
    const content = Array.from({ length: 300 }, (_, i) => `- AC-${i + 1}: criterion ${i + 1}`).join("\n") + "\n- AC-400: last";
    const violation = validateSection(content, "acceptance_criteria").violations.find((v) => v.rule === "ac_numbering")!;
    expect(violation.offendingContent).toMatch(/^Found: AC-1, AC-2, .*AC-20 and 281 more$/);
  });

  it("fr_to_ac_coverage names twenty uncovered requirements of three hundred", () => {
    // The rule reads the requirements defined in a table.
    const requirements =
      "| ID | Requirement |\n|---|---|\n" +
      Array.from({ length: 300 }, (_, i) => `| FR-${String(i + 1).padStart(3, "0")} | The system does thing ${i + 1}. |`).join("\n");
    const report = validateDocument([
      { type: "requirements", content: requirements },
      { type: "acceptance_criteria", content: "- AC-001: Nothing here names a requirement." },
    ]);
    const message = messageOf(report, "fr_to_ac_coverage");
    expect(message).toMatch(/^300 FR\(s\) have no acceptance criteria: FR-001, FR-002, .*FR-020 and 280 more$/);
  });
});
