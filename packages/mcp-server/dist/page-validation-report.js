/**
 * Response paging for `validate_prd_section` and `validate_prd_document`
 * (#125).
 *
 * THE BUG THIS FIXES
 * -------------------
 * Both validators returned their whole report in one response. A report
 * holds one entry per violation, and, when the host sends `known_symbols`,
 * one entry per unresolved symbol, so it grows with the defects of the
 * document: 487,789 chars for a 111,169-char `user_stories` section whose
 * 1,500 stories each depend on themselves, 514,288 chars for a document of
 * four such sections, 332,597 chars for a 78,889-char section naming 4,000
 * symbols absent from the graph (measured 2026-11-13 through the stdio
 * server built from main @ efd9e2e), above the 100,000-char budget the
 * server declares (MAX_RESPONSE_CHARS).
 *
 * THE FIX
 * -------
 * The report is paged by item, on the model of page-plan-response.ts
 * (#210). The items are the violations, in the report's order, followed by
 * the unresolved symbols, in theirs. Each page carries a contiguous slice of
 * that sequence starting at `item_offset`: the longest slice whose
 * serialized response stays within the budget. A `__page` marker states
 * where the slice sits (`offset`, `count`, `total`, `next_offset`) and its
 * measured size; the host calls the tool again with the same arguments and
 * `item_offset: next_offset` until `next_offset` is `null`.
 *
 * Every other field describes the whole report, not a slice, and is on
 * every page: `rulesChecked`, `rulesPassed`, `sectionType`,
 * `hasCriticalViolations`, `totalScore`, `checkedAt`, and the two counts of
 * `symbolExistence`. They are bounded by the number of rules, so a host
 * that reads any one page knows the verdict.
 *
 * An item is never cut. A page therefore overshoots only when its first
 * item does not fit on its own, which takes a single violation of about the
 * size of the budget. It is still returned whole, and the overshoot is
 * observable: `final_chars > budget_chars`.
 *
 * The tools hold no state: every page is recomputed from the arguments, and
 * the validators are deterministic apart from `checkedAt`, the time of the
 * call, so the pages of one report are consistent as long as the host
 * repeats the same arguments.
 */
import { MAX_RESPONSE_CHARS } from "@prd-gen/orchestration";
import { largestFittingCount, selfMeasuredChars } from "./fit-page.js";
/** The exact wire format index.ts ships (pretty-printed JSON). */
export function reportWireText(value) {
    return JSON.stringify(value, null, 2);
}
function itemCount(report) {
    return report.violations.length + (report.symbolExistence?.unresolvedSymbols.length ?? 0);
}
function pageOf(report, offset, count, budgetChars) {
    const violationCount = report.violations.length;
    const total = itemCount(report);
    const end = offset + count;
    const marker = {
        offset,
        count,
        total,
        next_offset: end < total ? end : null,
        final_chars: 0,
        budget_chars: budgetChars,
    };
    // The spread keeps the report's own key order; `symbolExistence` is
    // rewritten only when the report carries one.
    const sliced = { ...report, violations: report.violations.slice(offset, end) };
    const symbols = report.symbolExistence;
    const body = symbols === undefined
        ? sliced
        : {
            ...sliced,
            symbolExistence: {
                ...symbols,
                unresolvedSymbols: symbols.unresolvedSymbols.slice(Math.max(0, offset - violationCount), Math.max(0, end - violationCount)),
            },
        };
    const draft = { ...body, __page: marker };
    // final_chars is part of the payload it measures: the page is serialized
    // once with a 0 placeholder, and the shipped size follows from it.
    const finalChars = selfMeasuredChars(reportWireText(draft).length);
    return { ...draft, __page: { ...marker, final_chars: finalChars } };
}
/**
 * precondition:  `report` is the full report the validator returns for the
 *                tool's arguments; `offset` is an integer >= 0; `budgetChars`
 *                is the response budget, the server's declared
 *                MAX_RESPONSE_CHARS unless a caller states another (the tests
 *                sweep page sizes at a smaller one: the search compares sizes
 *                with the budget and nothing else).
 * postcondition: the returned page holds the items [offset, offset + count)
 *                of the report (its violations, then its unresolved
 *                symbols), each one unchanged, every other field of the
 *                report as it is, and `__page.final_chars <= budgetChars`
 *                unless the item at `offset` does not fit on its own page
 *                (count = 1, overshoot visible in `final_chars`). Following
 *                `next_offset` from 0 visits every item exactly once, in
 *                order. A report with no item is one page (offset must be
 *                0). An offset past the end of the report is an error.
 */
export function pageValidationReport(report, offset, budgetChars = MAX_RESPONSE_CHARS) {
    // zod enforces this over MCP; an in-process call does not go through zod,
    // and NaN or a negative offset would make slice() drop or misplace items
    // while next_offset still reported a complete walk.
    if (!Number.isSafeInteger(offset) || offset < 0) {
        return { error: `item_offset ${offset} is not a non-negative integer` };
    }
    const total = itemCount(report);
    if (total === 0 && offset === 0)
        return pageOf(report, 0, 0, budgetChars);
    if (offset >= total) {
        return { error: `item_offset ${offset} out of range: the report has ${total} items` };
    }
    const count = largestFittingCount((n) => pageOf(report, offset, n, budgetChars).__page.final_chars, total - offset, budgetChars);
    return pageOf(report, offset, count, budgetChars);
}
/**
 * What both validators say about paging, in their MCP description: a host
 * that reads only the first page sees only part of the violations.
 */
export const REPORT_PAGING_DESCRIPTION = " The response is paged under the 100,000-char MCP response budget: each page holds " +
    "whole items (the violations, then the unresolved symbols) from item_offset (default 0), " +
    "and __page.next_offset is the offset of the next page, null on the last one. Call again " +
    "with the same arguments and item_offset set to next_offset until it is null. The other " +
    "fields (rulesChecked, rulesPassed, hasCriticalViolations, totalScore) describe the whole " +
    "report and are on every page.";
/**
 * precondition:  as `pageValidationReport`.
 * postcondition: the MCP tool result for that page: its wire text, and
 *                `isError` when the offset is refused.
 */
export function reportPageResult(report, offset) {
    // zod applies the default over MCP; a direct handler call (tests,
    // in-process hosts) may omit the field.
    const page = pageValidationReport(report, offset ?? 0);
    const content = [{ type: "text", text: reportWireText(page) }];
    return "error" in page ? { content, isError: true } : { content };
}
//# sourceMappingURL=page-validation-report.js.map