import { expectOptionRetry } from "./expect-option-retry.js";
import { describe, expect, it } from "vitest";
import { makeCannedDispatcher, newPipelineState, PipelineStateSchema, step, type PipelineState } from "../index.js";
import { selfCheckState } from "./verify-budget-fixture.js";
import { buildPolicyGateQuestion } from "../handlers/verification-policy.js";

const base = newPipelineState({ run_id: "wrong-host", feature_description: "x", prd_context: "feature" });
const completion = { summary: "PRD ready", artifacts: [] };
const clarify: PipelineState = { ...base, current_step: "clarification" };
const cases = [
  { id: "prd_context", state: { ...base, current_step: "context_detection", prd_context: null, feature_description: "bug" }, other: "feature", label: "release" },
  { id: "clarification_continue", state: clarify, other: "continue", label: "proceed" },
  { id: "pr_gate", state: { ...base, current_step: "pr_gate", pending_completion: completion }, other: "No", label: "Push + open PR", fallback: "No" },
  { id: "implementation_gate", state: { ...base, current_step: "implementation_gate", pending_completion: completion }, other: "PRD only", label: "Implement", fallback: "PRD only" },
  { id: "self_check_verify_budget", state: selfCheckState(22, true), other: "Reduced sample", label: "Full fleet", fallback: "Reduced sample" },
] satisfies Array<{ id: string; state: PipelineState; label: string; other: string; fallback?: string }>;

describe.each(cases)("bounded $id", ({ id, state, label, other, fallback }) => {
  function submit(saved: PipelineState, selected: string[], freeform?: string) {
    return step({ state: saved, result: { kind: "user_answer", question_id: id, selected, freeform } });
  }

  it.each(["conflicting fields", "multiple selections"])("counts %s across saved states and resolves the third", (shape) => {
    // Exercise different labels, duplicate labels and an extra non-option on successive attempts.
    const answers = shape === "multiple selections" ? [[label, other], [label, label], [label, "unknown"]] : [[label], [label], []];
    const freeform = shape === "conflicting fields" ? "do not approve" : undefined;
    let saved: PipelineState = state;
    for (const count of [1, 2]) {
      const out = submit(saved, answers[count - 1]!, freeform);
      expect(out.action).toMatchObject({ kind: "ask_user", question_id: id });
      expect(out.state.unmatched_answers).toEqual({ [id]: count });
      saved = PipelineStateSchema.parse(JSON.parse(JSON.stringify(out.state)));
    }
    const out = submit(saved, answers[2]!, freeform);
    if (!fallback) {
      expect(out.state.unmatched_answers).toEqual({ [id]: 3 });
      expect(out.action).toEqual({ kind: "failed", step: state.current_step, reason: `${id}: 3 unmatched answers.` });
      return;
    }
    expect(out.state.unmatched_answers).toEqual({});
    expect(out.messages).toContainEqual({ level: "warn", text: `${id}: 3 unmatched answers. Using "${fallback}".` });
    if (id === "pr_gate") expect(out.state.post_specs?.pr).toEqual({ pushed: false, url: null });
    if (id === "implementation_gate") expect(out.state.post_specs?.decision).toBe("prd_only");
    if (id === "self_check_verify_budget") expect(out.state.verification_plan?.sampled).toBe(true);
  });

  it.each(["", " \t "])("accepts a single label alongside %j", (blank) => {
    const out = submit(state, [label, blank]);
    expect(out.state.unmatched_answers).toEqual({});
    if (id === "pr_gate") expect(out.state.current_step).toBe("pr_creation");
    if (id === "implementation_gate") expect(out.state.post_specs?.decision).toBe("implement");
    if (id === "self_check_verify_budget") expect(out.state.verification_plan?.sampled).toBe(false);
    if (id === "clarification_continue") expect(out.state.proceed_signal).toBe(true);
    if (id === "prd_context") expect(out.state.prd_context).toBe("release");
  });

  it("leaves the input counters intact after a valid answer", () => {
    const input = { ...state, unmatched_answers: { [id]: 2, other: 1 } };
    const out = submit(input, [label]);
    expect(out.state.unmatched_answers).toEqual({ other: 1 });
    expect(input.unmatched_answers).toEqual({ [id]: 2, other: 1 });
  });

  it("accepts agreeing labels and resets only this question", () => {
    const out = submit({ ...state, unmatched_answers: { [id]: 2, other: 1 } }, [label], label.toUpperCase());
    expect(out.state.unmatched_answers).toEqual({ other: 1 });
    expect(out.action).not.toMatchObject({ kind: "ask_user", question_id: id });
    expect(out.action.kind).not.toBe("failed");
  });
});

it("restores a state saved before answer counters existed", () => {
  const legacy = { ...base };
  Reflect.deleteProperty(legacy, "unmatched_answers");
  expect(PipelineStateSchema.parse(legacy).unmatched_answers).toEqual({});
});

it("finishes a headless run whose host answers every question incorrectly", () => {
  let out = step({ state: { ...base, current_step: "implementation_gate", pending_completion: completion } });
  const dispatch = makeCannedDispatcher();
  let questions = 0;
  while (out.action.kind !== "done" && out.action.kind !== "failed") {
    const result = out.action.kind === "ask_user"
      ? { kind: "user_answer" as const, question_id: out.action.question_id, selected: ["wrong"] }
      : dispatch(out.action);
    if (out.action.kind === "ask_user") questions++;
    expect(questions).toBeLessThanOrEqual(3);
    out = step({ state: out.state, result });
  }
  expect(questions).toBe(3);
  expect(out.action.kind).toBe("done");
  expect(out.state.post_specs?.decision).toBe("prd_only");
});

it.each([
  ["pass", "Implement"],
  ["blocked", "Override policy (explicit)"],
  ["needs_attention", "Implement anyway (dérogation explicite)"],
] as const)("canned implementation respects the offered %s options", (status, approve) => {
  const question = buildPolicyGateQuestion({ status, reasons: [], blocking_claims: [], disagreements: [], unsampled_ratio: 0 });
  const run = (override_policy: boolean, implementation_gate_answer: "Implement" | "PRD only") =>
    makeCannedDispatcher({ override_policy, implementation_gate_answer })(question);
  expect(run(false, "Implement")).toMatchObject({ selected: [status === "pass" ? "Implement" : "PRD only"] });
  expect(run(true, "Implement")).toMatchObject({ selected: [approve] });
  expect(run(true, "PRD only")).toMatchObject({ selected: ["PRD only"] });
});

it.each(["yes", "do not proceed", "", undefined, "unknown"])("repeats the full clarification question for %j", (freeform) => {
  const out = step({ state: clarify, result: { kind: "user_answer", question_id: "clarification_continue", selected: [], freeform } });
  expect(out.state.proceed_signal).toBe(false);
  expect(out.action).toEqual({
    kind: "ask_user",
    question_id: "clarification_continue",
    header: "Asked 0 questions. Proceed?",
    description: "Min for this run: 8. Max: 10. 'proceed' to generate the PRD, 'continue' for more questions.\n\nYour answer was not one of the options. Choose one of: proceed, continue.",
    options: [
      { label: "proceed", description: "Generate the PRD now" },
      { label: "continue", description: "Ask another question" },
    ],
    multi_select: false,
  });
});

it.each([
  ["Push + open PR", "Push approved. Opening a pull request."],
  ["No", "Push declined. Proceeding to finalize without a PR."],
])("reports the PR gate decision for %s", (choice, text) => {
  const out = step({
    state: { ...base, current_step: "pr_gate", pending_completion: completion },
    result: { kind: "user_answer", question_id: "pr_gate", selected: [choice] },
  });
  expect(out.messages).toContainEqual({ level: "info", text });
});

it("repeats the full PR question on conflicting push instructions", () => {
  const out = step({
    state: { ...base, current_step: "pr_gate" },
    result: { kind: "user_answer", question_id: "pr_gate", selected: ["Push + open PR"], freeform: "No, do not push" },
  });
  expect(out.action).toEqual({
    kind: "ask_user",
    question_id: "pr_gate",
    header: "Push the branch and open a pull request?",
    description: "Review verdict: unavailable.\nPost-implementation gates: not run.\nFiles changed: 0.\nBranch: (unknown).\n\nA pull request is opened for human review — it is never self-merged.\n\nYour answer was not one of the options. Choose one of: Push + open PR, No.",
    options: [
      { label: "Push + open PR", description: "Push the branch and open a pull request for human review." },
      { label: "No", description: "Stop here. No branch is pushed and no PR is opened." },
    ],
    multi_select: false,
  });
});

it("ignores a budget answer to a different question", () => {
  const state = selfCheckState(22, true);
  const out = step({ state, result: { kind: "user_answer", question_id: "other", selected: ["Full fleet"] } });
  expect(out.action).toEqual(step({ state }).action);
  expect(out.state.verification_plan).toBeNull();
});

it("clears prior attempts when the user chooses another clarification round", () => {
  const out = step({
    state: { ...clarify, unmatched_answers: { clarification_continue: 2 } },
    result: { kind: "user_answer", question_id: "clarification_continue", selected: ["continue"] },
  });
  expect(out.action).toMatchObject({ kind: "spawn_subagents", purpose: "draft" });
  expect(out.state.unmatched_answers).toEqual({});
});

it.each([
  [null, "prd_context", "context_detection", "release", "input_analysis"],
  ["feature", "clarification_continue", "clarification", "proceed", "section_generation"],
] as const)("emits repeated failures then accepts a valid answer for %s context", (prd_context, question, failedStep, valid, nextStep) => {
  const dispatch = makeCannedDispatcher();
  let out = step({ state: newPipelineState({ run_id: "wrong-from-start", feature_description: "x", prd_context }) });
  let attempts = 0;
  while (out.action.kind !== "failed" && out.action.kind !== "done") {
    let result = dispatch(out.action);
    if (out.action.kind === "ask_user") {
      if (out.action.question_id === question) attempts++;
      expect(attempts).toBeLessThanOrEqual(3);
      result = { kind: "user_answer", question_id: out.action.question_id, selected: ["wrong"] };
    }
    out = step({ state: out.state, result });
  }
  expect(attempts).toBe(3);
  expect(out.action).toEqual({ kind: "failed", step: failedStep, reason: `${question}: 3 unmatched answers.` });
  expect(out.state.current_step).toBe(failedStep);
  const answer = { kind: "user_answer" as const, question_id: question, selected: ["wrong"] };
  const fourth = step({ state: out.state, result: answer });
  expect(fourth.state.current_step).toBe(failedStep);
  expect(fourth.state.unmatched_answers[question]).toBe(4);
  expect(fourth.action).toEqual({ kind: "failed", step: failedStep, reason: `${question}: 4 unmatched answers.` });

  const continued = step({ state: fourth.state, result: { ...answer, selected: [valid] } });
  expect(continued.action.kind).not.toBe("failed");
  expect(continued.state.current_step).toBe(nextStep);
  expect(continued.state.unmatched_answers).toEqual({});
});

it.each(["continue", "stray clarification_answer"])("starts a fresh continuation budget in the next round after %s", (transition) => {
  const continueId = "clarification_continue";
  const answer = (question_id: string, choice: string) => ({ kind: "user_answer" as const, question_id, selected: [choice] });
  const dispatch = makeCannedDispatcher();
  // A feature first asks whether to continue after eight completed rounds.
  const clarifications = Array.from({ length: 8 }, (_, index) => ({
    round: index + 1, asked_at: "now", question: "Which detail?", answer: index < 7 ? "detail" : undefined,
  }));
  const first = step({ state: { ...clarify, clarifications, unmatched_answers: { other: 2 } }, result: answer("clarification_answer", "detail") });
  expect(first.action).toMatchObject({ kind: "ask_user", question_id: continueId, header: "Asked 8 questions. Proceed?" });
  const wrong = answer(continueId, "wrong");
  const retry = step({ state: first.state, result: wrong });
  expect(retry.state.unmatched_answers).toEqual({ other: 2, clarification_continue: 1 });

  // A duplicate clarification_answer also re-enters composition without resolving the old prompt.
  const next = step({ state: retry.state, result: transition === "continue" ? answer(continueId, "continue") : answer("clarification_answer", "duplicate") });
  expect(next.action).toMatchObject({ kind: "spawn_subagents", batch_id: "clarification_compose_9" });
  const composed = step({ state: next.state, result: dispatch(next.action) });
  expect(composed.action).toMatchObject({ kind: "ask_user", question_id: "clarification_answer" });
  const second = step({ state: composed.state, result: answer("clarification_answer", "new detail") });
  expect(second.action).toMatchObject({ kind: "ask_user", question_id: continueId, header: "Asked 9 questions. Proceed?" });
  expect(second.state.unmatched_answers).toEqual({ other: 2 });
  let saved = second.state;
  for (const count of [1, 2]) {
    const out = step({ state: saved, result: wrong });
    expectOptionRetry(out.action, second.action);
    expect(out.state.unmatched_answers).toEqual({ other: 2, clarification_continue: count });
    saved = out.state;
  }
  const failed = step({ state: saved, result: wrong });
  expect(failed.action).toEqual({ kind: "failed", step: "clarification", reason: "clarification_continue: 3 unmatched answers." });
  expect(failed.state.unmatched_answers).toEqual({ other: 2, clarification_continue: 3 });
});
