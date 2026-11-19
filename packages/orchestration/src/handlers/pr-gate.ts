/**
 * `pr_gate` — the trust-seam human gate (design-phases-3-5.md §3, PR 5).
 *
 * This is the FIRST branch push / PR the pipeline ever opens. It is
 * MANDATORY and non-skippable: it always fires when reached, regardless of
 * the `review` verdict — including an advisory FAIL after `REVIEW_RETRY_CAP`
 * is exhausted (review.ts). A PR is opened here; it is NEVER self-merged —
 * see pr-creation.ts's `<prohibited>` block for the enforcement side of that
 * rule.
 *
 * The gate's message is an HONEST summary of what is about to be pushed:
 * the review verdict (PASS or an advisory FAIL, with findings), whether the
 * post-implementation security/regression gates passed, how many files
 * changed, and the branch name. A human deciding "push + open PR" must see
 * a FAIL verdict as plainly as a PASS one — hiding it would defeat the
 * point of a trust seam.
 *
 * Routing:
 *   - "Push + open PR" → `pr_creation`.
 *   - "No" → a VALID TERMINAL path (not a failure): straight to `finalize`
 *     with `post_specs.pr = {pushed:false, url:null}`.
 *
 * Non-bypass (design §6 lesson, restated here): UNLIKE every other step in
 * this loop, `pr_gate` has NO "already decided" idempotency shortcut. Every
 * other step's guard is `if (<result already recorded>) skip to next step`
 * (implementation.ts, testing.ts, review.ts) — that pattern is exactly what
 * this gate must NOT do, because the whole point of a mandatory gate is
 * that it cannot be bypassed by a state field happening to already be set.
 * A call to this handler with no matching `user_answer` ALWAYS emits
 * `ask_user` — there is no state under which it silently proceeds.
 *
 * source: design-phases-3-5.md §3, §4, §6 PR 5.
 */

import { answerOptionQuestion } from "./match-offered-option.js";
import type { StepHandler } from "../runner.js";
import { type PipelineState } from "../types/state.js";
import { initialPostSpecs, type PostSpecsState } from "../types/state/post-specs-state.js";
import { PR_GATE_QUESTION_ID } from "./protocol-ids.js";

function ensurePostSpecs(state: PipelineState): PostSpecsState {
  return state.post_specs ?? initialPostSpecs();
}

/**
 * precondition:  none.
 * postcondition: a human-readable summary of the review verdict, the
 *                post-implementation gate result, the changed-file count,
 *                and the branch — used as the gate's `ask_user` description
 *                body. Never omits a FAIL verdict or its findings.
 */
function buildGateSummary(postSpecs: PostSpecsState): string {
  const review = postSpecs.review;
  const verdictLine = review
    ? `Review verdict: ${review.verdict.toUpperCase()}${review.findings.length > 0 ? ` — ${review.findings.join("; ")}` : ""} (attempt ${review.attempt}, ${postSpecs.retry_count} retry/retries used).`
    : "Review verdict: unavailable.";
  const gatesLine = postSpecs.verification
    ? `Post-implementation gates passed: ${postSpecs.verification.gates_passed}.`
    : "Post-implementation gates: not run.";
  const filesLine = `Files changed: ${postSpecs.implementation?.changed_files.length ?? 0}.`;
  const branchLine = `Branch: ${postSpecs.implementation?.branch ?? "(unknown)"}.`;
  return [verdictLine, gatesLine, filesLine, branchLine].join("\n");
}

const PUSH_LABEL = "Push + open PR";

function prQuestion(postSpecs: PostSpecsState) {
  return {
    kind: "ask_user" as const,
    question_id: PR_GATE_QUESTION_ID,
    header: "Push the branch and open a pull request?",
    description: `${buildGateSummary(postSpecs)}\n\nA pull request is opened for human review — it is never self-merged.`,
    options: [
      {
        label: PUSH_LABEL,
        description: "Push the branch and open a pull request for human review.",
      },
      {
        label: "No",
        description: "Stop here. No branch is pushed and no PR is opened.",
      },
    ],
    multi_select: false,
  };
}

export const handlePrGate: StepHandler = ({ state, result }) => {
  const postSpecs = ensurePostSpecs(state);

  const question = prQuestion(postSpecs);
  if (result?.kind === "user_answer" && result.question_id === PR_GATE_QUESTION_ID) {
    return answerOptionQuestion({ ...state, post_specs: postSpecs }, question, question.options, result, (answered, label) => {
      if (label === PUSH_LABEL) {
        return {
          state: { ...answered, current_step: "pr_creation", post_specs: postSpecs },
          action: {
            kind: "emit_message",
            message: "Push approved. Opening a pull request.",
          },
        };
      }
      return {
        state: {
          ...answered,
          current_step: "finalize",
          post_specs: { ...postSpecs, pr: { pushed: false, url: null } },
        },
        action: {
          kind: "emit_message",
          message: "Push declined. Proceeding to finalize without a PR.",
        },
      };
    }, "No");
  }

  return { state: { ...state, post_specs: postSpecs }, action: question };
};
