/**
 * Tests for handleFeasibilityGate.
 *
 * Pre-fix this handler had ZERO direct tests. Its postconditions were
 * exercised only implicitly through smoke runs (one of which assumed the
 * "ask_user happens for epic input" behaviour without inspecting the
 * specific question_id or step transition).
 *
 * source: test-engineer H1 (Phase 3+4 cross-audit, 2026-04).
 */

import { describe, expect, it } from "vitest";
import { newPipelineState, step } from "../index.js";
import type { ActionResult, PipelineState } from "../index.js";

function stateAt(
  feature_description: string,
  partial?: Partial<PipelineState>,
): PipelineState {
  const seed = newPipelineState({
    run_id: "feasibility_test",
    feature_description,
  });
  return {
    ...seed,
    current_step: "feasibility_gate",
    prd_context: "feature",
    ...partial,
  };
}

describe("feasibility-gate", () => {
  it("non-epic input advances to clarification with emit_message", () => {
    // No EPIC_SIGNALS: zero matches → not epic.
    const out = step({ state: stateAt("simple OAuth login feature") });
    // emit_message is coalesced into messages, NOT returned as action.
    expect(out.action.kind).not.toBe("ask_user");
    expect(out.state.current_step).toBe("clarification");
    expect(out.messages.some((m) => m.text.includes("Scope acceptable"))).toBe(
      true,
    );
  });

  it("input with only ONE epic signal does NOT trigger ask_user", () => {
    // looksEpic requires >=2 signals. " and " alone is one signal.
    const out = step({ state: stateAt("OAuth login and registration") });
    expect(out.action.kind).not.toBe("ask_user");
    expect(out.state.current_step).toBe("clarification");
  });

  it("input with TWO or more epic signals emits ask_user(feasibility_focus)", () => {
    // " and ", " plus ", " also " = 3 signals.
    const out = step({
      state: stateAt(
        "build OAuth login and password reset, plus also add MFA support",
      ),
    });
    expect(out.action.kind).toBe("ask_user");
    if (out.action.kind !== "ask_user") return;
    expect(out.action.question_id).toBe("feasibility_focus");
    expect(out.action.options).toBeNull();
    expect(out.action.multi_select).toBe(false);
    // State must NOT have advanced — handler is awaiting the user's answer.
    expect(out.state.current_step).toBe("feasibility_gate");
  });

  it("user_answer with freeform replaces feature_description and advances", () => {
    const initial = stateAt(
      "build OAuth login and password reset, plus also add MFA",
    );
    const answer: ActionResult = {
      kind: "user_answer",
      question_id: "feasibility_focus",
      selected: [],
      freeform: "OAuth login only",
    };
    const out = step({ state: initial, result: answer });
    expect(out.state.feature_description).toBe("OAuth login only");
    expect(out.state.current_step).toBe("clarification");
  });

  it("user_answer with selected (no freeform) uses selected[0] as focus", () => {
    const initial = stateAt(
      "build OAuth login and password reset, plus also add MFA",
    );
    const answer: ActionResult = {
      kind: "user_answer",
      question_id: "feasibility_focus",
      selected: ["OAuth login"],
    };
    const out = step({ state: initial, result: answer });
    expect(out.state.feature_description).toBe("OAuth login");
    expect(out.state.current_step).toBe("clarification");
  });

  it("user_answer with neither freeform nor selected falls back to existing description", () => {
    const initial = stateAt(
      "build OAuth login and password reset, plus also add MFA",
    );
    const answer: ActionResult = {
      kind: "user_answer",
      question_id: "feasibility_focus",
      selected: [],
    };
    const out = step({ state: initial, result: answer });
    // Defensive fallback — not an ideal user interaction but the contract
    // permits it. The state must still advance.
    expect(out.state.feature_description).toBe(initial.feature_description);
    expect(out.state.current_step).toBe("clarification");
  });
});

it.each(["", "  "])("ignores blank focus text %j", (freeform) => {
  const state = stateAt("original scope");
  for (const selected of [[], ["picked scope"]]) {
    const result = { kind: "user_answer" as const, question_id: "feasibility_focus", selected, freeform };
    expect(step({ state, result }).state.feature_description).toBe(selected[0] ?? "original scope");
  }
});

it.each([
  { freeform: "  OAuth  login\n", selected: ["other scope"] },
  { freeform: "  ", selected: ["\tOAuth  login  "] },
])("trims the chosen focus before saving and reporting it", ({ freeform, selected }) => {
  const result = { kind: "user_answer" as const, question_id: "feasibility_focus", selected, freeform };
  const out = step({ state: stateAt("original scope"), result });
  expect(out.state.feature_description).toBe("OAuth  login");
  expect(out.messages).toContainEqual({ level: "info", text: "Focused scope: OAuth  login" });
});
