/**
 * Verification-policy evaluation — turns `pending_completion.verification`
 * (VerificationSummarySchema) plus a `VerificationPolicyConfig` into a
 * single `PolicyVerdict`. `implementation-gate.ts` (gate question shape) and
 * `verification-report.ts` (report rendering) both call `evaluateRunPolicy`
 * independently rather than threading a shared value between them — it is a
 * pure function of state already available to both, so the two consumers
 * can never disagree about what the policy concluded (Move 5: evaluation is
 * a distinct concern from EITHER consumer's rendering).
 *
 * source: design-phases-3-5.md §7; e2e run run_mrlqa0aj_u2rh15 (2026-07-15).
 */

import type { JudgeVerdict } from "@prd-gen/core";
import { validateDefineReadiness, validateDocument } from "@prd-gen/validation";
import { documentSections } from "../section-plan.js";
import type { VerificationSummary } from "../types/actions.js";
import type { PipelineState } from "../types/state.js";
import type { VerificationPolicyConfig } from "../types/state/verification-policy.js";
import { IMPLEMENTATION_GATE_QUESTION_ID } from "./protocol-ids.js";

/**
 * Default acceptance policy (used whenever `PipelineState.verification_policy`
 * is null — the composition root has not injected an override). Mirrors
 * `DEFAULT_VERIFY_BUDGET` (self-check-verify-budget.ts) — see
 * `VerificationPolicySchema` field docs for each default's rationale.
 */
export const DEFAULT_VERIFICATION_POLICY: VerificationPolicyConfig = {
  block_on: ["FAIL"],
  min_subjective_sampled_ratio: 0.5,
  on_unsampled_below_ratio: "ask",
  on_cross_model_disagreement: "ask",
};

/**
 * precondition:  none — `override` may be the composition-root injection or null.
 * postcondition: returns `override` unchanged when non-null, else
 *                DEFAULT_VERIFICATION_POLICY. Pure; no I/O.
 */
export function resolveVerificationPolicy(
  override: VerificationPolicyConfig | null,
): VerificationPolicyConfig {
  return override ?? DEFAULT_VERIFICATION_POLICY;
}

export type PolicyStatus = "pass" | "needs_attention" | "blocked";

export interface PolicyVerdict {
  readonly status: PolicyStatus;
  /** claim_ids whose verdict is in `policy.block_on`, dedup'd, first-seen order. */
  readonly blocking_claims: readonly string[];
  /**
   * Fraction of SUBJECTIVE-tier claims (denominator: `total_subjective_claims`)
   * that received NO judge verdict at all (dropped by `sampleWithinCap`
   * before dispatch). 0 when `total_subjective_claims` is 0 — vacuous truth,
   * no subjective claims existed to sample.
   */
  readonly unsampled_ratio: number;
  /** claim_ids where subjective judges disagreed across >=1 distinct model pair. */
  readonly disagreements: readonly string[];
  /** Human-readable reasons contributing to `status`, in evaluation order. */
  readonly reasons: readonly string[];
}

/**
 * precondition:  `verdicts` is `verification.judge_verdicts` (may be empty).
 * postcondition: distinct claim_ids carrying at least one NON-rule-tier
 *                (i.e. actually judge-dispatched) verdict. Rule-tier
 *                (mechanical) verdicts are excluded — they were never
 *                subject to sampling (claim-tier.ts) and are not part of
 *                the subjective-sampled-ratio denominator or numerator.
 */
function distinctSampledSubjectiveClaimIds(
  verdicts: readonly JudgeVerdict[],
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const v of verdicts) {
    if (v.judge.kind !== "rule") out.add(v.claim_id);
  }
  return out;
}

/**
 * precondition:  `verdicts` is `verification.judge_verdicts` (may be empty).
 * postcondition: claim_ids (dedup'd, first-seen order) where >=2 distinct
 *                `JudgeVerdict.model` values were assigned different
 *                verdicts for the SAME claim_id. Rule-tier verdicts
 *                (`judge.kind === "rule"`, `model` always undefined — see
 *                self-check-verdicts.ts computeMechanicalVerdicts) and
 *                verdicts missing a `model` are excluded — they carry no
 *                cross-model signal.
 */
function crossModelDisagreements(verdicts: readonly JudgeVerdict[]): readonly string[] {
  const verdictsByModelPerClaim = new Map<string, Map<string, Set<string>>>();
  for (const v of verdicts) {
    if (v.judge.kind === "rule" || !v.model) continue;
    const byModel = verdictsByModelPerClaim.get(v.claim_id) ?? new Map<string, Set<string>>();
    const verdictSet = byModel.get(v.model) ?? new Set<string>();
    verdictSet.add(v.verdict);
    byModel.set(v.model, verdictSet);
    verdictsByModelPerClaim.set(v.claim_id, byModel);
  }
  const out: string[] = [];
  for (const [claimId, byModel] of verdictsByModelPerClaim) {
    if (byModel.size < 2) continue; // only one model judged this claim
    const distinctVerdicts = new Set<string>();
    for (const verdictSet of byModel.values()) {
      for (const verdict of verdictSet) distinctVerdicts.add(verdict);
    }
    if (distinctVerdicts.size > 1) out.push(claimId);
  }
  return out;
}

/**
 * precondition:  none — `verification` may be undefined (no judge phase ran
 *                for this run: zero-claim short-circuit, or "Skip
 *                verification" chosen at the budget gate).
 * postcondition: pure function. `status` priority is blocked > needs_attention
 *                > pass:
 *                  - "blocked" iff `blocking_claims` is non-empty OR the
 *                    sampled-ratio breach fired with
 *                    `on_unsampled_below_ratio === "block"`.
 *                  - else "needs_attention" iff the sampled-ratio breach
 *                    fired with `on_unsampled_below_ratio === "ask"`, OR a
 *                    cross-model disagreement fired with
 *                    `on_cross_model_disagreement === "ask"`.
 *                  - else "pass".
 *                `"warn"`-configured gates never change `status` — they are
 *                still surfaced via `reasons` (prefixed `(warn only)`) so
 *                the report can render them without escalating the gate.
 */
export function evaluatePolicy(
  verification: VerificationSummary | undefined,
  policy: VerificationPolicyConfig,
): PolicyVerdict {
  const verdicts = verification?.judge_verdicts ?? [];
  const totalSubjective = verification?.total_subjective_claims ?? 0;

  const blockSet = new Set(policy.block_on);
  const blockingClaims: string[] = [];
  const seenBlocking = new Set<string>();
  for (const v of verdicts) {
    if (blockSet.has(v.verdict) && !seenBlocking.has(v.claim_id)) {
      seenBlocking.add(v.claim_id);
      blockingClaims.push(v.claim_id);
    }
  }

  const sampledSubjective = distinctSampledSubjectiveClaimIds(verdicts);
  const sampledRatio = totalSubjective > 0 ? sampledSubjective.size / totalSubjective : 1;
  const unsampledRatio = totalSubjective > 0 ? 1 - sampledRatio : 0;
  const ratioBreached = totalSubjective > 0 && sampledRatio < policy.min_subjective_sampled_ratio;

  const disagreements = crossModelDisagreements(verdicts);

  const reasons: string[] = [];
  let status: PolicyStatus = "pass";

  if (blockingClaims.length > 0) {
    status = "blocked";
    reasons.push(
      `${blockingClaims.length} claim(s) carry a blocked verdict (${policy.block_on.join(", ")}): ${blockingClaims.join(", ")}.`,
    );
  }

  if (ratioBreached) {
    const msg =
      `Only ${(sampledRatio * 100).toFixed(0)}% of subjective claims received a judge verdict ` +
      `(threshold: ${(policy.min_subjective_sampled_ratio * 100).toFixed(0)}%).`;
    if (policy.on_unsampled_below_ratio === "block") {
      status = "blocked";
      reasons.push(msg);
    } else if (policy.on_unsampled_below_ratio === "ask") {
      if (status !== "blocked") status = "needs_attention";
      reasons.push(msg);
    } else {
      reasons.push(`(warn only) ${msg}`);
    }
  }

  if (disagreements.length > 0) {
    const msg = `${disagreements.length} claim(s) show cross-model judge disagreement: ${disagreements.join(", ")}.`;
    if (policy.on_cross_model_disagreement === "ask") {
      if (status !== "blocked") status = "needs_attention";
      reasons.push(msg);
    } else {
      reasons.push(`(warn only) ${msg}`);
    }
  }

  return {
    status,
    blocking_claims: blockingClaims,
    unsampled_ratio: unsampledRatio,
    disagreements,
    reasons,
  };
}

/** The gate and its report share the same verdict, including for old pending runs. */
export function defineFindings(state: PipelineState) {
  return validateDefineReadiness(documentSections(state.sections));
}

export function evaluateRunPolicy(state: PipelineState, findings = defineFindings(state)): PolicyVerdict {
  const verdict = evaluatePolicy(
    state.pending_completion?.verification,
    resolveVerificationPolicy(state.verification_policy),
  );
  if (findings.length === 0) return verdict;
  return {
    ...verdict,
    status: "blocked",
    reasons: [...findings.map(({ message }) => message), ...verdict.reasons],
  };
}

/** Refresh a checkpoint saved under older validation rules before it can finalize. */
export function refreshDefineOutcome(state: PipelineState, findings: ReturnType<typeof defineFindings>): PipelineState {
  const pending = state.pending_completion;
  if (!pending) return state;
  const priorReasons = pending.outcome?.reasons ?? [];
  const added = findings.map(({ message }) => message).filter(message => !priorReasons.includes(message));
  if (added.length === 0) return state;
  const reasons = [...priorReasons, ...added];
  const report = validateDocument(documentSections(state.sections));
  const recalculated = ["Self-check complete", "Hard-output score: ", "Deterministic violations: "];
  const summary = pending.summary.split("\n").filter(line =>
    !recalculated.some(prefix => line.startsWith(prefix))).join("\n");
  return {
    ...state,
    pending_completion: {
      ...pending,
      summary: [
        `Self-check complete: NEEDS ATTENTION (${reasons.join("; ")}).`,
        `Hard-output score: ${report.totalScore.toFixed(2)} / 1.00`,
        `Deterministic violations: ${report.violations.length}`,
        summary,
      ].join("\n"),
      outcome: { status: "needs_attention", reasons },
    },
  };
}

/** ask_user option labels — shared between the gate builder and the decision table (implementation-gate.ts). */
export const GATE_OPTION_PRD_ONLY = "PRD only";
export const GATE_OPTION_IMPLEMENT = "Implement";
export const GATE_OPTION_IMPLEMENT_ANYWAY = "Implement anyway (dérogation explicite)";
export const GATE_OPTION_OVERRIDE_POLICY = "Override policy (explicit)";

const OPTION_PRD_ONLY_PASS = {
  label: GATE_OPTION_PRD_ONLY,
  description: "Stop here. No code changes — today's default behavior.",
} as const;
const OPTION_PRD_ONLY_FLAGGED = { label: GATE_OPTION_PRD_ONLY, description: "Stop here. No code changes." } as const;
const OPTION_IMPLEMENT = {
  label: GATE_OPTION_IMPLEMENT,
  description: "Spawn an engineer to implement, test, review, and (after a further gate) open a PR.",
} as const;
const OPTION_IMPLEMENT_ANYWAY = {
  label: GATE_OPTION_IMPLEMENT_ANYWAY,
  description: "Explicit derogation: implement despite the policy finding above.",
} as const;
const OPTION_OVERRIDE_POLICY = {
  label: GATE_OPTION_OVERRIDE_POLICY,
  description: "Explicit override: implement despite the block above.",
} as const;

type PolicyOption = typeof OPTION_PRD_ONLY_PASS | typeof OPTION_PRD_ONLY_FLAGGED | typeof OPTION_IMPLEMENT
  | typeof OPTION_IMPLEMENT_ANYWAY | typeof OPTION_OVERRIDE_POLICY;

interface GateQuestionShape {
  readonly header: string;
  readonly description: string;
  readonly options: [PolicyOption, PolicyOption];
}

/**
 * precondition:  `verdict.status !== "pass"` (the "pass" shape is built
 *                separately — see `buildPolicyGateQuestion`).
 * postcondition: pure function; the description always starts with
 *                `verdict.reasons` (human-readable) so a human is never
 *                blind to WHY the policy flagged this run.
 */
function nonPassGateShape(verdict: PolicyVerdict): GateQuestionShape {
  const reasonsText =
    verdict.reasons.length > 0 ? verdict.reasons.join(" ") : "Verification policy flagged this run.";
  if (verdict.status === "needs_attention") {
    return {
      header: "Verification policy flags attention before implementation",
      description: `${reasonsText} Implementing anyway is an explicit derogation from the acceptance policy.`,
      options: [OPTION_IMPLEMENT_ANYWAY, OPTION_PRD_ONLY_FLAGGED],
    };
  }
  // status === "blocked"
  return {
    header: "Verification policy blocks implementation",
    description: `${reasonsText} A bare "Implement" is not offered while this run is blocked.`,
    options: [OPTION_PRD_ONLY_FLAGGED, OPTION_OVERRIDE_POLICY],
  };
}

/**
 * precondition:  `verdict` is the CURRENT run's evaluatePolicy() output.
 * postcondition: returns a 2-option, single-select ask_user question whose
 *                option set is determined SOLELY by `verdict.status`:
 *                  "pass"            → ["PRD only", "Implement"] (today's
 *                                      exact copy — zero regression).
 *                  "needs_attention" → ["Implement anyway (dérogation
 *                                      explicite)", "PRD only"] — the
 *                                      derogation option is offered but
 *                                      framed as an explicit exception.
 *                  "blocked"         → ["PRD only", "Override policy
 *                                      (explicit)"] — never a bare
 *                                      "Implement" option while a claim is
 *                                      blocked.
 *                The header/description name every blocking claim,
 *                disagreement, and the unsampled ratio for "needs_attention"/
 *                "blocked" (verdict.reasons, already human-readable).
 */
export function buildPolicyGateQuestion(verdict: PolicyVerdict) {
  const shape: GateQuestionShape =
    verdict.status === "pass"
      ? {
          header: "Proceed to implementation?",
          description:
            "The PRD/specs are ready. Implement the change now (spawns an engineer, runs tests and review, opens a PR after a human gate), or stop here with PRD-only deliverables (today's behavior)?",
          options: [OPTION_PRD_ONLY_PASS, OPTION_IMPLEMENT],
        }
      : nonPassGateShape(verdict);

  return {
    kind: "ask_user" as const,
    question_id: IMPLEMENTATION_GATE_QUESTION_ID,
    multi_select: false,
    ...shape,
  };
}
