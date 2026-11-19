/**
 * `implementation_gate` — the human gate between the PRD deliverables
 * (self_check) and the post-specs implementation loop.
 *
 * self_check's finalize() has already computed `state.pending_completion`
 * and advanced here (design-phases-3-5.md §2.2). This handler:
 *   1. Evaluates the verification-acceptance policy (handlers/
 *      verification-policy.ts `evaluatePolicy`) over
 *      `pending_completion.verification`.
 *   2. Asks a question shaped by that verdict — "Implement" vs "PRD only"
 *      when the policy passed cleanly; an explicit-derogation question
 *      naming the blocking claims/disagreements/unsampled ratio otherwise
 *      (see `buildPolicyGateQuestion`). Routes:
 *        - "prd_only" → `finalize` directly. Zero regression for the
 *          policy-"pass" case (design §5, PR 3b acceptance criterion).
 *        - "implement" → `pre_impl_grounding`.
 *   3. Records a `policy_derogation` on `state.post_specs` whenever
 *      "implement" was chosen against a non-"pass" policy verdict.
 *
 * precondition:  state.pending_completion !== null (set by self_check's
 *                finalize() before advancing here).
 *
 * VERIFICATION-REPORT EXPORT (root-cause note, 2026-07-15, extended
 * 2026-07-15 for the policy gap — e2e run run_mrlqa0aj_u2rh15: the jury
 * returned 1 FAIL + 20 INCONCLUSIVE, yet this gate asked its question
 * exactly as if every claim had passed): self-check's verification results
 * were computed but never written to a file — only carried in the transient
 * `pending_completion`/`done` payload. `implementation_gate` is the FIRST
 * step reached once `pending_completion` is set (see precondition above),
 * so it writes `10-verification-report.md` (`buildVerificationReportFile`,
 * verification-report.ts) via the SAME write_file protocol file_export
 * uses. WRITE TIMING depends on the policy verdict:
 *   - status "pass": written BEFORE the question is asked (today's exact
 *     behavior, zero regression) — the decision cannot yet change the
 *     report's content since no derogation is possible on this path.
 *   - status "needs_attention" / "blocked": the question IS asked first
 *     (its header/description already names every blocking claim —
 *     `buildPolicyGateQuestion` — so a human is never blind); the report is
 *     written ONCE, after the answer, so it can render the recorded
 *     decision/derogation rather than a "pending" placeholder. This is
 *     still exactly one file_write round trip for this path, matching the
 *     "pass" path's cost.
 *
 * source: design-phases-3-5.md §2.2, §3 "implementation_gate", §7
 * "verification_policy"; e2e run run_mrlqa0aj_u2rh15 (2026-07-15).
 */

import { answerOptionQuestion } from "./match-offered-option.js";
import type { StepHandler } from "../runner.js";
import { type PipelineState } from "../types/state.js";
import { initialPostSpecs, type PostSpecsState } from "../types/state/post-specs-state.js";
import { IMPLEMENTATION_GATE_QUESTION_ID } from "./protocol-ids.js";
import { buildVerificationReportFile, VERIFICATION_REPORT_FILENAME } from "./verification-report.js";
import {
  buildPolicyGateQuestion,
  GATE_OPTION_IMPLEMENT,
  GATE_OPTION_IMPLEMENT_ANYWAY,
  GATE_OPTION_OVERRIDE_POLICY,
  GATE_OPTION_PRD_ONLY,
  evaluatePolicy,
  resolveVerificationPolicy,
  type PolicyVerdict,
} from "./verification-policy.js";

const GATE_DECISIONS = {
  [GATE_OPTION_PRD_ONLY]: "prd_only",
  [GATE_OPTION_IMPLEMENT]: "implement",
  [GATE_OPTION_IMPLEMENT_ANYWAY]: "implement",
  [GATE_OPTION_OVERRIDE_POLICY]: "implement",
} as const;

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

/**
 * precondition:  `postSpecs.decision !== "pending"` (the gate answer has
 *                already been processed into `postSpecs`).
 * postcondition: routes to `finalize` ("prd_only") or `pre_impl_grounding`
 *                ("implement"), carrying `postSpecs` unchanged.
 */
function advance(state: PipelineState, postSpecs: PostSpecsState) {
  if (postSpecs.decision === "prd_only") {
    return {
      state: { ...state, post_specs: postSpecs, current_step: "finalize" as const },
      action: { kind: "emit_message" as const, message: "PRD-only run selected. Skipping implementation." },
    };
  }
  return {
    state: { ...state, post_specs: postSpecs, current_step: "pre_impl_grounding" as const },
    action: {
      kind: "emit_message" as const,
      message: "Implementation selected. Gathering pre-implementation blast-radius grounding.",
    },
  };
}

/**
 * precondition:  the answer matched an option offered for this policy verdict.
 * postcondition: computes the decision + any derogation record, then either
 *                (a) returns the post-decision report write (non-"pass"
 *                verdicts only, single write) so the recorded decision is
 *                rendered, or (b) advances directly ("pass" verdicts — no
 *                derogation possible, nothing new to render).
 */
function handleGateAnswer(
  state: PipelineState,
  postSpecs: PostSpecsState,
  policyVerdict: PolicyVerdict,
  decision: "implement" | "prd_only",
) {
  const requiresDerogationRecord = decision === "implement" && policyVerdict.status !== "pass";
  const newPostSpecs: PostSpecsState = {
    ...postSpecs,
    decision,
    ...(requiresDerogationRecord
      ? {
          policy_derogation: {
            policy_status: policyVerdict.status as "needs_attention" | "blocked",
            reasons: [...policyVerdict.reasons],
          },
        }
      : {}),
  };

  if (policyVerdict.status !== "pass" && !hasVerificationReport(state)) {
    const stateWithDecision: PipelineState = { ...state, post_specs: newPostSpecs };
    const action = writeReportAction(stateWithDecision);
    if (action) return { state: stateWithDecision, action };
  }
  return advance(state, newPostSpecs);
}

export const handleImplementationGate: StepHandler = ({ state, result }) => {
  const stateAfterReportWrite = recordReportWrite(state, result);
  const postSpecs = ensurePostSpecs(stateAfterReportWrite);
  const policyVerdict: PolicyVerdict = evaluatePolicy(
    stateAfterReportWrite.pending_completion?.verification,
    resolveVerificationPolicy(stateAfterReportWrite.verification_policy),
  );

  // (A) The gate answer was already processed on a PRIOR call (postSpecs.decision
  // left "pending" only until handleGateAnswer runs) and this file_written is
  // the confirmation of the POST-decision report re-write — advance now.
  // Cannot misfire on the INITIAL write's confirmation: decision is only ever
  // set away from "pending" inside handleGateAnswer, which always runs
  // strictly after the initial write/ask sequence.
  if (result?.kind === "file_written" && postSpecs.decision !== "pending") {
    return advance(stateAfterReportWrite, postSpecs);
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

  const question = buildPolicyGateQuestion(policyVerdict);
  // (C) Gate answer arrived.
  if (result?.kind === "user_answer" && result.question_id === IMPLEMENTATION_GATE_QUESTION_ID) {
    return answerOptionQuestion({ ...stateAfterReportWrite, post_specs: postSpecs }, question, question.options, result,
      (answered, label) => handleGateAnswer(answered, postSpecs, policyVerdict, GATE_DECISIONS[label]),
      GATE_OPTION_PRD_ONLY);
  }

  // (D) Report already written (or none could be derived) and no answer yet
  // — ask, shaped by the policy verdict.
  return {
    state: { ...stateAfterReportWrite, post_specs: postSpecs },
    action: question,
  };
};
