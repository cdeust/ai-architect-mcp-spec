import type { StepHandler } from "../runner.js";
import type { ActionResult, HandlerAction } from "../types/actions.js";
import type { PipelineState } from "../types/state.js";
import {
  CAPABILITIES,
  clarificationRangeFor,
  extractJsonObject,
} from "@prd-gen/core";
import {
  buildClarificationPrompt,
  type GeneratedQuestion,
} from "@prd-gen/meta-prompting";

/**
 * Clarification loop (SKILL.md Rule 1).
 *
 * Two-phase per round:
 *   Phase A — compose the question:   spawn engineer with buildClarificationPrompt
 *                                     → receive { question, options, rationale }
 *                                     → store as a pending clarification turn
 *   Phase B — ask the user:           emit ask_user with the composed question
 *                                     → receive answer
 *                                     → store, then either ask continue/proceed,
 *                                       advance to budget, or repeat A.
 *
 * Continuation rules:
 *   - completed >= max  → auto-advance.
 *   - completed <  min  → loop directly back to phase A (no continue prompt).
 *   - in between        → ask user proceed-or-continue; their answer drives next.
 */

import {
  QUESTION_ID_CONTINUE,
  clarificationComposeInvocationId,
} from "./protocol-ids.js";

const QUESTION_ID_ANSWER = "clarification_answer";
const COMPOSE_BATCH_PREFIX = "clarification_compose_";

function composeBatchId(round: number): string {
  return `${COMPOSE_BATCH_PREFIX}${round}`;
}
const composeInvocationId = clarificationComposeInvocationId;

interface PendingTurnInternal {
  round: number;
  question: string;
  options: readonly string[] | null;
  rationale: string;
  asked_at: string;
}

function isComposeResult(
  result: ActionResult | undefined,
  round: number,
): result is Extract<ActionResult, { kind: "subagent_batch_result" }> {
  return (
    result?.kind === "subagent_batch_result" &&
    result.batch_id === composeBatchId(round)
  );
}

function tryParseGeneratedQuestion(rawText: string): GeneratedQuestion | null {
  try {
    const obj = extractJsonObject(rawText) as Partial<GeneratedQuestion>;
    if (typeof obj.question !== "string" || !obj.question.trim()) return null;
    const options =
      Array.isArray(obj.options) && obj.options.every((o) => typeof o === "string")
        ? obj.options
        : null;
    const rationale =
      typeof obj.rationale === "string" ? obj.rationale : "";
    return { question: obj.question.trim(), options, rationale };
  } catch {
    return null;
  }
}

function composeAction(state: PipelineState, round: number): HandlerAction {
  const prompt = buildClarificationPrompt({
    feature_description: state.feature_description,
    prd_context: state.prd_context!,
    request_size: state.request_size,
    round,
    prior_qa: state.clarifications.map((c) => ({
      question: c.question,
      answer: c.answer,
    })),
    recall_summary: "",
    // git-historian investigation report (Phase 2), threaded so clarification
    // questions can be informed by provenance/prior-attempt context without
    // re-asking something history already answers. "" when no codebase or
    // the investigation returned nothing.
    git_history_summary: state.git_history_summary ?? "",
  });
  return {
    kind: "spawn_subagents",
    purpose: "draft",
    batch_id: composeBatchId(round),
    invocations: [
      {
        invocation_id: composeInvocationId(round),
        subagent_type: "zetetic-team-subagents:engineer",
        description: `Compose clarification question (round ${round})`,
        prompt,
        isolation: "none",
      },
    ],
  };
}

function askComposedQuestion(turn: PendingTurnInternal): HandlerAction {
  const optionsForUser =
    turn.options && turn.options.length >= 2 && turn.options.length <= 4
      ? turn.options.map((o) => ({ label: o }))
      : null;
  return {
    kind: "ask_user",
    question_id: QUESTION_ID_ANSWER,
    header: `Round ${turn.round}: ${turn.question}`,
    description: turn.rationale || "Answer freeform if no options listed.",
    options: optionsForUser,
    multi_select: false,
  };
}

interface RoundBounds {
  readonly min: number;
  readonly max: number;
}

function computeBounds(state: PipelineState): RoundBounds {
  const range = clarificationRangeFor(state.prd_context!, state.request_size);
  const max = Math.min(range[1], CAPABILITIES.maxClarificationRounds);
  // Clamp min so we never require more questions than the cap allows.
  const min = Math.min(range[0], max);
  return { min, max };
}

function handleProceedOrContinue(
  state: PipelineState,
  result: Extract<ActionResult, { kind: "user_answer" }>,
): { state: PipelineState; action: HandlerAction } {
  const choice = (result.freeform ?? result.selected[0] ?? "").toLowerCase();
  if (choice.includes("proceed") || choice === "yes") {
    return {
      state: { ...state, proceed_signal: true, current_step: "budget" },
      action: {
        kind: "emit_message",
        message: `Clarification complete (${state.clarifications.length} rounds).`,
      },
    };
  }
  return {
    state,
    action: composeAction(state, state.clarifications.length + 1),
  };
}

function recordAnswerAndDispatch(
  state: PipelineState,
  result: Extract<ActionResult, { kind: "user_answer" }>,
  bounds: RoundBounds,
): { state: PipelineState; action: HandlerAction } | null {
  const lastTurn = state.clarifications[state.clarifications.length - 1];
  if (!lastTurn || lastTurn.answer !== undefined) return null;

  const updatedTurn = {
    ...lastTurn,
    answer: result.freeform ?? result.selected.join(", "),
    answered_at: new Date().toISOString(),
  };
  const clarifications = [...state.clarifications.slice(0, -1), updatedTurn];
  const completed = clarifications.length;

  if (completed >= bounds.max) {
    return {
      state: {
        ...state,
        clarifications,
        proceed_signal: true,
        current_step: "budget",
      },
      action: {
        kind: "emit_message",
        message: `Reached max clarification rounds (${bounds.max}). Proceeding.`,
      },
    };
  }

  if (completed < bounds.min) {
    return {
      state: { ...state, clarifications },
      action: composeAction({ ...state, clarifications }, completed + 1),
    };
  }

  return {
    state: { ...state, clarifications },
    action: {
      kind: "ask_user",
      question_id: QUESTION_ID_CONTINUE,
      header: `Asked ${completed} questions. Proceed?`,
      description: `Min for this run: ${bounds.min}. Max: ${bounds.max}. 'proceed' to generate the PRD, 'continue' for more questions.`,
      options: [
        { label: "proceed", description: "Generate the PRD now" },
        { label: "continue", description: "Ask another question" },
      ],
      multi_select: false,
    },
  };
}

function handleComposedQuestion(
  state: PipelineState,
  result: Extract<ActionResult, { kind: "subagent_batch_result" }>,
  expectedRound: number,
): { state: PipelineState; action: HandlerAction } {
  const response = result.responses.find(
    (r) => r.invocation_id === composeInvocationId(expectedRound),
  );
  const generated = response?.raw_text
    ? tryParseGeneratedQuestion(response.raw_text)
    : null;

  const turn: PendingTurnInternal = generated
    ? {
        round: expectedRound,
        question: generated.question,
        options: generated.options,
        rationale: generated.rationale,
        asked_at: new Date().toISOString(),
      }
    : {
        round: expectedRound,
        question:
          response?.error ??
          `What is the most important detail about "${state.feature_description}" that should drive this PRD?`,
        options: null,
        rationale: generated
          ? ""
          : "Subagent did not return a parseable question; using fallback.",
        asked_at: new Date().toISOString(),
      };

  return appendTurnAndAsk(state, turn);
}

export const handleClarification: StepHandler = ({ state, result }) => {
  if (!state.prd_context) {
    return {
      state,
      action: {
        kind: "failed",
        reason: "Clarification reached without PRD context",
        step: "clarification",
      },
    };
  }

  const bounds = computeBounds(state);
  const expectedRound = state.clarifications.length + 1;

  if (
    result?.kind === "user_answer" &&
    result.question_id === QUESTION_ID_CONTINUE
  ) {
    return handleProceedOrContinue(state, result);
  }

  if (
    result?.kind === "user_answer" &&
    result.question_id === QUESTION_ID_ANSWER
  ) {
    // recordAnswerAndDispatch returns null iff the answer cannot be matched
    // to a pending unanswered turn (duplicate answer or no question yet).
    // Falling through re-composes a question — correct stall recovery.
    const out = recordAnswerAndDispatch(state, result, bounds);
    if (out) return out;
  }

  if (isComposeResult(result, expectedRound)) {
    return handleComposedQuestion(state, result, expectedRound);
  }

  return { state, action: composeAction(state, expectedRound) };
};

function appendTurnAndAsk(
  state: PipelineState,
  turn: PendingTurnInternal,
): { state: PipelineState; action: HandlerAction } {
  const clarifications = [
    ...state.clarifications,
    {
      round: turn.round,
      question: turn.question,
      asked_at: turn.asked_at,
    },
  ];
  return {
    state: { ...state, clarifications },
    action: askComposedQuestion(turn),
  };
}
