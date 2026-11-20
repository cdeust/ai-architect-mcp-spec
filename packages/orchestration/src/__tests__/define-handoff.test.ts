import { expect, it } from "vitest";
import { initialPostSpecs, newPipelineState, readDefineHandoff, type NextAction, type PipelineState } from "../index.js";

import { evaluateRunPolicy } from "../handlers/verification-policy.js";

const run_id = "run_define_v1";
const pending: NextAction = {
  kind: "ask_user", question_id: "implementation_gate", header: "Proceed?",
  description: "Choose", multi_select: false, options: [{ label: "PRD only" }, { label: "Implement" }],
};

function ready(): PipelineState {
  const sections = [
    ["requirements", "- FR-001: Keep the validated commit."],
    ["acceptance_criteria", "- AC-001: Verify the saved commit (FR-001)."],
    ["testing", "Replay AC-001 against the same commit."],
  ] as const;
  return {
    ...newPipelineState({ run_id, feature_description: "Verify the delivery" }),
    current_step: "implementation_gate",
    sections: sections.map(([section_type, content]) => ({
      section_type, content, status: "passed", attempt: 1, violation_count: 0, last_violations: [], attempt_log: [],
    })),
    pending_completion: {
      summary: "Self-check complete.",
      artifacts: [],
      outcome: { status: "passed", reasons: [] },
      verification: {
        claims_evaluated: 2, distribution_suspicious: false, total_subjective_claims: 0,
        distribution: { PASS: 2, FAIL: 0, INCONCLUSIVE: 0, "NEEDS-RUNTIME": 0, "SPEC-COMPLETE": 0 },
        judge_verdicts: ["FR-001", "AC-001"].map(claim_id => ({
          claim_id, judge: { kind: "genius", name: "dijkstra" }, verdict: "PASS",
          confidence: 0.9, rationale: "Synthetic evidence.", caveats: [],
        })),
      },
    },
  };
}

it("projects without mutating the saved checkpoint or granting execution controls", () => {
  const state = ready();
  const prior = structuredClone(state);
  expect(readDefineHandoff(state, pending)).toEqual({
    handoff: {
      version: 1, run_id,
      requirements: [{ id: "FR-001", text: "Keep the validated commit." }],
      acceptance: [{ id: "AC-001", text: "Verify the saved commit (FR-001).", requirement_ids: ["FR-001"] }],
    },
  });
  expect(state).toEqual(prior);
  expect(readDefineHandoff({ ...state, post_specs: initialPostSpecs() }, pending))
    .toEqual(readDefineHandoff(state, pending));
});

it("requires the saved implementation question and an undecided gate", () => {
  const source = ready();
  for (const [state, action] of [
    [{ ...source, current_step: "file_export" }, pending],
    [source, null],
    [source, { kind: "done", summary: "Done", artifacts: [] }],
    [source, { ...pending, question_id: "other" }],
    [{ ...source, post_specs: { ...initialPostSpecs(), decision: "implement" } }, pending],
    [{ ...source, post_specs: { ...initialPostSpecs(), decision: "prd_only" } }, pending],
  ] satisfies Array<[PipelineState, NextAction | null]>) {
    expect(readDefineHandoff(state, action)).toEqual({
      error: { code: "define_not_pending", message: "Define requires a pending implementation decision." },
    });
  }
});

it("never infers readiness from old or incomplete evidence or an override question", () => {
  const state = ready();
  const completion = state.pending_completion!;
  const override = { ...pending, options: [{ label: "Override policy (explicit)" }, { label: "PRD only" }] };
  const failed: PipelineState = { ...state, sections: [...state.sections, {
    section_type: "goals", status: "failed", attempt: 1, violation_count: 1, last_violations: [], attempt_log: [],
  }] };
  for (const [input, action] of [
    [{ ...state, pending_completion: null }, pending],
    [{ ...state, pending_completion: { ...completion, outcome: undefined } }, pending],
    [{ ...state, pending_completion: { ...completion, outcome: { status: "needs_attention", reasons: ["Failed"] } } }, pending],
    [{ ...state, pending_completion: { ...completion, verification: undefined } }, pending],
    [failed, pending],
  ] satisfies Array<[PipelineState, NextAction]>) {
    expect(readDefineHandoff(input, action)).toEqual({
      error: { code: "define_not_ready", message: "Define requires passed PRD sections, a passed self-check and detailed verification evidence." },
    });
  }
  for (const action of [override, { ...pending, options: null }]) {
    expect(readDefineHandoff(state, action)).toEqual({
      error: { code: "define_not_ready", message: "The pending question does not offer ordinary implementation." },
    });
  }
});

it("checks present-day verification evidence even if a saved gate looked ready", () => {
  const state = ready();
  const completion = state.pending_completion!;
  state.pending_completion = { ...completion, verification: {
    ...completion.verification!, total_subjective_claims: 5,
  } };
  expect(readDefineHandoff(state, pending)).toEqual({
    error: { code: "define_not_ready", message: "The current verification policy requires attention." },
  });
});

it("refuses the old aggregate FAIL, zero evidence and partial individual evidence", () => {
  const state = ready();
  const completion = state.pending_completion!;
  const verification = completion.verification!;
  for (const broken of [
    { ...verification, distribution: { ...verification.distribution, PASS: 1, FAIL: 1 }, judge_verdicts: undefined },
    { ...verification, claims_evaluated: 0, judge_verdicts: [] },
    { ...verification, judge_verdicts: verification.judge_verdicts!.slice(0, 1) },
  ]) {
    expect(readDefineHandoff({ ...state, pending_completion: { ...completion, verification: broken } }, pending)).toEqual({
      error: { code: "define_not_ready", message: "Define requires passed PRD sections, a passed self-check and detailed verification evidence." },
    });
  }
});

it("revalidates the document rather than trusting a stale passed score", () => {
  const source = ready();
  source.sections[0]!.content = "- FR-001: The link expires after one hour.";
  source.sections.push({
    section_type: "overview", content: "- NFR-002: The link expires after three hours.",
    status: "passed", attempt: 1, violation_count: 0, last_violations: [], attempt_log: [],
  });
  expect(readDefineHandoff(source, pending)).toMatchObject({
    error: { code: "define_document_invalid", message: expect.stringContaining("contradictory_requirements") },
  });
});

it("cannot project a required section that never existed", () => {
  const source = ready();
  source.sections = source.sections.filter(section => section.section_type !== "acceptance_criteria");
  expect(readDefineHandoff(source, pending)).toMatchObject({
    error: { code: "define_document_invalid", message: expect.stringContaining("acceptance") },
  });
});

it("returns contract-level issues for present definitions with bad references", () => {
  const source = ready();
  source.sections[1]!.content = "- AC-001: Confirm the receipt (FR-002).";
  expect(readDefineHandoff(source, pending)).toMatchObject({
    error: { code: "define_document_invalid", message: expect.stringContaining("AC-001 references unknown requirement FR-002.") },
  });
});

it("blocks a stale passed gate when an otherwise valid acceptance policy contradicts a saved decision", () => {
  const state = ready();
  state.feature_description = "With `--until ci`, never publish the verified commit.";
  const draft = "With `--until ci`, publish the verified commit automatically (FR-001).";
  state.sections[1]!.content = `- AC-001: ${draft}`;
  const finding = `acceptance_criteria/AC-001 says "${draft}", opposing the user publication decision from user-request.`;
  expect(readDefineHandoff(state, pending)).toEqual({
    error: { code: "define_document_invalid", message: `sourced_publication_policy: ${finding}` },
  });
  expect(evaluateRunPolicy(state)).toMatchObject({ status: "blocked", reasons: [finding] });
  state.sections[1]!.content = state.sections[1]!.content!.replace("verified commit", "verification report");
  expect(readDefineHandoff(state, pending)).toHaveProperty("handoff.version", 1);
  expect(evaluateRunPolicy(state)).toMatchObject({ status: "pass", reasons: [] });
});

it("checks an ordinary HTML wrapper around a requirement using the same definition as Define v1", () => {
  const checkpoint = ready();
  checkpoint.feature_description = "With `--until ci`, never publish the verified commit.";
  checkpoint.sections[0]!.content = "<div>\n- FR-001: With `--until ci`, publish the verified commit automatically.\n</div>";
  expect(readDefineHandoff(checkpoint, pending)).toMatchObject({
    error: { code: "define_document_invalid", message: expect.stringContaining("requirements/FR-001") },
  });
});

it("does not offer quoted requirements as planning input and detaches table source metadata", () => {
  const checkpoint = ready();
  checkpoint.sections[0]!.content = "> - FR-001: The previous version published automatically.";
  expect(readDefineHandoff(checkpoint, pending)).toMatchObject({
    error: { code: "define_document_invalid" },
  });
  checkpoint.sections[0]!.content = "| ID | Requirement | Source |\n| --- | --- | --- |\n| FR-001 | Verify the saved commit. | user-request |";
  expect(readDefineHandoff(checkpoint, pending)).toMatchObject({
    handoff: { requirements: [{ id: "FR-001", text: "Verify the saved commit." }] },
  });
});
