import type { StepHandler } from "../runner.js";

/**
 * The step between clarification and section generation. It is in-process:
 * it checks the proceed-signal invariant set by clarification (a clean exit)
 * and moves on.
 *
 * It allocates nothing. It was named after a token budget that a separate
 * tool, `coordinate_context_budget`, computed and that no step of the
 * pipeline ever read; the tool is gone (#120). The step keeps its name, which
 * hosts and the run files of a server know (`current_step: "budget"`).
 */
export const handleBudget: StepHandler = ({ state }) => {
  if (!state.proceed_signal) {
    return {
      state,
      action: {
        kind: "failed",
        reason:
          "budget step reached without proceed_signal — clarification did not exit cleanly",
        step: "budget",
      },
    };
  }

  return {
    state: { ...state, current_step: "section_generation" },
    action: {
      kind: "emit_message",
      message: "Starting section generation.",
    },
  };
};
