/**
 * Response bounding for `get_pipeline_state` format:"full" (Phase 1d).
 *
 * THE BUG THIS FIXES
 * ------------------
 * Phase 1c capped the unbounded *input* arrays individually, each derived as a
 * SHARE of the 100,000-char Claude Code MCP response budget:
 *   - codebase_grounding bundle fields  ≈ 90k  (PrdInputBundleSchema)
 *   - clarifications (50 turns × ~1k)    ≈ 50k
 *   - errors+error_kinds (50 × ~500)     ≈ 25k
 * The shares were computed independently and OVERLAP. A single state sitting at
 * all three caps serializes to 90k + 50k + 25k + (sections, prd_validation,
 * scalars) ≈ 165k+ — well over the 100,000-char ceiling — so the Claude Code
 * host REJECTS the whole response. The per-field caps bound each array in
 * isolation but never the AGGREGATE serialized state.
 *
 * THE FIX
 * -------
 * Bound at the response boundary, not by shrinking the input contracts (the
 * inputs are legitimately that large; the contracts are correct). Measure the
 * serialized payload and, if it exceeds the budget, DEGRADE GRACEFULLY in
 * priority order — shed the least caller-relevant detail first, iteratively,
 * until it fits. Every shed is OBSERVABLE in the payload (omitted/elided flags
 * with original sizes) and the full detail stays reachable via a narrower
 * format selector — dynamic loading, never silent data loss.
 *
 *   This mirrors ai-prd-builder ContextDecomposer's allocation (commit
 *   462de01): shed lowest-priority slots first until the assembled context
 *   fits its token budget.
 *
 * MEASUREMENT IS EXACT — NO SAFETY FACTOR
 * ---------------------------------------
 * The host estimates a tool result's token count as round(chars / 4), where
 * `chars` is the JavaScript string length. In JS, `String.length` IS the count
 * of UTF-16 code units — exactly the unit the host counts. So
 * `JSON.stringify(payload).length` measured here equals the host's `chars`
 * input bit-for-bit; the budget comparison is exact and needs NO safety margin.
 *
 *   This DIFFERS from the Python sibling (ai-prd-builder ContextManager.swift /
 *   the Cortex repo), where `len()` counts Unicode code POINTS, not UTF-16
 *   units — a string with astral-plane characters has fewer code points than
 *   UTF-16 units, so that side applies a 0.75 factor to guard the divergence.
 *   Here the units coincide, so guarding would only waste budget.
 *   source: ai-prd-builder ContextManager.swift commit 462de01.
 *
 * PRIORITY ORDER (least-relevant shed first)
 * ------------------------------------------
 * Derived from what callers actually need from format:"full". The documented
 * purpose (skill/commands/generate-prd.md Step 7, SKILL.md §"On failed") is
 * DIAGNOSIS: "The errors[] field ... contains the full diagnostic trail."
 * The lightweight envelope (format:"summary") already exposes section
 * statuses, clarification_rounds, and error COUNTS; format:"full" is the
 * detail-escalation path on top of that. Ranked by caller value:
 *
 *   keep   1. scalar state + flags + counts   — tiny, the diagnostic skeleton.
 *   keep   2. errors[] / error_kinds[]         — THE documented purpose; already
 *                                                FIFO-capped at 50 (~25k worst).
 *   shed-3 3. sections[] content               — work product; large only when
 *                                                many sections carry full
 *                                                markdown. Re-derivable from the
 *                                                exported PRD files.
 *   shed-2 4. clarifications[] (oldest first)  — historical Q&A; the NEWEST turn
 *                                                is the most relevant, so elide
 *                                                from the front.
 *   shed-1 5. codebase_grounding, prd_validation — opaque ai-architect-mcp-codebase
 *                                                passthrough blobs, the LARGEST
 *                                                (~90k+), LEAST needed for
 *                                                failure diagnosis, and
 *                                                independently re-fetchable from
 *                                                AP. Shed FIRST.
 *
 * The shed order is the REVERSE of caller value: grounding (5) before
 * clarifications (4) before section content (3). errors and scalars are never
 * shed — sacrificing the diagnostic trail to fit a diagnostic response would
 * defeat the tool's purpose.
 *
 * source: 100,000-char ceiling — Claude Code 2.1.170 binary, MAX_RESPONSE_CHARS
 *   in @prd-gen/orchestration (single shared constant, not re-declared here).
 * source: priority order — skill/commands/generate-prd.md Step 7 +
 *   packages/skill/SKILL.md "On failed" (errors[] is the documented payload).
 * source: iterative least-priority-first shedding — ai-prd-builder
 *   ContextDecomposer, commit 462de01.
 */
import { type PipelineState } from "@prd-gen/orchestration";
/**
 * A shed marker left in place of an omitted blob field. Observable: the caller
 * sees the field WAS present, how big it was, and how to retrieve it.
 */
export interface OmittedStub {
    readonly omitted: true;
    /** Serialized char size of the value that was removed (compact JSON). */
    readonly chars: number;
    /** How to retrieve the full value — a narrower get_pipeline_state format. */
    readonly hint: string;
}
/** A record of one degradation applied, surfaced in the payload for observability. */
export interface Degradation {
    /** Dotted path of the field that was degraded. */
    readonly field: string;
    /** "omitted" (replaced by a stub) or "elided" (array truncated). */
    readonly kind: "omitted" | "elided";
    /** Serialized chars reclaimed by this degradation. */
    readonly reclaimed_chars: number;
    /** For elision: how many array elements were dropped. */
    readonly dropped?: number;
}
/**
 * The bounded full-state payload. `__bounded` is present and `applied`
 * non-empty ONLY when degradation occurred; an under-budget state returns the
 * raw state plus an empty-degradations marker so callers can rely on the field
 * always being present.
 */
export interface BoundedFullState {
    readonly state: Record<string, unknown>;
    readonly __bounded: {
        /** Measured serialized size of the state BEFORE degradation, without `__bounded`. */
        readonly original_chars: number;
        /** Serialized size of this response, `__bounded` included (≤ MAX_RESPONSE_CHARS). */
        readonly final_chars: number;
        /** The budget the payload was fitted to. */
        readonly budget_chars: number;
        /** Ordered list of degradations applied (empty when under budget). */
        readonly applied: ReadonlyArray<Degradation>;
    };
}
/**
 * Bound a PipelineState for format:"full" so its pretty-printed serialization
 * never exceeds the Claude Code 100,000-char MCP response budget.
 *
 * Precondition: `state` is a valid PipelineState (already schema-parsed).
 * Postcondition:
 *   - wireChars(result.state + result.__bounded) <= MAX_RESPONSE_CHARS, OR the
 *     state has been shed to the irreducible floor (scalars + errors) and STILL
 *     exceeds it (impossible under Phase 1c input caps: errors ≤ ~25k, scalars
 *     ≤ a few k — the floor is < 30k); in that impossible case the floor is
 *     returned with all sheds recorded (observable), never a silent pass.
 *   - every field removed/truncated is recorded in __bounded.applied with the
 *     chars it reclaimed, and the full detail is reachable via the hint's
 *     narrower format (grounding) or the exported PRD files (section content).
 *   - the irreducible diagnostic skeleton (scalars, flags, counts, errors[],
 *     error_kinds[]) is NEVER shed.
 *
 * Degradations are applied in fixed least-relevant-first order, each only if
 * the payload is still over budget after the previous one — exactly the
 * ContextDecomposer iterative shed loop.
 */
export declare function boundFullStateResponse(state: PipelineState): BoundedFullState;
/**
 * The bounded grounding-format payload (the narrow re-fetch path for the blobs
 * format:"full" sheds first).
 */
export interface BoundedGrounding {
    readonly run_id: string;
    readonly codebase_grounding: unknown;
    readonly prd_validation: unknown;
    readonly __bounded: {
        readonly budget_chars: number;
        readonly applied: ReadonlyArray<Degradation>;
    };
}
/**
 * Bound the format:"grounding" payload.
 *
 * WHY THIS IS BOUNDED TOO
 * -----------------------
 * codebase_grounding (input-capped ≈ 90k via PrdInputBundleSchema) and
 * prd_validation (input-capped ≈ 10k) each fit the 100,000-char budget ALONE,
 * but at their caps TOGETHER they reach ~100,257 wire chars — over budget. So
 * this narrow selector cannot blindly ship both. codebase_grounding is the
 * NAMED purpose of format:"grounding", so it is kept; prd_validation is shed to
 * a stub pointing at format:"validation" only when the pair overshoots.
 *   source: measured 2026-06-10 — both blobs at input caps serialize to 100,257
 *   wire chars > MAX_RESPONSE_CHARS (100,000).
 *
 * Precondition: `state` is a valid PipelineState.
 * Postcondition: wireChars(result) <= MAX_RESPONSE_CHARS (codebase_grounding
 *   alone is ≤ ~90k, so keeping it + shedding prd_validation always fits); any
 *   shed is recorded in __bounded.applied and the shed blob is re-fetchable via
 *   the stub hint (format:"validation").
 */
export declare function boundGroundingResponse(state: PipelineState): BoundedGrounding;
//# sourceMappingURL=bound-full-state.d.ts.map