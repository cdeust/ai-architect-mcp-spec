/**
 * `handlers/verification-policy.ts` — `evaluatePolicy` unit tests.
 *
 * Proves:
 *   1. A FAIL verdict blocks by default (`block_on: ["FAIL"]`).
 *   2. INCONCLUSIVE (or any non-blocked verdict) does NOT block by itself,
 *      but an unsampled subjective claim (no verdict at all) counts against
 *      `min_subjective_sampled_ratio`.
 *   3. Cross-model disagreement on a subjective claim triggers
 *      `needs_attention` under the default `on_cross_model_disagreement:
 *      "ask"`.
 *   4. Ratios are computed on the SUBJECTIVE tier only — mechanical
 *      (rule-tier) claims never count toward `unsampled_ratio`, in either
 *      the numerator or the denominator.
 *   5. The run_mrlqa0aj_u2rh15 e2e scenario (1 FAIL + 20 INCONCLUSIVE, both
 *      of which received real verdicts) blocks under policy defaults with
 *      AC-008 named as the blocking claim.
 *
 * source: design-phases-3-5.md §7; e2e run run_mrlqa0aj_u2rh15 (2026-07-15).
 */

import { describe, expect, it } from "vitest";
import type { JudgeVerdict } from "@prd-gen/core";
import type { VerificationSummary } from "../types/actions.js";
import {
  DEFAULT_VERIFICATION_POLICY,
  defineFindings,
  evaluatePolicy,
  evaluateRunPolicy,
  refreshDefineOutcome,
  resolveVerificationPolicy,
} from "../handlers/verification-policy.js";
import { newPipelineState, type PipelineState } from "../index.js";
import { documentSections } from "../section-plan.js";

it("keeps absent planned definitions in validation and discards other unusable drafts", () => {
  expect(documentSections([
    { section_type: "overview", status: "passed", content: "Scope" },
    { section_type: "overview", status: "failed", content: "Rejected" },
    { section_type: "testing", status: "passed" },
    { section_type: "requirements", status: "failed", content: "- FR-001: Rejected." },
    { section_type: "acceptance_criteria", status: "passed", content: "" },
    { section_type: "jira_tickets", status: "passed", content: "Ticket" },
  ])).toEqual([
    { type: "overview", content: "Scope" },
    { type: "requirements", content: "" },
    { type: "acceptance_criteria", content: "" },
  ]);
});

it("keeps pre-finalization state and upgrades a saved completion without an outcome", () => {
  const seed = newPipelineState({ run_id: "run_policy_old", feature_description: "Old plan" });
  const state: PipelineState = {
    ...seed,
    sections: [{
      section_type: "requirements", status: "passed", content: "ok",
      attempt: 1, violation_count: 0, last_violations: [], attempt_log: [],
    }],
  };
  const findings = defineFindings(state);
  expect(evaluateRunPolicy(state)).toMatchObject({ status: "blocked", blocking_claims: [], disagreements: [] });
  expect(refreshDefineOutcome(state, findings)).toBe(state);
  const old = { ...state, pending_completion: { summary: "Notes for the reviewer", artifacts: [] } };
  const refreshed = refreshDefineOutcome(old, findings);
  expect(refreshed.pending_completion?.summary).toContain("Notes for the reviewer");
  expect(refreshed.pending_completion?.outcome).toEqual({
    status: "needs_attention",
    reasons: ["The requirements section must define at least one FR or NFR statement."],
  });
  expect(refreshDefineOutcome(refreshed, findings)).toBe(refreshed);
});

function judge(overrides: Partial<JudgeVerdict> & Pick<JudgeVerdict, "claim_id" | "verdict">): JudgeVerdict {
  return {
    judge: { kind: "genius", name: "dijkstra" },
    rationale: "canned",
    caveats: [],
    confidence: 0.8,
    ...overrides,
  };
}

function summary(overrides: Partial<VerificationSummary>): VerificationSummary {
  return {
    claims_evaluated: 0,
    distribution: {} as VerificationSummary["distribution"],
    distribution_suspicious: false,
    total_subjective_claims: 0,
    ...overrides,
  };
}

describe("evaluatePolicy — resolveVerificationPolicy", () => {
  it("returns DEFAULT_VERIFICATION_POLICY when override is null", () => {
    expect(resolveVerificationPolicy(null)).toEqual(DEFAULT_VERIFICATION_POLICY);
  });
  it("returns the override unchanged when non-null", () => {
    const override = { ...DEFAULT_VERIFICATION_POLICY, min_subjective_sampled_ratio: 0.9 };
    expect(resolveVerificationPolicy(override)).toBe(override);
  });
});

describe("evaluatePolicy — block_on (default: FAIL blocks unconditionally)", () => {
  it("blocks when a claim's verdict is FAIL", () => {
    const v = evaluatePolicy(
      summary({
        total_subjective_claims: 1,
        judge_verdicts: [judge({ claim_id: "AC-001", verdict: "FAIL" })],
      }),
      DEFAULT_VERIFICATION_POLICY,
    );
    expect(v.status).toBe("blocked");
    expect(v.blocking_claims).toEqual(["AC-001"]);
  });

  it("does NOT block on an INCONCLUSIVE verdict by itself (INCONCLUSIVE not in default block_on)", () => {
    const v = evaluatePolicy(
      summary({
        total_subjective_claims: 1,
        judge_verdicts: [judge({ claim_id: "AC-001", verdict: "INCONCLUSIVE" })],
      }),
      DEFAULT_VERIFICATION_POLICY,
    );
    expect(v.status).toBe("pass");
    expect(v.blocking_claims).toEqual([]);
  });

  it("no verification data at all -> pass (vacuous truth, nothing to block on)", () => {
    const v = evaluatePolicy(undefined, DEFAULT_VERIFICATION_POLICY);
    expect(v.status).toBe("pass");
    expect(v.blocking_claims).toEqual([]);
    expect(v.unsampled_ratio).toBe(0);
  });
});

describe("evaluatePolicy — min_subjective_sampled_ratio (unsampled claims)", () => {
  it("an unsampled subjective claim (present in total_subjective_claims, absent from judge_verdicts) counts against the ratio", () => {
    // 4 subjective claims total; only 1 received a verdict -> sampled ratio 25%,
    // below the default 50% threshold -> on_unsampled_below_ratio:"ask" -> needs_attention.
    const v = evaluatePolicy(
      summary({
        total_subjective_claims: 4,
        judge_verdicts: [judge({ claim_id: "FR-001", verdict: "PASS" })],
      }),
      DEFAULT_VERIFICATION_POLICY,
    );
    expect(v.status).toBe("needs_attention");
    expect(v.unsampled_ratio).toBeCloseTo(0.75, 5);
    expect(v.reasons.some((r) => r.includes("25%"))).toBe(true);
  });

  it("on_unsampled_below_ratio:'block' escalates the ratio breach to blocked", () => {
    const policy = { ...DEFAULT_VERIFICATION_POLICY, on_unsampled_below_ratio: "block" as const };
    const v = evaluatePolicy(
      summary({
        total_subjective_claims: 4,
        judge_verdicts: [judge({ claim_id: "FR-001", verdict: "PASS" })],
      }),
      policy,
    );
    expect(v.status).toBe("blocked");
  });

  it("on_unsampled_below_ratio:'warn' never escalates status, but still reports the ratio", () => {
    const policy = { ...DEFAULT_VERIFICATION_POLICY, on_unsampled_below_ratio: "warn" as const };
    const v = evaluatePolicy(
      summary({
        total_subjective_claims: 4,
        judge_verdicts: [judge({ claim_id: "FR-001", verdict: "PASS" })],
      }),
      policy,
    );
    expect(v.status).toBe("pass");
    expect(v.reasons.some((r) => r.startsWith("(warn only)"))).toBe(true);
  });

  it("fully sampled (ratio 100%) never breaches, regardless of threshold", () => {
    const v = evaluatePolicy(
      summary({
        total_subjective_claims: 2,
        judge_verdicts: [
          judge({ claim_id: "FR-001", verdict: "PASS" }),
          judge({ claim_id: "FR-002", verdict: "PASS" }),
        ],
      }),
      DEFAULT_VERIFICATION_POLICY,
    );
    expect(v.status).toBe("pass");
    expect(v.unsampled_ratio).toBe(0);
  });
});

describe("evaluatePolicy — ratios computed on the subjective tier only", () => {
  it("mechanical (rule-tier) verdicts never count toward unsampled_ratio's numerator or denominator", () => {
    // total_subjective_claims=1 (the ONE real subjective claim). Two extra
    // rule-tier verdicts are present (mechanical claims — self-check.ts
    // always includes them in judge_verdicts) but must not inflate the
    // "sampled subjective" count, since they were never subject to sampling
    // in the first place.
    const v = evaluatePolicy(
      summary({
        total_subjective_claims: 1,
        judge_verdicts: [
          judge({ claim_id: "AC-010", verdict: "SPEC-COMPLETE", judge: { kind: "rule", name: "rule-tier" } }),
          judge({ claim_id: "AC-011", verdict: "SPEC-COMPLETE", judge: { kind: "rule", name: "rule-tier" } }),
        ],
      }),
      DEFAULT_VERIFICATION_POLICY,
    );
    // The single subjective claim received ZERO real verdicts -> 0% sampled,
    // 100% unsampled -> ratio breach -> needs_attention (default "ask").
    expect(v.unsampled_ratio).toBe(1);
    expect(v.status).toBe("needs_attention");
  });

  it("total_subjective_claims=0 (mechanical-only run) never breaches the ratio", () => {
    const v = evaluatePolicy(
      summary({
        total_subjective_claims: 0,
        judge_verdicts: [judge({ claim_id: "AC-010", verdict: "SPEC-COMPLETE", judge: { kind: "rule", name: "rule-tier" } })],
      }),
      DEFAULT_VERIFICATION_POLICY,
    );
    expect(v.unsampled_ratio).toBe(0);
    expect(v.status).toBe("pass");
  });
});

describe("evaluatePolicy — cross-model disagreement", () => {
  it("two models disagreeing on the same subjective claim triggers needs_attention (default on_cross_model_disagreement:'ask')", () => {
    const v = evaluatePolicy(
      summary({
        total_subjective_claims: 1,
        judge_verdicts: [
          judge({ claim_id: "ARCH-001", verdict: "PASS", model: "haiku" }),
          judge({ claim_id: "ARCH-001", verdict: "FAIL", model: "sonnet" }),
        ],
      }),
      // block_on excludes FAIL here so the block gate doesn't mask the
      // disagreement gate under test.
      { ...DEFAULT_VERIFICATION_POLICY, block_on: [] },
    );
    expect(v.status).toBe("needs_attention");
    expect(v.disagreements).toEqual(["ARCH-001"]);
  });

  it("same model judging twice with different verdicts is NOT a cross-model disagreement", () => {
    const v = evaluatePolicy(
      summary({
        total_subjective_claims: 1,
        judge_verdicts: [
          judge({ claim_id: "ARCH-001", verdict: "PASS", model: "haiku" }),
          judge({ claim_id: "ARCH-001", verdict: "PASS", model: "haiku" }),
        ],
      }),
      DEFAULT_VERIFICATION_POLICY,
    );
    expect(v.disagreements).toEqual([]);
  });

  it("two models agreeing is NOT a disagreement", () => {
    const v = evaluatePolicy(
      summary({
        total_subjective_claims: 1,
        judge_verdicts: [
          judge({ claim_id: "ARCH-001", verdict: "PASS", model: "haiku" }),
          judge({ claim_id: "ARCH-001", verdict: "PASS", model: "sonnet" }),
        ],
      }),
      DEFAULT_VERIFICATION_POLICY,
    );
    expect(v.disagreements).toEqual([]);
    expect(v.status).toBe("pass");
  });

  it("on_cross_model_disagreement:'warn' never escalates status", () => {
    const policy = { ...DEFAULT_VERIFICATION_POLICY, block_on: [], on_cross_model_disagreement: "warn" as const };
    const v = evaluatePolicy(
      summary({
        total_subjective_claims: 1,
        judge_verdicts: [
          judge({ claim_id: "ARCH-001", verdict: "PASS", model: "haiku" }),
          judge({ claim_id: "ARCH-001", verdict: "FAIL", model: "sonnet" }),
        ],
      }),
      policy,
    );
    expect(v.status).toBe("pass");
    expect(v.reasons.some((r) => r.startsWith("(warn only)"))).toBe(true);
  });
});

describe("evaluatePolicy — e2e scenario (run_mrlqa0aj_u2rh15)", () => {
  it("1 FAIL (AC-008) + 20 INCONCLUSIVE, policy defaults -> status blocked, AC-008 listed", () => {
    // 29 subjective claims total (28 FR/AC + 1 architecture, per
    // claim-tier.ts module doc's calibration case). 21 received real
    // verdicts (1 FAIL + 20 INCONCLUSIVE) under a reduced (sampled) jury —
    // the other 8 never got dispatched at all.
    const verdicts: JudgeVerdict[] = [
      judge({ claim_id: "AC-008", verdict: "FAIL", model: "haiku" }),
      ...Array.from({ length: 20 }, (_, i) =>
        judge({ claim_id: `AC-${(9 + i).toString().padStart(3, "0")}`, verdict: "INCONCLUSIVE", model: "haiku" }),
      ),
    ];
    const v = evaluatePolicy(
      summary({ total_subjective_claims: 29, judge_verdicts: verdicts }),
      DEFAULT_VERIFICATION_POLICY,
    );
    expect(v.status).toBe("blocked");
    expect(v.blocking_claims).toEqual(["AC-008"]);
  });
});
