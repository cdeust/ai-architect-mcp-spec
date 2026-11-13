import type { PipelineState } from "./core-state.js";
import { PipelineStateSchema } from "./core-state.js";
import { MAX_PIPELINE_ERRORS } from "./bounded-io.js";

export function newPipelineState(input: {
  run_id: string;
  feature_description: string;
  codebase_path?: string | null;
  /**
   * When true, the preflight step is skipped — the runner advances straight
   * past missing-Cortex / missing-ai-architect checks. Use only when the
   * caller has another mechanism for ensuring those MCPs are wired (or
   * accepts degraded section generation without persistent memory recall).
   *
   * source: missing-Cortex bug found 2026-04-26.
   */
  skip_preflight?: boolean;
}): PipelineState {
  const now = new Date().toISOString();
  return PipelineStateSchema.parse({
    run_id: input.run_id,
    current_step: "banner",
    prd_context: null,
    feature_description: input.feature_description,
    codebase_path: input.codebase_path ?? null,
    codebase_graph_path: null,
    codebase_output_dir: null,
    codebase_indexed: false,
    codebase_gitignore_written: false,
    preflight_status: input.skip_preflight ? "skipped" : null,
    sections: [],
    clarifications: [],
    proceed_signal: false,
    started_at: now,
    updated_at: now,
    errors: [],
    written_files: [],
    verification_plan: null,
    strategy_executions: [],
    quality_scores: [],
  });
}

export function touch(state: PipelineState): PipelineState {
  return { ...state, updated_at: new Date().toISOString() };
}

/**
 * Append a single error with its kind tag. Use this at every error-append
 * site instead of `errors: [...state.errors, message]`. Keeps the parallel
 * `error_kinds[]` array in lockstep with `errors[]`.
 *
 * Bounded-I/O (Phase 1c): the errors/error_kinds arrays are capped at
 * MAX_PIPELINE_ERRORS to stay within the Claude Code 100,000-char MCP response
 * budget (get_pipeline_state format:"full" ships the whole state). When the
 * cap is reached this performs FIFO eviction — the OLDEST entry is dropped so
 * the most recent failures (the ones a caller acts on) survive. Eviction is
 * NOT silent: the dropped count is recorded by incrementing the returned
 * state's `errors_dropped` so observability is preserved (Phase 1c rule).
 *
 * Precondition: state.errors.length === state.error_kinds.length (lockstep
 *   invariant, enforced by the PipelineStateSchema refine).
 * Postcondition: result.errors.length === result.error_kinds.length AND
 *   result.errors.length <= MAX_PIPELINE_ERRORS AND result.errors ends with
 *   `message` (the new error is never the one evicted) AND
 *   result.errors_dropped === state.errors_dropped + (1 if eviction occurred).
 *
 * source: curie cross-audit H-2 (Phase 3+4, 2026-04). Tag taxonomy
 * extended to three kinds in curie H1 (Phase 3+4 follow-up, 2026-04).
 * Bounded-I/O cap added Phase 1c (2026-06-10).
 */
export function appendError(
  state: PipelineState,
  message: string,
  kind: "section_failure" | "structural" | "upstream_failure",
): PipelineState {
  const nextErrors = [...state.errors, message];
  const nextKinds = [...state.error_kinds, kind];
  // FIFO eviction: once over cap, drop the oldest entry from BOTH arrays in
  // lockstep. The append above already added the newest entry, so slicing the
  // front keeps the most recent MAX_PIPELINE_ERRORS entries including `message`.
  const overflow = nextErrors.length - MAX_PIPELINE_ERRORS;
  if (overflow > 0) {
    return {
      ...state,
      errors: nextErrors.slice(overflow),
      error_kinds: nextKinds.slice(overflow),
      errors_dropped: state.errors_dropped + overflow,
    };
  }
  return {
    ...state,
    errors: nextErrors,
    error_kinds: nextKinds,
  };
}
