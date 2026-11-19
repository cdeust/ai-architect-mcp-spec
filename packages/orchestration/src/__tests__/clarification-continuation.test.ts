import { describe, expect, it } from "vitest";
import { makeCannedDispatcher, newPipelineState, PipelineStateSchema, step, type PipelineState } from "../index.js";

const dispatch = makeCannedDispatcher();
const turns = Array.from({ length: 8 }, (_, i) => ({
  round: i + 1, asked_at: "now", question: "Which detail?", answer: "given",
}));
const seed: PipelineState = {
  ...newPipelineState({ run_id: "resume", feature_description: "x", prd_context: "feature" }),
  current_step: "clarification",
  unmatched_answers: { clarification_continue: 2, other: 1 },
};
function decision(state: PipelineState, choice: string) {
  return step({ state, result: { kind: "user_answer", question_id: "clarification_continue", selected: [choice] } });
}

const first = step({ state: seed });
const fourth = step({ state: { ...seed, clarifications: turns.slice(0, 3) } });
const ninth = step({ state: { ...seed, clarifications: turns } });
const question = step({ state: ninth.state, result: {
  kind: "subagent_batch_result", batch_id: "clarification_compose_9", responses: [{
    invocation_id: "clarification_compose_inv_9",
    raw_text: JSON.stringify({ question: "Who approves?", rationale: "Name the reviewer.", options: ["Owner", "Team"] }),
  }],
} });

describe.each([["proceed"], ["continue"]])("unsolicited %s", (choice) => {
  const checkpoints = [
    ["compose #1", first, false], ["compose #4", fourth, false], ["compose #9", ninth, false],
    ["question #9", question, false], ["legacy compose #1", first, true],
    ["legacy compose #4", fourth, true], ["markerless question #9", question, true],
  ] as const;
  it.each(checkpoints)("reissues %s without spending an attempt", (_, issued, legacy) => {
    const saved = PipelineStateSchema.parse(issued.state);
    if (legacy) delete saved.clarification_continue_pending;
    let out = decision(saved, choice);
    expect(out.action).toEqual(issued.action);
    expect(out.messages).toEqual([]);
    expect(out.state.current_step).toBe("clarification");
    expect(out.state.proceed_signal).toBe(false);
    expect(out.state.clarifications).toEqual(saved.clarifications);
    expect(out.state.unmatched_answers).toEqual({ clarification_continue: 2, other: 1 });
    for (let i = 0; out.state.current_step === "clarification" && i < 20; i++) {
      out = step({ state: out.state, result: dispatch(out.action) });
    }
    expect(out.state.current_step).toBe("section_generation");
  });
});

it("recovers a question from a legacy turn that saved only its text", () => {
  const state = { ...seed, clarifications: [...turns, { round: 9, asked_at: "then", question: "Who approves?" }] };
  const out = decision(state, "proceed");
  expect(out.action).toEqual({
    kind: "ask_user", question_id: "clarification_answer", header: "Round 9: Who approves?",
    description: "Answer freeform if no options listed.", options: null, multi_select: false,
  });
  const answered = step({ state: out.state, result: dispatch(out.action) });
  expect(decision(answered.state, "proceed").state.current_step).toBe("section_generation");
});

describe.each([true, undefined])("pending continuation with marker %s", (marker) => {
  it.each(["proceed", "continue"])("accepts %s", (choice) => {
    const saved = { ...seed, clarifications: turns, clarification_continue_pending: marker };
    const out = decision(saved, choice);
    expect(out.state.unmatched_answers).toEqual({ other: 1 });
    expect(out.state.clarification_continue_pending).toBe(false);
    if (choice === "proceed") {
      expect(out.messages).toContainEqual({ level: "info", text: "Clarification complete (8 rounds)." });
      expect(out.state.current_step).toBe("section_generation");
    } else {
      expect(out.action).toEqual(ninth.action);
      const asked = step({ state: out.state, result: dispatch(out.action) });
      const answered = step({ state: asked.state, result: dispatch(asked.action) });
      expect(decision(answered.state, "proceed").state.current_step).toBe("section_generation");
    }
  });
});
