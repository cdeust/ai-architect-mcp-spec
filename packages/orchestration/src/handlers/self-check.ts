/**
 * Self-check (SKILL.md Rule 13).
 *
 * Two-phase:
 *   Phase A — emit a multi-judge verification batch over all generated sections.
 *             The host spawns the judges in parallel via the Agent tool and
 *             feeds the verdicts back as a `subagent_batch_result`.
 *   Phase B — combine deterministic `validateDocument` violations + multi-judge
 *             VerificationReport into the final `done` summary.
 *
 * If verification yields zero claims (e.g. nothing extractable from a tiny
 * PRD), Phase B runs immediately on Phase A's "no judges to run" path.
 *
 * self_check no longer emits `remember`/`done` itself (PR 3b,
 * design-phases-3-5.md §2.2): finalize() computes the final
 * summary/artifacts/verification, stores it in `state.pending_completion`,
 * and advances to `implementation_gate` — the post-specs human gate. The
 * relocated Phase C (Cortex `remember` → `done`) now lives in
 * handlers/finalize.ts, the sole step that reaches `complete`.
 */

import type { StepHandler } from "../runner.js";
import type { ActionResult, DoneOutcome, NextAction } from "../types/actions.js";
import {
  appendError,
  type PipelineState,
  type VerifyBudgetConfig,
} from "../types/state.js";
import { validateDocument } from "@prd-gen/validation";
import {
  planDocumentVerification,
  buildJudgePrompt,
  buildMechanicalVerdicts,
} from "@prd-gen/verification";
import {
  agentSubagentType,
  isBlockingViolation,
  type Claim,
  type JudgeRequest,
  type JudgeVerdict,
} from "@prd-gen/core";
import { VERIFY_BUDGET_QUESTION_ID } from "./protocol-ids.js";
import {
  resolveVerifyBudget,
  reduceJudgeRequests,
  sampleWithinCap,
  buildBudgetGateQuestion,
  verifyBudgetDecisionFromAnswer,
  assignJudgeModels,
} from "./self-check-verify-budget.js";
import { handlePrdValidation } from "./self-check-prd-validation.js";
import { withDocumentScore } from "./self-check-quality-score.js";
import { concludeWithObservations } from "./self-check-observations.js";
import {
  invocationIdFor,
  buildJudgeIndex,
  parseVerdicts,
  computeMechanicalVerdicts,
  countSubjectiveClaims,
  truncateJudgeVerdictRationale,
} from "./self-check-verdicts.js";

const VERIFY_BATCH_ID = "self_check_verify";

/**
 * postcondition: the sections whose claims self-check judges — every section
 *                with content, except jira_tickets (generated outside the
 *                section validation loop; no claim extractor is defined for
 *                ticket format) and failed sections. failSection keeps a
 *                failed draft in `content`, but that draft is not a
 *                deliverable (file_export withholds it, #122), so judging
 *                its claims would count them in the verification report as
 *                if they were part of the PRD. The failure itself is still
 *                reported: finalize() counts failed sections and sets
 *                outcome "needs_attention".
 */
function gatherSections(state: PipelineState) {
  return state.sections
    .filter(
      (s) =>
        s.content &&
        s.status !== "failed" &&
        s.section_type !== "jira_tickets",
    )
    .map((s) => ({ type: s.section_type, content: s.content! }));
}

/**
 * precondition:  `requests` is the FINAL invocation set — already reduced
 *                (reduceJudgeRequests) and, if the budget gate fired,
 *                sampled or explicitly overridden. This function performs
 *                no further filtering.
 * postcondition: one spawn_subagents invocation per request, in the same
 *                order, each carrying `model`/`effort` — `model` comes from
 *                assignJudgeModels (architecture claims cycle through
 *                `config.diversity_models`; every other claim dispatches
 *                under `config.diversity_models[0]`) — no judge invocation
 *                is dispatched under the session model by default (source:
 *                measured e2e run run_mrlqa0aj_u2rh15; see
 *                self-check-verify-budget.ts module doc).
 */
function buildVerifyAction(
  requests: readonly JudgeRequest[],
  config: VerifyBudgetConfig,
): NextAction {
  const models = assignJudgeModels(requests, config);
  return {
    kind: "spawn_subagents",
    purpose: "judge",
    batch_id: VERIFY_BATCH_ID,
    invocations: requests.map((req, idx) => {
      const built = buildJudgePrompt(req);
      return {
        invocation_id: invocationIdFor(idx),
        subagent_type: agentSubagentType(req.judge),
        description: built.description,
        prompt: built.prompt,
        isolation: "none" as const,
        model: models[idx],
        effort: config.judge_effort,
      };
    }),
  };
}

/**
 * precondition:  the three counts come from the same finalize() call;
 *                `hardOutputScore` is validateDocument's totalScore, in [0, 1].
 * postcondition: status is "needs_attention" iff at least one reason holds —
 *                a failed section, a critical deterministic violation, or a
 *                score at its floor of 0 (the penalties saturated, so the
 *                score no longer distinguishes anything). No tuned threshold:
 *                each reason is a fact the summary already reports.
 *                `reasons` lists the facts in that order; empty iff "passed".
 *
 * source: issue #122 — an audited run showed `done` with a score of 0.00.
 */
export function computeDoneOutcome(
  sectionsFailed: number,
  criticalViolations: number,
  hardOutputScore: number,
): DoneOutcome {
  const reasons: string[] = [];
  if (sectionsFailed > 0) {
    reasons.push(`${sectionsFailed} section(s) failed validation`);
  }
  if (criticalViolations > 0) {
    reasons.push(`${criticalViolations} critical deterministic violation(s)`);
  }
  if (hardOutputScore <= 0) {
    reasons.push("hard-output score is 0.00");
  }
  return {
    status: reasons.length === 0 ? "passed" : "needs_attention",
    reasons,
  };
}

function finalize(
  state: PipelineState,
  verdicts: readonly JudgeVerdict[] = [],
  totalSubjectiveClaims = 0,
  judgedClaims: readonly Claim[] = [],
) {
  const sections = gatherSections(state);
  const docReport = validateDocument(sections);
  const { report: verificationReport, observations } = concludeWithObservations(verdicts, judgedClaims);

  const sectionsPassed = state.sections.filter((s) => s.status === "passed")
    .length;
  const sectionsFailed = state.sections.filter((s) => s.status === "failed")
    .length;
  const sectionsTotal = state.sections.length;
  const docCritical = docReport.violations.filter((v) => v.isCritical).length;
  const docAdvisory = docReport.violations.filter(
    (v) => !isBlockingViolation(v),
  ).length;

  const outcome = computeDoneOutcome(
    sectionsFailed,
    docCritical,
    docReport.totalScore,
  );

  const summary = [
    outcome.status === "passed"
      ? `Self-check complete.`
      : `Self-check complete: NEEDS ATTENTION (${outcome.reasons.join("; ")}).`,
    `Sections: ${sectionsPassed}/${sectionsTotal} passed, ${sectionsFailed} failed.`,
    `Deterministic violations: ${docReport.violations.length} (${docCritical} critical, ${docAdvisory} advisory)`,
    `Hard-output score: ${docReport.totalScore.toFixed(2)} / 1.00`,
    `Multi-judge claims: ${verificationReport.claims_evaluated}`,
    `  PASS:           ${verificationReport.distribution.PASS}`,
    `  SPEC-COMPLETE:  ${verificationReport.distribution["SPEC-COMPLETE"]}`,
    `  NEEDS-RUNTIME:  ${verificationReport.distribution["NEEDS-RUNTIME"]}`,
    `  INCONCLUSIVE:   ${verificationReport.distribution.INCONCLUSIVE}`,
    `  FAIL:           ${verificationReport.distribution.FAIL}`,
    verificationReport.distribution_suspicious
      ? `  ⚠ Distribution suspicious — 100% PASS suggests confirmatory bias.`
      : "",
  ]
    .filter((l) => l !== "")
    .join("\n");

  // finalize() no longer emits `remember`/`done` itself (PR 3b,
  // design-phases-3-5.md §2.2): it stores the computed payload in
  // state.pending_completion and advances to `implementation_gate`, the
  // post-specs human gate. handlers/finalize.ts (the relocated Phase C)
  // performs the Cortex `remember` round trip and returns `done` once every
  // gate/dead-end path converges back there.
  return {
    state: {
      ...state,
      quality_scores: withDocumentScore(state, docReport),
      reliability_observations: [...state.reliability_observations, ...observations],
      pending_completion: {
        summary,
        artifacts: state.sections.map((s) => `${s.section_type}: ${s.status}`),
        // Typed verification surface (Phase 3+4 cross-audit closure). Callers
        // MUST consume this field, not regex-parse `summary`. The string
        // remains as a human-readable artifact only.
        verification: {
          claims_evaluated: verificationReport.claims_evaluated,
          distribution: verificationReport.distribution,
          distribution_suspicious: verificationReport.distribution_suspicious,
          // Attach the PRD-vs-graph validation report when one was produced.
          // Left undefined for non-codebase runs so the prior verification
          // shape is unchanged (backward-compatible). See
          // VerificationSummarySchema.
          ...(state.prd_validation
            ? { prd_graph_validation: state.prd_validation }
            : {}),
          // Per-claim judge verdicts (VerificationSummarySchema.judge_verdicts,
          // actions.ts). Omitted (undefined) when `verdicts` is empty — that is
          // the genuinely-absent case (zero-claim fast path, or the user chose
          // "Skip verification" at the budget gate) and file-export.ts's
          // renderJudgeVerdicts() renders an honest gap notice for it. Non-empty
          // arrays are persisted verbatim (rationale capped defensively — see
          // JUDGE_VERDICT_RATIONALE_TRUNCATE_CHARS above) so
          // 10-verification-report.md's "Per-Claim Judge Verdicts" table is
          // real data, not a permanent gap.
          // source: e2e run_mrlqa0aj_u2rh15 (2026-07-15) follow-up — see
          // VerificationSummarySchema.judge_verdicts doc in actions.ts.
          ...(verdicts.length > 0
            ? { judge_verdicts: verdicts.map(truncateJudgeVerdictRationale) }
            : {}),
          // Pre-sampling subjective-claim denominator for
          // handlers/verification-policy.ts's unsampled-ratio gate — see
          // VerificationSummarySchema.total_subjective_claims doc.
          total_subjective_claims: totalSubjectiveClaims,
        },
        outcome,
      },
      current_step: "implementation_gate" as const,
    },
    action: {
      kind: "emit_message" as const,
      message: "Self-check complete. Awaiting implementation decision.",
    },
  };
}

/**
 * Assemble the snapshot + spawn_subagents action for a final invocation set.
 *
 * precondition:  `requests` is non-empty and already reduced/sampled.
 * postcondition: verification_plan.claim_ids/judges are parallel arrays,
 *                index-aligned with the dispatched invocations (invariant
 *                enforced by VerificationPlanSnapshotSchema's refine).
 */
function dispatchVerify(
  state: PipelineState,
  requests: readonly JudgeRequest[],
  config: VerifyBudgetConfig,
  sampled: boolean,
) {
  return {
    state: {
      ...state,
      verification_plan: {
        batch_id: VERIFY_BATCH_ID,
        claim_ids: requests.map((r) => r.claim.claim_id),
        judges: requests.map((r) => r.judge),
        sampled,
      },
    },
    action: buildVerifyAction(requests, config),
  };
}

/**
 * Phase A — plan the multi-judge batch and dispatch it, subject to the
 * judge-panel budget (self-check-verify-budget.ts). If there's nothing to
 * verify (no claim-rich sections, or extractor produces zero claims),
 * finalize immediately on the fast path.
 *
 * Budget gate: `planDocumentVerification` returns the FULL panel per claim
 * (PANELS in judge-selector.ts — 2-5 judges/claim). `reduceJudgeRequests`
 * cuts that to `config.judges_per_claim` (default 1; 2 for architecture
 * claims) BEFORE any dispatch decision — the invocation count checked
 * against `config.invocation_cap` is always the reduced count, never the
 * full-panel count. When the reduced count still exceeds the cap, this
 * function asks the user (VERIFY_BUDGET_QUESTION_ID) instead of dispatching,
 * and re-enters here on the answer (`result.kind === "user_answer"` is
 * routed to Phase A by handleSelfCheck's dispatcher below, since only
 * `subagent_batch_result` routes to Phase B).
 *
 * precondition:  state.current_step === "self_check"; if `result` is
 *                present it is either undefined, a stale/foreign
 *                ActionResult, or the user_answer for
 *                VERIFY_BUDGET_QUESTION_ID.
 * postcondition: returns finalize(state) (zero-claim fast path), an
 *                ask_user gate action (over-cap, no answer yet), or a
 *                dispatchVerify() spawn_subagents action.
 */
function handleSelfCheckPhaseA(
  state: PipelineState,
  result: ActionResult | undefined,
) {
  const sections = gatherSections(state);
  if (sections.length === 0) {
    return finalize(state);
  }

  const plan = planDocumentVerification(sections);
  // Mechanical-tier claims (claim-tier.ts) never enter judge_requests — they
  // get a rule-tier verdict directly, regardless of which fast-path/dispatch
  // branch the subjective-tier claims below take.
  const mechanicalVerdicts = buildMechanicalVerdicts(plan.mechanical_claims);
  // Pre-reduction/pre-sampling subjective-claim count — the denominator
  // handlers/verification-policy.ts's unsampled-ratio gate needs (see
  // VerificationSummarySchema.total_subjective_claims doc). Computed once,
  // from the FULL plan, so every finalize() call below (regardless of which
  // reduction/sampling/skip branch is taken) reports the SAME denominator.
  const totalSubjectiveClaims = countSubjectiveClaims(plan.judge_requests);
  if (plan.judge_requests.length === 0) {
    return finalize(state, mechanicalVerdicts, totalSubjectiveClaims);
  }

  const config = resolveVerifyBudget(state.verify_budget);
  const reduced = reduceJudgeRequests(plan.judge_requests, config);
  if (reduced.length === 0) {
    return finalize(state, mechanicalVerdicts, totalSubjectiveClaims);
  }

  if (result?.kind === "user_answer" && result.question_id === VERIFY_BUDGET_QUESTION_ID) {
    const decision = verifyBudgetDecisionFromAnswer(result);
    if (decision === "skip") {
      return finalize(state, mechanicalVerdicts, totalSubjectiveClaims);
    }
    const finalRequests =
      decision === "sample" ? sampleWithinCap(reduced, config.invocation_cap) : reduced;
    return dispatchVerify(state, finalRequests, config, decision === "sample");
  }

  if (reduced.length > config.invocation_cap) {
    return { state, action: buildBudgetGateQuestion(reduced.length, config) };
  }

  return dispatchVerify(state, reduced, config, false);
}

/**
 * Phase B — verdicts came back. Use the snapshot persisted in Phase A
 * rather than re-deriving so Phase B is immune to any state mutation
 * between phases (and to non-determinism in plan generation).
 *
 * No snapshot can mean: (a) Phase B was never preceded by Phase A, or
 * (b) Phase B already ran (snapshot was cleared) and the host is retrying
 * with stale state. Both cases produce the same "no judges to aggregate"
 * outcome — finalize idempotently with zero verdicts.
 */
function handleSelfCheckPhaseB(
  state: PipelineState,
  result: Extract<ActionResult, { kind: "subagent_batch_result" }>,
) {
  const sections = gatherSections(state);
  // Recomputed (not persisted in the snapshot) — pure function of
  // `state.sections`, unchanged since Phase A, same rederivation strategy
  // `parseVerdictsFromSnapshot` already relies on below.
  const judgeRequests = planDocumentVerification(sections).judge_requests;
  const totalSubjectiveClaims = countSubjectiveClaims(judgeRequests);
  const snapshot = state.verification_plan;
  if (!snapshot || snapshot.batch_id !== VERIFY_BATCH_ID) {
    return finalize(state, computeMechanicalVerdicts(sections), totalSubjectiveClaims);
  }
  const verdicts = parseVerdictsFromSnapshot(snapshot, state, result);
  // Mechanical-tier claims (claim-tier.ts) were excluded from the dispatched
  // panel entirely (Phase A) — recompute their rule-tier verdicts here (pure
  // function of state.sections, unchanged since Phase A) so they're present
  // in `judge_verdicts` alongside the judge-parsed subjective verdicts.
  const mechanicalVerdicts = computeMechanicalVerdicts(gatherSections(state));

  // Surface plan-mismatch diagnostics into state.errors so they're
  // observable to operators and tests. The caveats carry the mismatchKind
  // ("ordering_regression" | "content_mutation"); without this append, the
  // diagnostic was buried inside synthetic INCONCLUSIVE JudgeVerdict objects
  // that consensus() does not propagate to the typed `done.verification`
  // surface (cross-audit MED-19, Phase 3+4 follow-up, 2026-04).
  let stateAfter: PipelineState = { ...state, verification_plan: null };
  const mismatchSeen = new Set<string>();
  for (const v of verdicts) {
    for (const caveat of v.caveats) {
      if (caveat.startsWith("mismatch_kind:") && !mismatchSeen.has(caveat)) {
        mismatchSeen.add(caveat);
        stateAfter = appendError(
          stateAfter,
          `[self_check] plan mismatch detected — ${caveat}`,
          "structural", // protocol-level diagnostic — not a section validator
        );
      }
    }
  }

  // The claims that went to judges, with their types: what the orchestrator
  // needs to hand one observation per judge verdict to the reliability
  // store (#121). The other paths to finalize() carry no judge verdict.
  const judgedClaims = judgeRequests.map((request) => request.claim);
  return finalize(stateAfter, [...mechanicalVerdicts, ...verdicts], totalSubjectiveClaims, judgedClaims);
}

export const handleSelfCheck: StepHandler = ({ state, result }) => {
  // Phase C (Cortex `remember` → `done`) no longer lives in self_check (PR
  // 3b, design-phases-3-5.md §2.2) — finalize() (below) sets
  // pending_completion AND advances current_step to "implementation_gate"
  // in the SAME return, so self_check is never re-entered with
  // pending_completion still set. handlers/finalize.ts owns Phase C now.

  // Phase 0 — PRD-vs-graph validation runs before the judge phase. It either
  // emits the validation call (and we return immediately) or falls through
  // with possibly-updated state (validation stored / skipped / failed-advisory).
  const validation = handlePrdValidation(state, result);
  if ("action" in validation) {
    return { state: validation.state, action: validation.action };
  }
  const stateAfterValidation = validation.state;

  if (
    result?.kind === "subagent_batch_result" &&
    result.batch_id === VERIFY_BATCH_ID
  ) {
    return handleSelfCheckPhaseB(stateAfterValidation, result);
  }
  return handleSelfCheckPhaseA(stateAfterValidation, result);
};

/**
 * Phase B verdict parsing using the persisted snapshot. We re-run
 * planDocumentVerification + the SAME budget reduction (and, when
 * snapshot.sampled is true, the SAME sampleWithinCap transform) Phase A
 * applied, only to recover the JudgeRequest objects (judge identities and
 * claim metadata); the AUTHORITATIVE ordering comes from the snapshot's
 * claim_ids array. If the re-derived plan no longer matches, we fall back to
 * constructing minimal JudgeVerdicts from the snapshot ids.
 *
 * Rederiving with the SAME config the snapshot was built under is load-
 * bearing: `state.verify_budget` does not change within a run (composition-
 * root-injected once, before start_pipeline), so `resolveVerifyBudget`
 * returns the identical config Phase A used — the reduction/sampling
 * transform is therefore a pure, deterministic function of (sections,
 * config, snapshot.sampled), reproducible here without persisting the
 * intermediate JudgeRequest objects themselves.
 *
 * The snapshot now also carries judges[], so attribution survives the
 * fallback path without needing to invent a synthetic identity.
 */
function parseVerdictsFromSnapshot(
  snapshot: NonNullable<PipelineState["verification_plan"]>,
  state: PipelineState,
  batchResult: Extract<ActionResult, { kind: "subagent_batch_result" }>,
): JudgeVerdict[] {
  const sections = gatherSections(state);
  const config = resolveVerifyBudget(state.verify_budget);
  const reduced = reduceJudgeRequests(
    planDocumentVerification(sections).judge_requests,
    config,
  );
  const rederived = snapshot.sampled
    ? sampleWithinCap(reduced, config.invocation_cap)
    : reduced;

  const sameLength = rederived.length === snapshot.claim_ids.length;
  const sameOrder =
    sameLength &&
    rederived.every((r, i) => r.claim.claim_id === snapshot.claim_ids[i]);

  if (sameOrder) {
    return parseVerdicts(buildJudgeIndex(rederived, config), batchResult);
  }

  // Diagnose the mismatch reason — set vs order — for the caller to persist.
  // The mismatchKind is encoded in each verdict's caveats so the consensus
  // engine + the caller's state.errors append (in handleSelfCheck) can both
  // surface the diagnostic. Curie A5 (pass-2): the previous `void mismatchKind`
  // discarded the info entirely, blocking the K=200 plan-mismatch
  // investigation in Phase 4.3.
  const snapshotSet = new Set(snapshot.claim_ids);
  const rederivedIds = rederived.map((r) => r.claim.claim_id);
  const sameSet =
    sameLength && rederivedIds.every((id) => snapshotSet.has(id));
  const mismatchKind: "ordering_regression" | "content_mutation" = sameSet
    ? "ordering_regression"
    : "content_mutation";

  // Mutation occurred between phases — degrade gracefully. We still know the
  // exact judge identity for each slot (snapshot.judges[idx]), so attribution
  // in ConsensusVerdict.judges and Bayesian reliability lookups remain correct.
  const byId = new Map(
    batchResult.responses.map((r) => [r.invocation_id, r]),
  );
  const out: JudgeVerdict[] = [];
  for (let idx = 0; idx < snapshot.claim_ids.length; idx++) {
    const claim_id = snapshot.claim_ids[idx];
    const judge = snapshot.judges[idx];
    const response = byId.get(invocationIdFor(idx));
    out.push({
      judge,
      claim_id,
      verdict: "INCONCLUSIVE",
      rationale:
        response?.error ??
        "Plan mismatch between Phase A and Phase B — original verdict cannot be parsed without JudgeRequest context",
      caveats: ["plan_mismatch", `mismatch_kind:${mismatchKind}`],
      confidence: 0,
    });
  }
  return out;
}
