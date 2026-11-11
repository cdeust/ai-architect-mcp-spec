/**
 * Page fitting under a response budget, shared by the paged verification-plan
 * responses (page-plan-response.ts).
 *
 * The same search first shipped inside page-action-response.ts (#193); it is
 * stated here once, on sizes alone, so that a pager only says how large a
 * page of `count` items is.
 */
/**
 * precondition:  `zeroChars` is the serialized size of a response whose
 *                self-measuring field (`__page.final_chars`) holds 0, an
 *                integer >= 1.
 * postcondition: the size `s` of that response once the field holds `s`
 *                itself: `s = zeroChars - 1 + digits(s)`, since replacing the
 *                one-character `0` by `s` changes nothing but that number's
 *                digits. The smallest such `s` is returned; one exists
 *                because `zeroChars - 1 + d` has at most `d` digits as soon
 *                as `d` reaches the digit count of `zeroChars`, plus one.
 */
export function selfMeasuredChars(zeroChars) {
    for (let digits = 1;; digits++) {
        const size = zeroChars - 1 + digits;
        if (String(size).length === digits)
            return size;
    }
}
/**
 * precondition:  `remaining >= 1`; `sizeOf(n)` is the serialized size of the
 *                page holding the next `n` items, for 1 <= n <= remaining,
 *                and does not decrease when `n` grows.
 * postcondition: the largest `n` with `sizeOf(n) <= budgetChars`, or 1 when
 *                even one item does not fit: a page always holds one item,
 *                so that a walk along `next_offset` makes progress.
 *
 * The largest fitting count is bracketed by doubling from 1, then found by
 * binary search inside the bracket, so no probe measures more than about
 * twice a page (a binary search over the whole remainder would measure half
 * of it first).
 */
export function largestFittingCount(sizeOf, remaining, budgetChars) {
    let fit = 1;
    let over = remaining + 1;
    for (let probe = 2; probe <= remaining; probe *= 2) {
        if (sizeOf(probe) > budgetChars) {
            over = probe;
            break;
        }
        fit = probe;
    }
    let lo = fit + 1;
    let hi = over - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (sizeOf(mid) <= budgetChars) {
            fit = mid;
            lo = mid + 1;
        }
        else {
            hi = mid - 1;
        }
    }
    return fit;
}
//# sourceMappingURL=fit-page.js.map