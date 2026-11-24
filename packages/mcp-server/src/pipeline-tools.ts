/**
 * Pipeline-tool registration — orchestrator + verification.
 *
 * Adds the new MCP tools that drive the full PRD workflow:
 *
 *   start_pipeline     — initialize a pipeline run, return first NextAction
 *   submit_action_result  — feed an ActionResult to the reducer, return next action
 *   get_pipeline_state — read current state by run_id
 *   plan_section_verification    — emit JudgeRequest[] for a section
 *   plan_document_verification   — emit JudgeRequest[] across all sections
 *   conclude_verification        — aggregate JudgeVerdict[] → VerificationReport
 *
 * The host (Claude Code) drives the loop: call start, execute the action,
 * call submit_action_result with the result, repeat until `done`.
 */

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  planSectionVerification,
  planDocumentVerification,
  concludeSection,
  concludeDocument,
} from "@prd-gen/verification";
import {
  SectionTypeSchema,
  JudgeVerdictSchema,
  ClaimSchema,
  ExternalGroundingTypeSchema,
  type Claim,
} from "@prd-gen/core";
import { registerStartPipeline } from "./tools/start-pipeline.js";
import { registerSubmitActionResult } from "./tools/submit-action-result.js";
import { registerGetPipelineState } from "./tools/get-pipeline-state.js";
import { buildConcludeOpts } from "./build-conclude-opts.js";
import { PLAN_PAGING_DESCRIPTION, planPageResult } from "./page-plan-response.js";

export function registerPipelineTools(server: McpServer): Record<string, RegisteredTool> {
  const startPipeline = registerStartPipeline(server);

  const submitActionResult = registerSubmitActionResult(server);

  const getPipelineState = registerGetPipelineState(server);

  // ─── plan_section_verification ─────────────────────────────────────────────

  const planSectionVerificationTool = server.tool(
    "plan_section_verification",
    "Extract claims from a PRD section and select judges. Returns JudgeRequest[] the host must execute via Agent tool in parallel. " +
    PLAN_PAGING_DESCRIPTION,
    {
      section_type: SectionTypeSchema,
      content: z.string(),
      codebase_excerpts: z.array(z.string()).default([]),
      memory_excerpts: z.array(z.string()).default([]),
      request_offset: z.number().int().min(0).default(0),
    },
    { readOnlyHint: true },
    async ({ section_type, content, codebase_excerpts, memory_excerpts, request_offset }) => {
      const plan = planSectionVerification(section_type, content, {
        codebase_excerpts,
        memory_excerpts,
        include_prd_excerpt: true,
      });
      return planPageResult(plan, request_offset);
    },
  );

  // ─── plan_document_verification ────────────────────────────────────────────

  const planDocumentVerificationTool = server.tool(
    "plan_document_verification",
    "Same as plan_section_verification but across all sections of a document. " +
    PLAN_PAGING_DESCRIPTION,
    {
      sections: z
        .array(
          z.object({
            type: SectionTypeSchema,
            content: z.string(),
          }),
        )
        .min(1),
      codebase_excerpts: z.array(z.string()).default([]),
      memory_excerpts: z.array(z.string()).default([]),
      request_offset: z.number().int().min(0).default(0),
    },
    { readOnlyHint: true },
    async ({ sections, codebase_excerpts, memory_excerpts, request_offset }) => {
      const plan = planDocumentVerification(sections, {
        codebase_excerpts,
        memory_excerpts,
        include_prd_excerpt: true,
      });
      return planPageResult(plan, request_offset);
    },
  );

  // ─── conclude_verification ─────────────────────────────────────────────────

  const concludeVerification = server.tool(
    "conclude_verification",
    "Aggregate JudgeVerdict[] from spawned subagents into a VerificationReport (consensus + dissent). " +
    "IMPORTANT: omitting claim_types when a reliability repository is open suppresses observation flushing " +
    "for this batch — the calibration data will be missing for these runs (one-sided censoring).",
    {
      scope: z.enum(["section", "document"]).default("section"),

      section_type: SectionTypeSchema.optional(),
      verdicts: z.array(JudgeVerdictSchema),
      consensus_strategy: z
        .enum(["weighted_average", "bayesian"])
        .default("weighted_average"),
      run_id: z
        .string()
        .optional()
        .describe(
          "Pipeline run_id — required for calibrated Bayesian reliability weights " +
          "(CC-3 control-arm seam uses this to partition treatment vs control runs). " +
          "When absent, falls back to Beta(7,3) prior for all judges.",
        ),
      claim_types: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Map of claim_id → claim_type. When provided, enables per-(judge × claim_type) " +
          "reliability lookup. Omit to fall back to per-agent scalar priors. " +
          "Source: derive from plan_section_verification / plan_document_verification response: " +
          "{ [req.claim.claim_id]: req.claim.claim_type } for each entry in judge_requests[]. " +
          "TODO(Wave-E): auto-populate from plan state when server-side session context is available.",
        ),
      claims: z
        .array(
          z.object({
            claim_id: z.string(),
            claim_type: ClaimSchema.shape.claim_type,
            text: z.string().optional().default(""),
            evidence: z.string().optional().default(""),
            source_section: z.string().optional(),
            external_grounding: z
              .object({
                type: ExternalGroundingTypeSchema,
                payload: z.unknown(),
              })
              .optional(),
          }),
        )
        .optional()
        .describe(
          "OPTIONAL. Pass the Claim objects from the corresponding " +
          "plan_section_verification / plan_document_verification response if you want " +
          "oracle-based ground truth (breaks Curie A2 annotator-circularity for grounded claims). " +
          "Claims that carry external_grounding will have their truth resolved by the " +
          "appropriate oracle; claims without it fall back to consensus-majority " +
          "(back-compat preserved). Shape mirrors the Claim type but only text and evidence " +
          "are required for grounding propagation — omit them to pass minimal objects. " +
          "source: Curie A2.3, PHASE_4_PLAN.md §4.1 Wave F closure.",
        ),
    },
    { destructiveHint: true },
    async ({ scope, section_type, verdicts, consensus_strategy, run_id, claim_types, claims }) => {
      // Parse incoming claims array → Map<claim_id, Claim> when provided.
      // Precondition: each element has at least claim_id, claim_type (validated by zod above).
      // Postcondition: claimsMap is undefined when claims is absent (back-compat);
      //   otherwise a Map keyed by claim_id with full Claim objects (text/evidence
      //   defaulted to empty string when omitted by the caller).
      // Invariant: parse errors never abort the pipeline — malformed claims are skipped.
      let claimsMap: ReadonlyMap<string, Claim> | undefined;
      if (claims !== undefined && claims.length > 0) {
        const map = new Map<string, Claim>();
        for (const raw of claims) {
          const parsed = ClaimSchema.safeParse({
            ...raw,
            text: raw.text ?? "",
            evidence: raw.evidence ?? "",
          });
          if (parsed.success) {
            map.set(parsed.data.claim_id, parsed.data);
          }
          // FAILS_ON: invalid claim shape — skipped; back-compat preserved.
        }
        if (map.size > 0) claimsMap = map;
      }

      // Reliability wiring + observation flusher + Curie-A3 warn live in
      // `buildConcludeOpts` to keep this handler under the §4.1 LOC cap.
      const concludeOpts = buildConcludeOpts({ consensus_strategy, run_id, claim_types, claims: claimsMap });

      const report =
        scope === "document"
          ? concludeDocument(verdicts, concludeOpts)
          : concludeSection(section_type ?? "overview", verdicts, concludeOpts);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    },
  );

  return {
    start_pipeline: startPipeline,
    submit_action_result: submitActionResult,
    get_pipeline_state: getPipelineState,
    plan_section_verification: planSectionVerificationTool,
    plan_document_verification: planDocumentVerificationTool,
    conclude_verification: concludeVerification,
  };
}
