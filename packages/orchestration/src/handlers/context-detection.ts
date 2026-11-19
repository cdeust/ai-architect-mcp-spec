import { matchOfferedOption, retryOptionQuestion } from "./match-offered-option.js";
import type { StepHandler } from "../runner.js";
import {
  PRD_CONTEXT_CONFIGS,
  CAPABILITIES,
  REQUEST_SIZE_CONFIGS,
  REQUEST_SIZE_DEFAULT,
  effectiveRequestSize,
  type PRDContext,
} from "@prd-gen/core";
import type { PipelineState } from "../types/state.js";

/**
 * The words that name a kind of PRD. No word names a size: the size of a
 * request is declared by the host at start_pipeline (`request_size`, #119).
 * The host has the whole conversation to judge it; a word list has one
 * sentence, and needs a new rule for each way of writing it ("non-trivial",
 * "a one-line change took down checkout").
 */
const TRIGGER_WORDS: Record<PRDContext, readonly string[]> = {
  proposal: ["proposal", "pitch", "stakeholder"],
  feature: ["feature", "build", "implement", "add support"],
  bug: ["bug", "fix", "broken", "regression", "defect"],
  incident: ["incident", "outage", "production issue", "p0", "p1"],
  poc: ["poc", "proof of concept", "spike", "feasibility"],
  mvp: ["mvp", "minimum viable", "v1"],
  release: ["release", "ship", "production launch"],
  cicd: ["ci", "cd", "ci/cd", "pipeline", "deploy automation"],
};

/**
 * An incident is read before every other kind: "Outage: a one-line fix took
 * down checkout" is an incident, though "fix" names a bug. Its report needs
 * the sections of an incident, and no size shortens them.
 */
function detectFromText(text: string): PRDContext | null {
  const lower = text.toLowerCase();
  if (TRIGGER_WORDS.incident.some((t) => lower.includes(t))) return "incident";
  for (const [ctx, triggers] of Object.entries(TRIGGER_WORDS) as [
    PRDContext,
    readonly string[],
  ][]) {
    if (triggers.some((t) => lower.includes(t))) return ctx;
  }
  return null;
}

const QUESTION_ID = "prd_context";

/**
 * precondition:  `context` is the kind the run will have; `said` words it for
 *                the message, from the display name of the kind.
 * postcondition: the run has its kind and goes on to input_analysis. The
 *                message says the kind, then the size when one applies. When
 *                the host declared a size that is not for this kind (an
 *                incident is never a fast path), it says the run is held to
 *                the plan of its kind: a declaration is never dropped
 *                without a word. When a size with a plan of its own is kept
 *                for a kind the server read from the words (`guessed`), it
 *                says what that guess cannot see: an incident is exempt from
 *                a fast path only when its kind is known, and its words may
 *                not name it ("checkout returns 500 since the deploy").
 */
function settle(state: PipelineState, context: PRDContext, said: (kind: string) => string, guessed = false) {
  const kept = effectiveRequestSize(context, state.request_size);
  let message = said(PRD_CONTEXT_CONFIGS[context].displayName);
  if (kept !== state.request_size) {
    message += `. The declared size "${state.request_size}" is not applied: a run of this kind keeps the rounds and sections of its kind.`;
  } else if (kept !== REQUEST_SIZE_DEFAULT) {
    message += `. Request size: ${REQUEST_SIZE_CONFIGS[kept].displayName}.`;
    if (guessed) {
      message += ` The kind was read from the words of the description, not declared: if this request is an incident, start again with prd_context "incident", which keeps the plan of its kind.`;
    }
  }
  return {
    state: { ...state, prd_context: context, current_step: "input_analysis" as const },
    action: { kind: "emit_message" as const, message },
  };
}

const declaredOrAnswered = (kind: string) => `PRD context: ${kind}`;
const detectedFromWords = (kind: string) => `PRD context detected: ${kind} (from trigger words)`;

function refuse(reason: string, state: PipelineState) {
  return {
    state,
    action: { kind: "failed" as const, reason, step: "context_detection" as const },
  };
}

export const handleContextDetection: StepHandler = ({ state, result }) => {
  const allowed = CAPABILITIES.allowedContextTypes;

  // Declared by the host at start_pipeline: kept as it is, under the same
  // rule as a detected or an answered one.
  if (state.prd_context) {
    if (!allowed.includes(state.prd_context)) {
      return refuse(`PRD context not allowed: ${state.prd_context}`, state);
    }
    return settle(state, state.prd_context, declaredOrAnswered);
  }

  const answer = result?.kind === "user_answer" && result.question_id === QUESTION_ID ? result : undefined;
  if (!answer) {
    const detected = detectFromText(state.feature_description);
    if (detected && allowed.includes(detected)) return settle(state, detected, detectedFromWords, true);
  }

  // Ask user — restricted to tier-allowed options.
  const options = allowed.map((ctx) => ({
    label: ctx,
    description: PRD_CONTEXT_CONFIGS[ctx].description,
  }));

  const question = {
    kind: "ask_user" as const,
    question_id: QUESTION_ID,
    header: "Which kind of PRD?",
    description:
      "I couldn't infer the PRD type from your request. Pick the closest match: it sets what the PRD covers, and its clarification depth and sections unless the declared request size sets them.",
    // source: protocol constraint. AskUserActionSchema.options enforces
    // .max(4) at the schema level (types/actions.ts). Slicing here ensures
    // a tier with >4 allowed contexts doesn't fail Zod parsing on the
    // emitted action. Cross-audit code-reviewer H6 (Phase 3+4, 2026-04).
    options: options.slice(0, 4),
    multi_select: false,
  };
  if (!answer) return { state, action: question };
  const context = matchOfferedOption(question.options, answer);
  if (context === undefined) return { state, action: retryOptionQuestion(question) };
  return settle(state, context, declaredOrAnswered);
};
