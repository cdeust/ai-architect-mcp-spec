/**
 * Clarification prompts — generate the next clarification question for the user.
 *
 * Called by the host (via the engineer subagent) when the orchestrator's
 * clarification handler emits an `ask_user` action with `question_id =
 * clarification_answer`. The host invokes the engineer with this prompt to
 * COMPOSE a question, then asks the user via AskUserQuestion.
 */

import {
  PRD_CONTEXT_CONFIGS,
  REQUEST_SIZE_DEFAULT,
  clarificationRangeFor,
  type PRDContext,
  type RequestSize,
} from "@prd-gen/core";

export interface ClarificationPromptInput {
  readonly feature_description: string;
  readonly prd_context: PRDContext;
  /**
   * The declared size of the request (#119): the round count the question
   * composer is told comes from it when it sets one. Absent: `standard`.
   */
  readonly request_size?: RequestSize;
  readonly round: number;
  readonly prior_qa: ReadonlyArray<{ question: string; answer?: string }>;
  readonly recall_summary: string;
  /**
   * git-historian investigation report for the feature's zone
   * (state.git_history_summary). Optional — absent/empty when no codebase,
   * pre-Phase-2 callers, or the investigation returned nothing. Rendered
   * truncated to 2000 chars, matching `recall_summary`'s existing
   * `<codebase_context>` truncation below.
   *
   * source: Phase 2 (2026-07-14) — git-historian stage.
   */
  readonly git_history_summary?: string;
}

export function buildClarificationPrompt(
  input: ClarificationPromptInput,
): string {
  const ctx = PRD_CONTEXT_CONFIGS[input.prd_context];
  // prior_qa is the full chronological clarification history (round 1 first,
  // no gaps, no sliding window — see handlers/clarification.ts where each
  // turn's round is assigned as `state.clarifications.length + 1` at append
  // time). The round label for the entry at index `idx` is therefore `idx + 1`.
  const priorBlock = input.prior_qa.length
    ? input.prior_qa
        .map(
          (qa, idx) =>
            `Round ${idx + 1}:\nQ: ${qa.question}\nA: ${qa.answer ?? "(no answer)"}`,
        )
        .join("\n\n")
    : "(no prior questions)";

  return [
    `<role>You are eliciting requirements for a ${ctx.displayName} PRD.</role>`,
    "",
    `<feature>${input.feature_description}</feature>`,
    "",
    `<round>${input.round} of ${clarificationRangeFor(input.prd_context, input.request_size ?? REQUEST_SIZE_DEFAULT)[1]}</round>`,
    "",
    `<prior_questions_and_answers>`,
    priorBlock,
    `</prior_questions_and_answers>`,
    "",
    input.recall_summary
      ? `<codebase_context>\n${input.recall_summary.slice(0, 2000)}\n</codebase_context>`
      : "",
    input.git_history_summary
      ? `<git_history>\n${input.git_history_summary.slice(0, 2000)}\n</git_history>`
      : "",
    "",
    `<task>`,
    `Generate ONE clarification question that:`,
    `- Addresses the highest-uncertainty area not yet covered`,
    `- Cannot be answered by reading prior answers or codebase context above`,
    `- Has a concrete answer (not "tell me more about X")`,
    `</task>`,
    "",
    `<output_format>`,
    `Return EXACTLY ONE JSON object, nothing else:`,
    `{`,
    `  "question": "<the question to ask the user>",`,
    `  "options": ["<option 1>", "<option 2>", "<option 3>"] | null,`,
    `  "rationale": "<why this question now, in one sentence>"`,
    `}`,
    `If options is non-null, the user picks from a fixed set. Otherwise freeform.`,
    `</output_format>`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export interface GeneratedQuestion {
  readonly question: string;
  readonly options: readonly string[] | null;
  readonly rationale: string;
}
