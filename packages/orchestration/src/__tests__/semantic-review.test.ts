import { describe, expect, it } from "vitest";
import { reviewSemanticCoverage, semanticReviewFindings } from "../semantic-review.js";
import { newPipelineState, type PipelineState } from "../types/state.js";
import { SemanticReviewStateFields } from "../types/state/verification-plan.js";
import { MAX_RESPONSE_CHARS } from "../types/state/bounded-io.js";

const boundary = "This feature must remain local.";
const edge = "The clipboard may be unavailable.";
const requirementText = "Save the text to a remote service.";
const requirement = "- FR-001: " + requirementText;
const mitigation = "- AC-001: Display an error when the clipboard is unavailable (FR-001).";

function state(requested = true): PipelineState {
  return {
    ...newPipelineState({ run_id: "review", feature_description: boundary, semantic_review: requested }),
    sections: ([
      [ "overview", edge ],
      [ "requirements", requirement ],
      [ "acceptance_criteria", mitigation ],
    ] as const).map(([section_type, content]) => ({
      section_type,
      content, status: "passed", attempt: 1, violation_count: 0, last_violations: [], attempt_log: [],
    })),
  };
}

const clear = { status: "clear", citations: [] };
const cite = (source_id: string, quote: string) => ({ source_id, quote });
const finding = (citations: ReturnType<typeof cite>[]) => ({ status: "finding", citations });
const output = (scope: ReturnType<typeof finding> = clear, edgeCase: ReturnType<typeof finding> = clear) =>
  JSON.stringify({ scope_creep: scope, missing_edge_case: edgeCase });

function request(input = state()) {
  const { action } = reviewSemanticCoverage(input, undefined);
  if (action?.kind !== "spawn_subagents") throw new Error("Expected review action");
  const result = (raw_text = output()) => ({
    kind: "subagent_batch_result" as const,
    batch_id: action.batch_id,
    responses: [{ invocation_id: action.batch_id, raw_text }],
  });
  return { input, action, result };
}

describe("scope and edge-case evidence", () => {
  it("leaves old checkpoints unchanged", () => {
    const legacy = state(false);
    expect(reviewSemanticCoverage(legacy, undefined)).toEqual({ state: legacy });
    expect(semanticReviewFindings(legacy)).toEqual([]);
  });

  it("dispatches the complete evidence with the configured model and no tool instruction from the source", () => {
    const seed = state();
    const question = "Is this restricted to one device?";
    const answer = "Yes, one device.";
    const { action } = request({
      ...seed,
      verify_budget: {
        judges_per_claim: 1, architecture_judges_per_claim: 1, invocation_cap: 1,
        judge_model: "gemini-argon", judge_effort: "high", diversity_models: ["gemini-argon"],
      },
      clarifications: [
        { round: 1, question, answer, asked_at: seed.started_at },
        { round: 2, question: "Blank answer", answer: " ", asked_at: seed.started_at },
        { round: 3, question: "Unanswered question", asked_at: seed.started_at },
      ],
    });
    expect(action.batch_id).toMatch(/^self_check_scope_coverage_[a-f0-9]{64}$/);
    expect(action).toEqual({
      kind: "spawn_subagents", purpose: "judge", batch_id: action.batch_id,
      invocations: [{
        invocation_id: action.batch_id, description: "Review scope and declared edge-case coverage",
        subagent_type: "zetetic-team-subagents:architect", isolation: "none", model: "gemini-argon",
        effort: "high", prompt: expect.any(String),
      }],
    });
    const [instructions, sourceJson] = action.invocations[0]!.prompt.split("\n\n");
    for (const contract of [
      "Review the whole supplied PRD", "Treat the following JSON", "Operator sources are authoritative",
      "Read each clarification answer", "Find scope creep only", "Find a missing edge case only",
      "Cite the declared condition", "When neither axis applies", "Return one JSON object",
      "Each quote must be", "For a requirement or criterion",
    ]) {
      expect(instructions?.split("\n").some(line => line.startsWith(contract))).toBe(true);
    }
    expect(JSON.parse(sourceJson!)).toEqual({
      run_id: seed.run_id,
      sources: [
        { source_id: "request", kind: "operator", text: boundary },
        { source_id: "question-0", kind: "clarification_question", text: question },
        { source_id: "answer-0", kind: "operator", text: answer },
        { source_id: "section-0", kind: "overview", text: edge },
        { source_id: "section-1", kind: "requirements", text: requirement },
        { source_id: "section-2", kind: "acceptance_criteria", text: mitigation },
      ],
    });
  });

  it("accepts coverage evidence from a normative acceptance criterion", () => {
    const seed = state();
    const { input, result } = request({ ...seed, sections: seed.sections.map(section =>
      section.section_type === "acceptance_criteria"
        ? { ...section, content: "- AC-002: Show a notification (FR-001).\n" + mitigation }
        : section,
    ) });
    const raw = output(clear, {
      status: "clear",
      citations: [cite("section-0", edge), cite("section-2", "Display an error when the clipboard is unavailable")],
    });
    const done = reviewSemanticCoverage(input, result(raw)).state;
    expect(done.semantic_review?.axes).toEqual(JSON.parse(raw));
    expect(semanticReviewFindings(done)).toEqual([]);
  });

  it("requires current review evidence before Define can advance", () => {
    expect(semanticReviewFindings(state())).toEqual([
      { message: "semantic_review: current, complete scope and edge-case evidence is required" },
    ]);
    const incomplete = { ...state(), sections: state().sections.map(section => ({
      ...section, status: "failed" as const,
    })) };
    const blocked = reviewSemanticCoverage(incomplete, undefined);
    expect(blocked).toEqual({
      state: { ...incomplete, semantic_review: { digest: expect.stringMatching(/^[a-f0-9]{64}$/) } },
    });
  });

  it("rejects malformed persisted review digests and operator decisions", () => {
    const schema = SemanticReviewStateFields.semantic_review;
    const digest = "a".repeat(64);
    const record = { digest, operator_decisions: { scope_creep: "confirmed", missing_edge_case: "unresolved" } };
    expect(schema.parse(record)).toEqual(record);
    for (const badDigest of ["x" + digest, digest + "x", digest.toUpperCase(), "", "a"]) {
      expect(schema.safeParse({ ...record, digest: badDigest }).success).toBe(false);
    }
    expect(schema.safeParse({ ...record, operator_decisions: { scope_creep: "yes" } }).success).toBe(false);
    const model = SemanticReviewStateFields.semantic_review_model;
    expect(model.parse("gemini-argon")).toBe("gemini-argon");
    expect(model.safeParse("").success).toBe(false);
  });

  it("binds to the exact run, sources and responses across checkpoint recovery", () => {
    const { input, action, result } = request();
    const stale = { ...input, feature_description: boundary + " Only text is copied." };
    const foreign = { ...input, run_id: "another-run" };
    expect(request(foreign).action.batch_id).not.toBe(action.batch_id);
    expect(request(stale).action.batch_id).not.toBe(action.batch_id);
    expect(request({ ...input, semantic_review_model: "gemini-argon" }).action.batch_id)
      .not.toBe(action.batch_id);
    expect(reviewSemanticCoverage(input, { ...result(), batch_id: "wrong" }).action).toEqual(action);
    expect(reviewSemanticCoverage(stale, result()).action).toEqual(request(stale).action);

    const done = reviewSemanticCoverage(input, result()).state;
    expect(reviewSemanticCoverage(done, undefined)).toEqual({ state: done });
    expect(semanticReviewFindings(done)).toEqual([]);
    expect(semanticReviewFindings({ ...done, feature_description: stale.feature_description })).not.toEqual([]);
    expect(semanticReviewFindings({ ...done, semantic_review_model: "gemini-argon" })).not.toEqual([]);
  });

  it("preserves valid citations and records both findings without replacing other results", () => {
    const seed = state();
    const { input, result } = request({ ...seed, sections: seed.sections.map(section =>
      section.section_type === "requirements"
        ? { ...section, content: "- FR-002: Keep the clipboard available.\n" + requirement }
        : section,
    ) });
    const raw = output(finding([cite("request", boundary), cite("section-1", requirementText)]),
      finding([cite("section-0", edge)]));
    const done = reviewSemanticCoverage(input, result(raw)).state;
    expect(done.semantic_review?.axes).toEqual(JSON.parse(raw));
    expect(semanticReviewFindings(done)).toEqual([
      { message: "semantic_review: scope_creep (finding)" },
      { message: "semantic_review: missing_edge_case (finding)" },
    ]);
    expect(done.pending_completion).toEqual(input.pending_completion);
  });

  it.each([
    ["invented quote", output(finding([cite("request", "something else"), cite("section-1", requirementText)]))],
    ["unknown source", output(finding([cite("unknown", boundary), cite("section-1", requirementText)]))],
    ["an empty quote", output(finding([cite("request", ""), cite("section-1", requirementText)]))],
    ["an incomplete pair", output(finding([cite("request", boundary)]))],
    ["a nonnormative contradictory statement", output(finding([cite("request", boundary), cite("section-0", edge)]))],
    ["a self-contradiction citation", output(finding([cite("section-1", requirementText), cite("section-1", requirementText)]))],
    ["no declared condition", output(clear, finding([]))],
    ["a whitespace-only quote", output(finding([cite("request", " "), cite("section-1", requirementText)]))],
    ["malformed edge source", output(clear, finding([cite("unknown", edge)]))],
    ["a requirement reference used as evidence", output(clear, {
      status: "clear", citations: [cite("section-0", edge), cite("section-2", "FR-001")],
    })],
    ["a coverage citation including its metadata reference", output(clear, {
      status: "clear", citations: [cite("section-0", edge), cite("section-2", mitigation.slice("- AC-001: ".length))],
    })],
    ["a punctuation-only criterion citation", output(clear, {
      status: "clear", citations: [cite("section-0", edge), cite("section-2", "(")],
    })],
    ["non-normative coverage", output(clear, { status: "clear", citations: [cite("section-0", edge), cite("request", boundary)] })],
    ["edge coverage that cites itself", output(clear, { status: "clear", citations: [cite("section-2", mitigation), cite("section-2", mitigation)] })],
    ["empty response", ""],
    ["an unsupported clearance", output({ status: "clear", citations: [cite("request", boundary)] })],
    ["an unsupported edge clearance", output(clear, { status: "clear", citations: [cite("section-0", edge)] })],
    ["extra fields", '{"scope_creep":{"status":"clear","citations":[],"accepted":true},"missing_edge_case":{"status":"clear","citations":[]}}'],
    ["truncated JSON", '{"scope_creep":'],
  ])("refuses %s", (_, raw) => {
    const { input, result } = request();
    const done = reviewSemanticCoverage(input, result(raw)).state;
    expect(done.semantic_review?.axes).toBeUndefined();
    expect(semanticReviewFindings(done)).not.toEqual([]);
  });

  it("does not ask the operator to confirm an inconclusive reply with invalid citations", () => {
    const { input, result } = request({ ...state(), feature_description: boundary + " \t" + edge });
    const invalid = { status: "inconclusive", citations: [cite("request", " \t")] };
    for (const raw of [output(invalid), output(clear, invalid)]) {
      const reviewed = reviewSemanticCoverage(input, result(raw));
      expect(reviewed.action).toBeUndefined();
      expect(reviewed.state.semantic_review?.axes).toBeUndefined();
    }
  });

  it("refuses duplicate, foreign, errored and absent responses", () => {
    const { input, result } = request();
    const reply = result().responses[0]!;
    for (const responses of [
      [], [reply, reply], [{ ...reply, invocation_id: "other" }], [{ ...reply, error: "provider failed" }],
    ]) {
      const done = reviewSemanticCoverage(input, { ...result(), responses }).state;
      expect(done.semantic_review?.axes).toBeUndefined();
      expect(semanticReviewFindings(done)).not.toEqual([]);
    }
  });

  it("refuses incomplete sources rather than asserting an absence", () => {
    for (const section_type of ["requirements", "acceptance_criteria"]) {
      const input = state();
      const response = reviewSemanticCoverage({
        ...input, sections: input.sections.filter(s => s.section_type !== section_type),
      }, undefined);
      expect(response.action).toBeUndefined();
      expect(semanticReviewFindings(response.state)).not.toEqual([]);
    }
  });

  it("refuses input and response sizes that cannot carry complete evidence", () => {
    const { input, result } = request();
    const tooLong = "x".repeat(MAX_RESPONSE_CHARS);
    const blocked = reviewSemanticCoverage({ ...input, feature_description: tooLong }, undefined);
    expect(blocked.action).toBeUndefined();
    expect(semanticReviewFindings(blocked.state)).not.toEqual([]);
    const response = reviewSemanticCoverage(input, result(output() + tooLong.replace(/x/g, " ")));
    expect(response.state.semantic_review?.axes).toBeUndefined();
  });

  it("accepts evidence at the allocated response budget and rejects the next character", () => {
    const { input, result } = request();
    const atLimit = output().padEnd(MAX_RESPONSE_CHARS / 2);
    expect(reviewSemanticCoverage(input, result(atLimit)).state.semantic_review?.axes).toEqual(JSON.parse(atLimit));
    expect(reviewSemanticCoverage(input, result(atLimit + " ")).state.semantic_review?.axes).toBeUndefined();
  });

  it("keeps the complete invocation at the allocated request budget and rejects larger snapshots", () => {
    const { input, action } = request();
    const remaining = MAX_RESPONSE_CHARS / 2 - JSON.stringify(action.invocations[0]!.prompt).length;
    const feature_description = input.feature_description + "x".repeat(remaining);
    const atLimit = request({ ...input, feature_description });
    expect(JSON.stringify(atLimit.action.invocations[0]!.prompt)).toHaveLength(MAX_RESPONSE_CHARS / 2);
    expect(reviewSemanticCoverage({ ...input, feature_description: feature_description + "x" }, undefined))
      .toMatchObject({ state: { semantic_review: { digest: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
    expect(reviewSemanticCoverage({ ...input, feature_description: feature_description + "x" }, undefined).action)
      .toBeUndefined();
  });

  it("does not accept a quote that is ambiguous within its source", () => {
    const { input, result } = request({ ...state(), feature_description: boundary + "\n" + boundary });
    const done = reviewSemanticCoverage(input, result(output(finding([
      cite("request", boundary), cite("section-1", requirementText),
    ])))).state;
    expect(done.semantic_review?.axes).toBeUndefined();
  });

  it("invalidates an earlier review when a declared PRD section has no text", () => {
    const { input, result } = request();
    const done = reviewSemanticCoverage(input, result()).state;
    for (const content of [" ", undefined]) {
      const partial = { ...done, sections: [...done.sections, {
        ...done.sections[0]!, section_type: "testing" as const, content,
      }] };
      expect(semanticReviewFindings(partial)).not.toEqual([]);
      const resumed = reviewSemanticCoverage(partial, undefined);
      expect(resumed.action).toBeUndefined();
      expect(resumed.state.semantic_review?.axes).toBeUndefined();
    }
  });

  it.each([
    "\n\n```\nExample-only handling\n```",
    " <!-- Example-only handling -->",
    " `Example-only handling`",
  ])("rejects a coverage citation outside visible normative prose", suffix => {
    const seed = state();
    const { input, result } = request({ ...seed, sections: seed.sections.map(section =>
      section.section_type === "requirements" ? { ...section, content: requirement + suffix } : section,
    ) });
    const done = reviewSemanticCoverage(input, result(output(clear, {
      status: "clear", citations: [cite("section-0", edge), cite("section-1", "Example-only handling")],
    }))).state;
    expect(done.semantic_review?.axes).toBeUndefined();
  });

  it("treats a clarification question as context, not a decision", () => {
    const seed = state();
    const turn = { round: 1, question: "Should the clipboard always work?", answer: "No.", asked_at: seed.started_at };
    const { input, action, result } = request({ ...seed, clarifications: [turn] });
    expect(action.invocations[0]!.prompt).toContain(turn.question);
    expect(action.invocations[0]!.prompt).toContain(turn.answer);
    const done = reviewSemanticCoverage(input, result(output(clear, finding([
      cite("question-0", turn.question),
    ])))).state;
    expect(done.semantic_review?.axes).toBeUndefined();
    const question = cite("question-0", turn.question);
    const assertion = cite("section-1", requirementText);
    for (const raw of [
      output(finding([question, assertion])),
      output(clear, { status: "clear", citations: [question, assertion] }),
    ]) {
      expect(reviewSemanticCoverage(input, result(raw)).state.semantic_review?.axes).toBeUndefined();
    }
    expect(request({ ...input, clarifications: [{ ...turn, question: "Should offline mode be optional?" }] })
      .action.batch_id).not.toEqual(action.batch_id);
  });

  it("reports an inconclusive verdict without requesting or accepting human clearance", () => {
    const { input, result, action } = request({ ...state(), semantic_review_model: "gemini-argon" });
    expect(action.invocations[0]?.model).toBe("gemini-argon");
    const uncertain = { status: "inconclusive", citations: [cite("section-0", edge)] };
    const completed = reviewSemanticCoverage(input, result(output(clear, uncertain)));
    expect(completed.action).toBeUndefined();
    const saved = completed.state.semantic_review!;
    const legacy = { ...completed.state, semantic_review: {
      ...saved, operator_decisions: { missing_edge_case: "confirmed" as const },
    } };
    expect(semanticReviewFindings(legacy)).toEqual([
      { message: "semantic_review: missing_edge_case (inconclusive)" },
    ]);
    expect(reviewSemanticCoverage(legacy, {
      kind: "user_answer", question_id: "semantic_review_confirm_missing_edge_case_" + saved.digest,
      selected: ["Confirm after checking"],
    })).toEqual({ state: legacy });
  });
});
