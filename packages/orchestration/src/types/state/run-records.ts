import { z } from "zod";
import { AgentIdentitySchema, ClaimSchema, PRDContextSchema } from "@prd-gen/core";

/**
 * What a concluded self-check knows about the quality of its document: the
 * figures of `validateDocument`. The run id and the audit flags are not here:
 * the composition root adds the first, and no audit-flag pass runs in the
 * pipeline (#121).
 */
export const QualityScoreRecordSchema = z.object({
  prd_context: PRDContextSchema,
  rules_checked: z.number().int().nonnegative(),
  rules_passed: z.number().int().nonnegative(),
  critical_violations: z.number().int().nonnegative(),
  total_score: z.number().min(0).max(1),
});
export type QualityScoreRecord = z.infer<typeof QualityScoreRecordSchema>;

/**
 * One judge verdict set against the outcome retained for its claim, as the
 * verification orchestrator hands it to an observation hook
 * (`ClaimObservationFlushed`). Queued by the self-check that concludes on
 * judge verdicts and written by the composition root to the reliability
 * store: the reducer does no I/O (#121).
 */
export const ReliabilityObservationRecordSchema = z.object({
  claim_id: z.string(),
  judge: AgentIdentitySchema,
  claim_type: ClaimSchema.shape.claim_type,
  ground_truth_is_fail: z.boolean(),
  judge_was_correct: z.boolean(),
  external_grounding: ClaimSchema.shape.external_grounding,
});
export type ReliabilityObservationRecord = z.infer<typeof ReliabilityObservationRecordSchema>;
