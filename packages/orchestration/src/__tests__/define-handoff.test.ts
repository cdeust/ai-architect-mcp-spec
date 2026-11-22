import { expect, it } from "vitest";
import { initialPostSpecs, newPipelineState, readDefineHandoff, step, type NextAction, type PipelineState } from "../index.js";

import { reviewSemanticCoverage } from "../semantic-review.js";
import { buildVerificationReportFile, VERIFICATION_REPORT_FILENAME } from "../handlers/verification-report.js";
import { REMEMBER_CORRELATION_ID } from "../handlers/finalize.js";
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
  for (const action of [override,
    { ...pending, options: null },
    { ...pending, options: [{ label: "Implement" }, { label: "Implement" }] },
    { ...pending, options: [...pending.options, { label: "Override policy (explicit)" }] },
    { ...pending, options: [{ label: "PRD only" }, { label: "PRD only" }] },
  ]) {
    expect(readDefineHandoff(state, action)).toEqual({
      error: { code: "define_not_ready", message: "The pending question does not permit a verified planning handoff." },
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
  checkpoint.sections[0]!.content = [
    '<div><blockquote>',
    '',
    'A literal `</blockquote>` tag.',
    '',
    '<!--',
    '</blockquote>',
    '-->',
    '',
    '~~~html',
    '</blockquote>',
    '~~~',
    '',
    '<blockquote>',
    '- FR-002: An older version published automatically.',
    '</blockquote>',
    '',
    '- FR-003: A rejected design published automatically.',
    '',
    '</blockquote>',
    '</div>',
    '',
    '- FR-001: Verify the saved commit.',
  ].join("\n");
  expect(readDefineHandoff(checkpoint, pending)).toMatchObject({
    handoff: { requirements: [{ id: "FR-001", text: "Verify the saved commit." }] },
  });
  checkpoint.sections[0]!.content = "| ID | Requirement | Source |\n| --- | --- | --- |\n| FR-001 | Verify the saved commit. | user-request |";
  expect(readDefineHandoff(checkpoint, pending)).toMatchObject({
    handoff: { requirements: [{ id: "FR-001", text: "Verify the saved commit." }] },
  });
});

it("preserves both requirements and traced criteria when their normative text surrounds an illustrative quote", () => {
  const checkpoint = ready();
  checkpoint.sections[0]!.content += "\n- FR-002: Retain the signed receipt. <blockquote>Legacy rule.</blockquote>";
  checkpoint.sections[1]!.content += "\n- AC-002: Preserve the receipt. <blockquote>Legacy note.</blockquote> (FR-002).";
  checkpoint.sections[2]!.content += " Replay AC-002 against the saved receipt.";
  expect(readDefineHandoff(checkpoint, pending)).toMatchObject({
    handoff: {
      requirements: [
        { id: "FR-001", text: "Keep the validated commit." },
        { id: "FR-002", text: "Retain the signed receipt." },
      ],
      acceptance: [
        { id: "AC-001", requirement_ids: ["FR-001"] },
        { id: "AC-002", requirement_ids: ["FR-002"] },
      ],
    },
  });
  checkpoint.sections[0]!.content = "| ID | Requirement | Source |\n| --- | --- | --- |\n| FR-001 | Keep the validated commit. | user-request |\n| FR-002 | <blockquote>Legacy requirement.</blockquote> | Prior design |";
  expect(readDefineHandoff(checkpoint, pending)).toMatchObject({ error: { code: "define_document_invalid" } });
});

it("preserves the Define payload for the new gate and honors a persisted legacy refusal", () => {
  const state = ready();
  const safe = { ...pending, options: [{ label: "PRD only" }, { label: "Review verification findings" }] };
  expect(readDefineHandoff(state, safe)).toEqual(readDefineHandoff(state, pending));
  expect(readDefineHandoff({ ...state, post_specs: { ...initialPostSpecs(), legacy_define_refusal: true } }, safe))
    .toMatchObject({ error: { code: "define_not_ready" } });
});

it("blocks a ready-looking implementation checkpoint with missing semantic evidence", () => {
  const state = { ...ready(), semantic_review_requested: true as const };
  const message = "semantic_review: current, complete scope and edge-case evidence is required";
  expect(readDefineHandoff(state, pending)).toEqual({ error: { code: "define_not_ready", message } });
  expect(evaluateRunPolicy(state)).toMatchObject({ status: "blocked", reasons: [message] });
});

function reviewedCheckpoint() {
  const enabled = {
    ...ready(), semantic_review_requested: true as const,
    written_files: [`prd-output/${run_id}/01-prd.md`],
  };
  const { action } = reviewSemanticCoverage(enabled, undefined);
  if (action?.kind !== "spawn_subagents") throw new Error("Expected an independent reviewer");
  return reviewSemanticCoverage(enabled, {
    kind: "subagent_batch_result", batch_id: action.batch_id,
    responses: [{
      invocation_id: action.batch_id,
      raw_text: JSON.stringify({
        scope_creep: { status: "clear", citations: [] }, missing_edge_case: { status: "clear", citations: [] },
      }),
    }],
  }).state;
}

it("reaches a terminal Define checkpoint without awaiting a user", () => {
  const reviewed = reviewedCheckpoint();
  const first = step({ state: reviewed });
  if (first.action.kind !== "write_file") throw new Error("Expected a verification report write");
  expect(first.action.content).toContain("Automatic Define outcome: passed.");
  const recorded = step({ state: first.state, result: {
    kind: "file_written", path: first.action.path, bytes: Buffer.byteLength(first.action.content),
  } });
  expect(recorded.action).toMatchObject({ kind: "call_cortex_tool", correlation_id: REMEMBER_CORRELATION_ID });
  const complete = finishRemember(recorded.state);
  expect(complete.action).toMatchObject({ kind: "done", outcome: { status: "passed" } });
  expect(complete.state.post_specs).toMatchObject({ automatic_define: 1, decision: "prd_only" });
  expect(complete.state.pending_completion).toEqual(reviewed.pending_completion);
  expect(readDefineHandoff(complete.state, complete.action)).toEqual(readDefineHandoff(ready(), pending));
  if (complete.action.kind !== "done") throw new Error("Expected terminal action");
  for (const action of [
    { ...complete.action, outcome: { status: "needs_attention" as const, reasons: ["Blocked"] } },
    { ...complete.action, verification: undefined },
    { ...complete.action, outcome: undefined },
  ]) {
    expect(readDefineHandoff(complete.state, action)).toEqual({ error: {
      code: "define_not_ready", message: "The completed verification action and retained evidence disagree.",
    } });
  }

  const state = complete.state;
  const incomplete = { ...state, sections: state.sections.filter(s => s.section_type !== "acceptance_criteria") };
  expect(readDefineHandoff(incomplete, { ...complete.action, outcome: undefined }))
    .toMatchObject({ error: { code: "define_document_invalid" } });
  const post_specs = state.post_specs!;
  for (const [checkpoint, action] of [
    [{ ...state, semantic_review_requested: undefined }, complete.action],
    [{ ...state, post_specs: { ...post_specs, automatic_define: undefined } }, complete.action],
    [{ ...state, post_specs: { ...post_specs, decision: "implement" } }, complete.action],
    [{ ...state, current_step: "finalize" }, complete.action],
    [state, pending],
    [state, null],
  ] satisfies Array<[PipelineState, NextAction | null]>) {
    expect(readDefineHandoff(checkpoint, action)).toMatchObject({ error: { code: "define_not_pending" } });
  }
});

function finishRemember(state: PipelineState) {
  return step({ state, result: {
    kind: "tool_result", correlation_id: REMEMBER_CORRELATION_ID, success: true,
  } });
}

it("clears transient completion evidence when the legacy run finishes", () => {
  const state = { ...ready(), current_step: "finalize" as const };
  expect(state.post_specs).toBeNull();
  expect(finishRemember(state).state.pending_completion).toBeNull();
});

it("fails closed if an automatic gate is missing its saved self-check", () => {
  const state = { ...reviewedCheckpoint(), pending_completion: null };
  const stopped = step({ state });
  expect(stopped.action).toEqual({
    kind: "failed", step: "implementation_gate", reason: "Define requires saved self-check evidence.",
  });
  expect(stopped.state.current_step).toBe("complete");
});

it("records a blocked terminal outcome when the standard judge evidence is incomplete", () => {
  const state = reviewedCheckpoint();
  state.pending_completion = { ...state.pending_completion!, verification: undefined };
  const result = step({ state });
  expect(result.action).toMatchObject({
    kind: "write_file", content: expect.stringContaining(
      "Automatic Define outcome: needs_attention.\n- Define requires passed PRD sections",
    ),
  });
  expect(result.state.pending_completion?.outcome).toEqual({
    status: "needs_attention",
    reasons: ["Define requires passed PRD sections, a passed self-check and detailed verification evidence."],
  });
});

it("writes the automatic refusal report even if a legacy report already exists", () => {
  const state = reviewedCheckpoint();
  const saved = state.pending_completion!;
  const verification = saved.verification!;
  state.pending_completion = {
    ...saved,
    verification: { ...verification, judge_verdicts: verification.judge_verdicts!.map(verdict => ({
      ...verdict, verdict: "FAIL" as const,
    })) },
  };
  state.written_files.push(`prd-output/${run_id}/${VERIFICATION_REPORT_FILENAME}`);
  const result = step({ state });
  expect(result.action).toMatchObject({
    kind: "write_file",
    content: expect.stringContaining("Automatic Define outcome: needs_attention.\n- 2 claim(s) carry a blocked verdict (FAIL)"),
  });
});

it("reports the legacy pending decision for older runs", () => {
  const state = { ...ready(), written_files: [`prd-output/${run_id}/01-prd.md`] };
  const report = buildVerificationReportFile(state);
  expect(report?.content()).toContain("Human decision: pending (gate not yet answered).");
  expect(report?.content()).not.toContain("Automatic Define outcome");
});
