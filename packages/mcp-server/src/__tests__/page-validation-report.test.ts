/**
 * Unit tests for the paging of validation reports (#125). The sweeps run at
 * small budgets: the search compares sizes with the budget and nothing else,
 * and the real 100,000-char budget is held end to end, through the built
 * server, by validation-response-budget.test.ts.
 */
import { describe, expect, it } from "vitest";
import { MAX_RESPONSE_CHARS } from "@prd-gen/orchestration";
import {
  pageValidationReport,
  reportPageResult,
  reportWireText,
  type CheckedReport,
  type ReportPage,
} from "../page-validation-report.js";

function violation(i: number, contentChars: number) {
  return {
    rule: "no_self_referencing_deps" as const,
    sectionType: "user_stories" as const,
    message: `STORY-${i} references itself in dependencies`,
    offendingContent: `${i}:` + "x".repeat(contentChars),
    location: null,
    isCritical: true,
    scorePenalty: 0.15,
  };
}

/** `symbols` undefined: the host sent no graph, the report has no symbol check. */
function report(violations: number, contentChars: number, symbols?: number): CheckedReport {
  const base: CheckedReport = {
    violations: Array.from({ length: violations }, (_, i) => violation(i, contentChars)),
    rulesChecked: ["no_self_referencing_deps", "sp_arithmetic"],
    rulesPassed: ["sp_arithmetic"],
    sectionType: "user_stories",
    hasCriticalViolations: violations > 0,
    totalScore: violations > 0 ? 0.5 : 1,
    checkedAt: "2026-11-13T00:00:00.000Z",
  };
  if (symbols === undefined) return base;
  return {
    ...base,
    symbolExistence: {
      checkedSymbols: symbols + 2,
      knownSymbols: 7,
      unresolvedSymbols: Array.from({ length: symbols }, (_, i) => ({
        symbol: `Service${i}.run` + "y".repeat(contentChars),
        occurrences: 1 + (i % 3),
      })),
    },
  };
}

function walk(r: CheckedReport, budget?: number): ReportPage[] {
  const pages: ReportPage[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = pageValidationReport(r, offset, budget);
    if ("error" in page) throw new Error(page.error);
    pages.push(page);
    offset = page.__page.next_offset;
    if (pages.length > 10_000) throw new Error("walk does not terminate");
  }
  return pages;
}

/** The fields that describe the whole report: everything but the two item lists. */
function summaryOf(value: CheckedReport): unknown {
  const { violations: _violations, symbolExistence, ...rest } = value as CheckedReport & { __page?: unknown };
  delete (rest as { __page?: unknown }).__page;
  if (symbolExistence === undefined) return rest;
  const { unresolvedSymbols: _unresolved, ...counts } = symbolExistence;
  return { ...rest, symbolExistence: counts };
}

function unresolvedOf(value: CheckedReport) {
  return value.symbolExistence?.unresolvedSymbols ?? [];
}

describe("pageValidationReport", () => {
  it("returns a report that fits whole, on one page, with its size and its own key order", () => {
    const r = report(4, 20, 3);
    const page = pageValidationReport(r, 0) as ReportPage;
    const { __page, ...body } = page;
    expect(body).toEqual(r);
    expect(Object.keys(page)).toEqual([...Object.keys(r), "__page"]);
    expect(__page).toMatchObject({ offset: 0, count: 7, total: 7, next_offset: null });
    expect(__page.budget_chars).toBe(MAX_RESPONSE_CHARS);
    expect(__page.final_chars).toBe(reportWireText(page).length);
  });

  it("adds no symbolExistence to a report that has none", () => {
    const page = pageValidationReport(report(2, 20), 0) as ReportPage;
    expect(page).not.toHaveProperty("symbolExistence");
    expect(page.__page).toMatchObject({ offset: 0, count: 2, total: 2, next_offset: null });
  });

  it("returns a report with no item as one page that keeps its verdict", () => {
    const r = report(0, 0, 0);
    const page = pageValidationReport(r, 0) as ReportPage;
    expect(summaryOf(page)).toEqual(summaryOf(r));
    expect(page.violations).toEqual([]);
    expect(unresolvedOf(page)).toEqual([]);
    expect(page.__page).toMatchObject({ offset: 0, count: 0, total: 0, next_offset: null });
  });

  it("fills every page and visits every item once, violations then unresolved symbols, for page sizes 1 to 17", () => {
    const budget = 10_000;
    const empty = (pageValidationReport(report(0, 0, 0), 0) as ReportPage).__page.final_chars;
    const seenCounts = new Set<number>();
    for (let size = 1; size <= 17; size++) {
      // Sized so that about `size` violations fill a page.
      const contentChars = Math.floor((budget - empty) / (size + 0.5)) - 260;
      expect(contentChars).toBeGreaterThan(0);
      for (const [violations, symbols] of [[1, 0], [2, 1], [5, 0], [0, 9], [9, 4], [16, 17], [33, 2], [50, 50]]) {
        const r = report(violations, contentChars, symbols);
        const pages = walk(r, budget);
        for (const page of pages) {
          expect(page.__page.final_chars).toBe(reportWireText(page).length);
          expect(page.__page.final_chars).toBeLessThanOrEqual(budget);
          expect(page.__page.budget_chars).toBe(budget);
          expect(page.__page.total).toBe(violations + symbols);
          expect(page.__page.count).toBe(page.violations.length + unresolvedOf(page).length);
          // The whole-report fields are on every page.
          expect(summaryOf(page)).toEqual(summaryOf(r));
          const { offset, count, next_offset } = page.__page;
          if (next_offset === null) continue;
          // One more item would not have fit.
          const bigger = pageValidationReport(r, offset, Number.MAX_SAFE_INTEGER) as ReportPage;
          const oneMore = {
            ...bigger,
            violations: r.violations.slice(offset, offset + count + 1),
            symbolExistence: {
              ...r.symbolExistence!,
              unresolvedSymbols: unresolvedOf(r).slice(
                Math.max(0, offset - violations),
                Math.max(0, offset + count + 1 - violations),
              ),
            },
            __page: page.__page,
          };
          expect(reportWireText(oneMore).length).toBeGreaterThan(budget);
          seenCounts.add(count);
        }
        expect(pages.flatMap((page) => page.violations)).toEqual(r.violations);
        expect(pages.flatMap((page) => unresolvedOf(page))).toEqual(unresolvedOf(r));
        // No unresolved symbol comes before the last violation.
        const firstSymbolPage = pages.findIndex((page) => unresolvedOf(page).length > 0);
        if (firstSymbolPage >= 0) {
          for (const later of pages.slice(firstSymbolPage + 1)) expect(later.violations).toEqual([]);
        }
      }
    }
    for (let size = 1; size <= 17; size++) expect(seenCounts).toContain(size);
  });

  it("returns an item larger than the budget whole, on its own page, with the overshoot visible", () => {
    const r = report(3, 10, 2);
    (r.violations[1] as { offendingContent: string }).offendingContent = "z".repeat(3_000);
    const pages = walk(r, 2_000);
    const oversize = pages.find((page) => page.__page.offset === 1)!;
    expect(oversize.__page.count).toBe(1);
    expect(oversize.__page.final_chars).toBeGreaterThan(oversize.__page.budget_chars);
    expect(oversize.violations).toEqual([r.violations[1]]);
    expect(pages.flatMap((page) => page.violations)).toEqual(r.violations);
    expect(pages.flatMap((page) => unresolvedOf(page))).toEqual(unresolvedOf(r));
  });

  it("rejects NaN, negative, fractional and out-of-range offsets", () => {
    const r = report(2, 10, 1);
    for (const bad of [Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(pageValidationReport(r, bad)).toMatchObject({
        error: expect.stringContaining("is not a non-negative integer"),
      });
    }
    expect(pageValidationReport(r, 3)).toMatchObject({
      error: expect.stringContaining("the report has 3 items"),
    });
    expect(pageValidationReport(report(0, 0), 1)).toMatchObject({
      error: expect.stringContaining("the report has 0 items"),
    });
  });
});

describe("reportPageResult", () => {
  it("ships the page as pretty-printed JSON, from offset 0 when none is given", () => {
    const r = report(3, 10);
    const result = reportPageResult(r, undefined);
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe(reportWireText(pageValidationReport(r, 0)));
  });

  it("marks a refused offset as an error", () => {
    const result = reportPageResult(report(3, 10), 9);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: "item_offset 9 out of range: the report has 3 items",
    });
  });
});
