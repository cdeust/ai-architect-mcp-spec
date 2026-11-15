/**
 * Handler protocol constants.
 *
 * Shared identifiers used by handlers to address subagent invocations and
 * user prompts, AND by test/benchmark dispatchers (canned-dispatcher) to
 * route fake responses by `invocation_id` prefix.
 *
 * Centralized here so a rename in one place updates both producer (the
 * handler) and consumer (the dispatcher). Pre-fix, canned-dispatcher.ts
 * carried local copies of these constants with `// source: handlers/X.ts`
 * source comments — a shotgun-surgery smell where a rename in the handler
 * would silently desync the dispatcher.
 *
 * source: code-reviewer M4 (Phase 3+4 cross-audit, 2026-04).
 */

/** clarification.ts — question_id used to short-circuit clarification with "proceed". */
export const QUESTION_ID_CONTINUE = "clarification_continue";

/** clarification.ts — invocation_id prefix for the question-compose phase. */
export const CLARIFICATION_COMPOSE_INV_PREFIX = "clarification_compose_inv_";

/** section-generation.ts — invocation_id prefix for section-draft generation. */
export const SECTION_GENERATE_INV_PREFIX = "section_generate_";

/** self-check.ts — invocation_id prefix for the multi-judge verdict phase. */
export const SELF_CHECK_JUDGE_INV_PREFIX = "self_check_judge_";

/** jira-generation.ts — single invocation_id for the jira-ticket synthesis. */
export const JIRA_GENERATION_INV_ID = "jira_generation_engineer";

/**
 * input-analysis.ts — single invocation_id AND batch_id for the
 * git-historian investigation phase (single-invocation batch, mirrors
 * JIRA_GENERATION_INV_ID's naming — one constant covers both since there is
 * exactly one invocation per batch).
 */
export const GIT_HISTORY_INV_ID = "input_analysis_git_history";

/**
 * clarification.ts — invocation_id producer for round N's compose phase.
 * Lives here so the canned dispatcher uses the SAME function the handler
 * does — preventing the handler and the dispatcher from drifting on the
 * exact format. The current format is `<prefix><round>` (round number
 * appended directly).
 */
export function clarificationComposeInvocationId(round: number): string {
  return `${CLARIFICATION_COMPOSE_INV_PREFIX}${round}`;
}

/**
 * implementation-gate.ts — ask_user question_id for the "Implement" /
 * "PRD only" gate. Named here (not inline) so canned-dispatcher.ts's
 * explicit "PRD only" default and any test driving the gate share the SAME
 * literal — a drift here would silently fall through to the generic
 * options[0] canned answer, flipping the smoke-test baseline onto the
 * "Implement" path.
 *
 * source: design-phases-3-5.md §3 "implementation_gate".
 */
export const IMPLEMENTATION_GATE_QUESTION_ID = "implementation_gate";

/**
 * pre-impl-grounding.ts — correlation_id prefix for the per-symbol
 * `get_impact` cursor loop (one round trip per affected symbol).
 */
export const PRE_IMPL_GROUNDING_IMPACT_PREFIX = "pre_impl_grounding_impact_";

/**
 * pre-impl-grounding.ts — correlation_id producer for symbol index N's
 * `get_impact` call. Mirrors `clarificationComposeInvocationId` — the
 * handler and the canned dispatcher/tests must share this exact format.
 */
export function preImplGroundingImpactCorrelationId(index: number): string {
  return `${PRE_IMPL_GROUNDING_IMPACT_PREFIX}${index}`;
}

/**
 * post-impl-verification.ts — correlation ids for the 4-call POST-
 * implementation verification sequence (design-phases-3-5.md §1, §3):
 * `index_codebase`(worktree) → `detect_changes` → `verify_semantic_diff` →
 * `check_security_gates`. Unlike `pre_impl_grounding`'s per-symbol loop
 * (variable-length list, needs an index-parameterized producer function),
 * this sequence has exactly one call per stage — plain constants are
 * sufficient.
 */
export const POST_IMPL_INDEX_CODEBASE_CORRELATION_ID =
  "post_impl_verification_index_codebase";
export const POST_IMPL_DETECT_CHANGES_CORRELATION_ID =
  "post_impl_verification_detect_changes";
export const POST_IMPL_VERIFY_SEMANTIC_DIFF_CORRELATION_ID =
  "post_impl_verification_verify_semantic_diff";
export const POST_IMPL_CHECK_SECURITY_GATES_CORRELATION_ID =
  "post_impl_verification_check_security_gates";

/**
 * implementation.ts — single invocation AND batch_id for the `implementation`
 * step's engineer spawn (design-phases-3-5.md §3, PR 4a). Single-invocation
 * batch, mirrors GIT_HISTORY_INV_ID / JIRA_GENERATION_INV_ID's naming
 * convention — one constant covers both since there is exactly one
 * invocation per batch.
 */
export const IMPLEMENTATION_INV_ID = "implementation_engineer";

/**
 * testing.ts — single invocation AND batch_id for the `testing` step's
 * test-engineer spawn (design-phases-3-5.md §3, PR 4b). Single-invocation
 * batch, same naming convention as IMPLEMENTATION_INV_ID — runs exactly once
 * per `testing` visit (no retry loop on this step; a test-engineer failure
 * degrades to a finding surfaced at `review`, per design §4).
 */
export const TESTING_INV_ID = "testing_test_engineer";

/**
 * review.ts — invocation_id/batch_id producer for the `review` step's
 * code-reviewer spawn (design-phases-3-5.md §3, PR 4b). Attempt-indexed
 * (unlike TESTING_INV_ID/IMPLEMENTATION_INV_ID) because `review` is a
 * bounded retry loop: each attempt gets its own invocation_id so a stale
 * response from a prior attempt can never be mistaken for the current one
 * (mirrors preImplGroundingImpactCorrelationId's index-parameterized
 * producer — the handler and canned-dispatcher/tests share this exact
 * format).
 */
export const REVIEW_INV_PREFIX = "review_code_reviewer_";
export function reviewInvocationId(attempt: number): string {
  return `${REVIEW_INV_PREFIX}${attempt}`;
}

/**
 * pr-gate.ts — ask_user question_id for the trust-seam gate ("Push + open
 * PR" / "No"). Named here (not inline) so canned-dispatcher.ts's explicit
 * default and any test driving the gate share the SAME literal — mirrors
 * IMPLEMENTATION_GATE_QUESTION_ID's rationale (a drift here would silently
 * fall through to the generic options[0] canned answer).
 *
 * source: design-phases-3-5.md §3 "pr_gate" — "mandatory, non-skippable,
 * always fires when reached regardless of review verdict."
 */
export const PR_GATE_QUESTION_ID = "pr_gate";

/**
 * pr-creation.ts — single invocation AND batch_id for the `pr_creation`
 * step's engineer spawn (design-phases-3-5.md §3, PR 5). Single-invocation
 * batch, same naming convention as IMPLEMENTATION_INV_ID/TESTING_INV_ID —
 * runs at most once per `pr_gate` "yes" decision (no retry loop on this
 * step; a push/`gh pr create` failure degrades to `finalize`, per design §4).
 */
export const PR_CREATION_INV_ID = "pr_creation_engineer";

/**
 * self-check.ts — `ask_user` question_id for the judge-panel budget gate
 * (handlers/self-check-verify-budget.ts). Fires only when the reduced
 * per-claim judge-request count exceeds `VerifyBudgetConfig.invocation_cap`.
 * Named here (not inline) so canned-dispatcher.ts's default answer and any
 * test driving the gate share the SAME literal — mirrors
 * IMPLEMENTATION_GATE_QUESTION_ID / PR_GATE_QUESTION_ID's rationale.
 *
 * source: measured e2e run run_mrlqa0aj_u2rh15 (2026-07-15) — 89 uncapped
 * judge invocations in one batch; see types/state/verify-budget.ts.
 */
export const VERIFY_BUDGET_QUESTION_ID = "self_check_verify_budget";

/**
 * preflight.ts — single invocation_id AND batch_id of the
 * zetetic-team-subagents probe (one `zetetic-team-subagents:engineer`
 * invocation, the first subagent type a run needs). source: #123.
 */
export const PREFLIGHT_SUBAGENT_PROBE_ID = "preflight_subagent_probe";
