import { z } from "zod";
import { MAX_RESPONSE_CHARS, defineEnvelopeText, readDefineHandoff, buildVerifiedPlan, ReviewIdSchema, isLegacyExecutionCheckpoint, refreshImplementationGateQuestion, } from "@prd-gen/orchestration";
import { prepareImplementationReview } from "../implementation-review.js";
import { boundFullStateResponse, boundGroundingResponse } from "../bound-full-state.js";
import { pageActionResponse } from "../page-action-response.js";
import { runs, runNotFound, planningSizeError, architectOsRequired, envelope } from "../pipeline-runs.js";
const getPipelineStateInput = () => ({
    run_id: z.string(),
    format: z
        .enum(["full", "summary", "grounding", "validation", "action", "define_handoff_v1", "verified_plan_v1", "implementation_review_v1"])
        .default("summary"),
    invocation_offset: z.number().int().min(0).default(0),
    plan_step: z.string().optional().describe("Operator-selected architect-os Step name for plan and review formats."),
    review_id: ReviewIdSchema.optional().describe("Operator-assigned review dossier identifier."),
});
const handleGetPipelineState = async ({ run_id, format, invocation_offset, plan_step, review_id }) => {
    const found = runs.find(run_id);
    if (found.kind !== "found")
        return runNotFound(run_id, found);
    const state = found.run.state;
    if (format === "define_handoff_v1" || format === "verified_plan_v1" || format === "implementation_review_v1") {
        const define = readDefineHandoff(state, found.run.action);
        const sourceText = "error" in define ? JSON.stringify(define) : defineEnvelopeText(define.handoff);
        if (sourceText.length > MAX_RESPONSE_CHARS)
            return planningSizeError("define");
        if (format === "define_handoff_v1" || "error" in define) {
            return { content: [{ type: "text", text: sourceText }], isError: "error" in define };
        }
        const plan = buildVerifiedPlan(define.handoff, define.intent, plan_step);
        const text = JSON.stringify(plan);
        if (text.length > MAX_RESPONSE_CHARS)
            return planningSizeError("plan");
        if (format === "verified_plan_v1" || "error" in plan) {
            return { content: [{ type: "text", text }], isError: "error" in plan };
        }
        const review = await prepareImplementationReview({
            authority: process.env.PRD_GEN_REVIEW_AUTHORITY,
            repository: process.env.PRD_GEN_REVIEW_REPOSITORY,
            repositoryId: process.env.PRD_GEN_REVIEW_REPOSITORY_ID,
            git: process.env.PRD_GEN_REVIEW_GIT,
        }, review_id, plan.verified_plan, define.handoff);
        const reviewText = JSON.stringify(review);
        if (reviewText.length > MAX_RESPONSE_CHARS)
            return planningSizeError("review");
        return { content: [{ type: "text", text: reviewText }], isError: "error" in review };
    }
    let payload;
    if (format === "full") {
        // Bound the full-state serialization to the 100,000-char MCP budget.
        // The per-field input caps (Phase 1c) overlap, so a worst-case state
        // overshoots the AGGREGATE budget; boundFullStateResponse degrades by
        // priority (grounding → clarifications → section content → tickets and
        // the kept Define), recording
        // every shed in __bounded. source: bound-full-state.ts.
        payload = boundFullStateResponse(state);
    }
    else if (format === "grounding") {
        // The narrow re-fetch path for the blobs format:"full" sheds first.
        // Each blob is bounded at the input contract (codebase_grounding ≈ 90k
        // via PrdInputBundleSchema; prd_validation ≈ 10k). Each fits ALONE, but
        // the two together at their caps reach ~100,257 wire chars — over budget.
        // So this selector is itself bounded: codebase_grounding (the named
        // purpose of this format) is kept; prd_validation rides only if it fits,
        // else it is shed to a stub pointing at format:"validation". source:
        // measured 2026-06-10 — grounding+validation at input caps = 100,257 >
        // 100,000; boundGroundingResponse in bound-full-state.ts.
        payload = boundGroundingResponse(state);
    }
    else if (format === "validation") {
        // Narrow re-fetch for prd_validation alone (the blob format:"grounding"
        // sheds when grounding+validation together overshoot). Fits standalone:
        // prd_validation is input-capped ≈ 10k. source: bound-full-state.ts.
        payload = {
            run_id: state.run_id,
            prd_validation: state.prd_validation,
        };
    }
    else if (format === "action") {
        // Narrow re-fetch for the last action with its prompts — the
        // recovery path a host follows when a start_pipeline/
        // submit_action_result envelope's __bounded.applied records
        // action.invocations[].prompt. Paged by whole invocations under
        // MAX_RESPONSE_CHARS: the unpaged refetch measured ~112k chars in the
        // 2026-10-10 audit (#125). The action is the one kept with the state,
        // in memory or in the run's file. A pending implementation question
        // can be upgraded to match the current gate policy. source: page-action-response.ts.
        if (isLegacyExecutionCheckpoint(state, found.run.action))
            return architectOsRequired();
        // zod applies the default over MCP; a direct handler call (tests,
        // in-process hosts) may omit the field.
        const page = pageActionResponse(state.run_id, refreshImplementationGateQuestion(state, found.run.action), invocation_offset ?? 0);
        if ("error" in page) {
            return {
                content: [{ type: "text", text: JSON.stringify(page) }],
                isError: true,
            };
        }
        payload = page;
    }
    else {
        payload = envelope(state, null);
    }
    return {
        content: [
            { type: "text", text: JSON.stringify(payload, null, 2) },
        ],
    };
};
export function registerGetPipelineState(server) {
    return server.tool("get_pipeline_state", "Read the current pipeline state by run_id. format:'summary' (default) returns " +
        "the lightweight envelope; format:'full' returns the whole state, bounded to the " +
        "Claude Code 100,000-char MCP response budget by shedding least-relevant detail " +
        "first (observable __bounded markers; full grounding re-fetchable via " +
        "format:'grounding'); format:'grounding' returns the codebase_grounding (+ " +
        "prd_validation when it fits) blobs format:'full' sheds first; format:'validation' " +
        "returns prd_validation alone (the blob format:'grounding' sheds when the pair " +
        "overshoots); format:'action' returns the last action (refreshing a pending verification question) with " +
        "full spawn_subagents prompts — the recovery path when a start_pipeline/" +
        "submit_action_result response's __bounded.applied records action.invocations[]." +
        "prompt: the prompts from that record's next_offset on are omitted stubs, and " +
        "next_offset is the invocation_offset to read them from. It is " +
        "paged under the same budget: each page holds whole invocations from " +
        "invocation_offset (default 0), and __page.next_offset is the offset of the next " +
        "page, null on the last one. format:'define_handoff_v1' returns validated planning data, with the generated tickets' estimates, prerequisites and criteria " +
        "(structurally checked, not judged) when the run generated them, from the pending specification question or, once the gate advanced, " +
        "from the Define it kept while the checkpoint still projects it (until the finished run is dropped). " +
        "format:'verified_plan_v1' derives and verifies a one-Step plan from that checkpoint. " +
        "format:'implementation_review_v1' reads the operator-approved plan and its pinned Git comparison for review.", getPipelineStateInput(), { readOnlyHint: true }, handleGetPipelineState);
}
//# sourceMappingURL=get-pipeline-state.js.map