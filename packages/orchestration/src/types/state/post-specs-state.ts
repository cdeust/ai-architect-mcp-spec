/**
 * Post-specs state — the Phases 3-5 implementation loop
 * (design-phases-3-5.md), nested under `state.post_specs`.
 *
 * Design decision (§2.1 of the design doc explicitly gives every field of
 * this shape; PR 3b only WIRES `decision` + `impact_queries`): the full
 * shape is declared here in one pass rather than growing this file once per
 * sub-PR (3c/4a/4b/5). Justification —
 *   1. The design doc already fixes the exact contract for all 6 groups;
 *      this is transcription of a settled shape, not incremental design.
 *   2. Adding one group at a time would touch this file, its barrel
 *      re-export, and every test importing `PipelineState` five more times
 *      for the SAME nested object — a self-inflicted shotgun-surgery risk
 *      this file's sibling `core-state.ts` doc explicitly warns against
 *      (§4.1 cohesion).
 *   3. Zero behavior change: every not-yet-wired group defaults to `null`
 *      (or, for `decision`, `"pending"`) and no handler outside 3b's own
 *      `implementation_gate` / `pre_impl_grounding` reads or writes them —
 *      the schema addition is inert until a future PR's handler touches it.
 *
 * `post_specs` itself is nullable, default `null`, on `PipelineState` (see
 * core-state.ts) — every existing consumer/test that never reaches the
 * post-specs loop is unaffected (matches the `verification_plan` /
 * `retry_policy` nullable-field precedent already established there).
 *
 * Every AP payload is stored as an opaque `z.record(z.string(), z.unknown())`
 * passthrough — orchestration never parses AP response shapes (mirrors
 * `codebase_grounding` / `prd_validation` precedent in core-state.ts).
 *
 * source: design-phases-3-5.md §2.1 (schema), §5 (PR 3b scope).
 */

import { z } from "zod";

/**
 * One `get_impact` round trip's outcome for a single affected symbol.
 * `success: false` entries are retained (not dropped) so `finalize`'s
 * remember content and any future review-stage prompt can see WHICH
 * symbols failed to ground, not just a partial-success count.
 */
export const ImpactQueryResultSchema = z.object({
  qualified_name: z.string(),
  success: z.boolean(),
  data: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});
export type ImpactQueryResult = z.infer<typeof ImpactQueryResultSchema>;

/**
 * `pre_impl_grounding`'s cursor state (PR 3b). `index` is the number of
 * symbols already processed (success or failure) — also the 0-based index
 * of the NEXT symbol to query. `done` is set once the cursor has walked the
 * full (capped) symbol list, or once the step decided there is nothing to
 * ground (no graph / no sidecar).
 */
export const ImpactQueriesStateSchema = z.object({
  done: z.boolean().default(false),
  index: z.number().int().nonnegative().default(0),
  results: z.array(ImpactQueryResultSchema).default([]),
});
export type ImpactQueriesState = z.infer<typeof ImpactQueriesStateSchema>;

/**
 * `implementation` step's outcome (Phase 4a — NOT wired in 3b). Nullable;
 * stays null until the `implementation` handler exists and runs.
 */
export const ImplementationStateSchema = z.object({
  branch: z.string(),
  worktree_path: z.string().nullable(),
  changed_files: z.array(z.string()).default([]),
  raw_report: z.string(),
});
export type ImplementationState = z.infer<typeof ImplementationStateSchema>;

/**
 * `post_impl_verification`'s 4-call sequence cursor (PR 3c, design-phases-3-5.md
 * §1, §3): `index_codebase`(worktree) → `detect_changes` → `verify_semantic_diff`
 * → `check_security_gates`, strictly linear (unlike `pre_impl_grounding`'s
 * variable-length per-symbol loop, so a step enum is sufficient — no index
 * counter needed). `"done"` is the terminal value once all 4 calls have been
 * dispatched (successfully or degraded).
 */
export const VerificationStepSchema = z.enum([
  "index_codebase",
  "detect_changes",
  "verify_semantic_diff",
  "check_security_gates",
  "done",
]);
export type VerificationStep = z.infer<typeof VerificationStepSchema>;

/**
 * `post_impl_verification` step's outcome (Phase 3c — wired by
 * post-impl-verification.ts; Phase 4a still owns `implementation`, the
 * precondition for this step ever running).
 */
export const VerificationStateSchema = z.object({
  /** Cursor — see VerificationStepSchema. */
  step: VerificationStepSchema.default("index_codebase"),
  /**
   * The "after" graph produced by the worktree re-index (call 1). Needed by
   * calls 2-4 (`detect_changes`, `verify_semantic_diff`,
   * `check_security_gates` all take a graph_path). Null until call 1
   * succeeds; stays null (verification degrades) if call 1 fails.
   */
  after_graph_path: z.string().nullable().default(null),
  /**
   * Qualified names from `detect_changes`'s `symbols_affected[].qualified_name`
   * (ai-architect-mcp-codebase/src/git_diff.rs ChangedSymbol), carried forward so
   * `check_security_gates` (call 4) can consume them as its required
   * `changed_symbols` argument — design §1: "check_security_gates ... its own
   * schema *requires* changed_symbols (from detect_changes)". Empty array
   * (not null) when detect_changes was skipped or failed — check_security_gates'
   * schema accepts `minItems: 0`, so an empty list is a valid degrade, not a
   * blocked call.
   */
  changed_symbols: z.array(z.string()).default([]),
  detect_changes: z.record(z.string(), z.unknown()).nullable().default(null),
  verify_semantic_diff: z.record(z.string(), z.unknown()).nullable().default(null),
  check_security_gates: z.record(z.string(), z.unknown()).nullable().default(null),
  /**
   * Fail-closed on the boolean (design §4): default false, and stays false
   * unless `check_security_gates` returns success with
   * `data.gates_passed === true`. Any degrade along the sequence (index
   * failure, security-gates call failure, or the call never running) leaves
   * this false rather than defaulting to "passed".
   */
  gates_passed: z.boolean().default(false),
});
export type VerificationState = z.infer<typeof VerificationStateSchema>;

/**
 * precondition:  none.
 * postcondition: a fresh VerificationState at the start of the 4-call
 *                sequence (step:"index_codebase", every result null,
 *                gates_passed false). Used by post-impl-verification.ts the
 *                first time a run reaches the step (post_specs.verification
 *                is null until then).
 */
export function initialVerification(): VerificationState {
  return VerificationStateSchema.parse({});
}

/** `testing` step's outcome (Phase 4b — NOT wired in 3b). */
export const TestingStateSchema = z.object({
  raw_report: z.string(),
});
export type TestingState = z.infer<typeof TestingStateSchema>;

/** `review` step's outcome (Phase 4b — NOT wired in 3b). */
export const ReviewStateSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  findings: z.array(z.string()).default([]),
  attempt: z.number().int().positive(),
});
export type ReviewState = z.infer<typeof ReviewStateSchema>;

/** `pr_creation` step's outcome (Phase 5 — NOT wired in 3b). */
export const PrStateSchema = z.object({
  pushed: z.boolean().default(false),
  url: z.string().nullable().default(null),
});
export type PrState = z.infer<typeof PrStateSchema>;

/**
 * Recorded human derogation/override when `implementation_gate`'s
 * verification-policy evaluation (handlers/verification-policy.ts
 * `evaluatePolicy`) was NOT "pass" and the human chose to implement anyway.
 * `null` when no derogation was needed (policy status was "pass") or no
 * decision has been made yet. `10-verification-report.md`'s "Verification
 * Policy" section renders this verbatim.
 */
export const PolicyDerogationSchema = z.object({
  /** `evaluatePolicy`'s status at the moment the derogation was granted. */
  policy_status: z.enum(["needs_attention", "blocked"]),
  /** `evaluatePolicy`'s human-readable reasons at that moment, verbatim. */
  reasons: z.array(z.string()),
});
export type PolicyDerogation = z.infer<typeof PolicyDerogationSchema>;

export const PostSpecsStateSchema = z.object({
  /** Set when migrating a pending legacy question that refused ordinary implementation. */
  legacy_define_refusal: z.literal(true).optional(),
  /** Set by the autonomous verification gate before terminal finalization. */
  automatic_define: z.literal(1).optional(),
  /**
   * Set by `implementation_gate`'s ask_user answer. `"pending"` is the
   * pre-gate default (self_check's finalize() initializes post_specs but
   * leaves decision at its schema default until the gate answers).
   */
  decision: z.enum(["pending", "implement", "prd_only"]).default("pending"),
  /**
   * Set by `implementation_gate` when `decision === "implement"` AND the
   * verification-policy status was not "pass" — see `PolicyDerogationSchema`
   * doc. `null` otherwise (policy passed cleanly, or no decision yet).
   */
  policy_derogation: PolicyDerogationSchema.nullable().default(null),
  /** PR 3b — wired by pre_impl_grounding.ts. */
  impact_queries: ImpactQueriesStateSchema.default({
    done: false,
    index: 0,
    results: [],
  }),
  /** Phase 4a — not wired in 3b. */
  implementation: ImplementationStateSchema.nullable().default(null),
  /** Phase 3c/4a — not wired in 3b. */
  verification: VerificationStateSchema.nullable().default(null),
  /** Phase 4b — not wired in 3b. */
  testing: TestingStateSchema.nullable().default(null),
  /** Phase 4b — not wired in 3b. */
  review: ReviewStateSchema.nullable().default(null),
  /** Phase 5 — not wired in 3b. */
  pr: PrStateSchema.nullable().default(null),
  /** Phase 4b review-loop counter — not wired in 3b. */
  retry_count: z.number().int().nonnegative().default(0),
});
export type PostSpecsState = z.infer<typeof PostSpecsStateSchema>;

/**
 * precondition:  none.
 * postcondition: returns a fresh PostSpecsState with every schema default
 *                applied (decision:"pending", impact_queries:{done:false,
 *                index:0,results:[]}, every other group null/0). Used by
 *                `implementation_gate` the first time a run reaches the
 *                post-specs loop (state.post_specs is null until then).
 */
export function initialPostSpecs(): PostSpecsState {
  return PostSpecsStateSchema.parse({});
}
