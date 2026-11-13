/**
 * Response bounding for `submit_action_result` / `start_pipeline` envelopes
 * that carry a `spawn_subagents` action (Phase 1e).
 *
 * THE BUG THIS FIXES
 * -------------------
 * self_check's judge-verification batch can spawn dozens of judge subagents
 * in one `spawn_subagents` action, each carrying a multi-KB prompt (built by
 * `buildJudgePrompt` — full section content + claim + judge instructions). A
 * batch of 89 invocations at ~37K chars each measured a 3.5MB serialized
 * envelope — 35x the Claude Code 100,000-char MCP response budget
 * (MAX_RESPONSE_CHARS, `@prd-gen/orchestration` bounded-io.ts) that
 * `get_pipeline_state format:"full"` already respects via
 * `boundFullStateResponse`. `envelope()` in pipeline-tools.ts (the shared
 * response builder for `start_pipeline` and `submit_action_result`) had NO
 * equivalent bound — the host had to grep a spilled file to recover the
 * batch.
 * source: e2e run_mrlqa0aj_u2rh15 (2026-07-15) — measured 3.5MB response.
 *
 * THE FIX
 * -------
 * Mirror `bound-full-state.ts`'s degrade-observably pattern at the ENVELOPE
 * boundary. When the response would exceed MAX_RESPONSE_CHARS and the action
 * is `spawn_subagents`, the envelope keeps every invocation (with its
 * `invocation_id`, `subagent_type`, `description` and `isolation`) and the
 * whole prompts of the longest prefix of invocations that fits the budget.
 * The prompt of every later invocation is replaced by an `OmittedStub`, and
 * the shed is recorded in the top-level `__bounded` marker (present on EVERY
 * envelope, empty `applied` when no degradation occurred — same invariant
 * `boundFullStateResponse` establishes). The record's `next_offset` is the
 * index of the first stub: the host reads the missing prompts with
 * `get_pipeline_state(run_id, format:"action", invocation_offset: next_offset)`,
 * served from an in-memory per-run cache that pipeline-tools.ts updates on
 * every start_pipeline/submit_action_result call BEFORE bounding is applied —
 * no silent truncation, no filesystem spooling required. That refetch is
 * itself paged under MAX_RESPONSE_CHARS by whole invocations
 * (page-action-response.ts, #125).
 *
 * Until #125 the prompts were shed all together, and the host read every one
 * of them back: three calls to hold the prompts of 3 invocations of 37,000
 * chars (the ~112k batch of the 2026-10-10 audit), where the first two fit in
 * the envelope (measured 2026-11-13 on main @ efd9e2e).
 *
 * What is kept is always a prefix, never an arbitrary subset, and a prompt is
 * never cut: a prompt in the envelope is either the string the pipeline
 * built or a stub that says, in place, where to read it. A host that reads
 * the whole batch back from offset 0 gets it, as before.
 *
 * THE SIZES ARE THOSE OF THE SHIPPED RESPONSE
 * -------------------------------------------
 * `final_chars` is the serialized size of the response as shipped,
 * `__bounded` included, and that size is what is compared with the budget.
 * The comparison used to be made on the payload without its marker, which
 * was added afterwards: a 99,904-char payload shipped as 100,027 chars with
 * an empty `applied` (measured 2026-11-13 on main @ efd9e2e).
 */
import type { Degradation } from "./bound-full-state.js";
export interface EnvelopePayload {
    readonly run_id: string;
    readonly current_step: string;
    readonly messages: unknown;
    /**
     * `unknown` — mirrors envelope()'s own `action: unknown` parameter
     * (pipeline-tools.ts). Callers pass either a NextAction or a raw
     * HandlerAction (get_pipeline_state's format:"summary" path passes
     * `null`); narrowed internally via a runtime shape check, never trusted
     * by static type alone.
     */
    readonly action: unknown;
    readonly state_summary: unknown;
}
/** The record of the prompts shed from a `spawn_subagents` envelope. */
export interface PromptOmission extends Degradation {
    /**
     * Index of the first invocation whose prompt is a stub: the
     * `invocation_offset` at which the format:"action" refetch resumes. 0 when
     * no prompt could be kept.
     */
    readonly next_offset: number;
}
export interface BoundedEnvelope extends EnvelopePayload {
    readonly __bounded: {
        /** Serialized size of the payload before bounding, without `__bounded`. */
        readonly original_chars: number;
        /** Serialized size of this response, `__bounded` included. */
        readonly final_chars: number;
        readonly budget_chars: number;
        readonly applied: ReadonlyArray<Degradation | PromptOmission>;
    };
}
/**
 * precondition:  `payload` is the envelope object about to be returned to
 *                the host over MCP — NOT YET serialized; `budgetChars` is the
 *                response budget, the server's declared MAX_RESPONSE_CHARS
 *                unless a caller states another (the tests sweep prefixes at
 *                a smaller one: the search compares sizes with the budget
 *                and nothing else).
 * postcondition: `__bounded.final_chars` is the serialized size of the
 *                result. It is `<= budgetChars` whenever the payload fits
 *                with its marker (returned unchanged, `applied` empty), or
 *                the action is `spawn_subagents` and the envelope fits once
 *                every non-empty prompt is a stub. In that second case the
 *                prompts of the invocations [0, next_offset) are the
 *                payload's own and every later non-empty prompt is a stub;
 *                `next_offset` is the largest such prefix the page search
 *                finds, which is the largest that fits when no shed prompt
 *                is shorter than its stub (a stub is under 300 chars, a
 *                judge prompt is multi-KB). The full action stays
 *                recoverable via
 *                `get_pipeline_state(run_id, format:"action")`, paged by
 *                `invocation_offset`.
 *                Otherwise the overshoot is NOT hidden: `final_chars >
 *                budget_chars`. That is an envelope over budget with every
 *                prompt shed (returned so, `next_offset` 0), or one for
 *                which no strategy applies — another action kind, or no
 *                prompt to shed — returned unchanged with `applied` empty.
 */
export declare function boundEnvelopeResponse(payload: EnvelopePayload, budgetChars?: number): BoundedEnvelope;
//# sourceMappingURL=bound-envelope-action.d.ts.map