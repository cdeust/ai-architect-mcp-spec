import type { PipelineState } from "@prd-gen/orchestration";
import {
  getRetryArmForRun,
  getMaxAttemptsForRun,
  MAX_ATTEMPTS_BASELINE,
} from "@prd-gen/benchmark";

export function withRetryPolicy(state: PipelineState): PipelineState {
  // B1 — Wire retry_policy from composition root (Curie A7).
  // The reducer (section-generation.ts) reads state.retry_policy and never
  // calls benchmark seams directly (§1.5 DIP / §2.2 layer rule). The
  // composition root is the only permitted caller of the benchmark seams.
  //
  // Preserve an existing policy (resumed run): if state.retry_policy is
  // already non-null, we skip overwrite. newPipelineState always returns
  // null for retry_policy (fresh state), so in practice this guard protects
  // future paths where state is loaded from persistent storage before
  // start_pipeline re-runs.
  //
  // Pass null as calibratedValue: no Wave D calibration run has completed
  // yet, so getMaxAttemptsForRun returns MAX_ATTEMPTS_BASELINE.
  //
  // source: Curie cross-audit Wave D, A7 anomaly resolution.
  const arm = getRetryArmForRun(state.run_id);
  // Pass MAX_ATTEMPTS_BASELINE as the calibratedValue: no Wave D calibration
  // run has completed yet. For a control-arm run, getMaxAttemptsForRun ignores
  // calibratedValue and returns MAX_ATTEMPTS_BASELINE anyway.
  const maxAttempts = getMaxAttemptsForRun(state.run_id, MAX_ATTEMPTS_BASELINE);
  return state.retry_policy !== null
      ? state // preserve existing policy (resumed run)
      : { ...state, retry_policy: { maxAttempts, arm } };
}
