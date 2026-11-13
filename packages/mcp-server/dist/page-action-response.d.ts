/**
 * Response bounding for `get_pipeline_state(run_id, format:"action")` (#125).
 *
 * THE BUG THIS FIXES
 * -------------------
 * `boundEnvelopeResponse` sheds the `spawn_subagents` prompts that do not fit
 * from an oversized `start_pipeline` / `submit_action_result` envelope and
 * points the host at `get_pipeline_state(run_id, format:"action")` to recover
 * them (when this was written it shed every prompt of the batch). That
 * recovery path returned the whole unbounded action in one response, so a
 * judge batch whose envelope overshot the 100,000-char budget overshot it
 * again on the refetch: the 2026-10-10 audit of v0.8.0 measured about 112k
 * characters on that path, above the budget the server itself declares in
 * `__bounded.budget_chars`.
 *
 * THE FIX
 * -------
 * The refetch is paged by invocation. Each page carries the action with a
 * contiguous slice of `invocations`, starting at `invocation_offset`: the
 * longest slice whose serialized response stays within MAX_RESPONSE_CHARS.
 * The host refetches when the normal envelope's `__bounded.applied` records
 * `action.invocations[].prompt`: the prompts from that record's `next_offset`
 * on arrive as `omitted` stubs, and `next_offset` is the `invocation_offset`
 * to read them from. `__bounded` itself is present on every envelope.
 * Prompts are never cut: a host needs each prompt whole, so the unit of a page
 * is one invocation. A `__page` marker states where the slice sits in the
 * batch (`offset`, `count`, `total`, `next_offset`) and its measured size; the
 * host follows `next_offset` until it is `null`, then dispatches the batch.
 *
 * A page overshoots only when a single invocation, with the envelope around
 * it, does not fit. It is still returned whole (cutting it would hand the
 * judge a corrupt prompt), and the overshoot is observable: `final_chars >
 * budget_chars`. Judge prompts measured ~37k chars (e2e run_mrlqa0aj_u2rh15),
 * so this does not happen with the shipped prompt builder.
 */
export interface ActionPageMarker {
    /** Index in the full batch of the first invocation on this page. */
    readonly offset: number;
    /** Number of invocations on this page. */
    readonly count: number;
    /** Number of invocations in the full batch. */
    readonly total: number;
    /** `invocation_offset` of the next page, or `null` on the last page. */
    readonly next_offset: number | null;
    /** Serialized size of this response, `__page` included. */
    readonly final_chars: number;
    readonly budget_chars: number;
}
export interface ActionPage {
    readonly run_id: string;
    readonly action: unknown;
    readonly __page: ActionPageMarker;
}
export interface ActionPageError {
    readonly error: string;
}
/**
 * precondition:  `zeroChars` is the serialized size of a response whose
 *                `final_chars` is 0, an integer >= 1.
 * postcondition: the size `s` of that response once `final_chars` holds `s`
 *                itself: `s = zeroChars - 1 + digits(s)`, since replacing the
 *                one-character `0` by `s` changes nothing but that number's
 *                digits. The smallest such `s` is returned; one exists
 *                because `zeroChars - 1 + d` has at most `d` digits as soon
 *                as `d` reaches the digit count of `zeroChars`, plus one.
 *
 * Computed, not re-measured: the size was found by serializing the page
 * again until the value was stable (two or three passes), which tripled the
 * serialization cost of every probe of every page.
 */
export declare function selfMeasuredChars(zeroChars: number): number;
/**
 * precondition:  `action` is the unbounded last action cached for `runId`
 *                (or `null` when none is cached); `offset` is an integer >= 0;
 *                `budgetChars` is the response budget, the server's declared
 *                MAX_RESPONSE_CHARS unless a caller states another (the
 *                tests sweep page sizes at a smaller one: the search
 *                compares sizes with the budget and nothing else).
 * postcondition: for a `spawn_subagents` action, the returned page holds the
 *                invocations [offset, offset + count) of the batch, every
 *                other field of the action unchanged, and
 *                `__page.final_chars <= budgetChars` unless the single
 *                invocation at `offset` alone exceeds the budget (count = 1,
 *                overshoot visible in `final_chars`). Following `next_offset`
 *                from 0 visits every invocation exactly once. Any other
 *                action is returned whole on one page (offset must be 0).
 *                An offset past the end of the batch is an error.
 */
export declare function pageActionResponse(runId: string, action: unknown, offset: number, budgetChars?: number): ActionPage | ActionPageError;
//# sourceMappingURL=page-action-response.d.ts.map