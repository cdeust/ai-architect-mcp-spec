import { permitsDefineHandoff } from "./architect-os-boundary.js";
import { findDefineDecisionConflicts } from "./define-decisions.js";
import { semanticReviewFindings } from "./semantic-review.js";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { DefineHandoffV1Schema, isBlockingViolation, type DefineHandoffV1 } from "@prd-gen/core";
import { projectDefineDocument, validateDocument } from "@prd-gen/validation";
import { evaluatePolicy, resolveVerificationPolicy } from "./handlers/verification-policy.js";
import { IMPLEMENTATION_GATE_QUESTION_ID } from "./handlers/protocol-ids.js";
import { documentSections, prdSections } from "./section-plan.js";
import type { NextAction } from "./types/actions.js";
import type { PipelineState } from "./types/state.js";

type RefusalCode = "define_not_pending" | "define_not_ready" | "define_document_invalid";
type Projection = { readonly handoff: DefineHandoffV1 } |
  { readonly error: { readonly code: RefusalCode; readonly message: string } };

function refusal(code: RefusalCode, message: string): Projection {
  return { error: { code, message } };
}

/** Read a validated Define checkpoint without granting implementation authority. */
export function readDefineHandoff(state: PipelineState, action: NextAction | null): Projection {
  const automatic = state.semantic_review_requested && state.post_specs?.automatic_define === 1 &&
    state.current_step === "complete" && state.post_specs.decision === "prd_only" && action?.kind === "done";
  const legacy = state.current_step === "implementation_gate" && action?.kind === "ask_user" &&
    action.question_id === IMPLEMENTATION_GATE_QUESTION_ID &&
    (!state.post_specs || state.post_specs.decision === "pending");
  if (!automatic && !legacy) {
    return refusal("define_not_pending", "Define requires a pending implementation decision.");
  }

  const projection = projectVerifiedDefine(state);
  if ("error" in projection) return projection;
  if (automatic && (action.outcome?.status !== "passed" ||
      !isDeepStrictEqual(action.verification, state.pending_completion!.verification))) {
    return refusal("define_not_ready", "The completed verification action and retained evidence disagree.");
  }
  if (legacy && !permitsDefineHandoff(action)) {
    return refusal("define_not_ready", "The pending question does not permit a verified planning handoff.");
  }
  return projection;
}

/** Shared by the automatic completion gate and the read-only projection. */
export function projectVerifiedDefine(state: PipelineState): Projection {
  const sections = documentSections(state.sections);
  const parsed = DefineHandoffV1Schema.safeParse({ version: 1, run_id: state.run_id, ...projectDefineDocument(sections) });
  if (!parsed.success) {
    return refusal("define_document_invalid", z.prettifyError(parsed.error));
  }

  const failure = validateDocument(sections).violations.find(isBlockingViolation);
  if (failure) {
    return refusal("define_document_invalid", `${failure.rule}: ${failure.message}`);
  }
  const dispute = findDefineDecisionConflicts(state, sections)[0];
  if (dispute) {
    return refusal("define_document_invalid", `sourced_publication_policy: ${dispute}`);
  }
  const semanticFinding = semanticReviewFindings(state)[0];
  if (semanticFinding) return refusal("define_not_ready", semanticFinding.message);
  const completion = state.pending_completion;
  const verification = completion?.verification;
  const judged = new Set(verification?.judge_verdicts?.map(({ claim_id }) => claim_id));
  if (completion?.outcome?.status !== "passed" || !verification ||
      judged.size === 0 || judged.size !== verification.claims_evaluated ||
      prdSections(state.sections).some(section => section.status !== "passed")) {
    return refusal("define_not_ready", "Define requires passed PRD sections, a passed self-check and detailed verification evidence.");
  }

  const policy = evaluatePolicy(verification, resolveVerificationPolicy(state.verification_policy));
  if (policy.status !== "pass") {
    return refusal("define_not_ready", "The current verification policy requires attention.");
  }
  if (state.post_specs?.legacy_define_refusal) {
    return refusal("define_not_ready", "The pending question does not permit a verified planning handoff.");
  }
  return { handoff: parsed.data };
}
