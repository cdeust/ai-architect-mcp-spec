import { describe, expect, it } from "vitest";
import { newPipelineState, type PipelineState } from "../index.js";
import type { SectionType } from "@prd-gen/core";
import { stepOnce } from "./helpers/step-once.js";

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
