import { z } from "zod";

/**
 * Judge-panel budget for self-check's multi-judge verification batch
 * (handlers/self-check.ts / handlers/self-check-verify-budget.ts).
 *
 * The composition root (mcp-server) MAY inject an override on
 * `PipelineState.verify_budget` before a run starts — mirrors `retry_policy`
 * in core-state.ts. The reducer only ever READS this field; it never derives
 * or mutates it (§1.5 DIP / §5.2 composition-root pattern). `null` means
 * "use DEFAULT_VERIFY_BUDGET" (handlers/self-check-verify-budget.ts).
 *
 * Rationale for the shape: judging PRD claims is read-and-compare work, not
 * frontier reasoning — it does not need the session's own model. A run with
 * ~29 claims under the PRIOR uncapped panel (2-3 genius + 1-2 team judges per
 * claim, all dispatched with no `model`/`effort` field, so the host ran every
 * one under the session model) produced 89 judge invocations in one batch.
 * source: measured e2e run run_mrlqa0aj_u2rh15 (2026-07-15), batch_id
 * self_check_verify, 89 invocations, 3 judges x 28 FR/AC claims + a 5-judge
 * architecture panel x 1 architecture claim.
 */
export const VerifyBudgetConfigSchema = z.object({
  /** Judges dispatched per claim, for every claim_type except "architecture". */
  judges_per_claim: z.number().int().positive(),
  /**
   * Judges dispatched per "architecture"-typed claim. Kept above
   * `judges_per_claim` by default — architecture claims are the highest-
   * stakes panel in PANELS (judge-selector.ts: high_stakes: true, 5-judge
   * full panel) so a single judge's mistake is more costly there.
   */
  architecture_judges_per_claim: z.number().int().positive(),
  /**
   * Above this count of (judge × claim) verdicts requested (post-reduction,
   * pre-sampling), self-check emits `ask_user` instead of dispatching
   * `spawn_subagents` — see
   * handlers/self-check-verify-budget.ts:buildBudgetGateQuestion. Since
   * issue #119 one invocation carries every claim of a judge, so the
   * dispatched invocation count is at most this number, usually far below.
   */
  invocation_cap: z.number().int().positive(),
  /**
   * Model every NON-architecture judge invocation is dispatched under
   * (spawn_subagents invocation.model). Also the fallback when
   * `diversity_models` is empty (schema requires length >= 1; defensive
   * only).
   */
  judge_model: z.string(),
  /** Effort level every judge invocation is dispatched under (spawn_subagents invocation.effort). */
  judge_effort: z.enum(["low", "medium", "high"]),
  /**
   * Model-diversity slots for "architecture"-typed claims (judge-
   * selector.ts's highest-stakes panel, `architecture_judges_per_claim`
   * judges by default). Each judge slot within an architecture claim's
   * panel cycles through this list by index — judge 0 gets
   * `diversity_models[0]`, judge 1 gets `diversity_models[1 %
   * diversity_models.length]`, etc. — so the panel spans distinct
   * PERSONAS (judge-selector.ts's PANELS) AND distinct underlying MODELS,
   * not persona diversity alone.
   *
   * HONEST LIMIT (arXiv:2602.11865, DeepMind "Virtual Agent Economies" —
   * the "Cognitive Monoculture" threat class): persona diversity is NOT
   * model independence. Every entry in the default list ("haiku", "sonnet")
   * is a Claude-family model sharing one vendor's pretraining corpus and
   * alignment lineage — cycling between them mitigates only INTRA-family
   * blind spots (the two models can still share a systematic misreading of
   * the same claim). It does not, and cannot, close the monoculture gap
   * that a genuinely independent (cross-vendor) verifier would. This field
   * accepts arbitrary model-identifier strings specifically so a host with
   * cross-vendor judge routing (e.g. a non-Claude model reachable through
   * its own subagent_type) can close that gap WITHOUT a schema change —
   * the type is `string`, not a Claude-model enum. Standard (non-
   * architecture) subjective claims still dispatch a single judge under
   * `judge_model` — diversity slots are reserved for the highest-stakes
   * panel by design, not applied uniformly, to keep the invocation-count
   * reduction this feature exists for (see module doc above).
   *
   * source: design-phases-3-5.md "Verification tiering & monoculture
   * limits"; arXiv:2602.11865.
   */
  diversity_models: z.array(z.string()).min(1),
});
export type VerifyBudgetConfig = z.infer<typeof VerifyBudgetConfigSchema>;
