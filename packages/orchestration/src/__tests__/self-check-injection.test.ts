import { describe, expect, it } from "vitest";
import { newPipelineState, type PipelineState } from "../index.js";
import { resolveRemember } from "./helpers/resolve-completion.js";
import { stepOnce } from "./helpers/step-once.js";

describe("VerificationPlanSnapshot positional invariant", () => {
  it("rejects mismatched claim_ids/judges lengths via Zod refinement", async () => {
    // Cross-audit closure (dijkstra H1, 2026-04). The snapshot's positional
    // invariant — claim_ids[i] correlates with judges[i] — is load-bearing
    // in the Phase B fallback path. Zod refinement enforces it at parse time
    // so a buggy producer cannot construct an inconsistent snapshot and
    // silently break attribution.
    const { VerificationPlanSnapshotSchema } = await import("../types/state.js");

    const ok = VerificationPlanSnapshotSchema.safeParse({
      batch_id: "b",
      claim_ids: ["C-1", "C-2"],
      judges: [
        { kind: "genius", name: "fermi" },
        { kind: "genius", name: "carnot" },
      ],
    });
    expect(ok.success).toBe(true);

    const tooFewJudges = VerificationPlanSnapshotSchema.safeParse({
      batch_id: "b",
      claim_ids: ["C-1", "C-2"],
      judges: [{ kind: "genius", name: "fermi" }],
    });
    expect(tooFewJudges.success).toBe(false);

    const tooManyJudges = VerificationPlanSnapshotSchema.safeParse({
      batch_id: "b",
      claim_ids: ["C-1"],
      judges: [
        { kind: "genius", name: "fermi" },
        { kind: "genius", name: "carnot" },
      ],
    });
    expect(tooManyJudges.success).toBe(false);
  });
});

describe("self_check Phase A", () => {
  it("emits spawn_subagents when content has extractable claims", () => {
    // Cross-audit closure (popper C1, test-engineer C2, 2026-04). Asserts
    // the Phase A action directly, not via the done summary.
    const baseState = newPipelineState({
      run_id: "inj_phase_a_direct",
      feature_description: "build a feature for OAuth login",
    });
    const stateAtSelfCheck: PipelineState = {
      ...baseState,
      current_step: "self_check",
      prd_context: "feature",
      proceed_signal: true,
      sections: [
        {
          section_type: "requirements",
          status: "passed",
          attempt: 1,
          violation_count: 0,
          last_violations: [],
          content:
            "## Requirements\n\n- FR-001: The system shall support OAuth login.",
        },
      ],
    };

    const out = stepOnce(stateAtSelfCheck);
    expect(out.action.kind).toBe("spawn_subagents");
    if (out.action.kind !== "spawn_subagents") return;
    expect(out.action.purpose).toBe("judge");
    expect(out.action.invocations.length).toBeGreaterThan(0);
    expect(out.state.verification_plan).not.toBeNull();
    if (out.state.verification_plan) {
      expect(out.state.verification_plan.claim_ids.length).toBe(
        out.state.verification_plan.judges.length,
      );
      expect(out.state.verification_plan.batch_id).toBe(out.action.batch_id);
    }

    // Cross-audit closure (popper H-1, Phase 3+4 follow-up, 2026-04).
    // Pin the EXACT distinct claim count for this fixture. A single FR-001
    // line produces one claim; a mutation that doubles claim extraction
    // (e.g., counting the same FR twice, or extracting a phantom claim
    // from the heading) survives `length > 0` but fails this assertion.
    const distinctClaims = new Set(
      out.state.verification_plan!.claim_ids,
    );
    expect(distinctClaims.size).toBe(1);
    // The single claim's id must reference FR-001 (the canonical extractor
    // output for an FR line). A mutation that drops the id format or
    // synthesizes a different id surfaces here.
    expect(Array.from(distinctClaims)[0]).toContain("FR-001");
  });
});

describe("self_check Phase B graceful degradation", () => {
  it("malformed JSON produces INCONCLUSIVE verdicts; run still reaches done", () => {
    // Exercises the catch branch in parseVerdicts (self-check.ts).
    const baseState = newPipelineState({
      run_id: "inj_malformed_judge",
      feature_description: "build a feature for OAuth login",
    });
    const stateAtSelfCheck: PipelineState = {
      ...baseState,
      current_step: "self_check",
      prd_context: "feature",
      proceed_signal: true,
      sections: [
        {
          section_type: "requirements",
          status: "passed",
          attempt: 1,
          violation_count: 0,
          last_violations: [],
          content:
            "## Requirements\n\n- FR-001: The system shall support OAuth login.",
        },
      ],
    };

    const phaseA = stepOnce(stateAtSelfCheck);
    expect(phaseA.action.kind).toBe("spawn_subagents");
    if (phaseA.action.kind !== "spawn_subagents") return;

    const malformedResponses = phaseA.action.invocations.map((inv) => ({
      invocation_id: inv.invocation_id,
      raw_text: "this is not json { broken",
    }));
    const phaseBRaw = stepOnce(phaseA.state, {
      kind: "subagent_batch_result",
      batch_id: phaseA.action.batch_id,
      responses: malformedResponses,
    });
    const phaseB = resolveRemember(phaseBRaw);
    expect(phaseB.action.kind).toBe("done");
    if (phaseB.action.kind !== "done") return;
    // Cross-audit closure (test-engineer C1, popper M-2, 2026-04). The
    // previous test asserted only `kind === "done"`. A regression that
    // returned [] from parseVerdicts would silently survive — claims_evaluated
    // would be 0 and the gate would never fire. Pin the count + INCONCLUSIVE
    // distribution so that survival path is blocked.
    //
    // claims_evaluated counts unique CLAIMS (one ConsensusVerdict per claim),
    // not judge invocations. The snapshot's distinct claim_ids set is the
    // authoritative count. The FR-001 fixture produces exactly 1 claim;
    // multiple judges form the panel for that single claim.
    expect(phaseB.action.verification).toBeDefined();
    if (!phaseB.action.verification) return;
    const snapshot = phaseA.state.verification_plan;
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;
    const distinctClaimCount = new Set(snapshot.claim_ids).size;
    expect(distinctClaimCount).toBeGreaterThan(0);
    expect(phaseB.action.verification.claims_evaluated).toBe(distinctClaimCount);
    expect(phaseB.action.verification.distribution.INCONCLUSIVE).toBe(
      distinctClaimCount,
    );
  });

  it("error-only response produces INCONCLUSIVE verdicts; run still reaches done", () => {
    const baseState = newPipelineState({
      run_id: "inj_judge_error_response",
      feature_description: "build a feature for OAuth login",
    });
    const stateAtSelfCheck: PipelineState = {
      ...baseState,
      current_step: "self_check",
      prd_context: "feature",
      proceed_signal: true,
      sections: [
        {
          section_type: "requirements",
          status: "passed",
          attempt: 1,
          violation_count: 0,
          last_violations: [],
          content:
            "## Requirements\n\n- FR-001: The system shall support OAuth login.",
        },
      ],
    };

    const phaseA = stepOnce(stateAtSelfCheck);
    expect(phaseA.action.kind).toBe("spawn_subagents");
    if (phaseA.action.kind !== "spawn_subagents") return;

    const errorResponses = phaseA.action.invocations.map((inv) => ({
      invocation_id: inv.invocation_id,
      error: "agent timed out",
    }));
    const phaseBRaw = stepOnce(phaseA.state, {
      kind: "subagent_batch_result",
      batch_id: phaseA.action.batch_id,
      responses: errorResponses,
    });
    const phaseB = resolveRemember(phaseBRaw);
    expect(phaseB.action.kind).toBe("done");
    if (phaseB.action.kind !== "done") return;
    // Same mutation guard as the malformed-JSON test above (CRIT-6).
    expect(phaseB.action.verification).toBeDefined();
    if (!phaseB.action.verification) return;
    const snapshot = phaseA.state.verification_plan;
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;
    const distinctClaimCount = new Set(snapshot.claim_ids).size;
    expect(distinctClaimCount).toBeGreaterThan(0);
    expect(phaseB.action.verification.claims_evaluated).toBe(distinctClaimCount);
    expect(phaseB.action.verification.distribution.INCONCLUSIVE).toBe(
      distinctClaimCount,
    );
  });

  it("Phase B mismatch (content_mutation) records caveat correctly", () => {
    // Cross-audit closure (test-engineer C2, dijkstra H1, Phase 3+4, 2026-04).
    const baseState = newPipelineState({
      run_id: "inj_phase_b_mismatch",
      feature_description: "build a feature for OAuth login",
    });
    const stateWithStaleSnapshot: PipelineState = {
      ...baseState,
      current_step: "self_check",
      prd_context: "feature",
      proceed_signal: true,
      sections: [
        {
          section_type: "requirements",
          status: "passed",
          attempt: 1,
          violation_count: 0,
          last_violations: [],
          content:
            "## Requirements\n\n- FR-042: Completely different requirement.",
        },
      ],
      verification_plan: {
        batch_id: "self_check_verify",
        claim_ids: ["FR-001-stale", "FR-002-stale"],
        judges: [
          { kind: "genius", name: "fermi" },
          { kind: "genius", name: "carnot" },
        ],
      },
    };

    const phaseBRaw = stepOnce(stateWithStaleSnapshot, {
      kind: "subagent_batch_result",
      batch_id: "self_check_verify",
      responses: [
        {
          invocation_id: "self_check_judge_0000",
          raw_text: JSON.stringify({
            verdict: "PASS",
            rationale: "x",
            caveats: [],
            confidence: 0.9,
          }),
        },
        {
          invocation_id: "self_check_judge_0001",
          raw_text: JSON.stringify({
            verdict: "PASS",
            rationale: "x",
            caveats: [],
            confidence: 0.9,
          }),
        },
      ],
    });
    const phaseB = resolveRemember(phaseBRaw);

    expect(phaseB.action.kind).toBe("done");
    if (phaseB.action.kind !== "done") return;
    expect(phaseB.action.verification).toBeDefined();
    if (!phaseB.action.verification) return;
    expect(phaseB.action.verification.claims_evaluated).toBe(2);
    expect(phaseB.action.verification.distribution.INCONCLUSIVE).toBe(2);

    // Cross-audit closure (MED-19, Phase 3+4 follow-up, 2026-04). The
    // mismatchKind classifier ("content_mutation" vs "ordering_regression")
    // must be observable in state.errors. A mutation that swapped the two
    // classifications survived the previous test because the assertion only
    // covered the INCONCLUSIVE distribution. Pin the kind explicitly.
    const mismatchErrors = phaseB.state.errors.filter((e) =>
      e.includes("mismatch_kind:"),
    );
    expect(mismatchErrors.length).toBeGreaterThan(0);
    expect(mismatchErrors.some((e) => e.includes("content_mutation"))).toBe(
      true,
    );
    expect(mismatchErrors.some((e) => e.includes("ordering_regression"))).toBe(
      false,
    );
    // The error_kinds parallel array must remain in lockstep (HIGH-17 / CRIT-5).
    expect(phaseB.state.errors.length).toBe(phaseB.state.error_kinds.length);
  });
});
