import { z } from "zod";

export const AcceptanceIdSchema = z.string().regex(/^AC-\d{1,9}$/);
const TicketId = z.string().regex(/^TICKET-\d{3}$/);
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

const prose = z.string().trim().min(1);
export const JiraTicketSchema = TicketSchema.extend({
  title: prose,
  description: prose,
  source: prose,
  phase: z.int().positive(),
  epic: prose,
});
export type JiraTicket = z.infer<typeof JiraTicketSchema>;

export const JiraDraftSchema = z.strictObject({
  tickets: z.array(JiraTicketSchema).min(1).superRefine(validateGraph),
});
