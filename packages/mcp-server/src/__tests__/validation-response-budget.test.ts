/**
 * Size contract of the two validators (#125): no response of
 * `validate_prd_section` or `validate_prd_document` exceeds the 100,000-char
 * budget the server declares (MAX_RESPONSE_CHARS), and paging the report
 * loses and duplicates no violation and no unresolved symbol.
 *
 * Driven through the built server over stdio, so the measured text is the
 * text a host receives: the two tools are registered in index.ts.
 *
 * source: measured 2026-11-13 through the stdio server built from main @
 * efd9e2e, before the change. `validate_prd_section` returned 487,789 chars
 * for the 1,500 stories below (111,169 chars) and 332,597 chars for the
 * 4,000 symbol references (78,889 chars); `validate_prd_document` returned
 * 514,288 chars for a document of four sections (333,337 chars).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ValidationReport } from "@prd-gen/core";
import { MAX_RESPONSE_CHARS } from "@prd-gen/orchestration";
import { checkSymbolExistence, validateDocument, validateSection } from "@prd-gen/validation";
import type { ReportPage } from "../page-validation-report.js";
import {
  SELF_DEPENDENT_STORIES as STORIES,
  UNRESOLVED_SYMBOL_REFERENCES as SYMBOLS,
} from "./large-inputs.js";
import { startStdioServer, type StdioServer } from "./stdio-server.js";

// Above vitest's 5 s default: each page is a validator call on a section of
// about 100,000 chars, in a server shared by the file.
const TEST_TIMEOUT_MS = 60_000;

let server: StdioServer;

beforeAll(async () => {
  server = await startStdioServer();
});

afterAll(async () => {
  await server?.close();
});

/** Follows `__page.next_offset` from 0; returns every response text. */
async function walk(tool: string, args: Record<string, unknown>): Promise<string[]> {
  const texts: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const response = await server.call(tool, { ...args, item_offset: offset });
    expect(response.isError, response.text.slice(0, 300)).toBe(false);
    texts.push(response.text);
    const page = (JSON.parse(response.text) as ReportPage).__page;
    expect(page.offset).toBe(offset);
    offset = page.next_offset;
    if (texts.length > 1_000) throw new Error("walk does not terminate");
  }
  return texts;
}

/** A report without the time of the call, the one field two calls differ by. */
function timeless<T extends { checkedAt: string }>(report: T): Omit<T, "checkedAt"> {
  const { checkedAt: _checkedAt, ...rest } = report;
  return rest;
}

/**
 * Checks the pages of one report against the report the validator returns
 * in process: sizes, the whole-report fields on every page, and the items.
 */
function expectPagesToBe(
  texts: string[],
  whole: ValidationReport & { symbolExistence?: ReturnType<typeof checkSymbolExistence> },
): void {
  expect(JSON.stringify(whole, null, 2).length).toBeGreaterThan(MAX_RESPONSE_CHARS);
  expect(texts.length).toBeGreaterThan(1);
  const pages = texts.map((text) => JSON.parse(text) as ReportPage);
  const total = whole.violations.length + (whole.symbolExistence?.unresolvedSymbols.length ?? 0);
  texts.forEach((text, i) => {
    expect(text.length, `page ${i}`).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(pages[i].__page.final_chars, `page ${i}`).toBe(text.length);
    expect(pages[i].__page.budget_chars).toBe(MAX_RESPONSE_CHARS);
    expect(pages[i].__page.total).toBe(total);
    const { violations: _violations, symbolExistence, __page: _page, ...summary } = pages[i];
    const { violations: _all, symbolExistence: wholeSymbols, ...wholeSummary } = whole;
    expect(timeless(summary), `page ${i}`).toEqual(timeless(wholeSummary));
    expect(symbolExistence?.checkedSymbols).toBe(wholeSymbols?.checkedSymbols);
    expect(symbolExistence?.knownSymbols).toBe(wholeSymbols?.knownSymbols);
  });
  expect(pages.flatMap((page) => page.violations)).toEqual(whole.violations);
  expect(pages.flatMap((page) => page.symbolExistence?.unresolvedSymbols ?? [])).toEqual(
    whole.symbolExistence?.unresolvedSymbols ?? [],
  );
  expect(pages.reduce((n, page) => n + page.__page.count, 0)).toBe(total);
}

describe("validators: every response within the declared budget (#125)", () => {
  it("validate_prd_section pages 1,500 violations under the budget, losing and duplicating none", async () => {
    const whole = validateSection(STORIES, "user_stories");
    expect(whole.violations.length).toBeGreaterThanOrEqual(1_500);
    const texts = await walk("validate_prd_section", { content: STORIES, section_type: "user_stories" });
    expectPagesToBe(texts, whole);
    expect(JSON.parse(texts[0])).not.toHaveProperty("symbolExistence");
  }, TEST_TIMEOUT_MS);

  it("validate_prd_section pages 4,000 unresolved symbols after the violations", async () => {
    const report = validateSection(SYMBOLS, "technical_specification");
    const whole = { ...report, symbolExistence: checkSymbolExistence(SYMBOLS, []) };
    expect(whole.symbolExistence.unresolvedSymbols).toHaveLength(4_000);
    const texts = await walk("validate_prd_section", {
      content: SYMBOLS,
      section_type: "technical_specification",
      known_symbols: [],
    });
    expectPagesToBe(texts, whole);
    // The violations come first: they are all on the first page here.
    expect((JSON.parse(texts[0]) as ReportPage).violations).toEqual(whole.violations);
  }, TEST_TIMEOUT_MS);

  it("validate_prd_document pages the report of a whole document", async () => {
    const sections = [
      { type: "user_stories" as const, content: STORIES },
      { type: "technical_specification" as const, content: SYMBOLS },
    ];
    const whole = {
      ...validateDocument(sections),
      symbolExistence: checkSymbolExistence(
        sections.map((s) => s.content),
        ["Service7.run", "Service8"],
      ),
    };
    expect(whole.violations.length).toBeGreaterThanOrEqual(1_500);
    expect(whole.symbolExistence.unresolvedSymbols.length).toBeGreaterThan(3_900);
    const texts = await walk("validate_prd_document", {
      sections,
      known_symbols: ["Service7.run", "Service8"],
    });
    expectPagesToBe(texts, whole);
  }, TEST_TIMEOUT_MS);

  it("returns a report that fits as one page with the fields of the report", async () => {
    const content = "- STORY-1: as a user I want to sign in — 2 SP. Depends On: STORY-1";
    const whole = validateSection(content, "user_stories");
    expect(whole.violations.length).toBeGreaterThan(0);
    const response = await server.call("validate_prd_section", { content, section_type: "user_stories" });
    expect(response.isError).toBe(false);
    const { __page, ...report } = JSON.parse(response.text) as ReportPage;
    expect(timeless(report)).toEqual(timeless(whole));
    expect(__page).toMatchObject({
      offset: 0,
      count: whole.violations.length,
      total: whole.violations.length,
      next_offset: null,
      final_chars: response.text.length,
    });
  }, TEST_TIMEOUT_MS);

  it("refuses an item_offset past the end of the report", async () => {
    const response = await server.call("validate_prd_section", {
      content: "## requirements\n\n- FR-001: The system supports OAuth login.",
      section_type: "requirements",
      item_offset: 10_000,
    });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.text).error).toContain("item_offset 10000 out of range");
  }, TEST_TIMEOUT_MS);
});
