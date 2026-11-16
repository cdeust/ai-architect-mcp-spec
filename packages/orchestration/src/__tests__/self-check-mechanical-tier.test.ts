/**
 * Mechanical-tier claims (claim-tier.ts, self-check-verdicts.ts) — verifies
 * self-check's Phase A/B wiring: mechanical claims never enter the dispatched
 * judge panel (zero invocation cost) yet still appear in `judge_verdicts` as
 * a rule-tier "SPEC-COMPLETE" record, on every exit path (zero-subjective-
 * claims fast path, normal dispatch, and the budget-skip path).
 *
 * source: design-phases-3-5.md "Verification tiering & monoculture limits";
 * calibrated against e2e run run_mrlqa0aj_u2rh15 (see
 * verification/src/__tests__/claim-tier.test.ts for the 29-claim fixture).
 */

import { claimIdsInJudgePrompt } from "@prd-gen/verification";
import { describe, it, expect } from "vitest";
import {
  newPipelineState,
  step,
  type ActionResult,
  type PipelineState,
  type SectionStatus,
} from "../index.js";
import { VERIFY_BUDGET_QUESTION_ID } from "../handlers/protocol-ids.js";
import { VERIFY_BUDGET_OPTION_SKIP } from "../handlers/self-check-verify-budget.js";

function section(
  section_type: SectionStatus["section_type"],
  content: string,
): SectionStatus {
  return {
    section_type,
    status: "passed",
    attempt: 1,
    violation_count: 0,
    last_violations: [],
    content,
    attempt_log: [],
  };
}

/** AC-010..AC-013 — 4 real mechanical-tier ACs (see claim-tier.test.ts). */
const MECHANICAL_AC_CONTENT = [
  "## acceptance_criteria",
  "",
  "AC-010 : Étant donné le code source, quand on l'inspecte, alors aucune fonction n'est présente.",
  "",
  "AC-011 : Étant donné le module, quand on grep les constantes, alors aucune référence n'est trouvée.",
  "",
  "AC-012 : Étant donné le module, quand on grep les tokens, alors aucune occurrence n'est trouvée.",
  "",
  "AC-013 : Étant donné le module, quand on diffe le fichier avant/après, alors aucune modification n'y est apportée.",
].join("\n");

/** AC-001..AC-002 — 2 real subjective-tier ACs. */
const SUBJECTIVE_AC_CONTENT = [
  "## acceptance_criteria",
  "",
  "AC-001 : Étant donné un pourcentage de 25 %, alors la couleur retournée est HEAT_1.",
  "",
  "AC-002 : Étant donné un pourcentage de 60 %, alors la couleur retournée est HEAT_2.",
].join("\n");

function selfCheckState(
  content: string,
  overrides: Partial<PipelineState> = {},
): PipelineState {
  const base = newPipelineState({
    run_id: `mechanical-tier-test-${content.length}`,
    feature_description: "mechanical tier test",
    skip_preflight: true,
  });
  return {
    ...base,
    current_step: "self_check",
    sections: [section("acceptance_criteria", content)],
    ...overrides,
  };
}

describe("self-check mechanical-tier claims", () => {
  it("all-mechanical document: zero invocations dispatched, 4 rule-tier verdicts in judge_verdicts", () => {
    const state = selfCheckState(MECHANICAL_AC_CONTENT);
    const out = step({ state, result: undefined });

    // Fast path: plan.judge_requests.length === 0 → finalize() runs
    // immediately, never dispatching spawn_subagents.
    expect(out.action.kind).not.toBe("spawn_subagents");
    expect(out.state.verification_plan).toBeNull();

    const verification = out.state.pending_completion?.verification;
    expect(verification).toBeDefined();
    expect(verification!.claims_evaluated).toBe(4);
    expect(verification!.distribution["SPEC-COMPLETE"]).toBe(4);
    // All-mechanical document -> zero SUBJECTIVE claims. total_subjective_claims
    // (handlers/verification-policy.ts's unsampled-ratio denominator) must be
    // 0, not 4 — mechanical claims never count toward the subjective tier.
    expect(verification!.total_subjective_claims).toBe(0);

    const verdicts = verification!.judge_verdicts;
    expect(verdicts).toBeDefined();
    expect(verdicts).toHaveLength(4);
    for (const v of verdicts!) {
      expect(v.judge).toEqual({ kind: "rule", name: "rule-tier" });
      expect(v.verdict).toBe("SPEC-COMPLETE");
      expect(v.caveats).toContain("rule_tier");
      expect(v.model).toBeUndefined(); // never model-dispatched
    }
    expect(verdicts!.map((v) => v.claim_id).sort()).toEqual([
      "AC-010",
      "AC-011",
      "AC-012",
      "AC-013",
    ]);
  });

  it("mixed document: mechanical claims skip dispatch, subjective claims get judge invocations — total invocation count excludes the mechanical claims entirely", () => {
    const mixedContent = [MECHANICAL_AC_CONTENT, "", SUBJECTIVE_AC_CONTENT].join("\n");
    const state = selfCheckState(mixedContent);
    const out = step({ state, result: undefined });

    expect(out.action.kind).toBe("spawn_subagents");
    if (out.action.kind !== "spawn_subagents") throw new Error("unreachable");

    // Only the 2 subjective ACs (AC-001, AC-002) are judged — the 4
    // mechanical ACs (AC-010..013) never appear in the dispatched batch. Both
    // go to the same judge, so they share one invocation (issue #119).
    expect(out.action.invocations).toHaveLength(1);
    expect(claimIdsInJudgePrompt(out.action.invocations[0].prompt).slice().sort()).toEqual(["AC-001", "AC-002"]);
    const snapshot = out.state.verification_plan!;
    expect(snapshot.claim_ids.sort()).toEqual(["AC-001", "AC-002"]);

    // Complete Phase B with synthetic PASS responses for the 2 subjective claims.
    const batchResult: ActionResult = {
      kind: "subagent_batch_result",
      batch_id: out.action.batch_id,
      responses: out.action.invocations.map((inv) => ({
        invocation_id: inv.invocation_id,
        raw_text: JSON.stringify(
          claimIdsInJudgePrompt(inv.prompt).map((claim_id) => ({
            claim_id,
            verdict: "PASS",
            rationale: "synthetic mixed-tier test judge response",
            caveats: [],
            confidence: 0.9,
          })),
        ),
      })),
    };
    const finalOut = step({ state: out.state, result: batchResult });

    const verification = finalOut.state.pending_completion?.verification;
    expect(verification).toBeDefined();
    // 4 mechanical (SPEC-COMPLETE, rule-tier) + 2 subjective (PASS, judged).
    expect(verification!.claims_evaluated).toBe(6);
    expect(verification!.distribution["SPEC-COMPLETE"]).toBe(4);
    expect(verification!.distribution.PASS).toBe(2);
    // Denominator excludes the 4 mechanical claims — only the 2 subjective
    // ACs (AC-001, AC-002) count.
    expect(verification!.total_subjective_claims).toBe(2);
    const ruleVerdicts = verification!.judge_verdicts!.filter(
      (v) => v.judge.kind === "rule",
    );
    expect(ruleVerdicts).toHaveLength(4);
  });

  it("'Skip verification' at the budget gate still preserves mechanical-tier verdicts", () => {
    // Force the budget gate by combining the mechanical content with enough
    // subjective claims to exceed the (test-scoped) default cap is overkill
    // here — instead exercise the skip path directly via a state with
    // verify_budget forcing an immediate over-cap on a single subjective
    // claim, then answering "Skip verification".
    const mixedContent = [MECHANICAL_AC_CONTENT, "", SUBJECTIVE_AC_CONTENT].join("\n");
    const state = selfCheckState(mixedContent, {
      verify_budget: {
        judges_per_claim: 1,
        architecture_judges_per_claim: 2,
        invocation_cap: 1, // 2 subjective claims > cap 1 forces the gate
        judge_model: "haiku",
        judge_effort: "low",
        diversity_models: ["haiku", "sonnet"],
      },
    });
    const gated = step({ state, result: undefined });
    expect(gated.action.kind).toBe("ask_user");
    if (gated.action.kind !== "ask_user") throw new Error("unreachable");
    expect(gated.action.question_id).toBe(VERIFY_BUDGET_QUESTION_ID);

    const answer: ActionResult = {
      kind: "user_answer",
      question_id: VERIFY_BUDGET_QUESTION_ID,
      selected: [VERIFY_BUDGET_OPTION_SKIP],
    };
    const out = step({ state: gated.state, result: answer });

    const verification = out.state.pending_completion?.verification;
    expect(verification).toBeDefined();
    // Subjective claims were skipped entirely (0), but mechanical verdicts
    // are NOT part of the skip decision — they never depended on the judge
    // panel in the first place.
    expect(verification!.claims_evaluated).toBe(4);
    expect(verification!.distribution["SPEC-COMPLETE"]).toBe(4);
    expect(verification!.judge_verdicts!.every((v) => v.judge.kind === "rule")).toBe(
      true,
    );
    // The 2 subjective claims still count in the denominator — they were
    // extracted, just never dispatched (user chose "Skip verification").
    // handlers/verification-policy.ts's evaluatePolicy would report these as
    // 100% unsampled, not "0 subjective claims existed".
    expect(verification!.total_subjective_claims).toBe(2);
  });
});
