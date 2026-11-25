import { z } from "zod";
import { SectionTypeSchema } from "@prd-gen/core";
import { planSectionVerification, planDocumentVerification } from "@prd-gen/verification";
import { PLAN_PAGING_DESCRIPTION, planPageResult } from "../page-plan-response.js";
// ─── plan_section_verification ─────────────────────────────────────────────
const planSectionInput = () => ({
    section_type: SectionTypeSchema,
    content: z.string(),
    codebase_excerpts: z.array(z.string()).default([]),
    memory_excerpts: z.array(z.string()).default([]),
    request_offset: z.number().int().min(0).default(0),
});
const handlePlanSection = async ({ section_type, content, codebase_excerpts, memory_excerpts, request_offset }) => {
    const plan = planSectionVerification(section_type, content, {
        codebase_excerpts,
        memory_excerpts,
        include_prd_excerpt: true,
    });
    return planPageResult(plan, request_offset);
};
// ─── plan_document_verification ────────────────────────────────────────────
const planDocumentInput = () => ({
    sections: z
        .array(z.object({
        type: SectionTypeSchema,
        content: z.string(),
    }))
        .min(1),
    codebase_excerpts: z.array(z.string()).default([]),
    memory_excerpts: z.array(z.string()).default([]),
    request_offset: z.number().int().min(0).default(0),
});
const handlePlanDocument = async ({ sections, codebase_excerpts, memory_excerpts, request_offset }) => {
    const plan = planDocumentVerification(sections, {
        codebase_excerpts,
        memory_excerpts,
        include_prd_excerpt: true,
    });
    return planPageResult(plan, request_offset);
};
export function registerPlanVerificationTools(server) {
    const planSectionVerificationTool = server.tool("plan_section_verification", "Extract claims from a PRD section and select judges. Returns JudgeRequest[] the host must execute via Agent tool in parallel. " +
        PLAN_PAGING_DESCRIPTION, planSectionInput(), { readOnlyHint: true }, handlePlanSection);
    const planDocumentVerificationTool = server.tool("plan_document_verification", "Same as plan_section_verification but across all sections of a document. " +
        PLAN_PAGING_DESCRIPTION, planDocumentInput(), { readOnlyHint: true }, handlePlanDocument);
    return {
        plan_section_verification: planSectionVerificationTool,
        plan_document_verification: planDocumentVerificationTool,
    };
}
//# sourceMappingURL=plan-verification.js.map