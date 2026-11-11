/**
 * Response paging for `plan_section_verification` and
 * `plan_document_verification` (#125).
 *
 * THE BUG THIS FIXES
 * -------------------
 * A verification plan carries one JudgeRequest per (judge × subjective
 * claim), and `buildRequests` (verification/orchestrator.ts) puts the whole
 * document, as `context.prd_excerpt`, and every codebase and memory excerpt
 * into each of them. The response therefore grows as requests × document:
 * 57,992 chars of sections with 4 judge requests came back as 238,729 chars
 * (measured on #125, 2026-11-10), and 58,000 chars with 47 judge requests
 * as 2,803,785 chars (verification-response-budget.test.ts fixture,
 * 2026-11-11), above the 100,000-char budget the server declares
 * (MAX_RESPONSE_CHARS).
 *
 * THE FIX
 * -------
 * The plan is paged by judge request, on the model of
 * page-action-response.ts (#193). Each page carries a contiguous slice of
 * `judge_requests` starting at `request_offset`: the longest slice whose
 * serialized response stays within the budget. A `__page` marker states
 * where the slice sits (`offset`, `count`, `total`, `next_offset`) and its
 * measured size; the host calls the tool again with the same arguments and
 * `request_offset: next_offset` until `next_offset` is `null`.
 *
 * `claims` and `mechanical_claims` describe the whole plan, not a slice, so
 * they are returned once, on the page at offset 0, and left out of the
 * later pages, whose budget goes to judge requests.
 *
 * A request is never cut and its `context` is left as the planner built it:
 * the judges' input does not change. A page therefore overshoots only when
 * its first request does not fit on its own (on the page at offset 0: with
 * the claim lists), which happens once the document nears the budget. It is
 * still returned whole, and the overshoot is observable: `final_chars >
 * budget_chars`. Sending the document once per plan instead of once per
 * request would remove that case, and changes what a host must assemble for
 * a judge: it is not done here.
 *
 * The tools hold no state: every page is recomputed from the arguments, and
 * the planner is deterministic, so the pages of one plan are consistent as
 * long as the host repeats the same arguments.
 */
import type { VerificationPlan } from "@prd-gen/verification";
export interface PlanPageMarker {
    /** Index in the full plan of the first judge request on this page. */
    readonly offset: number;
    /** Number of judge requests on this page. */
    readonly count: number;
    /** Number of judge requests in the full plan. */
    readonly total: number;
    /** `request_offset` of the next page, or `null` on the last page. */
    readonly next_offset: number | null;
    /** Serialized size of this response, `__page` included. */
    readonly final_chars: number;
    readonly budget_chars: number;
}
export interface PlanPage {
    /** Present on the page at offset 0 only. */
    readonly claims?: VerificationPlan["claims"];
    readonly judge_requests: VerificationPlan["judge_requests"];
    /** Present on the page at offset 0 only. */
    readonly mechanical_claims?: VerificationPlan["mechanical_claims"];
    readonly __page: PlanPageMarker;
}
export interface PlanPageError {
    readonly error: string;
}
/** The exact wire format pipeline-tools.ts ships (pretty-printed JSON). */
export declare function planWireText(value: PlanPage | PlanPageError): string;
/**
 * precondition:  `plan` is the full plan the planner returns for the tool's
 *                arguments; `offset` is an integer >= 0; `budgetChars` is the
 *                response budget, the server's declared MAX_RESPONSE_CHARS
 *                unless a caller states another (the tests sweep page sizes
 *                at a smaller one: the search compares sizes with the budget
 *                and nothing else).
 * postcondition: the returned page holds the judge requests
 *                [offset, offset + count) of the plan, each one unchanged,
 *                plus `claims` and `mechanical_claims` when offset is 0, and
 *                `__page.final_chars <= budgetChars` unless the request at
 *                `offset` does not fit on its own page (count = 1, overshoot
 *                visible in `final_chars`). Following `next_offset` from 0
 *                visits every judge request exactly once, in order. A plan
 *                with no judge request is one page (offset must be 0). An
 *                offset past the end of the plan is an error.
 */
export declare function pagePlanResponse(plan: VerificationPlan, offset: number, budgetChars?: number): PlanPage | PlanPageError;
/**
 * What both plan tools say about paging, in their MCP description: a host
 * that reads only the first page verifies only part of the plan.
 */
export declare const PLAN_PAGING_DESCRIPTION: string;
/**
 * precondition:  as `pagePlanResponse`.
 * postcondition: the MCP tool result for that page: its wire text, and
 *                `isError` when the offset is refused.
 */
export declare function planPageResult(plan: VerificationPlan, offset: number): {
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError?: true;
};
//# sourceMappingURL=page-plan-response.d.ts.map