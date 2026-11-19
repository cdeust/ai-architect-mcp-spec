import type { StepHandler } from "../runner.js";

/**
 * Feasibility gate (SKILL.md Rule 0).
 *
 * If feature_description contains epic-scope signals (multiple distinct
 * features joined by "and", "+", or comma-separated nouns), ask user to
 * pick ONE epic to focus on.
 *
 * For now: pass-through. Epic-detection logic stays simple — refine when
 * we have real data on what triggers "too large" PRDs.
 */

const QUESTION_ID = "feasibility_focus";
const EPIC_SIGNALS = [
  / and /i,
  / & /,
  /,\s*\w+\s*,/, // multiple comma-separated items
  /\bplus\b/i,
  /\balso\b/i,
];

function looksEpic(text: string): boolean {
  const matches = EPIC_SIGNALS.filter((re) => re.test(text)).length;
  return matches >= 2;
}

export const handleFeasibilityGate: StepHandler = ({ state, result }) => {
  if (result?.kind === "user_answer" && result.question_id === QUESTION_ID) {
    const focus = [result.freeform, result.selected[0]].find((text) => text?.trim()) ?? state.feature_description;
    return {
      state: {
        ...state,
        feature_description: focus,
        current_step: "clarification",
      },
      action: {
        kind: "emit_message",
        message: `Focused scope: ${focus}`,
      },
    };
  }

  if (looksEpic(state.feature_description)) {
    return {
      state,
      action: {
        kind: "ask_user",
        question_id: QUESTION_ID,
        header: "This looks like an epic. Pick one focus.",
        description:
          "Generating one PRD for multiple features at once produces shallow output. Which single piece should this PRD cover? Type a focused description.",
        options: null,
        multi_select: false,
      },
    };
  }

  return {
    state: { ...state, current_step: "clarification" },
    action: {
      kind: "emit_message",
      message: "Scope acceptable. Proceeding to clarification.",
    },
  };
};
