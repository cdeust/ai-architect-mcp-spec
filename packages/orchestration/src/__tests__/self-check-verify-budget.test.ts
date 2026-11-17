/**
 * Judge-panel budget gate — direct unit tests against `handleSelfCheck` via
 * `step()`, WITHOUT driving the full pipeline (unlike
 * self-check-fires-mismatch.test.ts's `driveToPhaseA`). Constructing
 * `PipelineState` directly with `current_step: "self_check"` and
 * claim-rich sections is faster and keeps each test scoped to exactly the
 * budget-gate behavior under test.
 *
 * Covers (engineer task B1/B2, 2026-07-15):
 *   - default panel size: 1 judge/claim, 2 for architecture claims
 *   - model/effort present on every judge invocation
 *   - cap trigger emits ask_user with the 3 budget options
 *   - deterministic sampling (repeat calls produce the identical set;
 *     every claim_type present in the plan is covered)
 *   - a host-skipped judge (response.error set) maps to INCONCLUSIVE
 *     without failing the run (B2)
 *
 * source: measured e2e run run_mrlqa0aj_u2rh15 (2026-07-15) — 89 uncapped
 * judge invocations under the session model in one spawn_subagents batch.
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
import {
  VERIFY_BUDGET_OPTION_SAMPLE,
  VERIFY_BUDGET_OPTION_FULL,
  VERIFY_BUDGET_OPTION_SKIP,
  DEFAULT_VERIFY_BUDGET,
  sampleWithinCap,
  assignJudgeModels,
} from "../handlers/self-check-verify-budget.js";
import type { JudgeRequest } from "@prd-gen/core";

const VERIFY_BATCH_ID = "self_check_verify";

// ─── Fixtures ───────────────────────────────────────────────────────────────

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

/** N synthetic FR-### requirement lines — one fr_traceability claim each. */
function requirementsContent(n: number): string {
  const lines = Array.from(
    { length: n },
    (_, i) => `- FR-${(i + 1).toString().padStart(3, "0")}: The system does thing number ${i + 1}.`,
  );
  return ["## requirements", "", ...lines].join("\n");
}

/**
 * Exactly ONE architecture claim — matches ONLY ARCH_PATTERNS' "hexagonal"
 * entry. (A phrase like "ports and adapters" would ALSO match the
 * ports-and-adapters pattern, yielding two architecture claims instead of
 * one — avoided here so fr_count/architecture-claim arithmetic in the tests
 * below stays exact.)
 */
const TECHNICAL_SPEC_CONTENT = [
  "## technical_specification",
  "",
  "We use a hexagonal design with a clear boundary around the domain core.",
].join("\n");

/**
 * Build a self_check-entry PipelineState with `fr_count` FR requirement
 * claims plus (optionally) exactly one architecture claim.
 */
function selfCheckState(
  fr_count: number,
  includeArchitecture: boolean,
  overrides: Partial<PipelineState> = {},
): PipelineState {
  const base = newPipelineState({
    run_id: `self-check-budget-test-${fr_count}-${includeArchitecture}`,
    feature_description: "budget gate test",
    skip_preflight: true,
  });
  const sections: SectionStatus[] = [
    section("requirements", requirementsContent(fr_count)),
  ];
  if (includeArchitecture) {
    sections.push(section("technical_specification", TECHNICAL_SPEC_CONTENT));
  }
  return {
    ...base,
    current_step: "self_check",
    sections,
    ...overrides,
  };
}

function dispatchAction(state: PipelineState, result?: ActionResult) {
  return step({ state, result });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("self-check judge-panel budget gate", () => {
  it("dispatches 1 judge/claim by default, 2 for an architecture claim (under cap)", () => {
    // 2 FR claims + 1 architecture claim: 2*1 + 1*2 = 4 verdicts requested —
    // well under DEFAULT_VERIFY_BUDGET.invocation_cap (20), so no gate fires.
    const state = selfCheckState(2, true);
    const out = dispatchAction(state);

    expect(out.action.kind).toBe("spawn_subagents");
    if (out.action.kind !== "spawn_subagents") throw new Error("unreachable");
    expect(out.action.batch_id).toBe(VERIFY_BATCH_ID);
    // One invocation per (judge, model) batch (issue #119): the two FR claims
    // share one judge and one model; the architecture claim's two judges run
    // under two models. 4 (judge × claim) pairs travel in 3 prompts.
    expect(out.action.invocations).toHaveLength(3);
    const promptedClaims = out.action.invocations.flatMap((inv) => claimIdsInJudgePrompt(inv.prompt));
    expect(promptedClaims.slice().sort()).toEqual(["ARCH-HEXAGONAL", "ARCH-HEXAGONAL", "FR-001", "FR-002"]);
    // Each prompt embeds the PRD once, whatever the number of its claims.
    for (const inv of out.action.invocations) {
      expect(inv.prompt.split("<prd_excerpt>").length - 1).toBe(1);
    }

    // The snapshot's parallel claim_ids/judges arrays are the direct
    // evidence of panel size per claim — count occurrences per claim_id.
    const snapshot = out.state.verification_plan;
    expect(snapshot).not.toBeNull();
    const countsByClaim = new Map<string, number>();
    for (const id of snapshot!.claim_ids) {
      countsByClaim.set(id, (countsByClaim.get(id) ?? 0) + 1);
    }
    expect(countsByClaim.get("FR-001")).toBe(1);
    expect(countsByClaim.get("FR-002")).toBe(1);
    expect(countsByClaim.get("ARCH-HEXAGONAL")).toBe(2);
  });

  it("sets effort on every judge invocation; model uniform for non-architecture, diversified for architecture", () => {
    const state = selfCheckState(2, true);
    const out = dispatchAction(state);

    expect(out.action.kind).toBe("spawn_subagents");
    if (out.action.kind !== "spawn_subagents") throw new Error("unreachable");
    expect(out.action.invocations.length).toBeGreaterThan(0);
    for (const inv of out.action.invocations) {
      expect(inv.effort).toBe(DEFAULT_VERIFY_BUDGET.judge_effort);
      expect(inv.model).toBeDefined();
    }

    // Non-architecture (FR-*) invocations dispatch under diversity_models[0]
    // (the "standard subjective claims keep 1 haiku judge" default).
    const claimsOf = (inv: (typeof out.action.invocations)[number]) => claimIdsInJudgePrompt(inv.prompt);
    const frInvocations = out.action.invocations.filter((inv) =>
      claimsOf(inv).some((id) => id.startsWith("FR-")),
    );
    expect(frInvocations).toHaveLength(1);
    expect(claimsOf(frInvocations[0])).toEqual(["FR-001", "FR-002"]);
    for (const inv of frInvocations) {
      expect(inv.model).toBe(DEFAULT_VERIFY_BUDGET.diversity_models[0]);
    }

    // The architecture claim's 2 judges cycle through diversity_models —
    // one distinct model per slot, not the single judge_model default.
    const archInvocations = out.action.invocations.filter((inv) =>
      claimsOf(inv).some((id) => id.startsWith("ARCH-")),
    );
    expect(archInvocations).toHaveLength(2);
    expect(archInvocations.map((inv) => inv.model)).toEqual(
      DEFAULT_VERIFY_BUDGET.diversity_models,
    );
  });
});

describe("self-check judge-panel budget gate — model-diversity slots (arXiv:2602.11865 mitigation)", () => {
  it("assignJudgeModels: architecture claims cycle diversity_models per judge slot; other claims use diversity_models[0]", () => {
    const requests: JudgeRequest[] = [
      {
        judge: { kind: "genius", name: "aristotle" },
        claim: { claim_id: "FR-001", claim_type: "fr_traceability", text: "t", evidence: "e" },
        context: { codebase_excerpts: [], memory_excerpts: [] },
      },
      {
        judge: { kind: "genius", name: "liskov" },
        claim: { claim_id: "ARCH-001", claim_type: "architecture", text: "t", evidence: "e" },
        context: { codebase_excerpts: [], memory_excerpts: [] },
      },
      {
        judge: { kind: "genius", name: "simon" },
        claim: { claim_id: "ARCH-001", claim_type: "architecture", text: "t", evidence: "e" },
        context: { codebase_excerpts: [], memory_excerpts: [] },
      },
      {
        judge: { kind: "genius", name: "alexander" },
        claim: { claim_id: "ARCH-001", claim_type: "architecture", text: "t", evidence: "e" },
        context: { codebase_excerpts: [], memory_excerpts: [] },
      },
    ];
    const models = assignJudgeModels(requests, DEFAULT_VERIFY_BUDGET);
    expect(models[0]).toBe(DEFAULT_VERIFY_BUDGET.diversity_models[0]); // FR-001, slot 0
    expect(models[1]).toBe(DEFAULT_VERIFY_BUDGET.diversity_models[0]); // ARCH-001 slot 0
    expect(models[2]).toBe(DEFAULT_VERIFY_BUDGET.diversity_models[1]); // ARCH-001 slot 1
    // Cycles back to slot 0's model when architecture_judges_per_claim
    // exceeds diversity_models.length.
    expect(models[3]).toBe(DEFAULT_VERIFY_BUDGET.diversity_models[0]); // ARCH-001 slot 2
  });

  it("diversity slots count toward invocation_cap; every claim keeps >= 1 judge before ask_user fires", () => {
    // 18 FR claims (18*1) + 1 architecture claim (1*2) = 20 == cap exactly —
    // no gate fires; the architecture claim's 2 diversity-model slots were
    // already counted in the 20, not added on top of it.
    const state = selfCheckState(18, true);
    const out = dispatchAction(state);
    expect(out.action.kind).toBe("spawn_subagents");
    if (out.action.kind !== "spawn_subagents") throw new Error("unreachable");
    expect(out.state.verification_plan!.claim_ids).toHaveLength(20);
    // The 20 verdicts travel in one prompt per (judge, model) batch: the 18
    // FR claims in one, the architecture claim's two judges in one each.
    expect(out.action.invocations).toHaveLength(3);

    // Every distinct claim_id present in the dispatched snapshot has at
    // least 1 judge — reduceJudgeRequests' invariant (limits >= 1).
    const snapshot = out.state.verification_plan!;
    const counts = new Map<string, number>();
    for (const id of snapshot.claim_ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect(counts.size).toBe(19); // 18 FR + 1 ARCH
    for (const count of counts.values()) expect(count).toBeGreaterThanOrEqual(1);
  });
});

describe("self-check judge-panel budget gate — over-cap decisions", () => {
  it("emits ask_user with the 3 budget options when the reduced count exceeds the cap", () => {
    // 28 FR claims (28*1) + 1 architecture claim (1*2) = 30 > cap (20) —
    // mirrors the e2e run_mrlqa0aj_u2rh15 scenario (29 claims).
    const state = selfCheckState(28, true);
    const out = dispatchAction(state);

    expect(out.action.kind).toBe("ask_user");
    if (out.action.kind !== "ask_user") throw new Error("unreachable");
    expect(out.action.question_id).toBe(VERIFY_BUDGET_QUESTION_ID);
    expect(out.action.options).not.toBeNull();
    const labels = out.action.options!.map((o) => o.label);
    expect(labels).toEqual([
      VERIFY_BUDGET_OPTION_SAMPLE,
      VERIFY_BUDGET_OPTION_FULL,
      VERIFY_BUDGET_OPTION_SKIP,
    ]);
    // No batch was dispatched — verification_plan stays null until the
    // gate is answered.
    expect(out.state.verification_plan).toBeNull();
  });

  it("'Reduced sample' answer dispatches a batch within the cap, covering every claim type", () => {
    const state = selfCheckState(28, true);
    const gated = dispatchAction(state);
    expect(gated.action.kind).toBe("ask_user");

    const answer: ActionResult = {
      kind: "user_answer",
      question_id: VERIFY_BUDGET_QUESTION_ID,
      selected: [VERIFY_BUDGET_OPTION_SAMPLE],
    };
    const out = dispatchAction(gated.state, answer);

    expect(out.action.kind).toBe("spawn_subagents");
    if (out.action.kind !== "spawn_subagents") throw new Error("unreachable");
    expect(out.state.verification_plan!.claim_ids.length).toBeLessThanOrEqual(
      DEFAULT_VERIFY_BUDGET.invocation_cap,
    );
    expect(out.state.verification_plan?.sampled).toBe(true);
    const claimIds = out.state.verification_plan!.claim_ids;
    expect(claimIds.some((id) => id.startsWith("FR-"))).toBe(true);
    expect(claimIds.some((id) => id.startsWith("ARCH-"))).toBe(true);
  });
});

describe("self-check judge-panel budget gate — 'Full fleet' / 'Skip' decisions", () => {
  it("'Full fleet' answer dispatches the full reduced (uncapped) set", () => {
    const state = selfCheckState(28, true);
    const gated = dispatchAction(state);

    const answer: ActionResult = {
      kind: "user_answer",
      question_id: VERIFY_BUDGET_QUESTION_ID,
      selected: [VERIFY_BUDGET_OPTION_FULL],
    };
    const out = dispatchAction(gated.state, answer);

    expect(out.action.kind).toBe("spawn_subagents");
    if (out.action.kind !== "spawn_subagents") throw new Error("unreachable");
    // 28 FR claims * 1 + 1 architecture claim * 2 = 30, above the cap —
    // "Full fleet" bypasses the cap (but NOT the per-claim reduction).
    expect(out.state.verification_plan!.claim_ids).toHaveLength(30);
    expect(out.state.verification_plan?.sampled).toBe(false);
  });

  it("'Skip verification' answer finalizes with zero verdicts, no batch dispatched", () => {
    const state = selfCheckState(28, true);
    const gated = dispatchAction(state);

    const answer: ActionResult = {
      kind: "user_answer",
      question_id: VERIFY_BUDGET_QUESTION_ID,
      selected: [VERIFY_BUDGET_OPTION_SKIP],
    };
    const out = dispatchAction(gated.state, answer);

    // finalize() sets pending_completion + advances to implementation_gate,
    // whose ask_user is the next substantive action the runner coalesces to.
    expect(out.action.kind).not.toBe("failed");
    expect(out.state.verification_plan).toBeNull();
    expect(out.state.pending_completion?.verification?.claims_evaluated).toBe(0);
  });
});

/**
 * Drive the budget gate to a "Reduced sample" dispatch. Extracted so the
 * Phase B mismatch test body (below) stays under the §4.2 50-line function
 * cap (craftsmanship-checker.sh FUNCTION_TOO_LONG).
 *
 * postcondition: verification_plan.sampled === true; invocations.length > 1
 *                (so the mismatch test can drop one and still have signal).
 */
function dispatchSampledBatch() {
  const state = selfCheckState(28, true);
  const gated = dispatchAction(state);
  expect(gated.action.kind).toBe("ask_user");

  const sampleAnswer: ActionResult = {
    kind: "user_answer",
    question_id: VERIFY_BUDGET_QUESTION_ID,
    selected: [VERIFY_BUDGET_OPTION_SAMPLE],
  };
  const dispatched = dispatchAction(gated.state, sampleAnswer);
  expect(dispatched.action.kind).toBe("spawn_subagents");
  if (dispatched.action.kind !== "spawn_subagents") throw new Error("unreachable");
  expect(dispatched.state.verification_plan?.sampled).toBe(true);
  return dispatched;
}

/**
 * Build a Phase B batch whose invocation_ids diverge from the sampled
 * snapshot: drop the FIRST sampled invocation's response (missing id) and
 * inject one bogus id that was never dispatched (extra id).
 */
function buildMismatchedResponses(
  sampledInvocations: readonly { readonly invocation_id: string }[],
) {
  const responses = sampledInvocations
    .slice(1) // drop index 0 — simulates a missing response
    .map((inv) => ({
      invocation_id: inv.invocation_id,
      raw_text: JSON.stringify({
        verdict: "PASS",
        rationale: "phase-B mismatch-test judge response",
        caveats: [],
        confidence: 0.75,
      }),
    }));
  responses.push({
    // Extra id never present in the dispatched invocation set.
    invocation_id: "self_check_judge_9999",
    raw_text: JSON.stringify({
      verdict: "PASS",
      rationale: "response for an invocation_id nobody dispatched",
      caveats: [],
      confidence: 0.75,
    }),
  });
  return responses;
}

describe("self-check judge-panel budget gate — Phase B degradation (follow-up, e2e run_mrlqa0aj_u2rh15)", () => {
  it(
    "Phase B mismatch fallback: sampled snapshot + a batch response whose " +
      "invocation_ids don't exactly match (extra/missing) degrades " +
      "deterministically — missing responses become INCONCLUSIVE, extra " +
      "responses are ignored (no crash, no double-count)",
    () => {
      const dispatched = dispatchSampledBatch();
      const sampledInvocations = dispatched.action.invocations;
      expect(sampledInvocations.length).toBeGreaterThan(1);
      const sampledCount = dispatched.state.verification_plan!.claim_ids.length;

      const batchResult: ActionResult = {
        kind: "subagent_batch_result",
        batch_id: dispatched.action.batch_id,
        responses: buildMismatchedResponses(sampledInvocations),
      };

      const out = dispatchAction(dispatched.state, batchResult);

      // No crash — the run still reaches a non-"failed" action.
      expect(out.action.kind).not.toBe("failed");

      const verification = out.state.pending_completion?.verification;
      expect(verification).toBeDefined();

      // No double-count: claims_evaluated is bounded by the SAMPLED claim
      // count, never inflated by the bogus extra invocation_id (which has no
      // corresponding entry in the snapshot and is simply never looked up).
      expect(verification!.claims_evaluated).toBeLessThanOrEqual(sampledCount);
      expect(verification!.claims_evaluated).toBeGreaterThan(0);

      // The missing response (index 0's claim) resolves to INCONCLUSIVE,
      // never silently dropped and never crashing the aggregation.
      expect(verification!.distribution.INCONCLUSIVE).toBeGreaterThanOrEqual(1);

      // verification_plan snapshot is cleared after Phase B, same as every
      // other Phase B exit path (idempotent re-entry guard).
      expect(out.state.verification_plan).toBeNull();
    },
  );
});

describe("self-check judge-panel budget gate — sampling determinism & host-skip degradation", () => {
  it("sampleWithinCap is deterministic and covers every distinct claim_type", () => {
    const claimTypes = [
      "fr_traceability",
      "fr_traceability",
      "fr_traceability",
      "architecture",
      "architecture",
      "performance",
    ] as const;
    const requests: JudgeRequest[] = claimTypes.map((claim_type, i) => ({
      judge: { kind: "genius", name: "fermi" },
      claim: {
        claim_id: `C-${i}`,
        claim_type,
        text: "t",
        evidence: "e",
      },
      context: { codebase_excerpts: [], memory_excerpts: [] },
    }));

    const cap = 3;
    const first = sampleWithinCap(requests, cap);
    const second = sampleWithinCap(requests, cap);

    expect(first).toEqual(second); // deterministic replay
    expect(first.length).toBe(cap);
    const coveredTypes = new Set(first.map((r) => r.claim.claim_type));
    expect(coveredTypes).toEqual(new Set(["fr_traceability", "architecture", "performance"]));
  });

  it("a host-skipped judge (response.error set) maps to INCONCLUSIVE without failing the run", () => {
    // Small under-cap scenario so Phase A dispatches immediately.
    const state = selfCheckState(2, false);
    const dispatched = dispatchAction(state);
    expect(dispatched.action.kind).toBe("spawn_subagents");
    if (dispatched.action.kind !== "spawn_subagents") throw new Error("unreachable");

    // Every judge was skipped by the host (e.g. budget/quota exhaustion) —
    // no raw_text, only `error`.
    const batchResult: ActionResult = {
      kind: "subagent_batch_result",
      batch_id: dispatched.action.batch_id,
      responses: dispatched.action.invocations.map((inv) => ({
        invocation_id: inv.invocation_id,
        error: "host skipped this judge invocation",
      })),
    };

    const out = dispatchAction(dispatched.state, batchResult);

    expect(out.action.kind).not.toBe("failed");
    const verification = out.state.pending_completion?.verification;
    expect(verification).toBeDefined();
    expect(verification!.claims_evaluated).toBe(2); // 2 FR claims, 1 judge each
    expect(verification!.distribution.INCONCLUSIVE).toBe(2);
    expect(verification!.distribution.FAIL).toBe(0);
  });
});
