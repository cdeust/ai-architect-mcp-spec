import { extractJsonObject, JiraDraftSchema, unknownTicketCriterion, type JiraTicket } from "@prd-gen/core";
import { z } from "zod";

/**
 * Validate the engineer's structured tickets against the document's criteria.
 * A fenced or prefaced object is read like every other structured agent reply.
 */
export function parseJiraDraft(raw: string, criteria: ReadonlySet<string>) {
  let json: unknown;
  try {
    json = extractJsonObject(raw);
  } catch {
    return { error: "Expected a JSON object containing tickets." };
  }
  const parsed = JiraDraftSchema.safeParse(json);
  if (!parsed.success) return { error: z.prettifyError(parsed.error) };
  const unknown = unknownTicketCriterion(parsed.data.tickets, criteria);
  return unknown ? { error: unknown } : { tickets: parsed.data.tickets };
}

function points(tickets: JiraTicket[]) {
  // Each estimate is a safe integer. A sum of valid estimates can exceed that range.
  return tickets.reduce((sum, ticket) => sum + BigInt(ticket.story_points), 0n);
}

/** Groups in first-seen order (Map.groupBy is outside the configured ES library). */
function groupBy<K>(tickets: JiraTicket[], key: (ticket: JiraTicket) => K): Map<K, JiraTicket[]> {
  const groups = new Map<K, JiraTicket[]>();
  for (const ticket of tickets) {
    const group = groups.get(key(ticket));
    if (group) group.push(ticket);
    else groups.set(key(ticket), [ticket]);
  }
  return groups;
}

function renderTicket(ticket: JiraTicket): string {
  return [
    `#### ${ticket.id} — ${ticket.title}`,
    "",
    ticket.description,
    "",
    `- **Acceptance Criteria:** ${ticket.acceptance_ids.join(", ")}`,
    `- **Story Points:** ${ticket.story_points}`,
    `- **Depends On:** ${ticket.depends_on.join(", ") || "None"}`,
    `- **Source:** ${ticket.source}`,
  ].join("\n");
}

export function renderJiraTickets(tickets: JiraTicket[]): string {
  const phases = groupBy(tickets, ticket => ticket.phase);
  const summary = ["## Summary", "", "| Phase | Story Count | Total SP |", "| --- | ---: | ---: |"];
  const document = ["# JIRA Tickets"];
  for (const phase of [...phases.keys()].sort((a, b) => a - b)) {
    const stories = phases.get(phase)!;
    const total = points(stories);
    document.push(`## Phase ${phase} (${total} SP)`);
    for (const [epic, epicStories] of groupBy(stories, story => story.epic)) {
      document.push(`### ${epic} (${points(epicStories)} SP)`, ...epicStories.map(renderTicket));
    }
    summary.push(`| Phase ${phase} | ${stories.length} | ${total} |`);
  }
  summary.push(`| **Total** | ${tickets.length} | ${points(tickets)} |`);
  return [...document, summary.join("\n")].join("\n\n");
}
