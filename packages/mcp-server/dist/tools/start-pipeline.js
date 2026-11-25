import { z } from "zod";
import { newPipelineState, step } from "@prd-gen/orchestration";
import { PRDContextSchema, RequestSizeSchema, REQUEST_SIZE_CONFIGS, REQUEST_SIZE_DEFAULT } from "@prd-gen/core";
import { drainEvidenceQueues } from "../evidence-drain.js";
import { withRetryPolicy } from "../retry-policy-wiring.js";
import { boundEnvelopeResponse } from "../bound-envelope-action.js";
import { MAX_CONCURRENT_RUNS, runs, generateRunId, envelope } from "../pipeline-runs.js";
/**
 * postcondition: one sentence per size that changes a run, built from
 *                REQUEST_SIZE_CONFIGS so that the description a host reads
 *                cannot give other numbers than the ones the run uses.
 */
function describeRequestSizes() {
    const sentences = RequestSizeSchema.options.flatMap((size) => {
        const { displayName, plan } = REQUEST_SIZE_CONFIGS[size];
        if (plan === null)
            return [];
        const { sections, clarificationRange, notFor } = plan;
        // Stryker disable next-line StringLiteral: equivalent: one kind is exempt today, so the separator joins nothing
        const exempt = notFor.join(", ");
        return [
            `'${size}' (${displayName}) is the fast path for a small, self-contained change: ${sections.length} sections (${sections.join(", ")}) and ${clarificationRange[0]} to ${clarificationRange[1]} clarification rounds, in place of those of the kind. It is not for: ${exempt}, which keeps the rounds and sections of its kind.`,
        ];
    });
    // Stryker disable next-line StringLiteral: equivalent: one size has a plan today, so the separator joins nothing
    return sentences.join(" ");
}
const startPipelineInput = () => ({
    feature_description: z
        .string()
        .describe("What the PRD is about — passed to all prompts"),
    semantic_review: z.boolean().optional()
        .describe("Request one additional host judge for scope and declared edge-case coverage. Define requires a clear result for both checks."),
    codebase_path: z
        .string()
        .optional()
        .describe("Absolute path to the codebase. Triggers index_codebase via ai-architect-mcp-codebase."),
    skip_preflight: z
        .boolean()
        .optional()
        .describe("If true, skip the preflight step that probes Cortex (and ai-architect when codebase_path is set). Default false. Use only when you accept degraded section generation without persistent memory recall."),
    prd_context: PRDContextSchema
        .optional()
        .describe("The kind of PRD the request calls for, declared by the host, which has the whole conversation where the server has only feature_description. Omit it and the server reads the kind from the words of feature_description, or asks the user. get_prd_context_info gives the clarification range and the section count of a kind."),
    request_size: RequestSizeSchema
        .optional()
        .describe(`The size of the request, declared by the host: the server never reads a size from feature_description. ${describeRequestSizes()} Declare prd_context with it: the exemption holds for a kind the run knows, and a kind read from the words of feature_description can miss an incident. Omit it for a request of ordinary size.`),
});
const handleStartPipeline = async ({ feature_description, codebase_path, skip_preflight, prd_context, request_size, semantic_review }) => {
    // Global run semaphore (bounded-I/O Phase 3). Admit a new run only while
    // fewer than MAX_CONCURRENT_RUNS are in flight. At cap we REJECT with a
    // structured, retryable error rather than hang or grow unbounded — the
    // caller backs off and retries. No queue: an MCP tool call is synchronous
    // request/response, so a bounded queue would just move the wait onto a
    // held connection; an explicit retry signal is the honest contract.
    // source: MAX_CONCURRENT_RUNS in pipeline-runs.ts.
    const inFlightCount = runs.inFlightCount();
    if (inFlightCount >= MAX_CONCURRENT_RUNS) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        error: "run_capacity_exceeded",
                        message: `pipeline run capacity reached: ${inFlightCount}/${MAX_CONCURRENT_RUNS} runs in flight. ` +
                            "Retry after an in-flight run completes (current_step:'complete'), " +
                            "or raise PRD_MAX_CONCURRENT_RUNS.",
                        in_flight: inFlightCount,
                        max_concurrent_runs: MAX_CONCURRENT_RUNS,
                        retryable: true,
                    }, null, 2),
                },
            ],
            isError: true,
        };
    }
    const run_id = generateRunId();
    const reviewModel = process.env.PRD_GEN_SEMANTIC_REVIEW_MODEL?.trim() || undefined;
    const initial = newPipelineState({
        run_id,
        feature_description,
        codebase_path: codebase_path ?? null,
        skip_preflight: skip_preflight ?? false,
        prd_context: prd_context ?? null,
        request_size: request_size ?? REQUEST_SIZE_DEFAULT,
        semantic_review: semantic_review || Boolean(reviewModel),
        semantic_review_model: reviewModel,
    });
    const initialWithPolicy = withRetryPolicy(initial);
    const { state, action, messages } = step({ state: initialWithPolicy });
    // Drain BEFORE persist — same invariant as submit_action_result.
    // The first step is currently `banner` which produces no
    // strategy_executions, but the invariant "every persisted state has
    // an empty queue" must hold at every storage boundary or the queue
    // grows silently when future handlers move toward the entry point
    // (cross-audit feynman CRIT-1 + dijkstra H2, Phase 4 wiring, 2026-04).
    const drained = drainEvidenceQueues(state);
    // The state, with the UNBOUNDED action: kept before boundEnvelopeResponse
    // potentially sheds its prompts. source: bound-envelope-action.ts.
    runs.keep(drained, action);
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(boundEnvelopeResponse(envelope(drained, action, messages)), null, 2),
            },
        ],
    };
};
export function registerStartPipeline(server) {
    return server.tool("start_pipeline", "Initialize a new PRD pipeline run. Returns run_id and the first NextAction the host must execute.", startPipelineInput(), { destructiveHint: true }, handleStartPipeline);
}
//# sourceMappingURL=start-pipeline.js.map