/**
 * Drains the reliability observations a run has queued (#121).
 *
 * The reducer (orchestration, handlers/self-check-observations.ts) queues
 * the observations of a self-check that concludes on judge verdicts, one per
 * judge of each claim at least two judges ruled on; this is the I/O side,
 * called by the composition root
 * (pipeline-tools.ts) before a state is stored. The writer is the one
 * `conclude_verification` uses (observation-writer.ts).
 */
import type { ReliabilityRepository } from "@prd-gen/core";
import type { PipelineState } from "@prd-gen/orchestration";
import { writeObservation } from "./observation-writer.js";

/**
 * precondition:  `repo` is the server's reliability repository, or null when
 *                better-sqlite3 is unavailable or the database cannot be
 *                opened.
 * postcondition: every queued observation was handed once to the writer,
 *                under the run id; the returned state has an empty queue,
 *                repository or not, so the queue cannot grow from step to
 *                step. Without a repository nothing is written, the log
 *                included, as for `conclude_verification`.
 */
export function drainReliabilityObservations(
  state: PipelineState,
  repo: Pick<ReliabilityRepository, "recordObservation"> | null,
): PipelineState {
  if (repo !== null) {
    for (const queued of state.reliability_observations) {
      writeObservation(
        repo,
        {
          claim_id: queued.claim_id,
          judge: queued.judge,
          claimType: queued.claim_type,
          observation: {
            groundTruthIsFail: queued.ground_truth_is_fail,
            judgeWasCorrect: queued.judge_was_correct,
          },
          external_grounding: queued.external_grounding,
        },
        state.run_id,
      );
    }
  }
  return { ...state, reliability_observations: [] };
}
