import { describe, expect, it } from "vitest";
import { newPipelineState, step, type ActionResult } from "../index.js";
import { expectOptionRetry } from "./expect-option-retry.js";

describe.each(["selected", "freeform"])("malformed %s", (field) => {
  it.each(field === "selected" ? [null, undefined, 42, {}] : [null, 42, {}])("counts %j even alongside a valid label", (value) => {
    const state = { ...newPipelineState({ run_id: "invalid-field", feature_description: "x" }), current_step: "pr_gate" as const };
    const original = step({ state }).action;
    const fields = field === "selected"
      ? { selected: ["Push + open PR", value] }
      : { selected: ["Push + open PR"], freeform: value };
    const result = { kind: "user_answer", question_id: "pr_gate", ...fields } as ActionResult;
    const out = step({ state, result });
    expectOptionRetry(out.action, original);
    expect(out.state.unmatched_answers).toEqual({ pr_gate: 1 });
    expect(out.state.errors).toEqual([]);
  });
});
