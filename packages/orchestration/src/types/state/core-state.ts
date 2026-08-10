import { z } from "zod";
import { PRDContextSchema } from "@prd-gen/core";
import { ExecutionResultSchema } from "@prd-gen/strategy";
import { VerificationSummarySchema } from "../actions.js";
import { PipelineStepSchema } from "./pipeline-step.js";
import { SectionStatusSchema } from "./section-status.js";
import { VerificationPlanSnapshotSchema } from "./verification-plan.js";
import { MAX_CLARIFICATION_TURNS, MAX_PIPELINE_ERRORS } from "./bounded-io.js";
import { PostSpecsStateSchema } from "./post-specs-state.js";
import { VerifyBudgetConfigSchema } from "./verify-budget.js";
import { VerificationPolicySchema } from "./verification-policy.js";

export const ClarificationTurnSchema = z.object({
  round: z.number().int().min(1),
  question: z.string(),
  answer: z.string().optional(),
  asked_at: z.string(),
  answered_at: z.string().optional(),
});
export type ClarificationTurn = z.infer<typeof ClarificationTurnSchema>;

export const PipelineStateSchema = z.object({
  run_id: z.string(),
  current_step: PipelineStepSchema,
  prd_context: PRDContextSchema.nullable(),
  feature_description: z.string(),
  codebase_path: z.string().nullable(),
  /**
   * Filesystem path returned by ai-architect-mcp-codebase `index_codebase`
   * (response field `graph_path`). Subsequent graph-query tools (query_graph,
   * get_symbol, etc.) use this as their `graph_path` argument.
   */
  codebase_graph_path: z.string().nullable(),
  /** Output directory passed to `index_codebase` so retries are idempotent. */
  codebase_output_dir: z.string().nullable(),
  codebase_indexed: z.boolean(),
  /**
   * Idempotency flag for the `.prd-gen/.gitignore` self-ignore guard write
   * (input_analysis.ts), set true once the corresponding `file_written`
   * result is processed. Deliberately NOT tracked in `written_files` — that
   * array is the PRD-deliverable ledger file-export.ts builds and
   * pipeline-kpis.ts counts (`written_files_count` KPI expects exactly the
   * 9 PRD output files); folding an infrastructure guard file into it would
   * silently inflate that count. source: git-hygiene defect, memory 4263670.
   */
  codebase_gitignore_written: z.boolean().default(false),
  /**
   * Code-graph grounding for the feature, returned by ai-architect-mcp-codebase
   * `prepare_prd_input` in FEATURE MODE (response field `prd_context`):
   *   { matched_symbols, impacted_communities, impacted_processes,
   *     graph_stats, mode }
   * Distinct from `prd_context` above (which is the PRD *kind* enum:
   * feature/bug/incident/…). This is the code-graph evidence later steps
   * (budget / section generation) inject as grounding so generated sections
   * reference real symbols/communities/processes. Stored as an opaque object
   * because the orchestration layer is a pure passthrough — it does not parse
   * the AP payload (mirrors how `index_codebase` data is consumed inline).
   *
   * Null until `prepare_prd_input` succeeds, or permanently null when no
   * codebase/feature_description is available (skip path, backward-compatible).
   *
   * source: AP feature-mode prepare_prd_input contract (shipped 2026-06).
   */
  codebase_grounding: z.record(z.string(), z.unknown()).nullable().default(null),
  /**
   * Idempotency flag for the `prepare_prd_input` emission in input_analysis.
   * Mirrors `codebase_indexed`: set true once the grounding call has been
   * processed (success OR a skip-after-index decision) so the step advances
   * exactly once and replayed state does not re-issue the call.
   *
   * source: AP feature-mode prepare_prd_input contract (shipped 2026-06).
   */
  prd_input_prepared: z.boolean().default(false),
  /**
   * Preflight gate state — `null` while preflight has not been attempted
   * yet, `"ok"` once Cortex (and ai-architect, when a codebase is given)
   * passed their liveness checks. Treated as a precondition: the runner
   * may not enter section_generation while preflight is unset.
   *
   * source: missing-Cortex bug found 2026-04-26 — silent per-section
   * recall failures should surface as ONE clear startup error, not as
   * degraded generation across every section.
   */
  preflight_status: z.enum(["ok", "skipped"]).nullable().default(null),
  sections: z.array(SectionStatusSchema).default([]),
  /**
   * Bounded-I/O cap (Phase 1c): at most MAX_CLARIFICATION_TURNS turns. The
   * handler bounds rounds per-context, but the default tier's
   * CAPABILITIES.maxClarificationRounds is Infinity, so this schema cap is the
   * guaranteed bound. Over-cap state parses to a ZodError (observable) rather
   * than silently growing the MCP response. source: see MAX_CLARIFICATION_TURNS.
   */
  clarifications: z
    .array(ClarificationTurnSchema)
    .max(MAX_CLARIFICATION_TURNS, {
      message: `clarifications exceeds ${MAX_CLARIFICATION_TURNS}-turn bounded-I/O cap (Claude Code 100,000-char MCP response budget). source: see MAX_CLARIFICATION_TURNS in state.ts.`,
    })
    .default([]),
  /**
   * Set when the user types "proceed" or clarification reaches max rounds.
   * Read by handleBudget to sanity-check that clarification finished cleanly
   * before generation starts.
   */
  proceed_signal: z.boolean().default(false),
  started_at: z.string(),
  updated_at: z.string(),
  /**
   * Genuine error messages only. NOT a progress log.
   *
   * Bounded-I/O cap (Phase 1c): at most MAX_PIPELINE_ERRORS entries, kept in
   * lockstep with error_kinds. Appended ONLY via appendError(), which performs
   * FIFO eviction (drops oldest) once the cap is reached and reports the
   * dropped count — never silent loss. The schema .max() is the backstop that
   * makes a direct over-cap spread fail to parse. source: see MAX_PIPELINE_ERRORS.
   */
  errors: z
    .array(z.string())
    .max(MAX_PIPELINE_ERRORS, {
      message: `errors exceeds ${MAX_PIPELINE_ERRORS}-entry bounded-I/O cap — append via appendError() (FIFO eviction). source: see MAX_PIPELINE_ERRORS in state.ts.`,
    })
    .default([]),
  /**
   * Parallel to `errors[]` (same length, same order). Tags each error as
   * one of three kinds. pipeline-kpis.ts:structural_error_count reads
   * `"structural"` count DIRECTLY rather than deriving it by subtraction.
   *
   *   "section_failure"   — section validator failed after MAX_ATTEMPTS.
   *                         1-per-failed-section by convention. Section-
   *                         level retries are not counted; only the final
   *                         fail-out increments. KPI: section_fail_count.
   *
   *   "structural"        — handler bug, runner protocol violation,
   *                         schema mismatch, uncaught exception. The KPI
   *                         gate `structural_error_count_max=0` blocks
   *                         any run with a structural defect.
   *
   *   "upstream_failure"  — recoverable failure in an external service
   *                         the pipeline tolerates (jira-generation
   *                         subagent fails → continue without JIRA;
   *                         index_codebase tool fails → fail input_analysis
   *                         but do not blame the handler). Counted
   *                         separately so the structural gate does not
   *                         fire spuriously on real-LLM runs where
   *                         upstream services have realistic flake rates
   *                         (cross-audit curie H1, Phase 3+4 follow-up,
   *                         2026-04).
   *
   * source: curie cross-audit H-2 (Phase 3+4, 2026-04) for the introduction
   * of the parallel array; curie H1 (Phase 3+4 follow-up, 2026-04) for the
   * upstream_failure split.
   */
  error_kinds: z
    .array(z.enum(["section_failure", "structural", "upstream_failure"]))
    // Bounded-I/O cap (Phase 1c): lockstep with errors[], same cap. source: MAX_PIPELINE_ERRORS.
    .max(MAX_PIPELINE_ERRORS, {
      message: `error_kinds exceeds ${MAX_PIPELINE_ERRORS}-entry bounded-I/O cap (must stay lockstep with errors[]). source: see MAX_PIPELINE_ERRORS in state.ts.`,
    })
    .default([]),
  /**
   * Count of error entries evicted from `errors`/`error_kinds` by appendError's
   * FIFO cap (bounded-I/O, Phase 1c). Non-zero means the run produced more than
   * MAX_PIPELINE_ERRORS errors and the oldest were dropped to stay within the
   * MCP response budget — the drop is observable here, never silent.
   * source: see MAX_PIPELINE_ERRORS / appendError in this file.
   */
  errors_dropped: z.number().int().nonnegative().default(0),
  /** Paths of files successfully written during file_export. Append-only. */
  written_files: z.array(z.string()).default([]),
  /**
   * Count of Cortex `recall` tool invocations that returned zero hits.
   * A non-zero count indicates sections were generated without memory context,
   * which degrades output quality. KPI gate: pipeline-kpis.ts reads this field
   * directly to surface the metric without post-hoc regex parsing.
   *
   * Incremented in section-generation.ts at the retrieving→generating
   * transition when summarizeRecall returns an empty string (data.results is
   * absent, empty, or all entries have no content).
   *
   * source: shannon S-6 (Phase 3+4 cross-audit, 2026-04) — load-bearing
   * quantity needed for recall-efficacy analysis.
   */
  cortex_recall_empty_count: z.number().int().nonnegative().default(0),
  /**
   * Verification plan dispatched in self-check Phase A. Set during Phase A;
   * read in Phase B to attribute verdicts. Null until Phase A runs.
   */
  verification_plan: VerificationPlanSnapshotSchema.nullable().default(null),
  /**
   * Path to the `stage-5.affected_symbols.json` sidecar written by
   * file-export.ts, when the technical_specification section ran and
   * produced content (extraction ran — regardless of how many claims it
   * found; empty arrays are a valid, written zero-claims document). Set in
   * file-export at the file-set-complete transition; read by self-check to
   * pass `affected_symbols_path` to `validate_prd_against_graph`. Null when
   * the technical_specification section never ran (see file-export.ts
   * module doc) or when file_export has not yet run.
   *
   * source: AP validate_prd_against_graph contract, `affected_symbols_path`
   * argument (ai-architect-mcp-codebase stages/stage-6.md §4.2/§6.1,
   * "Zero-claims case — not the same as absent"), pinned at commit
   * 92216cd90f8f26cb15348675fc6556b8293edfc1.
   */
  affected_symbols_path: z.string().nullable().default(null),
  /**
   * PRD-vs-graph validation report from ai-architect-mcp-codebase
   * `validate_prd_against_graph` (args { prd_path, graph_path }), fetched in
   * self-check after the PRD file is exported. Symbol-hallucination /
   * community-consistency / process-impact findings. Merged into the
   * self-check `done.verification` surface (not a new top-level shape).
   *
   * Stored as an opaque object — the orchestration layer is a pure passthrough
   * and does not parse the AP payload. Null until the call succeeds, or
   * permanently null when no `codebase_graph_path` exists (skip path,
   * backward-compatible).
   *
   * source: AP validate_prd_against_graph contract (shipped 2026-06).
   */
  prd_validation: z.record(z.string(), z.unknown()).nullable().default(null),
  /**
   * Idempotency flag for the `validate_prd_against_graph` emission in
   * self-check. Mirrors `prd_input_prepared`: set true once the validation
   * call has been processed (success OR skip) so self-check advances to its
   * existing verify phase exactly once.
   *
   * source: AP validate_prd_against_graph contract (shipped 2026-06).
   */
  prd_validated: z.boolean().default(false),
  /**
   * Append-only queue of strategy execution results, populated when a
   * section transitions to a terminal status (passed/failed). The
   * composition root (mcp-server) drains this queue after each step and
   * forwards entries to `EffectivenessTracker.recordExecution` so the
   * closed feedback loop populates `EvidenceRepository`.
   *
   * Decouples orchestration (pure reducer) from infrastructure (SQLite
   * persistence) per §2.2: the reducer emits data; the composition
   * root is the only layer that performs I/O.
   *
   * source: Phase 4 strategy-wiring (2026-04).
   */
  strategy_executions: z.array(ExecutionResultSchema).default([]),
  /**
   * Global Cortex memory-recall summary for the whole run, fetched ONCE
   * (query = feature_description) at the start of input_analysis — before
   * any codebase-specific or per-section context is built. Distinct from
   * `codebase_grounding` (code-graph evidence from ai-architect-mcp-codebase) and
   * from the per-section `call_cortex_tool[recall]` in section-generation.ts
   * (which queries a section-specific template). This is prior-run/decision
   * memory, injected into every downstream prompt that builds context so
   * generation benefits from what Cortex already knows about the feature —
   * not just what the current codebase graph shows.
   *
   * Empty string when the recall returned no usable content or Cortex was
   * unreachable (never null-vs-empty ambiguity downstream); `null` only
   * before the recall has run. Failure/emptiness is tracked via the existing
   * `cortex_recall_empty_count` counter (shared with the per-section path —
   * both are "a Cortex recall call returned nothing", the same degraded-
   * generation signal) rather than a duplicate counter.
   *
   * source: Phase 1a (2026-07-14) — Cortex memory-loop closure. Prior to this
   * field, Cortex was consulted only for preflight liveness (memory_stats)
   * and per-section recall; no run-level memory context reached section
   * drafting.
   */
  global_recall_summary: z.string().nullable().default(null),
  /**
   * Idempotency flag for the global recall emission in input_analysis.
   * Mirrors `prd_input_prepared` / `codebase_indexed`: set true once the
   * recall call has been processed (success OR failure) so the step fires
   * exactly once per run and replayed state does not re-issue the call.
   *
   * source: Phase 1a (2026-07-14).
   */
  global_recall_done: z.boolean().default(false),
  /**
   * git-historian investigation report for the feature's zone (provenance,
   * abandoned-approach recovery, churn hotspots, discovered constraints),
   * fetched ONCE per run in input_analysis AFTER code-graph grounding
   * (`prd_input_prepared`) settles — success or advisory failure — so the
   * investigation prompt can be scoped with the matched-symbol/impacted-
   * community hint from `codebase_grounding` when available. Only fires when
   * `codebase_path` is set (git history requires a codebase; mirrors why
   * `codebase_indexed`/`prd_input_prepared` are also codebase-gated).
   * Distinct from `global_recall_summary` (Cortex prior-run memory) and
   * `codebase_grounding` (code-graph symbols/communities): this is
   * version-control provenance, not memory or structure.
   *
   * Empty string when the subagent reported nothing usable (including "this
   * is not a git repository" — the subagent determines that, not this pure
   * reducer) or failed; `null` only before the investigation has run for a
   * codebase-bearing run, and permanently `null` when no codebase_path exists
   * (skip path, mirrors `codebase_grounding`'s null-forever no-codebase case).
   *
   * source: Phase 2 (2026-07-14) — git-historian stage.
   */
  git_history_summary: z.string().nullable().default(null),
  /**
   * Idempotency flag for the git-historian investigation emission in
   * input_analysis. Mirrors `prd_input_prepared`/`global_recall_done`: set
   * true once the investigation has been processed (success OR failure) so
   * the step advances exactly once per run and replayed state does not
   * re-issue the spawn. Stays permanently false (never checked) on the
   * no-codebase skip path — see `git_history_summary` doc.
   *
   * source: Phase 2 (2026-07-14) — git-historian stage.
   */
  git_history_done: z.boolean().default(false),
  /**
   * Terminal `done` action payload computed by self-check's finalize once
   * verdicts are aggregated, held here while Phase C (Cortex `remember`)
   * runs. The reducer cannot emit `done` and also wait for a host round
   * trip in the same step — this field is the seam: finalize's summary/
   * artifacts/verification are persisted so the NEXT step (after the
   * remember tool_result comes back) can reconstruct the exact `done`
   * action without re-deriving it from verdicts that are no longer
   * available (verification_plan is cleared during Phase B).
   *
   * Null before Phase A/B has produced a final summary, and null again once
   * Phase C consumes it (the `done` action is emitted and current_step
   * advances to "complete").
   *
   * source: Phase 1b (2026-07-14) — Cortex memory-loop closure.
   */
  pending_completion: z
    .object({
      summary: z.string(),
      artifacts: z.array(z.string()),
      // Matches DoneActionSchema.verification exactly (actions.ts) so
      // remember-phase.ts can reconstruct the `done` action byte-for-byte
      // without a cast. source: Phase 1b (2026-07-14).
      verification: VerificationSummarySchema.optional(),
    })
    .nullable()
    .default(null),
  /**
   * Idempotency flag for the Phase C `remember` emission in self-check.
   * Mirrors `prd_validated`. A `remember` failure is recorded via
   * `appendError` (upstream_failure) but still sets this flag true — the
   * run's completion must never be blocked by a memory-write failure.
   *
   * source: Phase 1b (2026-07-14).
   */
  run_remembered: z.boolean().default(false),
  /**
   * Per-run retry policy injected by the composition root (mcp-server) before
   * handing the state to the reducer. The reducer reads this field only —
   * it never calls `getRetryArmForRun` or `getMaxAttemptsForRun` directly,
   * preserving layer purity (§1.5 DIP / §2.2 layer rule: orchestration must
   * not import from benchmark).
   *
   * Fields:
   *   maxAttempts  — effective max attempts for this run (may differ from the
   *                  baseline MAX_ATTEMPTS for calibration treatment runs).
   *   arm          — ablation arm: "with_prior_violations" feeds last_violations
   *                  to the retry prompt; "without_prior_violations" feeds [].
   *
   * Defaults to null (= use MAX_ATTEMPTS baseline, with_prior_violations arm)
   * for backward compatibility. Wave D2 wires the composition root to populate
   * this field using getRetryArmForRun + getMaxAttemptsForRun from the
   * benchmark layer before starting the run.
   *
   * ADR (Wave D1.C, 2026-04-27): the seam is on the state object, not on a
   * separate config argument, so that the runner's pure reducer signature
   * (state → action) does not acquire a new parameter. State is the single
   * authority for all reducer inputs. The composition root is the only site
   * that calls benchmark-layer seams (§5.2 composition root pattern).
   *
   * source: Phase 4.2 ablation design (PHASE_4_PLAN.md §4.2).
   * source: §1.5 DIP — high-level modules must not depend on low-level modules.
   * source: §5.2 factory / composition root pattern.
   */
  // B9 — RetryPolicy is colocated with PipelineState rather than in a standalone
  // retry-policy.ts file because it is structurally dependent on the state shape:
  // the Zod schema here is an inline object (not a named Schema reference) so
  // it participates in PipelineStateSchema's refinement chain and Zod inference
  // without a separate parse boundary. The D1.C spec referenced a standalone
  // file; this was intentionally inlined during Wave D1 implementation to keep
  // the type adjacent to its only consumer (PipelineState). Any future caller
  // that needs the RetryPolicy type standalone can do:
  //   type RetryPolicy = NonNullable<PipelineState["retry_policy"]>
  // source: Wave D B9 ADR (2026-04-27).
  retry_policy: z
    .object({
      maxAttempts: z.number().int().positive(),
      arm: z.enum(["with_prior_violations", "without_prior_violations"]),
    })
    .nullable()
    .default(null),
  /**
   * Phases 3-5 post-specs implementation loop (design-phases-3-5.md).
   * Nullable, default null — every existing run/test that never reaches the
   * `implementation_gate` step is unaffected. Initialized (via
   * `initialPostSpecs()`) the first time `implementation_gate` runs.
   *
   * source: design-phases-3-5.md §2.1.
   */
  post_specs: PostSpecsStateSchema.nullable().default(null),
  /**
   * Judge-panel budget override for self-check's multi-judge verification
   * batch. Composition-root-injected only (mirrors `retry_policy`); the
   * reducer only reads it. `null` = use DEFAULT_VERIFY_BUDGET
   * (handlers/self-check-verify-budget.ts).
   *
   * source: measured e2e run run_mrlqa0aj_u2rh15 (2026-07-15) — see
   * verify-budget.ts module doc for the full rationale.
   */
  verify_budget: VerifyBudgetConfigSchema.nullable().default(null),
  /**
   * Verification-acceptance-policy override for `implementation_gate`
   * (handlers/verification-policy.ts `evaluatePolicy`). Composition-root-
   * injected only (mirrors `verify_budget`); the reducer only reads it.
   * `null` = use DEFAULT_VERIFICATION_POLICY.
   *
   * source: design-phases-3-5.md §7; e2e run run_mrlqa0aj_u2rh15 (2026-07-15).
   */
  verification_policy: VerificationPolicySchema.nullable().default(null),
})
  .refine((s) => s.errors.length === s.error_kinds.length, {
    message:
      "PipelineState: errors[] and error_kinds[] must have the same length (lockstep invariant — use appendError() to append, never spread directly).",
    path: ["error_kinds"],
  });
export type PipelineState = z.infer<typeof PipelineStateSchema>;
