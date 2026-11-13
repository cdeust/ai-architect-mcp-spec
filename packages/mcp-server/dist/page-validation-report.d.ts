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
import type { ValidationReport } from "@prd-gen/core";
import type { SymbolExistenceReport } from "@prd-gen/validation";
/** What the validators return: the report, plus the symbol check when asked. */
export type CheckedReport = ValidationReport & {
    symbolExistence?: SymbolExistenceReport;
};
export interface ReportPageMarker {
    /** Index in the item sequence of the first item on this page. */
    readonly offset: number;
    /** Number of items (violations, then unresolved symbols) on this page. */
    readonly count: number;
    /** Number of items in the full report. */
    readonly total: number;
    /** `item_offset` of the next page, or `null` on the last page. */
    readonly next_offset: number | null;
    /** Serialized size of this response, `__page` included. */
    readonly final_chars: number;
    readonly budget_chars: number;
}
export type ReportPage = CheckedReport & {
    readonly __page: ReportPageMarker;
};
export interface ReportPageError {
    readonly error: string;
}
/** The exact wire format index.ts ships (pretty-printed JSON). */
export declare function reportWireText(value: ReportPage | ReportPageError): string;
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
export declare function pageValidationReport(report: CheckedReport, offset: number, budgetChars?: number): ReportPage | ReportPageError;
/**
 * What both validators say about paging, in their MCP description: a host
 * that reads only the first page sees only part of the violations.
 */
export declare const REPORT_PAGING_DESCRIPTION: string;
/**
 * precondition:  as `pageValidationReport`.
 * postcondition: the MCP tool result for that page: its wire text, and
 *                `isError` when the offset is refused.
 */
export declare function reportPageResult(report: CheckedReport, offset: number | undefined): {
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError?: true;
};
//# sourceMappingURL=page-validation-report.d.ts.map