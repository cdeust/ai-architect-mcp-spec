import { answerOptionQuestion } from "./match-offered-option.js";
import { CLARIFICATION_TURN_CHARS } from "../types/state/bounded-io.js";
import type { StepHandler } from "../runner.js";
import { ASK_USER_MIN_OPTIONS, ASK_USER_MAX_OPTIONS, type ActionResult, type HandlerAction } from "../types/actions.js";
import { appendError, type ClarificationTurn, type PipelineState } from "../types/state.js";
import {
  CAPABILITIES,
  clarificationRangeFor,
  extractJsonObject,
} from "@prd-gen/core";
import { buildClarificationPrompt } from "@prd-gen/meta-prompting";

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

function isComposeResult(
  result: ActionResult | undefined,
  round: number,
): result is Extract<ActionResult, { kind: "subagent_batch_result" }> {
  return (
    result?.kind === "subagent_batch_result" &&
    result.batch_id === composeBatchId(round)
  );
}

function textViolation(field: string, value: string, requireNonblank: boolean): string | null {
  if (value.length > CLARIFICATION_TURN_CHARS) {
    return `${field} has ${value.length} UTF-16 code units (maximum ${CLARIFICATION_TURN_CHARS})`;
  }
  if (requireNonblank && !value.trim()) return `${field} is blank (${value.length} UTF-16 code units)`;
  return null;
}

function parseOptions(value: unknown): string[] | null | { error: string } {
  if (value == null) return null;
  if (!Array.isArray(value)) return { error: "options must be an array or null" };
  if (value.length < ASK_USER_MIN_OPTIONS || value.length > ASK_USER_MAX_OPTIONS) {
    return { error: `options has ${value.length} entries (expected ${ASK_USER_MIN_OPTIONS} to ${ASK_USER_MAX_OPTIONS})` };
  }
  const labels: string[] = [];
  for (const [index, label] of value.entries()) {
    const field = `options[${index}]`;
    if (typeof label !== "string") return { error: `${field} must be a string` };
    const error = textViolation(field, label, true);
    if (error) return { error };
    labels.push(label);
  }
  return labels;
}

function tryParseGeneratedQuestion(rawText: string): Pick<ClarificationTurn, "question" | "options" | "rationale"> | { error: string } {
  let obj: Record<string, unknown>;
  try {
    // extractJsonObject parses the balanced object starting at the opening brace.
    obj = extractJsonObject(rawText) as Record<string, unknown>;
  } catch {
    return { error: `no parseable question object (${rawText.length} UTF-16 code units)` };
  }
  const { question, rationale = "" } = obj;
  if (typeof question !== "string") return { error: "question must be a string" };
  const questionError = textViolation("question", question, true);
  if (questionError) return { error: questionError };
  const options = parseOptions(obj.options);
  if (options && "error" in options) return options;
  if (typeof rationale !== "string") return { error: "rationale must be a string" };
  const rationaleError = textViolation("rationale", rationale, false);
  if (rationaleError) return { error: rationaleError };
  return { question, options, rationale };
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

function askComposedQuestion(turn: ClarificationTurn): HandlerAction {
  return {
    kind: "ask_user",
    question_id: QUESTION_ID_ANSWER,
    header: `Round ${turn.round}: ${turn.question}`,
    description: turn.rationale || "Answer freeform if no options listed.",
    options: turn.options?.map(label => ({ label })) ?? null,
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

const PROCEED_LABEL = "proceed";
const CONTINUE_LABEL = "continue";

function continueQuestion(completed: number, bounds: RoundBounds) {
  return {
    kind: "ask_user" as const,
    question_id: QUESTION_ID_CONTINUE,
    header: `Asked ${completed} questions. Proceed?`,
    description: `Min for this run: ${bounds.min}. Max: ${bounds.max}. '${PROCEED_LABEL}' to generate the PRD, '${CONTINUE_LABEL}' for more questions.`,
    options: [
      { label: PROCEED_LABEL, description: "Generate the PRD now" },
      { label: CONTINUE_LABEL, description: "Ask another question" },
    ],
    multi_select: false,
  };
}

function handleProceedOrContinue(
  state: PipelineState,
  result: Extract<ActionResult, { kind: "user_answer" }>,
  bounds: RoundBounds,
): { state: PipelineState; action: HandlerAction } {
  const question = continueQuestion(state.clarifications.length, bounds);
  return answerOptionQuestion(state, question, question.options, result, (answered, choice) => {
    if (choice === PROCEED_LABEL) {
      return {
        state: { ...answered, clarification_continue_pending: false, proceed_signal: true, current_step: "budget" },
        action: {
          kind: "emit_message",
          message: `Clarification complete (${state.clarifications.length} rounds).`,
        },
      };
    }
    return {
      state: { ...answered, clarification_continue_pending: false },
      action: composeAction(answered, state.clarifications.length + 1),
    };
  });
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
    answer: result.freeform?.trim() || result.selected.join(", "),
    answered_at: new Date().toISOString(),
  };
  const clarifications = [...state.clarifications];
  clarifications[clarifications.length - 1] = updatedTurn;
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

  // Each round reuses this question ID but starts with its own retry budget.
  const { [QUESTION_ID_CONTINUE]: _previousRound, ...unmatched_answers } = state.unmatched_answers;
  return {
    state: { ...state, clarifications, unmatched_answers, clarification_continue_pending: true },
    action: continueQuestion(completed, bounds),
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
  const generated = tryParseGeneratedQuestion(response?.raw_text ?? "");
  if ("error" in generated) {
    const contextual = `What is the most important detail about "${state.feature_description}" that should drive this PRD?`;
    return appendTurnAndAsk(
      appendError(state, `Clarification compose: ${generated.error}`, "upstream_failure"),
      {
        round: expectedRound,
        question: contextual.length <= CLARIFICATION_TURN_CHARS
          ? contextual : "What is the most important detail that should drive this PRD?",
        options: null,
        rationale: "Subagent did not return a parseable question; using fallback.",
        asked_at: new Date().toISOString(),
      },
    );
  }
  return appendTurnAndAsk(state, { round: expectedRound, ...generated, asked_at: new Date().toISOString() });
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

  if (result?.kind === "user_answer") {
    // For a legacy checkpoint, an answered round at or above the minimum may
    // already have offered continuation. Require an explicit decision there.
    const continuationPending = state.clarification_continue_pending ?? (
      state.clarifications.length >= bounds.min && state.clarifications[state.clarifications.length - 1]!.answer !== undefined
    );
    if (continuationPending) {
      return handleProceedOrContinue(state, result, bounds);
    }
    // The host answered a question that was never pending, so this consumes no
    // unmatched-answer attempt. Replay the open question or fall through to compose.
    if (result.question_id === QUESTION_ID_CONTINUE) {
      const lastTurn = state.clarifications.at(-1);
      if (lastTurn && lastTurn.answer === undefined) {
        return { state, action: askComposedQuestion(lastTurn) };
      }
    }
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

  return { state: { ...state, clarification_continue_pending: false }, action: composeAction(state, expectedRound) };
};

function appendTurnAndAsk(
  state: PipelineState,
  turn: ClarificationTurn,
): { state: PipelineState; action: HandlerAction } {
  const clarifications = [...state.clarifications, turn];
  return {
    state: { ...state, clarifications, clarification_continue_pending: false },
    action: askComposedQuestion(turn),
  };
}
