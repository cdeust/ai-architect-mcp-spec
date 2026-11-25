/**
 * JIRA ticket generation prompt.
 *
 * Takes the requirements + user_stories + acceptance_criteria sections and
 * produces a self-contained prompt for the engineer subagent to emit a
 * structured tickets. The pipeline renders the operator's Markdown document.
 */

export interface JiraPromptInput {
  readonly feature_description: string;
  readonly source_sections: ReadonlyArray<{
    section_type: string;
    content: string;
  }>;
}

const RULES = [
  '1. Output ONLY JSON in this form, with no other keys, preamble or fences: {"tickets":[{"id":"TICKET-001","title":"Task title","description":"Work to do","acceptance_ids":["AC-001"],"story_points":3,"depends_on":[],"source":"FR-001","phase":1,"epic":"Delivery"}]}',
  "2. AC IDs MUST match the AC-XXX IDs in the source. NEVER create new AC numbering.",
  "3. Use distinct TICKET-NNN IDs, at least one distinct acceptance ID per ticket, and positive Fibonacci story points (1, 2, 3, 5, 8, ...). Cite the source in each ticket.",
  "4. SP totals and the summary are computed from tickets. Omit them from the JSON.",
  "5. List only existing prerequisites, once each. No self-dependency or other cycle.",
  "6. Distribute SP unevenly — real complexity is uneven.",
  "7. Use positive integer phase numbers and name each epic. Phases reflect delivery order.",
];

export function buildJiraPrompt(input: JiraPromptInput): string {
  const sourceBlock = input.source_sections
    .filter((s) => s.content)
    .map((s) => `## Source: ${s.section_type}\n\n${s.content}`)
    .join("\n\n");

  return [
    `<role>You generate JIRA tickets from a PRD.</role>`,
    "",
    `<feature>${input.feature_description}</feature>`,
    "",
    `<source_prd>`,
    sourceBlock,
    `</source_prd>`,
    "",
    `<rules>`,
    RULES.join("\n"),
    `</rules>`,
    "",
    `Produce the structured JIRA tickets now.`,
  ].join("\n");
}
