import type { StepHandler } from "../runner.js";
import type { AskUserAction } from "../types/actions.js";
import type { PipelineState } from "../types/state.js";

type Option<Label extends string> = { label: Label };
type Answer = { selected: readonly string[]; freeform?: string };

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Return the original accepted label, including choices the host can only expose as text.
 * More than one nonblank selection is a contradictory answer and matches nothing.
 */
export function matchOfferedOption<Label extends string>(
  options: readonly Option<Label>[],
  answer: Answer,
): Label | undefined {
  const picks = answer.selected.map(normalize).filter(Boolean);
  if (picks.length > 1) return undefined;
  const selected = picks[0] ?? "";
  const typed = normalize(answer.freeform ?? "");
  if (selected && typed && selected !== typed) return undefined;
  const chosen = selected || typed;
  if (!chosen) return undefined;
  return options.find(({ label }) => normalize(label) === chosen)?.label;
}

/** The third unmatched answer resolves the question under its documented fallback policy. */
export function answerOptionQuestion<Label extends string>(
  state: PipelineState,
  question: AskUserAction,
  accepted: readonly Option<Label>[],
  answer: Answer,
  route: (state: PipelineState, label: Label) => ReturnType<StepHandler>,
  fallback?: NoInfer<Label>,
): ReturnType<StepHandler> {
  const id = question.question_id;
  function clearedState(): PipelineState {
    const { [id]: _cleared, ...remaining } = state.unmatched_answers;
    return { ...state, unmatched_answers: remaining };
  }
  const label = matchOfferedOption(accepted, answer);
  if (label !== undefined) {
    return route(clearedState(), label);
  }

  const count = (state.unmatched_answers[id] ?? 0) + 1;
  const saved = { ...state, unmatched_answers: { ...state.unmatched_answers, [id]: count } };
  if (count < 3) {
    const labels = accepted.map((option) => option.label).join(", ");
    const description = `${question.description}\n\nYour answer was not one of the options. Choose one of: ${labels}.`;
    return { state: saved, action: { ...question, description } };
  }

  const reason = `${id}: ${count} unmatched answers.`;
  if (fallback === undefined) {
    return { state: saved, action: { kind: "failed", step: state.current_step, reason } };
  }
  return { ...route(clearedState(), fallback), warning: `${reason} Using "${fallback}".` };
}
