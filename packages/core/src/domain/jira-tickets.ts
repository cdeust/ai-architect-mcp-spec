import { z } from "zod";

export const AcceptanceIdSchema = z.string().regex(/^AC-\d{1,9}$/);
// TICKET-001 to TICKET-999: there is no ticket zero, so at most 999 tickets (owner decision, 2026-11-25).
const TICKET_ID = /^TICKET-(?!000)\d{3}$/;
const TicketId = z.string().regex(TICKET_ID);
const unique = (ids: string[]) => new Set(ids).size === ids.length;

// Source: architect-os 8dde031a, packages/contracts/src/tickets.ts.
function fibonacci(points: number): boolean {
  let previous = 1;
  let current = 2;
  while (previous < points) [previous, current] = [current, previous + current];
  return previous === points;
}

const TicketSchema = z.strictObject({
  id: TicketId,
  story_points: z.int().refine(fibonacci, "TICKET_POINTS_INVALID"),
  depends_on: z.array(TicketId).refine(unique, "TICKET_DEPENDENCY_DUPLICATE"),
  acceptance_ids: z.array(AcceptanceIdSchema).min(1).refine(unique, "TICKET_ACCEPTANCE_DUPLICATE"),
});

type Ticket = z.infer<typeof TicketSchema>;

// Use a topological walk so prerequisite validation is independent of ticket order.
function validateGraph(tickets: Ticket[], ctx: z.RefinementCtx) {
  // A malformed ID is already reported by its item; the graph never echoes it.
  if (!tickets.every(({ id, depends_on }) => TICKET_ID.test(id) && depends_on.every(ref => TICKET_ID.test(ref)))) return;
  const graph = new Map(tickets.map(({ id, depends_on }) => [id, { remaining: depends_on.length, successors: [] as string[] }]));
  if (graph.size !== tickets.length) {
    ctx.addIssue({ code: "custom", message: "TICKET_ID_DUPLICATE" });
    return;
  }
  const ready: string[] = [];
  for (const { id, depends_on } of tickets) {
    if (depends_on.length === 0) ready.push(id);
    for (const prerequisite of depends_on) {
      const entry = graph.get(prerequisite);
      if (!entry) {
        ctx.addIssue({ code: "custom", message: `TICKET_DEPENDENCY_UNKNOWN: ${id} → ${prerequisite}` });
        return;
      }
      entry.successors.push(id);
    }
  }
  for (const id of ready) {
    for (const successor of graph.get(id)!.successors) {
      const entry = graph.get(successor)!;
      if (--entry.remaining === 0) ready.push(successor);
    }
  }
  if (ready.length !== tickets.length) ctx.addIssue({ code: "custom", message: "TICKET_DEPENDENCY_CYCLE" });
}

export function unknownTicketCriterion(tickets: readonly Ticket[], criteria: ReadonlySet<string>) {
  for (const { id, acceptance_ids } of tickets) {
    const unknown = acceptance_ids.find(criterion => !criteria.has(criterion));
    if (unknown) return `TICKET_ACCEPTANCE_UNKNOWN: ${id} → ${unknown}`;
  }
  return undefined;
}

export const HandoffTicketsSchema = z.array(TicketSchema).min(1).superRefine(validateGraph);

// The prose is rendered into the operator's 07-jira-tickets.md. A heading or
// list field stays on its line, so it cannot forge a ticket, a total or a
// heading the handoff does not carry; no field holds an invisible format character.
const prose = z.string().trim().min(1).regex(/^[^\p{Cc}\p{Cf}\u2028\u2029]*$/u, "TICKET_TEXT_NOT_SINGLE_LINE");
// One character class, no alternation, so the match is linear: Cc is U+0000-U+001F
// and U+007F-U+009F; only LF (U+000A) is allowed of them.
const paragraphs = z.string().trim().min(1)
  .regex(/^[^\x00-\x09\x0b-\x1f\x7f-\x9f\p{Cf}\u2028\u2029]*$/u, "TICKET_TEXT_CONTROL_CHARACTER");
export const JiraTicketSchema = TicketSchema.extend({
  title: prose,
  description: paragraphs,
  source: prose,
  phase: z.int().positive(),
  epic: prose,
});
export type JiraTicket = z.infer<typeof JiraTicketSchema>;

/** The producer's tickets: a checkpoint that says "passed" holds a valid graph. */
export const JiraTicketsSchema = z.array(JiraTicketSchema).min(1).superRefine(validateGraph);

export const JiraDraftSchema = z.strictObject({ tickets: JiraTicketsSchema });

/**
 * What the Jira step recorded. `invalid`: the reply was refused; `missing`:
 * no reply came back; `skipped`: no source section to build from.
 */
export const JiraResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("passed"), tickets: JiraTicketsSchema }),
  z.strictObject({ status: z.literal("failed"), cause: z.enum(["invalid", "missing", "skipped"]), detail: z.string() }),
]);
export type JiraResult = z.infer<typeof JiraResultSchema>;

/** The handoff keeps the estimates and links, in the order of the shared ticket schema. */
export function toHandoffTickets(tickets: readonly JiraTicket[]): Ticket[] {
  return tickets.map(({ id, story_points, depends_on, acceptance_ids }) => ({ id, story_points, depends_on, acceptance_ids }));
}
