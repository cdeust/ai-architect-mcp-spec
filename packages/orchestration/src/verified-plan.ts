import { createHash } from "node:crypto";
import type { DefineHandoffV1 } from "@prd-gen/core";
import { z } from "zod";
import { defineEnvelopeText } from "./define-handoff.js";

// Source: architect-os fcf9d2c6, packages/sandbox/src/step-record.ts (isStepName).
const StepName = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const ProposalSchema = z.strictObject({
  step: StepName,
  objective: z.string(),
  verification: z.string(),
  acceptance_ids: z.array(z.string()),
});

function objectiveFor(define: DefineHandoffV1, intent: string): string {
  return [intent.trim(), ...define.requirements.map(({ id, text }) => `${id}: ${text}`)].join("\n").trimEnd();
}

function verificationFor(define: DefineHandoffV1): string {
  return define.acceptance.map(({ id, text, requirement_ids }) =>
    `${id} [${requirement_ids.join(", ")}]: ${text}`,
  ).join("\n").trimEnd();
}

type Proposal = z.infer<typeof ProposalSchema>;

/** A strict proposal must match the saved source, including order, wording and requirement links. */
export function verifyPlanProposal(
  define: DefineHandoffV1, intent: string, value: unknown,
): Proposal | undefined {
  const parsed = ProposalSchema.safeParse(value);
  if (!parsed.success || intent.trim().length === 0) return undefined;

  const proposal = parsed.data;
  const ids = proposal.acceptance_ids;
  if (ids.length !== define.acceptance.length ||
      define.acceptance.some(({ id }, index) => ids[index] !== id) ||
      proposal.objective !== objectiveFor(define, intent) ||
      proposal.verification !== verificationFor(define)) return undefined;
  return proposal;
}

/** Both consumers hash the same compact UTF-8 JSON file including its terminating LF. */
function fileSha256(text: string): string {
  return createHash("sha256").update(text + "\n").digest("hex");
}

/** Derive a one-step traceability plan. The caller supplies a validated Define projection. */
export function buildVerifiedPlan(define: DefineHandoffV1, intent: string, step: string | undefined) {
  const name = StepName.safeParse(step);
  if (!name.success) {
    return { error: { code: "plan_step_invalid", message: "Supply a valid architect-os Step name in plan_step." } };
  }

  const proposal = verifyPlanProposal(define, intent, {
    step: name.data,
    objective: objectiveFor(define, intent),
    verification: verificationFor(define),
    acceptance_ids: define.acceptance.map(({ id }) => id),
  });
  if (!proposal) {
    return { error: { code: "plan_source_invalid", message: "The saved intent and Define criteria must yield a complete plan." } };
  }

  const binding = {
    version: 1 as const,
    run_id: define.run_id,
    define_sha256: fileSha256(defineEnvelopeText(define)),
    proposal_sha256: fileSha256(JSON.stringify(proposal)),
  };
  return { verified_plan: { ...binding, plan_sha256: fileSha256(JSON.stringify(binding)), proposal } };
}
