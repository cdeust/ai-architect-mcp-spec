import { type HardOutputRule, type HardOutputRuleViolation } from "@prd-gen/core";
/**
 * Validation failure → corrective retrieval mapper.
 * Meadows leverage point #2: closes the validation→retrieval feedback loop.
 *
 * When a section fails validation, this maps the failure type to a
 * corrective Cortex recall query. Without this, retries use the same
 * context and produce the same failures.
 */
export interface CorrectiveRetrieval {
    /** The Cortex recall query to issue */
    query: string;
    /** Max results for this corrective retrieval */
    maxResults: number;
    /** Why this retrieval is needed */
    reason: string;
    /** Which rule failure triggered this */
    triggeringRule: HardOutputRule;
}
export interface FailureMappingResult {
    /** Corrective retrievals to issue before retry */
    correctiveRetrievals: CorrectiveRetrieval[];
    /** Whether retry is likely to succeed with new context */
    retryLikely: boolean;
    /** Summary of what went wrong */
    failureSummary: string;
}
export declare function mapFailuresToRetrievals(allViolations: readonly HardOutputRuleViolation[]): FailureMappingResult;
//# sourceMappingURL=failure-mapper.d.ts.map