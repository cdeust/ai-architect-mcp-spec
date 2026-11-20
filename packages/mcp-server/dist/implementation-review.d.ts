import type { DefineHandoffV1 } from "@prd-gen/core";
import { type VerifiedPlan } from "@prd-gen/orchestration";
export declare function prepareImplementationReview(paths: {
    authority?: string;
    repository?: string;
    repositoryId?: string;
    git?: string;
}, reviewId: string | undefined, plan: VerifiedPlan, define: DefineHandoffV1): Promise<{
    error: {
        code: string;
        message: string;
    };
} | {
    implementation_review: {
        version: number;
        status: string;
        review_id: string;
        run_id: string;
        step: string;
        repository_id: string;
        base_revision: string;
        reviewed_revision: string;
        plan_sha256: string;
        approval_sha256: string;
        diff_sha256: string;
        diff: string;
        acceptance: {
            id: string;
            text: string;
            requirement_ids: string[];
            status: string;
        }[];
    };
}>;
//# sourceMappingURL=implementation-review.d.ts.map