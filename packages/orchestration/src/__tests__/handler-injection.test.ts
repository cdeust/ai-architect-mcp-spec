/**
 * Per-handler injection tests.
 *
 * The smoke harness (`smoke.test.ts`) drives the reducer end-to-end through
 * `runSmoke`. Those tests prove the FULL run works. The tests in this file
 * inject a state directly at a chosen `current_step` and call `stepOnce`,
 * proving each handler's branch behaviour in isolation.
 *
 * Why split: smoke.test.ts grew past 500 lines (§4.1 cap) because it carried
 * both surfaces. This file owns the single-step injections so the harness
 * file can stay focused on full-run integration. Cross-audit code-reviewer
 * M1 (Phase 3+4, 2026-04).
 *
 * Coverage map (one-step injections only — full-run tests are in smoke.test.ts):
 *   handleJiraGeneration  — skip when no source content
 *   handleInputAnalysis   — failed result · missing graph_path
 *   handleSelfCheck       — Phase A direct dispatch · Phase B mismatch ·
 *                           malformed JSON · error response
 *   handleFileExport      — wrong result kind protocol violation
 *   handleSectionGeneration — retry on validation failure
 *   handleContextDetection— invalid user choice
 *   VerificationPlanSnapshot Zod refinement (positional invariant)
 */

import { describe, expect, it } from "vitest";
import {
  newPipelineState,
  step,
  type ActionResult,
  type PipelineState,
} from "../index.js";
import type { SectionType } from "@prd-gen/core";
import { resolveRemember } from "./helpers/resolve-completion.js";

function stepOnce(state: PipelineState, result?: ActionResult) {
  return step({ state, result });
}

describe("jira_generation", () => {
  it("is skipped when no source sections have content", () => {
    // Postcondition: handleJiraGeneration emits emit_message("No source sections")
    // and advances to file_export when requirements/user_stories/acceptance_criteria
    // are all absent. Exercised by driving the state machine with all sections
    // in 'failed' status so no content field is set.
    const baseState = newPipelineState({
      run_id: "inj_jira_skip",
      feature_description: "build a feature for OAuth login",
    });
    const noContentState: PipelineState = {
      ...baseState,
      current_step: "jira_generation",
      prd_context: "feature",
      proceed_signal: true,
      sections: [
        {
          section_type: "requirements",
          status: "failed",
          attempt: 3,
          violation_count: 1,
          last_violations: ["too short"],
          // No content field → gatherSourceSections filters it out
        },
      ],
    };

    const out = stepOnce(noContentState);
    expect(out.action.kind).not.toBe("spawn_subagents");
    expect(out.state.current_step).not.toBe("jira_generation");
  });
});

describe("input_analysis", () => {
  it("emits failed when analyze_codebase returns success:false", () => {
    const baseState = newPipelineState({
      run_id: "inj_index_failure",
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/inj",
    });
    const awaitingResult: PipelineState = {
      ...baseState,
      current_step: "input_analysis",
      // Phase 1a global recall already resolved — position the state past
      // it so this injection targets the codebase-analysis branch only.
      global_recall_done: true,
      codebase_output_dir: "/tmp/inj/.prd-gen/graphs/inj_index_failure",
    };
    const failedToolResult: ActionResult = {
      kind: "tool_result",
      correlation_id: "input_analysis_index",
      success: false,
      error: "disk quota exceeded",
    };

    const out = stepOnce(awaitingResult, failedToolResult);
    expect(out.action.kind).toBe("failed");
    if (out.action.kind === "failed") {
      expect(out.action.reason).toContain("disk quota exceeded");
      expect(out.action.step).toBe("input_analysis");
    }
  });

  it("emits failed when analyze_codebase returns no graph_path", () => {
    const baseState = newPipelineState({
      run_id: "inj_no_graph_path",
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/inj",
    });
    const awaitingResult: PipelineState = {
      ...baseState,
      current_step: "input_analysis",
      global_recall_done: true,
      codebase_output_dir: "/tmp/inj/.prd-gen/graphs/inj_no_graph_path",
    };
    const missingGraphPath: ActionResult = {
      kind: "tool_result",
      correlation_id: "input_analysis_index",
      success: true,
      data: {},
    };

    const out = stepOnce(awaitingResult, missingGraphPath);
    expect(out.action.kind).toBe("failed");
    if (out.action.kind === "failed") {
      expect(out.action.reason).toContain("graph_path");
    }
  });
});

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

describe("file_export protocol violation", () => {
  it("logs error and re-issues write when host sends wrong result kind", () => {
    const baseState = newPipelineState({
      run_id: "inj_file_export_wrong_result",
      feature_description: "build a feature for OAuth login",
    });
    const exportState: PipelineState = {
      ...baseState,
      current_step: "file_export",
      prd_context: "feature",
      proceed_signal: true,
      sections: [],
      written_files: [],
    };
    const wrongKindResult: ActionResult = {
      kind: "tool_result",
      correlation_id: "irrelevant",
      success: true,
      data: {},
    };

    const out = stepOnce(exportState, wrongKindResult);
    expect(out.action.kind).toBe("write_file");
    expect(out.state.errors.length).toBeGreaterThan(0);
    expect(out.state.errors[0]).toContain("unexpected result kind");
  });
});

describe("strategy wiring (Phase 4 closure)", () => {
  // Cross-audit closure: the strategy package was previously dead code.
  // Phase 4 wires `selectStrategy` per section, persists the assignment
  // into SectionStatus, threads it into buildSectionPrompt, and emits an
  // ExecutionResult into state.strategy_executions on terminal transitions.

  it("pending → retrieving materializes a strategy_assignment on the section", () => {
    const seed = newPipelineState({
      run_id: "wire_strategy_select",
      feature_description: "build a feature for OAuth login",
    });
    const stateAtSection: PipelineState = {
      ...seed,
      current_step: "section_generation",
      prd_context: "feature",
      proceed_signal: true,
      sections: [
        {
          section_type: "requirements",
          status: "pending",
          attempt: 0,
          violation_count: 0,
          last_violations: [],
        },
      ],
    };

    const out = stepOnce(stateAtSection);
    const reqs = out.state.sections.find(
      (s) => s.section_type === "requirements",
    );
    expect(reqs).toBeDefined();
    if (!reqs) return;
    expect(reqs.status).toBe("retrieving");
    expect(reqs.strategy_assignment).toBeDefined();
    if (!reqs.strategy_assignment) return;
    // Trial tier must produce at least one required strategy.
    expect(reqs.strategy_assignment.required.length).toBeGreaterThan(0);
    // Claim analysis was actually populated, not stubbed.
    expect(reqs.strategy_assignment.claimAnalysis.characteristics.length).toBeGreaterThan(0);
  });

  it("retry preserves the strategy_assignment from the first attempt (not re-selected)", () => {
    // Strategy must be chosen ONCE per section. Re-selecting on every
    // attempt would cause non-deterministic prompts and break the closed
    // feedback loop's per-claim attribution.
    const seed = newPipelineState({
      run_id: "wire_strategy_persists",
      feature_description: "build a feature for OAuth login",
    });
    const stateAtSection: PipelineState = {
      ...seed,
      current_step: "section_generation",
      prd_context: "feature",
      proceed_signal: true,
      sections: [
        {
          section_type: "requirements",
          status: "pending",
          attempt: 0,
          violation_count: 0,
          last_violations: [],
        },
      ],
    };

    const after1 = stepOnce(stateAtSection);
    const reqs1 = after1.state.sections.find(
      (s) => s.section_type === "requirements",
    );
    if (!reqs1?.strategy_assignment) return;
    const original = reqs1.strategy_assignment;

    // Step again. The handler should NOT touch the assignment on subsequent
    // transitions — only the pending → retrieving transition selects.
    const after2 = stepOnce(after1.state, {
      kind: "tool_result",
      correlation_id: "section_retrieve_requirements",
      success: true,
      data: { results: [], total: 0 },
    });
    const reqs2 = after2.state.sections.find(
      (s) => s.section_type === "requirements",
    );
    expect(reqs2?.strategy_assignment).toEqual(original);
  });

  it("section pass enqueues ONE ExecutionResult per required strategy", async () => {
    // Cross-audit closure (feynman CRIT-2, Phase 4 follow-up, 2026-04).
    // The prompt instructs the engineer to apply ALL required strategies.
    // Recording only required[0] would systematically over-weight the
    // first strategy and leave required[1..n] invisible to the feedback
    // loop. This test pins the per-strategy attribution.
    const { buildSectionPrompt } = await import("@prd-gen/meta-prompting");

    const seed = newPipelineState({
      run_id: "wire_strategy_exec_pass",
      feature_description: "build a feature for OAuth login",
    });
    const stateAtValidation: PipelineState = {
      ...seed,
      current_step: "section_generation",
      prd_context: "feature",
      proceed_signal: true,
      sections: [
        {
          section_type: "requirements",
          status: "generating",
          attempt: 1,
          violation_count: 0,
          last_violations: [],
          strategy_assignment: {
            required: ["chain_of_thought", "verified_reasoning"],
            optional: [],
            forbidden: [],
            expectedImprovement: 0.2,
            assignmentConfidence: 0.7,
            claimAnalysis: {
              claim: "test",
              characteristics: ["multi_step_logic"],
              complexityScore: 0.4,
              complexityTier: "moderate",
              analysisNotes: [],
            },
            researchCitations: ["arXiv:test"],
          },
        },
      ],
    };

    const draft =
      "## Requirements\n\n" +
      "| ID | Requirement | Priority | Source |\n" +
      "|----|-------------|----------|--------|\n" +
      "| FR-001 | OAuth login | P0 | user request |\n";

    const out = stepOnce(stateAtValidation, {
      kind: "subagent_batch_result",
      batch_id: "section_generate_requirements",
      responses: [
        { invocation_id: "section_generate_requirements", raw_text: draft },
      ],
    });

    // Hard postcondition: TWO executions enqueued (one per required strategy),
    // not a silent skip.
    expect(out.state.strategy_executions.length).toBe(2);
    const cot = out.state.strategy_executions.find(
      (e) => e.strategy === "chain_of_thought",
    );
    const vr = out.state.strategy_executions.find(
      (e) => e.strategy === "verified_reasoning",
    );
    expect(cot).toBeDefined();
    expect(vr).toBeDefined();
    if (!cot || !vr) return;
    // Pass on first attempt → full credit (HIGH-1: decoupled from retry count).
    expect(cot.wasCompliant).toBe(true);
    expect(cot.retryCount).toBe(0);
    expect(cot.actualConfidenceGain).toBeCloseTo(0.2, 5);
    expect(cot.prdContext).toBe("feature");
    expect(vr.actualConfidenceGain).toBeCloseTo(0.2, 5);

    // The strategies block in the prompt mentions both required strategies.
    const prompt = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "x",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
      strategy_assignment: stateAtValidation.sections[0].strategy_assignment,
    });
    expect(prompt).toContain("<strategies>");
    expect(prompt).toContain("chain_of_thought");
    expect(prompt).toContain("verified_reasoning");
  });

  it("section fail enqueues ExecutionResults with wasCompliant=false and gain=0", () => {
    // Cross-audit closure (test-engineer C, Phase 4 follow-up, 2026-04).
    // failSection must enqueue a result attributing the failure to the
    // strategy. Pre-fix: actualConfidenceGain was expectedImprovement *
    // (1/attempts) on success; HIGH-1 fix: gain is 0 on fail, full on pass.
    const seed = newPipelineState({
      run_id: "wire_strategy_exec_fail",
      feature_description: "build a feature for OAuth login",
    });
    const stateAtFinalAttempt: PipelineState = {
      ...seed,
      current_step: "section_generation",
      prd_context: "feature",
      proceed_signal: true,
      sections: [
        {
          section_type: "requirements",
          status: "generating",
          attempt: 3, // MAX_ATTEMPTS — next failure is terminal
          violation_count: 1,
          last_violations: ["[fr_numbering_gaps] FR-099 missing predecessors"],
          strategy_assignment: {
            required: ["chain_of_thought"],
            optional: [],
            forbidden: [],
            expectedImprovement: 0.25,
            assignmentConfidence: 0.7,
            claimAnalysis: {
              claim: "test",
              characteristics: ["multi_step_logic"],
              complexityScore: 0.4,
              complexityTier: "moderate",
              analysisNotes: [],
            },
            researchCitations: [],
          },
        },
      ],
    };

    // Draft that will FAIL validation (FR-numbering gap).
    const failingDraft =
      "## Requirements\n\n" +
      "| ID | Requirement | Priority | Source |\n" +
      "|----|-------------|----------|--------|\n" +
      "| FR-001 | login | P0 | u |\n" +
      "| FR-099 | reset | P1 | u |\n";

    const out = stepOnce(stateAtFinalAttempt, {
      kind: "subagent_batch_result",
      batch_id: "section_generate_requirements",
      responses: [
        { invocation_id: "section_generate_requirements", raw_text: failingDraft },
      ],
    });

    // The section is now in terminal `failed` status.
    const reqs = out.state.sections.find((s) => s.section_type === "requirements");
    expect(reqs?.status).toBe("failed");

    // ExecutionResult enqueued with wasCompliant=false, gain=0, retry=2.
    expect(out.state.strategy_executions.length).toBe(1);
    const exec = out.state.strategy_executions[0];
    expect(exec.strategy).toBe("chain_of_thought");
    expect(exec.wasCompliant).toBe(false);
    expect(exec.actualConfidenceGain).toBe(0);
    expect(exec.retryCount).toBe(2); // attempts=3 → retry=2
  });

  it("section-type differentiation: requirements vs technical_specification produce distinct claim characteristics", () => {
    // Cross-audit closure (test-engineer A, Phase 4 follow-up, 2026-04).
    // chooseStrategyForSection must shape the claim by section_type.
    // A mutation that returns the same assignment for every section_type
    // would survive the simpler "presence" assertions; this pins divergence.
    function pendingStateFor(section_type: SectionType): PipelineState {
      const seed = newPipelineState({
        run_id: `wire_diff_${section_type}`,
        feature_description: "build a feature for OAuth login",
      });
      return {
        ...seed,
        current_step: "section_generation",
        prd_context: "feature",
        proceed_signal: true,
        sections: [
          {
            section_type,
            status: "pending",
            attempt: 0,
            violation_count: 0,
            last_violations: [],
          },
        ],
      };
    }

    const reqOut = stepOnce(pendingStateFor("requirements"));
    const techOut = stepOnce(pendingStateFor("technical_specification"));
    const reqAssignment =
      reqOut.state.sections[0].strategy_assignment;
    const techAssignment =
      techOut.state.sections[0].strategy_assignment;
    expect(reqAssignment).toBeDefined();
    expect(techAssignment).toBeDefined();
    if (!reqAssignment || !techAssignment) return;
    // Assignments must differ in either characteristics or required strategies.
    const reqChars = JSON.stringify([...reqAssignment.claimAnalysis.characteristics].sort());
    const techChars = JSON.stringify([...techAssignment.claimAnalysis.characteristics].sort());
    const reqReq = JSON.stringify([...reqAssignment.required].sort());
    const techReq = JSON.stringify([...techAssignment.required].sort());
    expect(reqChars !== techChars || reqReq !== techReq).toBe(true);
  });

  it("PipelineStateSchema round-trips a state with strategy_assignment + strategy_executions", async () => {
    // Cross-audit closure (test-engineer K, Phase 4 follow-up, 2026-04).
    // The Zod schemas (StrategyAssignmentSchema, ExecutionResultSchema)
    // must accept a real-world populated state without losing fields.
    const { PipelineStateSchema } = await import("../types/state.js");

    const seed = newPipelineState({
      run_id: "wire_round_trip",
      feature_description: "build a feature for OAuth login",
    });
    const out = stepOnce({
      ...seed,
      current_step: "section_generation",
      prd_context: "feature",
      proceed_signal: true,
      sections: [
        {
          section_type: "requirements",
          status: "pending",
          attempt: 0,
          violation_count: 0,
          last_violations: [],
        },
      ],
    });

    // Both populated fields are present after pending → retrieving.
    expect(out.state.sections[0].strategy_assignment).toBeDefined();
    // Round-trip: parse → string → parse must succeed.
    const parsed = PipelineStateSchema.safeParse(out.state);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // Field-level fidelity: the parsed assignment matches the stored one.
    const stored = out.state.sections[0].strategy_assignment;
    const reparsed = parsed.data.sections[0].strategy_assignment;
    expect(reparsed).toEqual(stored);
  });
});

describe("section_generation retry", () => {
  it("retries on validation failure and increments attempt", () => {
    // Postcondition: when validateSection returns violations on the draft,
    // the handler increments `attempt` and re-spawns the engineer with the
    // violations passed in as `prior_violations`. We exercise the retry
    // once (attempt 1 → 2), not the full MAX_ATTEMPTS loop.
    const seed = newPipelineState({
      run_id: "inj_section_retry",
      feature_description: "build a feature for OAuth login",
    });
    const stateMidSection: PipelineState = {
      ...seed,
      current_step: "section_generation",
      prd_context: "feature",
      proceed_signal: true,
      sections: [
        {
          section_type: "requirements",
          status: "generating",
          attempt: 1,
          violation_count: 0,
          last_violations: [],
        },
      ],
    };

    // Feed a draft that triggers fr_numbering_gaps: FR-001 then jumps to FR-099.
    const draftWithGap =
      "## Requirements\n\n" +
      "| ID | Requirement | Priority | Source |\n" +
      "|----|-------------|----------|--------|\n" +
      "| FR-001 | OAuth login | P0 | user request |\n" +
      "| FR-099 | password reset | P1 | clarification round 1 |\n";

    const out = stepOnce(stateMidSection, {
      kind: "subagent_batch_result",
      batch_id: "section_generate_requirements",
      responses: [
        {
          invocation_id: "section_generate_requirements",
          raw_text: draftWithGap,
        },
      ],
    });

    const section = out.state.sections.find(
      (s) => s.section_type === "requirements",
    );
    expect(section).toBeDefined();
    if (!section) return;
    expect(section.status).toBe("generating");
    expect(section.attempt).toBeGreaterThan(1);
    expect(section.last_violations.length).toBeGreaterThan(0);
    expect(section.last_violations.join(" ")).toContain("fr_numbering_gaps");
    expect(out.action.kind).toBe("spawn_subagents");
  });
});

describe("banner", () => {
  // Cross-audit closure (test-engineer H3, Phase 3+4 follow-up, 2026-04).
  // Pre-fix the handler had zero direct tests; only smoke runs exercised it
  // and they asserted nothing about the emitted message.

  it("emits the banner and advances to preflight", () => {
    const seed = newPipelineState({
      run_id: "inj_banner_run",
      feature_description: "x",
    });
    const out = stepOnce({ ...seed, current_step: "banner" });
    expect(out.state.current_step).toBe("preflight");
    const allText = out.messages.map((m) => m.text).join("\n");
    expect(allText).toContain("PRD Spec Generator");
    expect(allText).toContain("inj_banner_run");
  });

  it("includes the run_id and the feature description in the banner", () => {
    const seed = newPipelineState({
      run_id: "inj_banner_meta",
      feature_description: "build OAuth login",
    });
    const out = stepOnce({ ...seed, current_step: "banner" });
    const allText = out.messages.map((m) => m.text).join("\n");
    expect(allText).toContain("inj_banner_meta");
    expect(allText).toContain("build OAuth login");
  });

  it("notes when no codebase path is provided", () => {
    const seed = newPipelineState({
      run_id: "inj_banner_no_codebase",
      feature_description: "x",
    });
    const out = stepOnce({ ...seed, current_step: "banner" });
    const allText = out.messages.map((m) => m.text).join("\n");
    expect(allText).toContain("Codebase: (none provided)");
  });
});

describe("clarification proceed branch", () => {
  // Cross-audit closure (test-engineer H4, Phase 3+4 follow-up, 2026-04).
  // The proceed/continue conditional in clarification.ts:138 was previously
  // exercised only by smoke runs. A mutation swapping "proceed" with
  // "continue" in the match would survive outside smoke. Direct injection
  // pins the branch.

  it("clarification_continue with selected: ['proceed'] sets proceed_signal=true and advances", () => {
    const seed = newPipelineState({
      run_id: "inj_clar_proceed",
      feature_description: "build OAuth login",
    });
    const stateAtClarification: PipelineState = {
      ...seed,
      current_step: "clarification",
      prd_context: "feature",
      // Pretend we already collected enough rounds that the "proceed" prompt
      // is the next action — feed the user_answer directly.
      clarifications: Array.from({ length: 8 }, (_, i) => ({
        round: i + 1,
        question: `q${i + 1}`,
        rationale: "test",
        answer: `a${i + 1}`,
      })),
    };

    const out = stepOnce(stateAtClarification, {
      kind: "user_answer",
      question_id: "clarification_continue",
      selected: ["proceed"],
    });

    // Postcondition: proceed_signal flips to true, state advances away
    // from clarification.
    expect(out.state.proceed_signal).toBe(true);
    expect(out.state.current_step).not.toBe("clarification");
  });
});

it.each(["do not proceed", "yes", "", undefined, "unknown"])(
  "repeats the clarification decision for %s", (freeform) => {
    const state = newPipelineState({ run_id: "retry", feature_description: "x", prd_context: "feature" });
    const out = stepOnce({ ...state, current_step: "clarification" }, {
      kind: "user_answer", question_id: "clarification_continue", selected: [], freeform,
    });
    expect(out.state.proceed_signal).toBe(false);
    expect(out.action).toMatchObject({
      kind: "ask_user", question_id: "clarification_continue",
      options: [{ label: "proceed" }, { label: "continue" }],
      description: expect.stringMatching(/not one of the options.*proceed.*continue/i),
    });
  },
);

describe("context_detection", () => {
  it("repeats the question when the user submits an invalid PRD context", () => {
    const seed = newPipelineState({
      run_id: "inj_invalid_prd_context",
      feature_description: "this description has no trigger words at all",
    });
    const stateAtContextDetection: PipelineState = {
      ...seed,
      current_step: "context_detection",
    };

    const out = stepOnce(stateAtContextDetection, {
      kind: "user_answer",
      question_id: "prd_context",
      selected: ["not_a_real_context_kind"],
    });

    expect(out.action).toMatchObject({ kind: "ask_user", question_id: "prd_context", description: expect.stringContaining("not one of the options") });
  });
});

describe("preflight", () => {
  // source: missing-Cortex bug found 2026-04-26 — silent per-section recall
  // failures should surface as ONE clear startup error, not as degraded
  // generation across every section.

  it("issues a Cortex memory_stats probe as the first preflight action", () => {
    const seed = newPipelineState({
      run_id: "preflight_first_action",
      feature_description: "x",
    });
    const out = stepOnce({ ...seed, current_step: "preflight" });
    expect(out.action.kind).toBe("call_cortex_tool");
    if (out.action.kind === "call_cortex_tool") {
      expect(out.action.tool_name).toBe("memory_stats");
      expect(out.action.correlation_id).toBe("preflight_cortex_probe");
    }
  });

  it("emits a `failed` action with actionable setup advice when Cortex is unreachable", () => {
    const seed = newPipelineState({
      run_id: "preflight_cortex_down",
      feature_description: "x",
    });
    const stateAtPreflight = { ...seed, current_step: "preflight" as const };
    // First step issues the probe.
    const probe = stepOnce(stateAtPreflight);
    expect(probe.action.kind).toBe("call_cortex_tool");
    if (probe.action.kind !== "call_cortex_tool") return;

    // Host returns success: false (MCP not registered).
    const after = stepOnce(probe.state, {
      kind: "tool_result",
      correlation_id: probe.action.correlation_id,
      success: false,
      error: "MCP server cortex not registered",
    });
    expect(after.action.kind).toBe("failed");
    if (after.action.kind === "failed") {
      expect(after.action.step).toBe("preflight");
      expect(after.action.reason).toMatch(/cortex/i);
      // The reason must mention how to fix it — install/marketplace/plugin.
      expect(after.action.reason.toLowerCase()).toMatch(
        /install|marketplace|plugin|skip_preflight/,
      );
    }
  });

  it("when codebase_path is set, probes ai-architect AFTER Cortex passes", () => {
    const seed = newPipelineState({
      run_id: "preflight_with_codebase",
      feature_description: "x",
      codebase_path: "/some/path",
    });
    const stateAtPreflight = { ...seed, current_step: "preflight" as const };
    const probe = stepOnce(stateAtPreflight);
    if (probe.action.kind !== "call_cortex_tool") {
      throw new Error("expected first probe to be call_cortex_tool");
    }
    // Cortex returns success.
    const afterCortex = stepOnce(probe.state, {
      kind: "tool_result",
      correlation_id: probe.action.correlation_id,
      success: true,
      data: {},
    });
    // Next probe must be ai-architect health_check.
    expect(afterCortex.action.kind).toBe("call_pipeline_tool");
    if (afterCortex.action.kind === "call_pipeline_tool") {
      expect(afterCortex.action.tool_name).toBe("health_check");
      expect(afterCortex.action.correlation_id).toBe(
        "preflight_ai_architect_probe",
      );
    }
  });

  it("when codebase_path is NOT set, probes zetetic-team-subagents right after Cortex passes (no ai-architect probe)", () => {
    const seed = newPipelineState({
      run_id: "preflight_no_codebase",
      feature_description: "x",
    });
    const stateAtPreflight = { ...seed, current_step: "preflight" as const };
    const probe = stepOnce(stateAtPreflight);
    if (probe.action.kind !== "call_cortex_tool") {
      throw new Error("expected first probe to be call_cortex_tool");
    }
    const afterCortex = stepOnce(probe.state, {
      kind: "tool_result",
      correlation_id: probe.action.correlation_id,
      success: true,
      data: {},
    });
    // source: #123 — the subagent plugin is probed before preflight passes.
    expect(afterCortex.action.kind).toBe("spawn_subagents");
    expect(afterCortex.state.current_step).toBe("preflight");
    expect(afterCortex.state.preflight_status).not.toBe("ok");
  });

  it("skip_preflight=true short-circuits the preflight step (no probes) and marks status=skipped", () => {
    const seed = newPipelineState({
      run_id: "preflight_skipped",
      feature_description: "x",
      skip_preflight: true,
    });
    const out = stepOnce({ ...seed, current_step: "preflight" });
    expect(out.state.preflight_status).toBe("skipped");
    // current_step has advanced past preflight. Whether the runner stopped
    // at context_detection or coalesced through it depends on subsequent
    // handler behavior — the load-bearing assertion is that no probe was
    // issued and the skipped status was recorded.
    expect(out.action.kind).not.toBe("call_cortex_tool");
    expect(out.action.kind).not.toBe("call_pipeline_tool");
  });
});
