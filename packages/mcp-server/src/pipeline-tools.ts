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
  MAX_RESPONSE_CHARS,
  readDefineHandoff,
  buildVerifiedPlan,
  ReviewIdSchema,
  isLegacyExecutionCheckpoint,
  refreshImplementationGateQuestion,
} from "@prd-gen/orchestration";
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
import { prepareImplementationReview } from "./implementation-review.js";
import { buildConcludeOpts } from "./build-conclude-opts.js";
import {
  boundFullStateResponse,
  boundGroundingResponse,
} from "./bound-full-state.js";
import { pageActionResponse } from "./page-action-response.js";
import { PLAN_PAGING_DESCRIPTION, planPageResult } from "./page-plan-response.js";
import {
  runs,
  runNotFound,
  envelope,
  architectOsRequired,
  planningSizeError,
} from "./pipeline-runs.js";

export function registerPipelineTools(server: McpServer): Record<string, RegisteredTool> {
  const startPipeline = registerStartPipeline(server);

  const submitActionResult = registerSubmitActionResult(server);

  // ─── get_pipeline_state ─────────────────────────────────────────────────

  const getPipelineState = server.tool(
    "get_pipeline_state",
    "Read the current pipeline state by run_id. format:'summary' (default) returns " +
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
    "page, null on the last one. format:'define_handoff_v1' returns validated planning data from completed automatic review or a pending legacy checkpoint. " +
    "format:'verified_plan_v1' derives and verifies a one-Step plan from that checkpoint. " +
    "format:'implementation_review_v1' reads the operator-approved plan and its pinned Git comparison for review.",
    {
      run_id: z.string(),
      format: z
        .enum(["full", "summary", "grounding", "validation", "action", "define_handoff_v1", "verified_plan_v1", "implementation_review_v1"])
        .default("summary"),
      invocation_offset: z.number().int().min(0).default(0),
      plan_step: z.string().optional().describe("Operator-selected architect-os Step name for plan and review formats."),
      review_id: ReviewIdSchema.optional().describe("Operator-assigned review dossier identifier."),
    },
    { readOnlyHint: true },
    async ({ run_id, format, invocation_offset, plan_step, review_id }) => {
      const found = runs.find(run_id);
      if (found.kind !== "found") return runNotFound(run_id, found);
      const state = found.run.state;
      if (format === "define_handoff_v1" || format === "verified_plan_v1" || format === "implementation_review_v1") {
        const define = readDefineHandoff(state, found.run.action);
        const sourceText = JSON.stringify(define);
        if (sourceText.length > MAX_RESPONSE_CHARS) return planningSizeError("define");
        if (format === "define_handoff_v1" || "error" in define) {
          return { content: [{ type: "text" as const, text: sourceText }], isError: "error" in define };
        }

        const plan = buildVerifiedPlan(define.handoff, state.feature_description, plan_step);
        const text = JSON.stringify(plan);
        if (text.length > MAX_RESPONSE_CHARS) return planningSizeError("plan");
        if (format === "verified_plan_v1" || "error" in plan) {
          return { content: [{ type: "text" as const, text }], isError: "error" in plan };
        }
        const review = await prepareImplementationReview(
          {
            authority: process.env.PRD_GEN_REVIEW_AUTHORITY,
            repository: process.env.PRD_GEN_REVIEW_REPOSITORY,
            repositoryId: process.env.PRD_GEN_REVIEW_REPOSITORY_ID,
            git: process.env.PRD_GEN_REVIEW_GIT,
          },
          review_id, plan.verified_plan, define.handoff,
        );
        const reviewText = JSON.stringify(review);
        if (reviewText.length > MAX_RESPONSE_CHARS) return planningSizeError("review");
        return { content: [{ type: "text" as const, text: reviewText }], isError: "error" in review };
      }
      let payload: unknown;
      if (format === "full") {
        // Bound the full-state serialization to the 100,000-char MCP budget.
        // The per-field input caps (Phase 1c) overlap, so a worst-case state
        // overshoots the AGGREGATE budget; boundFullStateResponse degrades by
        // priority (grounding → clarifications → section content), recording
        // every shed in __bounded. source: bound-full-state.ts.
        payload = boundFullStateResponse(state);
      } else if (format === "grounding") {
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
      } else if (format === "validation") {
        // Narrow re-fetch for prd_validation alone (the blob format:"grounding"
        // sheds when grounding+validation together overshoot). Fits standalone:
        // prd_validation is input-capped ≈ 10k. source: bound-full-state.ts.
        payload = {
          run_id: state.run_id,
          prd_validation: state.prd_validation,
        };
      } else if (format === "action") {
        // Narrow re-fetch for the last action with its prompts — the
        // recovery path a host follows when a start_pipeline/
        // submit_action_result envelope's __bounded.applied records
        // action.invocations[].prompt. Paged by whole invocations under
        // MAX_RESPONSE_CHARS: the unpaged refetch measured ~112k chars in the
        // 2026-10-10 audit (#125). The action is the one kept with the state,
        // in memory or in the run's file. A pending implementation question
        // can be upgraded to match the current gate policy. source: page-action-response.ts.
        if (isLegacyExecutionCheckpoint(state, found.run.action)) return architectOsRequired();
        const page = pageActionResponse(
          state.run_id,
          refreshImplementationGateQuestion(state, found.run.action),
          // zod applies the default over MCP; a direct handler call (tests,
          // in-process hosts) may omit the field.
          invocation_offset ?? 0,
        );
        if ("error" in page) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(page) }],
            isError: true,
          };
        }
        payload = page;
      } else {
        payload = envelope(state, null);
      }
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(payload, null, 2) },
        ],
      };
    },
  );

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
