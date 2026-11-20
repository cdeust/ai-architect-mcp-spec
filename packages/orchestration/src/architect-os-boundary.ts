import { matchOfferedOption } from "./handlers/match-offered-option.js";
import {
  IMPLEMENTATION_GATE_QUESTION_ID, PR_GATE_QUESTION_ID, REVIEW_INV_PREFIX, PRE_IMPL_GROUNDING_IMPACT_PREFIX,
  POST_IMPL_INDEX_CODEBASE_CORRELATION_ID, POST_IMPL_DETECT_CHANGES_CORRELATION_ID,
  POST_IMPL_VERIFY_SEMANTIC_DIFF_CORRELATION_ID, POST_IMPL_CHECK_SECURITY_GATES_CORRELATION_ID,
} from "./handlers/protocol-ids.js";
import {
  evaluateRunPolicy,
  GATE_OPTION_IMPLEMENT,
  GATE_OPTION_IMPLEMENT_ANYWAY,
  GATE_OPTION_OVERRIDE_POLICY,
  GATE_OPTION_PRD_ONLY,
  type PolicyVerdict,
} from "./handlers/verification-policy.js";
import type { ActionResult, NextAction } from "./types/actions.js";
import { initialPostSpecs } from "./types/state/post-specs-state.js";
import type { PipelineState } from "./types/state.js";

const implementationSteps: ReadonlySet<PipelineState["current_step"]> = new Set([
  "pre_impl_grounding", "implementation", "post_impl_verification", "testing", "review", "pr_gate", "pr_creation",
]);

const implementationCalls = new Set([
  POST_IMPL_INDEX_CODEBASE_CORRELATION_ID, POST_IMPL_DETECT_CHANGES_CORRELATION_ID,
  POST_IMPL_VERIFY_SEMANTIC_DIFF_CORRELATION_ID, POST_IMPL_CHECK_SECURITY_GATES_CORRELATION_ID,
]);

export const SPEC_REVIEW_FINDINGS = "Review verification findings";
const reviewOption = { label: SPEC_REVIEW_FINDINGS, description: "Keep the specification checkpoint pending." };
const finishOption = { label: GATE_OPTION_PRD_ONLY, description: "Finish this specification run." };
const retiredOptions = [GATE_OPTION_IMPLEMENT, GATE_OPTION_IMPLEMENT_ANYWAY, GATE_OPTION_OVERRIDE_POLICY]
  .map(label => ({ label }));

export const ARCHITECT_OS_BOUNDARY = {
  code: "architect_os_required",
  message: "Implementation belongs to architect-os. Use a validated Define handoff and an independently approved execution plan.",
} as const;

/** Old checkpoints remain inspectable but cannot resume the former implementation loop. */
export function isLegacyExecutionCheckpoint(state: PipelineState, action: NextAction | null): boolean {
  return implementationSteps.has(state.current_step) ||
    (state.current_step === "implementation_gate" && state.post_specs?.decision === "implement") ||
    (action?.kind === "ask_user" && action.question_id === PR_GATE_QUESTION_ID) ||
    (action?.kind === "spawn_subagents" && (["implement", "test", "pr"].includes(action.purpose) ||
      (action.purpose === "review" && action.batch_id.startsWith(REVIEW_INV_PREFIX)))) ||
    (action?.kind === "call_pipeline_tool" && (implementationCalls.has(action.correlation_id) ||
      action.correlation_id.startsWith(PRE_IMPL_GROUNDING_IMPACT_PREFIX)));
}

export function isRetiredImplementationAnswer(state: PipelineState, result: ActionResult): boolean {
  if (state.current_step !== "implementation_gate" || result.kind !== "user_answer" ||
      result.question_id !== IMPLEMENTATION_GATE_QUESTION_ID) return false;

  return matchOfferedOption(retiredOptions, { selected: [], freeform: result.freeform }) !== undefined ||
    (Array.isArray(result.selected) &&
      result.selected.some(label => matchOfferedOption(retiredOptions, { selected: [label] }) !== undefined));
}

function isDefineQuestion(state: PipelineState, action: NextAction | null): action is Extract<NextAction, { kind: "ask_user" }> {
  return state.current_step === "implementation_gate" && action?.kind === "ask_user" &&
    action.question_id === IMPLEMENTATION_GATE_QUESTION_ID;
}

export function permitsDefineHandoff(action: Extract<NextAction, { kind: "ask_user" }>): boolean {
  const options = action.options;
  return options?.length === 2 && options.some(({ label }) => label === GATE_OPTION_PRD_ONLY) &&
    options.some(({ label }) => label === GATE_OPTION_IMPLEMENT || label === SPEC_REVIEW_FINDINGS);
}

/** Keep a legacy planning refusal even when a report write replaces the saved question. */
export function recordLegacyDefineRefusal(state: PipelineState, action: NextAction | null): PipelineState {
  if (!isDefineQuestion(state, action) || permitsDefineHandoff(action)) return state;
  return { ...state, post_specs: { ...(state.post_specs ?? initialPostSpecs()), legacy_define_refusal: true } };
}

export function specVerificationQuestion(policy: PolicyVerdict) {
  return {
    kind: "ask_user" as const,
    question_id: IMPLEMENTATION_GATE_QUESTION_ID,
    multi_select: false,
    header: "Specification verification",
    description: [
      ...policy.reasons,
      "Read a validated Define v1 handoff to continue planning. Architect-os owns implementation.",
    ].join(" "),
    options: [finishOption, reviewOption],
  };
}

/** Reproject a stored question under the current specification boundary. */
export function presentSpecAction(state: PipelineState, action: NextAction | null): NextAction | null {
  return isDefineQuestion(state, action) ? specVerificationQuestion(evaluateRunPolicy(state)) : action;
}
