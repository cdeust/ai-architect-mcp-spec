import { expect, it } from "vitest";
import { ARCHITECT_OS_BOUNDARY, isLegacyExecutionCheckpoint, newPipelineState, step, type NextAction } from "../index.js";
import { isRetiredImplementationAnswer, recordLegacyDefineRefusal, specVerificationQuestion } from "../architect-os-boundary.js";
import { initialPostSpecs, PostSpecsStateSchema } from "../types/state/post-specs-state.js";

const run = newPipelineState({ run_id: "run_boundary", feature_description: "Change a feature" });
const gate = { ...run, current_step: "implementation_gate" as const };
const path = "prd-output/run_boundary/10-verification-report.md";

it.each([
  "pre_impl_grounding", "implementation", "post_impl_verification", "testing", "review", "pr_gate", "pr_creation",
] as const)("does not dispatch legacy step %s even with a late result", current_step => {
  const state = { ...run, current_step };
  for (const result of [undefined, { kind: "file_written" as const, path }]) {
    expect(step({ state, result })).toEqual({
      state, messages: [],
      action: { kind: "failed", reason: ARCHITECT_OS_BOUNDARY.message, step: current_step },
    });
  }
});

it.each(["Implement", "Implement anyway (de\u0301rogation explicite)", "Override policy (explicit)"])(
  "refuses %s in selected and freeform without an automatic fallback",
  label => {
    const state = { ...gate, unmatched_answers: { implementation_gate: 2 } };
    for (const answer of [
      { selected: [label] }, { selected: [], freeform: label },
      { selected: [label, "PRD only"] }, { selected: ["PRD only"], freeform: label },
    ]) {
      const result = { kind: "user_answer" as const, question_id: "implementation_gate", ...answer };
      const out = step({ state, result });
      expect(out.state).toBe(state);
      expect(out.action).toEqual({ kind: "failed", reason: ARCHITECT_OS_BOUNDARY.message, step: "implementation_gate" });
    }
  },
);

it("cannot resume a legacy approval from an outstanding report write", () => {
  const state = { ...gate, post_specs: { ...initialPostSpecs(), decision: "implement" as const } };
  const out = step({ state, result: { kind: "file_written", path } });
  expect(out.state).toBe(state);
  expect(out.action).toMatchObject({ kind: "failed", reason: ARCHITECT_OS_BOUNDARY.message });
});

it("shows verification findings without consuming the decision", () => {
  const out = step({ state: gate, result: {
    kind: "user_answer", question_id: "implementation_gate", selected: ["Review verification findings"],
  } });
  expect(out.state.current_step).toBe("implementation_gate");
  expect(out.state.post_specs?.decision).toBe("pending");
  expect(out.action).toMatchObject({
    kind: "ask_user", header: "Specification verification", question_id: "implementation_gate", multi_select: false,
    description: expect.stringContaining("Architect-os owns implementation."),
    options: [
      { label: "PRD only", description: "Finish this specification run." },
      { label: "Review verification findings", description: "Keep the specification checkpoint pending." },
    ],
  });
});

it("recognizes all previously persisted execution actions independent of a stale stage", () => {
  const reported = { batch_id: "legacy", invocations: [] };
  for (const action of [
    { kind: "ask_user", question_id: "pr_gate", header: "", description: "", options: null, multi_select: false },
    { kind: "spawn_subagents", purpose: "implement", ...reported },
    { kind: "spawn_subagents", purpose: "test", ...reported },
    { kind: "spawn_subagents", purpose: "pr", ...reported },
    { kind: "spawn_subagents", purpose: "review", ...reported, batch_id: "review_code_reviewer_1" },
    ...["pre_impl_grounding_impact_0", "post_impl_verification_index_codebase",
      "post_impl_verification_detect_changes", "post_impl_verification_verify_semantic_diff",
      "post_impl_verification_check_security_gates"].map(correlation_id => ({
      kind: "call_pipeline_tool" as const, tool_name: "get_impact", arguments: {}, correlation_id,
    })),
  ] satisfies NextAction[]) {
    expect(isLegacyExecutionCheckpoint(run, action)).toBe(true);
  }
  expect(isLegacyExecutionCheckpoint(run, { kind: "spawn_subagents", purpose: "review",
    ...reported, batch_id: "input_analysis_git_history" })).toBe(false);
  expect(isLegacyExecutionCheckpoint(run, { kind: "spawn_subagents", purpose: "draft",
    ...reported, batch_id: "review_code_reviewer_1" })).toBe(false);
  expect(isLegacyExecutionCheckpoint(run, { kind: "ask_user", question_id: "clarification",
    header: "Clarify", description: "Question", multi_select: false, options: null })).toBe(false);
  expect(isLegacyExecutionCheckpoint(run, { kind: "call_pipeline_tool", tool_name: "index_codebase",
    arguments: {}, correlation_id: "plan_grounding" })).toBe(false);
  expect(isLegacyExecutionCheckpoint(run, null)).toBe(false);
});


it("an old decision on a terminal checkpoint remains readable", () => {
  expect(isLegacyExecutionCheckpoint({ ...run, current_step: "complete",
    post_specs: { ...initialPostSpecs(), decision: "implement" } }, null)).toBe(false);
});

it("does not mistake unrelated or malformed answers for an execution request", () => {
  const result = { kind: "user_answer" as const, question_id: "implementation_gate", selected: ["Implement"] };
  expect(isRetiredImplementationAnswer(run, result)).toBe(false);
  expect(isRetiredImplementationAnswer(gate, { ...result, question_id: "other" })).toBe(false);
  const lateReport = { ...result, kind: "file_written" as const, path, bytes: 0 };
  expect(isRetiredImplementationAnswer(gate, lateReport)).toBe(false);
  expect(isRetiredImplementationAnswer(gate, { ...result, selected: null as unknown as string[] })).toBe(false);
});

it("does not record refusal for a gate that already permits the Define handoff", () => {
  expect(recordLegacyDefineRefusal(gate, { kind: "ask_user", question_id: "implementation_gate", header: "Specification verification",
    description: "Choose", multi_select: false,
    options: [{ label: "PRD only" }, { label: "Review verification findings" }],
  })).toBe(gate);
});

it("keeps historical handoff refusal through a serialized post-specs state", () => {
  const refused = { kind: "ask_user" as const, question_id: "implementation_gate", header: "Historical gate",
    description: "Override was required", multi_select: false,
    options: [{ label: "PRD only" }, { label: "Override policy (explicit)" }],
  };
  const prior = { ...initialPostSpecs(), retry_count: 2 };
  expect(recordLegacyDefineRefusal(run, refused)).toBe(run);
  for (const post_specs of [null, prior]) {
    const state = { ...gate, post_specs };
    const recorded = recordLegacyDefineRefusal(state, refused);
    expect(recorded).toEqual({ ...state, post_specs: { ...(post_specs ?? initialPostSpecs()), legacy_define_refusal: true } });
    expect(PostSpecsStateSchema.parse(recorded.post_specs)).toEqual(recorded.post_specs);
  }
});

it("keeps separate verification reasons readable", () => {
  const question = specVerificationQuestion({
    status: "blocked", reasons: ["Missing evidence.", "Failed check."], blocking_claims: [], disagreements: [], unsampled_ratio: 0,
  });
  expect(question.description).toBe(
    "Missing evidence. Failed check. Read a validated Define v1 handoff to continue planning. Architect-os owns implementation.",
  );
});
