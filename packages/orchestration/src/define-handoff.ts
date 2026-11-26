import { permitsDefineHandoff } from "./architect-os-boundary.js";
import { findDefineDecisionConflicts } from "./define-decisions.js";
import { semanticReviewFindings } from "./semantic-review.js";
import { jiraTicketsRefusal } from "./jira-refusal.js";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { DefineHandoffV1Schema, isBlockingViolation, toHandoffTickets, type DefineHandoffV1 } from "@prd-gen/core";
import { projectDefineDocument, validateDocument } from "@prd-gen/validation";
import { evaluatePolicy, resolveVerificationPolicy } from "./handlers/verification-policy.js";
import { IMPLEMENTATION_GATE_QUESTION_ID } from "./handlers/protocol-ids.js";
import { documentSections, prdSections } from "./section-plan.js";
import type { NextAction } from "./types/actions.js";
import type { PipelineState } from "./types/state.js";

type RefusalCode = "define_not_pending" | "define_not_ready" | "define_document_invalid";
type Refusal = { readonly error: { readonly code: RefusalCode; readonly message: string } };
type Projection = { readonly handoff: DefineHandoffV1 } | Refusal;
/** The handoff with the intent its verified plan is derived from. */
type Planning = { readonly handoff: DefineHandoffV1; readonly intent: string } | Refusal;

function refusal(code: RefusalCode, message: string): Refusal {
  return { error: { code, message } };
}

/**
 * The one serializer of the Define envelope: the MCP reply text and the
 * bytes the Plan binding hashes (architect-os writes this text plus LF).
 */
export function defineEnvelopeText(handoff: DefineHandoffV1): string {
  return JSON.stringify({ handoff });
}

/**
 * Keep the passed projection on the state that leaves the gate, so a read
 * after "PRD only" or the automatic completion serves exactly what passed.
 * A refused specification leaves no snapshot.
 */
export function withPassedDefine(state: PipelineState): PipelineState {
  const projection = projectVerifiedDefine(state);
  if ("error" in projection) {
    const { passed_define: _refused, ...rest } = state;
    return rest;
  }
  return { ...state, passed_define: { handoff: projection.handoff, intent: state.feature_description } };
}

/**
 * The terminal action must report a passed outcome and the verification the
 * checkpoint retains. A legacy run clears that evidence when it finishes.
 */
function completionAgrees(state: PipelineState, action: Extract<NextAction, { kind: "done" }>): boolean {
  const retained = state.pending_completion;
  return action.outcome?.status === "passed" &&
    (!retained || isDeepStrictEqual(action.verification, retained.verification));
}

function disagreement(): Refusal {
  return refusal("define_not_ready", "The completed verification action and retained evidence disagree.");
}

/**
 * Serve the snapshot the gate kept, after it advanced, only while the
 * checkpoint still projects exactly that Define for the same intent: a
 * checkpoint changed after the run finished is refused, not re-published.
 * Readiness (completion evidence, verification policy) is judged once, at
 * the gate, under the policy then in force: a legacy run clears that
 * evidence when it finishes, and a policy injected later does not withdraw
 * a Define the gate already let through.
 */
function readPassedDefine(
  state: PipelineState, passed: NonNullable<PipelineState["passed_define"]>, action: NextAction | null,
): Planning {
  // Readiness was proven when the snapshot was taken; the document is proven again here.
  if (action?.kind === "done" && !completionAgrees(state, action)) return disagreement();
  const current = projectDefineState(state);
  if ("error" in current) return current;
  if (!isDeepStrictEqual({ handoff: current.handoff, intent: state.feature_description }, passed)) {
    return refusal("define_not_ready", "The checkpoint no longer projects the Define kept when the run finished.");
  }
  return passed;
}

/** Read a validated Define checkpoint without granting implementation authority. */
export function readDefineHandoff(state: PipelineState, action: NextAction | null): Planning {
  if (state.passed_define) return readPassedDefine(state, state.passed_define, action);
  // Without a snapshot: the pending question, or an automatic completion saved
  // before the gate kept snapshots.
  const automatic = state.semantic_review_requested && state.post_specs?.automatic_define === 1 &&
    state.current_step === "complete" && state.post_specs.decision === "prd_only" && action?.kind === "done";
  const legacy = state.current_step === "implementation_gate" && action?.kind === "ask_user" &&
    action.question_id === IMPLEMENTATION_GATE_QUESTION_ID &&
    (!state.post_specs || state.post_specs.decision === "pending");
  if (!automatic && !legacy) {
    // A run that finished without keeping a Define says why when its document does.
    const reason = state.current_step === "complete" ? projectDefineState(state) : undefined;
    if (reason && "error" in reason) return reason;
    return refusal("define_not_pending", "Define requires a pending implementation decision or a Define kept when the run finished.");
  }

  const projection = projectVerifiedDefine(state);
  if ("error" in projection) return projection;
  if (automatic && !completionAgrees(state, action)) return disagreement();
  if (legacy && !permitsDefineHandoff(action)) {
    return refusal("define_not_ready", "The pending question does not permit a verified planning handoff.");
  }
  return { handoff: projection.handoff, intent: state.feature_description };
}

/** Shared by the automatic completion gate and the read-only projection. */
export function projectVerifiedDefine(state: PipelineState): Projection {
  const document = projectDefineState(state);
  if ("error" in document) return document;
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
  return document;
}

/** What the saved document, its tickets and its scope review project, apart from the run's evidence. */
function projectDefineState(state: PipelineState): Projection {
  const jira = state.jira_result;
  const sections = documentSections(state.sections);
  const parsed = DefineHandoffV1Schema.safeParse({
    version: 1,
    run_id: state.run_id,
    ...projectDefineDocument(sections),
    ...(jira?.status === "passed" && { tickets: toHandoffTickets(jira.tickets) }),
  });
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
  // A run that attempted tickets publishes them or nothing; only a checkpoint
  // of the Markdown-only generator reads without them.
  const ticketRefusal = jiraTicketsRefusal(state);
  if (ticketRefusal) return refusal("define_not_ready", ticketRefusal);
  const semanticFinding = semanticReviewFindings(state)[0];
  if (semanticFinding) return refusal("define_not_ready", semanticFinding.message);
  return { handoff: parsed.data };
}
