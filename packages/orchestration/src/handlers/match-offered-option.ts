type Option<Label extends string> = { label: Label };
type Answer = { selected: readonly string[]; freeform?: string };

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Return the original accepted label, including choices the host can only expose as text. */
export function matchOfferedOption<Label extends string>(
  options: readonly Option<Label>[],
  answer: Answer,
): Label | undefined {
  const selected = normalize(answer.selected[0] ?? "");
  const typed = normalize(answer.freeform ?? "");
  if (selected && typed && selected !== typed) return undefined;
  const chosen = selected || typed;
  if (!chosen) return undefined;
  return options.find(({ label }) => normalize(label) === chosen)?.label;
}

export function retryOptionQuestion<Q extends { description: string; options: readonly Option<string>[] }>(question: Q, accepted = question.options) {
  const labels = accepted.map(({ label }) => label).join(", ");
  return { ...question, description: `${question.description}\n\nYour answer was not one of the options. Choose one of: ${labels}.` };
}
