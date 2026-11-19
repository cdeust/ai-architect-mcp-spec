type Option<Label extends string> = { label: Label };
type Answer = { selected: readonly string[]; freeform?: string };

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Return the question's original label so routing uses the same choices the user saw. */
export function matchOfferedOption<Label extends string>(
  options: readonly Option<Label>[],
  answer: Answer,
): Label | undefined {
  const chosen = normalize(answer.selected[0] ?? answer.freeform ?? "");
  if (!chosen) return undefined;
  return options.find(({ label }) => normalize(label) === chosen)?.label;
}

export function retryOptionQuestion<Q extends { description: string; options: readonly Option<string>[] }>(question: Q) {
  const labels = question.options.map(({ label }) => label).join(", ");
  return { ...question, description: `${question.description}\n\nYour answer was not one of the options. Choose one of: ${labels}.` };
}
