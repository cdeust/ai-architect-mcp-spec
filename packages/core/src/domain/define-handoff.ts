import { z } from "zod";
import { AcceptanceIdSchema, HandoffTicketsSchema, unknownTicketCriterion } from "./jira-tickets.js";

const RequirementId = z.string().regex(/^(?:FR|NFR)-\d{1,9}$/);
export function hasDefineStatementText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text.replace(/(?<![\w-])(?:FR|NFR)-\d{1,9}(?![\w-])/g, ""));
}

const Statement = z.string().refine(hasDefineStatementText);

/** Closed, data-only contract at the Define boundary. */
export const DefineHandoffV1Schema = z.strictObject({
  version: z.literal(1),
  run_id: z.string().min(1),
  requirements: z.array(z.strictObject({ id: RequirementId, text: Statement })).min(1),
  acceptance: z.array(z.strictObject({
    id: AcceptanceIdSchema,
    text: Statement,
    requirement_ids: z.array(RequirementId).min(1),
  })).min(1),
  tickets: HandoffTicketsSchema.optional(),
}).superRefine(({ requirements, acceptance, tickets }, ctx) => {
  const allRequirements = new Set(requirements.map(({ id }) => id));
  const allAcceptance = new Set(acceptance.map(({ id }) => id));
  if (allRequirements.size !== requirements.length || allAcceptance.size !== acceptance.length) {
    ctx.addIssue({ code: "custom", message: "Define identifiers must be unique." });
  }
  const covered = new Set<string>();
  for (const { id, requirement_ids } of acceptance) {
    if (new Set(requirement_ids).size !== requirement_ids.length) {
      ctx.addIssue({ code: "custom", message: `${id} repeats a requirement reference.` });
    }
    for (const requirement of requirement_ids) {
      if (!allRequirements.has(requirement)) {
        ctx.addIssue({ code: "custom", message: `${id} references unknown requirement ${requirement}.` });
      }
      covered.add(requirement);
    }
  }
  for (const requirement of allRequirements) {
    if (!covered.has(requirement)) {
      ctx.addIssue({ code: "custom", message: `${requirement} has no acceptance criterion.` });
    }
  }
  const unknown = tickets && unknownTicketCriterion(tickets, allAcceptance);
  if (unknown) ctx.addIssue({ code: "custom", path: ["tickets"], message: unknown });
});

export type DefineHandoffV1 = z.infer<typeof DefineHandoffV1Schema>;
