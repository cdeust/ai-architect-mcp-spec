import { z } from "zod";

const SemanticReviewAxisSchema = z.strictObject({
  status: z.enum(["clear", "finding", "inconclusive"]),
  // The review protocol asks for an anchor and, when applicable, its counterpart.
  citations: z.array(z.strictObject({ source_id: z.string(), quote: z.string() })).max(2),
});

export const SemanticReviewAxisNameSchema = z.enum(["scope_creep", "missing_edge_case"]);
export const SemanticReviewAxesSchema = z.record(SemanticReviewAxisNameSchema, SemanticReviewAxisSchema);

export const SemanticReviewStateFields = {
  semantic_review_requested: z.literal(true).optional(),
  semantic_review_model: z.string().min(1).optional(),
  semantic_review: z.strictObject({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    axes: SemanticReviewAxesSchema.optional(),
    operator_decisions: z.partialRecord(SemanticReviewAxisNameSchema, z.enum(["confirmed", "unresolved"])).optional(),
  }).optional(),
};
import { AgentIdentitySchema } from "@prd-gen/core";

/**
 * Snapshot of the verification plan dispatched in self-check Phase A.
 * Persisted so Phase B can map invocation_id → claim/judge without re-running
 * planDocumentVerification (which would corrupt attribution if state.sections
 * mutated between phases).
 *
 * `judges[i]` is the AgentIdentity that received `claim_ids[i]`. Storing both
 * preserves judge attribution in `ConsensusVerdict.judges` even on the
 * plan-mismatch fallback path — Bayesian reliability lookups remain correct.
 *
 * INVARIANT (load-bearing): `claim_ids.length === judges.length`. The
 * fallback path in self-check.ts:parseVerdictsFromSnapshot uses positional
 * lookups (`snapshot.judges[idx]` with `idx < snapshot.claim_ids.length`).
 * If lengths diverge, an out-of-bounds read returns `undefined`, which
 * later fails `agentKey()` in consensus.ts. Enforced via Zod refinement.
 *
 * source: dijkstra cross-audit H1 (Phase 3+4, 2026-04).
 */
export const VerificationPlanSnapshotSchema = z
  .object({
    batch_id: z.string(),
    /** Claim IDs in dispatch order — index = request slot (buildJudgeIndex maps slots to invocations). */
    claim_ids: z.array(z.string()),
    /** Judge identities, parallel to claim_ids by index. */
    judges: z.array(AgentIdentitySchema),
    /**
     * True when the dispatched set was produced by
     * `sampleWithinCap` (handlers/self-check-verify-budget.ts) rather than
     * the plain per-claim reduction. Phase B's rederivation
     * (self-check.ts:parseVerdictsFromSnapshot) MUST apply the same
     * transform the snapshot was built with, or the rederived plan will
     * never match and every claim falls back to INCONCLUSIVE via the
     * plan-mismatch path. Defaults false for backward compatibility with
     * snapshots predating the budget gate.
     *
     * source: self-check budget gate (2026-07-15) — see verify-budget.ts.
     */
    sampled: z.boolean().default(false),
  })
  .refine((s) => s.claim_ids.length === s.judges.length, {
    message:
      "VerificationPlanSnapshot: claim_ids and judges must have the same length (positional invariant — see self-check.ts:parseVerdictsFromSnapshot).",
    path: ["judges"],
  });
export type VerificationPlanSnapshot = z.infer<
  typeof VerificationPlanSnapshotSchema
>;
