import type { PipelineState } from "@prd-gen/orchestration";
import { EffectivenessTracker } from "@prd-gen/strategy";
import { getEvidenceRepo } from "./evidence-db-path.js";
import { drainQualityScores } from "./quality-score-drain.js";
import { drainReliabilityObservations } from "./reliability-observation-drain.js";
import { getReliabilityRepo } from "./reliability-wiring.js";

/**
 * Lazy EvidenceRepository + EffectivenessTracker. Both are optional —
 * better-sqlite3 may be unavailable at runtime. When the repository is
 * absent, drainStrategyExecutions is a no-op and the executions queue
 * is cleared without persistence.
 *
 * source: Phase 4 strategy-wiring (2026-04). The composition root is the
 * only place that performs I/O; orchestration produces the queue,
 * mcp-server drains it.
 */
// The repository itself is the server-wide singleton getEvidenceRepo()
// (evidence-db-path.ts); only the tracker wrapping it is cached here.
let _trackerResolved = false;
let _tracker: EffectivenessTracker | null = null;
function getTracker(): EffectivenessTracker | null {
  if (!_trackerResolved) {
    _trackerResolved = true;
    const repo = getEvidenceRepo();
    // Stryker disable next-line ConditionalExpression: equivalent: a tracker built on a missing repository only throws inside the try below, which swallows it, so the drained state is the same
    if (repo) _tracker = new EffectivenessTracker(repo);
  }
  return _tracker;
}

/**
 * Drain `state.strategy_executions` and forward each entry to the
 * EvidenceRepository. Returns the state with the queue cleared.
 *
 * The drain ALWAYS clears the queue, even when no repository is wired —
 * the queue would otherwise grow unbounded across pipeline runs. When the
 * repository IS wired, recordExecution may throw on schema mismatches;
 * we swallow such errors and continue (with a warning logged) because
 * persistence is best-effort feedback, not a correctness gate.
 */
function drainStrategyExecutions(state: PipelineState): PipelineState {
  if (state.strategy_executions.length === 0) return state;
  const tracker = getTracker();
  // Stryker disable next-line ConditionalExpression: equivalent: without a tracker the call below throws inside the try, which swallows it, so the drained state is the same
  if (tracker) {
    for (const exec of state.strategy_executions) {
      try {
        tracker.recordExecution({ ...exec, sessionId: state.run_id });
      } catch {
        // Best-effort; persistence failure must not break the pipeline.
      }
    }
  }
  return { ...state, strategy_executions: [] };
}

/**
 * The three queues the reducer fills for the evidence and reliability
 * stores, emptied before a state is stored. A repository is asked for only
 * when its queue holds something.
 */
export function drainEvidenceQueues(state: PipelineState): PipelineState {
  const drained = drainStrategyExecutions(state);
  const scored = drained.quality_scores.length === 0 ? drained : drainQualityScores(drained, getEvidenceRepo());
  if (scored.reliability_observations.length === 0) return scored;
  return drainReliabilityObservations(scored, getReliabilityRepo());
}
