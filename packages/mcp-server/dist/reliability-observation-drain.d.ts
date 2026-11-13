/**
 * Drains the reliability observations a run has queued (#121).
 *
 * The reducer (orchestration, handlers/self-check-observations.ts) queues
 * one observation per judge verdict of a self-check that concludes on judge
 * verdicts; this is the I/O side, called by the composition root
 * (pipeline-tools.ts) before a state is stored. The writer is the one
 * `conclude_verification` uses (observation-writer.ts).
 */
import type { ReliabilityRepository } from "@prd-gen/core";
import type { PipelineState } from "@prd-gen/orchestration";
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
export declare function drainReliabilityObservations(state: PipelineState, repo: Pick<ReliabilityRepository, "recordObservation"> | null): PipelineState;
//# sourceMappingURL=reliability-observation-drain.d.ts.map