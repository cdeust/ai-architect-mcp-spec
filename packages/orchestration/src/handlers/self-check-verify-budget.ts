/**
 * Judge-panel budget for self-check's Phase A/B multi-judge verification
 * batch. Extracted from self-check.ts (§4.1 500-line file cap) — this module
 * owns ONE concern: turning a full `JudgeRequest[]` plan (every judge in
 * PANELS, judge-selector.ts) into a bounded, deterministic invocation set,
 * and building the `ask_user` gate when that set still exceeds budget.
 *
 * self-check.ts owns phase sequencing and snapshot bookkeeping; this module
 * owns the pure reduction/sampling/gate-construction functions. Both are
 * "self-check's own files" — no other handler imports from here.
 *
 * source: measured e2e run run_mrlqa0aj_u2rh15 (2026-07-15) — the batch
 * `self_check_verify` dispatched 89 judge invocations (3 judges x 28 FR/AC
 * claims + a 5-judge architecture panel x 1 architecture claim), each a
 * ~37K-char prompt, with no `model`/`effort` field — the host ran every one
 * under the session model. Judging (read the claim, read the evidence,
 * compare) does not need frontier reasoning; a default of 1 judge/claim
 * under "haiku"/"low", gated at a 20-invocation cap, is the fix.
 */

import type { JudgeRequest } from "@prd-gen/core";
import type { VerifyBudgetConfig } from "../types/state.js";
import { VERIFY_BUDGET_QUESTION_ID } from "./protocol-ids.js";

/**
 * Default judge-panel budget (used whenever `PipelineState.verify_budget`
 * is null — the composition root has not injected an override).
 *
 * source: see module doc above for the measured e2e baseline this replaces.
 */
export const DEFAULT_VERIFY_BUDGET: VerifyBudgetConfig = {
  judges_per_claim: 1,
  architecture_judges_per_claim: 2,
  invocation_cap: 20,
  judge_model: "haiku",
  judge_effort: "low",
  // Cheapest distinct-model pair — see VerifyBudgetConfigSchema.diversity_models
  // doc (types/state/verify-budget.ts) for the monoculture-mitigation rationale
  // and its honest limit (both are Claude-family models).
  diversity_models: ["haiku", "sonnet"],
};

/**
 * precondition:  none — `override` may be the composition-root injection or null.
 * postcondition: returns `override` unchanged when non-null, else
 *                DEFAULT_VERIFY_BUDGET. Pure; no I/O.
 */
export function resolveVerifyBudget(
  override: VerifyBudgetConfig | null,
): VerifyBudgetConfig {
  return override ?? DEFAULT_VERIFY_BUDGET;
}

/**
 * Reduce a full judge-request plan (every judge in the claim's PANELS entry)
 * to at most `config.judges_per_claim` requests per claim — or
 * `config.architecture_judges_per_claim` for `claim_type === "architecture"`.
 *
 * precondition:  `requests` is in the deterministic order
 *                `planDocumentVerification` produces (claims in extraction
 *                order; within a claim, judges in PANELS' genius-then-team
 *                order).
 * postcondition: the result is a SUBSEQUENCE of `requests` (same relative
 *                order, no reordering) — deterministic replay across calls
 *                with the same inputs. Every claim_id present in `requests`
 *                is still present in the result (limits are >= 1, never 0),
 *                so no claim is silently dropped by this step.
 *
 * invariant (loop): `seen.get(claimId)` is the count of requests already
 *                    emitted for `claimId`; termination at `requests.length`.
 */
export function reduceJudgeRequests(
  requests: readonly JudgeRequest[],
  config: VerifyBudgetConfig,
): readonly JudgeRequest[] {
  const seen = new Map<string, number>();
  const out: JudgeRequest[] = [];
  for (const req of requests) {
    const claimId = req.claim.claim_id;
    const limit =
      req.claim.claim_type === "architecture"
        ? config.architecture_judges_per_claim
        : config.judges_per_claim;
    const count = seen.get(claimId) ?? 0;
    if (count < limit) {
      out.push(req);
    }
    seen.set(claimId, count + 1);
  }
  return out;
}

/**
 * Deterministically sample `requests` down to at most `cap` entries,
 * guaranteeing at least one request per distinct `claim_type` present (when
 * the number of distinct claim_types itself exceeds `cap`, coverage is
 * necessarily partial — the first `cap` distinct types win, still
 * deterministic).
 *
 * precondition:  `requests.length > cap` (callers only invoke this on the
 *                over-cap path; a no-op guard is still provided below for
 *                defensive reuse).
 * postcondition: result.length === min(requests.length, cap); result is a
 *                subsequence of `requests` (original relative order
 *                preserved); every claim_type present in `requests` is
 *                present in `result` UNLESS distinct-claim-type count > cap.
 *
 * invariant (pass 1 loop): `included.size` never exceeds `cap`; each
 *                           iteration either adds exactly one new claim_type
 *                           or leaves `included` unchanged. Termination:
 *                           `requests.length` (finite) or `included.size >=
 *                           cap` (whichever first).
 * invariant (pass 2 loop): same termination bound; pass 2 only adds entries
 *                           already excluded by pass 1's `!included.has`.
 */
export function sampleWithinCap(
  requests: readonly JudgeRequest[],
  cap: number,
): readonly JudgeRequest[] {
  if (requests.length <= cap) return requests;

  const included = new Set<JudgeRequest>();
  const seenTypes = new Set<string>();

  // Pass 1: one request per claim_type, in original order — coverage first.
  for (const req of requests) {
    if (included.size >= cap) break;
    if (!seenTypes.has(req.claim.claim_type)) {
      seenTypes.add(req.claim.claim_type);
      included.add(req);
    }
  }
  // Pass 2: fill remaining budget with the next requests in original order.
  for (const req of requests) {
    if (included.size >= cap) break;
    included.add(req);
  }
  return requests.filter((r) => included.has(r));
}

/**
 * Assign a dispatch model to each request in `requests`, in order.
 *
 * "architecture"-typed claims cycle through `config.diversity_models` — one
 * distinct model per judge slot WITHIN that claim's panel (slot index
 * modulo `diversity_models.length`), so an architecture claim's panel spans
 * both distinct personas (judge-selector.ts's PANELS) and distinct model
 * families, not personas alone — see VerifyBudgetConfigSchema.diversity_models
 * doc for the monoculture-mitigation rationale and its honest limit.
 * Every other claim_type dispatches its single judge under
 * `config.diversity_models[0]` (falls back to `config.judge_model` if
 * `diversity_models` is empty — defensive; the schema requires length >= 1).
 *
 * precondition:  `requests` is the FINAL invocation set (post-reduction,
 *                post-sampling) — same precondition as buildVerifyAction/
 *                dispatchVerify. Same-claim requests remain CONTIGUOUS in
 *                `requests` (reduceJudgeRequests/sampleWithinCap only ever
 *                drop entries, never reorder — see their own postcondition
 *                comments), which is what makes the per-claim slot-index
 *                counter below correct without needing the full plan.
 * postcondition: result.length === requests.length, index-aligned with
 *                `requests`. Deterministic replay for identical inputs.
 *
 * invariant (loop): `seen.get(claimId)` is the count of requests for
 *                    `claimId` already assigned a model; termination at
 *                    `requests.length`.
 */
export function assignJudgeModels(
  requests: readonly JudgeRequest[],
  config: VerifyBudgetConfig,
): readonly string[] {
  const models = config.diversity_models.length > 0
    ? config.diversity_models
    : [config.judge_model];
  const seen = new Map<string, number>();
  return requests.map((req) => {
    const claimId = req.claim.claim_id;
    const slot = seen.get(claimId) ?? 0;
    seen.set(claimId, slot + 1);
    return req.claim.claim_type === "architecture"
      ? models[slot % models.length]
      : models[0];
  });
}

/** ask_user option labels — shared between the gate builder and decision routing. */
export const VERIFY_BUDGET_OPTION_SAMPLE = "Reduced sample";
export const VERIFY_BUDGET_OPTION_FULL = "Full fleet";
export const VERIFY_BUDGET_OPTION_SKIP = "Skip verification";

/**
 * Build the `ask_user` action offered when the reduced judge-request count
 * still exceeds `config.invocation_cap`.
 *
 * precondition:  `invocationCount > config.invocation_cap` (caller's gate
 *                condition — not re-checked here, this function only builds
 *                the question).
 * postcondition: returns a 3-option, single-select AskUserAction whose
 *                option labels match VERIFY_BUDGET_OPTION_*.
 */
export function buildBudgetGateQuestion(
  invocationCount: number,
  config: VerifyBudgetConfig,
) {
  return {
    kind: "ask_user" as const,
    question_id: VERIFY_BUDGET_QUESTION_ID,
    header: "Judge panel exceeds the verdict budget",
    description:
      `Self-check's multi-judge verification would request ${invocationCount} judge verdicts ` +
      `(default: ${config.judges_per_claim} judge/claim, ${config.architecture_judges_per_claim} for architecture claims), ` +
      `above the ${config.invocation_cap}-verdict budget. Choose how to proceed.`,
    options: [
      {
        label: VERIFY_BUDGET_OPTION_SAMPLE,
        description: `Sample down to ${config.invocation_cap} verdicts, covering every claim type at least once.`,
      },
      {
        label: VERIFY_BUDGET_OPTION_FULL,
        description: `Request all ${invocationCount} verdicts despite the budget (explicit override).`,
      },
      {
        label: VERIFY_BUDGET_OPTION_SKIP,
        description: "Skip multi-judge verification entirely; finalize with deterministic checks only.",
      },
    ],
    multi_select: false,
  };
}
