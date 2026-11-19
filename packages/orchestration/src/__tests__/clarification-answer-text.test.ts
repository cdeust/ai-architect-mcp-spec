import { expect, it } from "vitest";
import { newPipelineState, step } from "../index.js";

it.each([
  ["", "first, second"],
  [" \t ", "first, second"],
  ["  typed  detail\n", "typed  detail"],
  [undefined, "first, second"],
])("records the exact answer for freeform %j", (freeform, expected) => {
  const state = newPipelineState({ run_id: "answer-text", feature_description: "x", prd_context: "feature" });
  const out = step({
    state: { ...state, current_step: "clarification", clarifications: [{ round: 1, asked_at: "now", question: "Detail?" }] },
    result: { kind: "user_answer", question_id: "clarification_answer", selected: ["first", "second"], freeform },
  });
  expect(out.state.clarifications.map(turn => turn.answer)).toEqual([expected]);
  expect(out.action).toMatchObject({ kind: "spawn_subagents", batch_id: "clarification_compose_2" });
});
