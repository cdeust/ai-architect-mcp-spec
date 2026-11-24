import { type PipelineState } from "@prd-gen/orchestration";
import { KeptRuns, type FoundRun } from "./kept-runs.js";
/**
 * Global run semaphore cap — max pipeline runs in flight at once.
 *
 * A "run in flight" is a run whose current_step !== "complete": the host is
 * still driving its loop (start_pipeline → submit_action_result*). Each in-flight
 * run pins one PipelineState (≤ MAX_RESPONSE_CHARS) plus any subagent work the
 * host spawns for it. Without a cap, a host that fires start_pipeline in a loop
 * grows unbounded concurrent work.
 *
 * source: engineering default pending measurement; calibrate by the observed
 * peak concurrent in-flight run count on a real interactive host (instrument
 * runs.inFlightCount() at each start_pipeline and set MAX_CONCURRENT_RUNS to
 * p99 + headroom). 8 is chosen conservatively: an interactive Claude Code host
 * drives one pipeline at a time in the common case, so 8 leaves generous room
 * for overlap while bounding fan-out. It is well under the RunStore max-runs cap
 * (64) so the semaphore — not eviction — is the first limit a runaway caller
 * hits, yielding a clear structured rejection instead of silent eviction.
 */
export declare const MAX_CONCURRENT_RUNS: number;
/**
 * The runs of this server: in memory, and each in its file under
 * `~/.prd-gen/runs/` so that a restart does not lose them (#121,
 * kept-runs.ts). Beside the state, a run keeps the last UNBOUNDED action
 * `step()` emitted, before `boundEnvelopeResponse` sheds the `spawn_subagents`
 * prompts that do not fit: it serves `get_pipeline_state(run_id,
 * format:"action")`, the path a host follows when it sees a `__bounded` marker
 * on an envelope, or when it comes back to a run after a restart (source:
 * e2e run_mrlqa0aj_u2rh15, 2026-07-15, bound-envelope-action.ts).
 *
 * When a finished run is dropped (TTL or max-runs), its persisted
 * strategy-execution evidence is released so disk growth tracks live runs.
 * Best-effort: a missing repo is a no-op. source: evidence-repository.ts
 * pruneRunEvidence.
 */
export declare const runs: KeptRuns;
/**
 * postcondition: the tool error for a run id that names no run the server
 *                can go on with: `unknown run_id`, or, when the run has a
 *                file that cannot be read as a run, that fact and the reason.
 */
export declare function runNotFound(runId: string, found: Exclude<FoundRun, {
    kind: "found";
}>): {
    content: {
        type: "text";
        text: string;
    }[];
    isError: boolean;
};
/**
 * Per-run_id in-flight guard for submit_action_result. The reducer pattern
 * (read state → step → write state) is atomic only under Node.js cooperative
 * scheduling because step() is synchronous and there is no await between get
 * and set. This Set explicitly rejects concurrent submissions for the same
 * run_id, providing defense-in-depth if the runtime ever changes.
 */
export declare const inFlight: Set<string>;
export declare function generateRunId(): string;
export declare function envelope(state: PipelineState, action: unknown, messages?: ReadonlyArray<{
    text: string;
    level: "info" | "warn" | "error";
}>): {
    run_id: string;
    current_step: "banner" | "budget" | "clarification" | "complete" | "context_detection" | "feasibility_gate" | "file_export" | "finalize" | "implementation" | "implementation_gate" | "input_analysis" | "jira_generation" | "post_impl_verification" | "pr_creation" | "pr_gate" | "pre_impl_grounding" | "preflight" | "review" | "section_generation" | "self_check" | "testing";
    /** Banners/status lines emitted while advancing to `action`. Display before acting. */
    messages: readonly {
        text: string;
        level: "info" | "warn" | "error";
    }[];
    action: unknown;
    state_summary: {
        sections: {
            section_type: "acceptance_criteria" | "api_specification" | "data_model" | "deployment" | "goals" | "jira_tickets" | "overview" | "performance_requirements" | "requirements" | "risks" | "security_considerations" | "source_code" | "technical_specification" | "test_code" | "testing" | "timeline" | "user_stories";
            status: "failed" | "generating" | "passed" | "pending" | "retrieving";
            attempt: number;
            violation_count: number;
        }[];
        clarification_rounds: number;
        errors: number;
        prd_context: "bug" | "cicd" | "feature" | "incident" | "mvp" | "poc" | "proposal" | "release" | null;
        request_size: "standard" | "tiny";
    };
};
export declare function architectOsRequired(): {
    content: {
        type: "text";
        text: string;
    }[];
    isError: boolean;
};
declare const planningSizeErrors: {
    define: {
        code: string;
        message: string;
    };
    plan: {
        code: string;
        message: string;
    };
    review: {
        code: string;
        message: string;
    };
};
export declare function planningSizeError(kind: keyof typeof planningSizeErrors): {
    content: {
        type: "text";
        text: string;
    }[];
    isError: boolean;
};
export {};
//# sourceMappingURL=pipeline-runs.d.ts.map