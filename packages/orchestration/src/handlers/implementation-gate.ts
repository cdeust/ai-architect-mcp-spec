/**
 * Persist specification verification and offer a PRD-only completion.
 * Define is readable while the verification question is pending; every exit
 * of the gate keeps the passed Define (withPassedDefine) for reads after it.
 * Any implementation decision is made in architect-os after plan approval.
 */
import { projectVerifiedDefine, withPassedDefine } from "../define-handoff.js";
import { specVerificationQuestion, presentSpecAction } from "../architect-os-boundary.js";
import { answerOptionQuestion } from "./match-offered-option.js";
import type { StepHandler } from "../runner.js";
import type { NextAction } from "../types/actions.js";
import { type PipelineState } from "../types/state.js";
import { initialPostSpecs, type PostSpecsState } from "../types/state/post-specs-state.js";
import { IMPLEMENTATION_GATE_QUESTION_ID } from "./protocol-ids.js";
import { buildVerificationReportFile, VERIFICATION_REPORT_FILENAME } from "./verification-report.js";
import {
  GATE_OPTION_PRD_ONLY,
  defineFindings,
  evaluateRunPolicy,
  refreshDefineOutcome,
  type PolicyVerdict,
} from "./verification-policy.js";

function ensurePostSpecs(state: PipelineState): PostSpecsState {
  return state.post_specs ?? initialPostSpecs();
}

function hasVerificationReport(state: PipelineState): boolean {
  return state.written_files.some((p) => p.endsWith(VERIFICATION_REPORT_FILENAME));
}

/**
 * precondition:  none.
 * postcondition: returns the updated state (report path appended to
 *                written_files when a matching file_written result was fed
 *                in) unchanged otherwise.
 */
function recordReportWrite(state: PipelineState, result: import("../types/actions.js").ActionResult | undefined): PipelineState {
  if (
    result?.kind === "file_written" &&
    result.path.endsWith(VERIFICATION_REPORT_FILENAME) &&
    !state.written_files.includes(result.path)
  ) {
    return { ...state, written_files: [...state.written_files, result.path] };
  }
  return state;
}

function writeReportAction(state: PipelineState): { kind: "write_file"; path: string; content: string } | null {
  const reportFile = buildVerificationReportFile(state);
  if (!reportFile) return null;
  return { kind: "write_file", path: reportFile.path, content: reportFile.content() };
}

/** Every exit of the gate passes here: the passed Define is kept before advancing. */
function finish(state: PipelineState, postSpecs: PostSpecsState) {
  return {
    state: { ...withPassedDefine({ ...state, post_specs: postSpecs }), current_step: "finalize" as const },
    action: { kind: "emit_message" as const, message: "Specification finalized." },
  };
}

function finishAnswer(state: PipelineState, postSpecs: PostSpecsState, policyVerdict: PolicyVerdict) {
  const decided: PostSpecsState = { ...postSpecs, decision: "prd_only" };
  if (policyVerdict.status !== "pass") {
    const withDecision = { ...state, post_specs: decided };
    const action = writeReportAction(withDecision);
    if (action) return { state: withDecision, action };
  }
  return finish(state, decided);
}

function finishAutomatic(state: PipelineState, postSpecs: PostSpecsState, policy: PolicyVerdict) {
  if (!state.pending_completion) {
    return {
      state: { ...state, current_step: "complete" as const },
      action: { kind: "failed" as const, step: "implementation_gate" as const,
        reason: "Define requires saved self-check evidence." },
    };
  }
  if (postSpecs.automatic_define && hasVerificationReport(state)) return finish(state, postSpecs);
  const projection = projectVerifiedDefine(state);
  const checked = "error" in projection
    ? refreshDefineOutcome(state, [
      ...policy.reasons.map(message => ({ message })),
      { message: projection.error.message },
    ])
    : state;
  const adjudicated = { ...postSpecs, automatic_define: 1 as const, decision: "prd_only" as const };
  const settled = { ...checked, post_specs: adjudicated };
  const action = writeReportAction(settled);
  return action ? { state: settled, action } : finish(settled, adjudicated);
}

export const handleImplementationGate: StepHandler = ({ state, result }) => {
  const findings = defineFindings(state);
  const stateAfterReportWrite = recordReportWrite(refreshDefineOutcome(state, findings), result);
  const postSpecs = ensurePostSpecs(stateAfterReportWrite);
  const policyVerdict = evaluateRunPolicy(stateAfterReportWrite, findings);

  if (state.semantic_review_requested) return finishAutomatic(stateAfterReportWrite, postSpecs, policyVerdict);

  // (A) The gate answer was already processed on a PRIOR call (postSpecs.decision
  // left "pending" only until handleGateAnswer runs) and this file_written is
  // the confirmation of the POST-decision report re-write — advance now.
  // Cannot misfire on the INITIAL write's confirmation: decision is only ever
  // set away from "pending" inside handleGateAnswer, which always runs
  // strictly after the initial write/ask sequence.
  if (result?.kind === "file_written" && postSpecs.decision !== "pending") {
    return finish(stateAfterReportWrite, postSpecs);
  }

  // (B) Initial report write — only for a "pass" verdict (today's exact
  // behavior, before ever asking). Non-"pass" verdicts skip straight to the
  // policy-shaped question — see module doc "WRITE TIMING".
  if (
    policyVerdict.status === "pass" &&
    result?.kind !== "file_written" &&
    !hasVerificationReport(stateAfterReportWrite)
  ) {
    const action = writeReportAction(stateAfterReportWrite);
    if (action) {
      return { state: { ...stateAfterReportWrite, post_specs: postSpecs }, action };
    }
  }

  const question = specVerificationQuestion(policyVerdict);
  // (C) Gate answer arrived.
  if (result?.kind === "user_answer" && result.question_id === IMPLEMENTATION_GATE_QUESTION_ID) {
    return answerOptionQuestion({ ...stateAfterReportWrite, post_specs: postSpecs }, question, question.options, result,
      (answered, choice) => choice === GATE_OPTION_PRD_ONLY
        ? finishAnswer(answered, postSpecs, policyVerdict)
        : { state: answered, action: question },
      GATE_OPTION_PRD_ONLY);
  }

  // (D) Report already written (or none could be derived) and no answer yet
  // — ask, shaped by the policy verdict.
  return {
    state: { ...stateAfterReportWrite, post_specs: postSpecs },
    action: question,
  };
};

/** Present saved checkpoints using the current specification verification question. */
export function refreshImplementationGateQuestion(state: PipelineState, action: NextAction | null): NextAction | null {
  return presentSpecAction(state, action);
}
