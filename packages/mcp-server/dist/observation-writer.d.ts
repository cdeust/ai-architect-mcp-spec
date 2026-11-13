/**
 * Writes one reliability observation: the reliability repository first,
 * then the observation log, with the oracle's verdict when the claim carries
 * external grounding.
 *
 * Moved out of `buildConcludeOpts` (#121), where it was the body of the
 * `onObservation` closure, so that the pipeline's self-check can write the
 * observations it queues with the writer `conclude_verification` uses. The
 * logic is the one that was there, split in two functions.
 *
 * Semantics kept from the closure:
 *   - B4 control arm: the write happens on every run, control-arm runs
 *     included; only the read side skips them.
 *   - Annotator circularity: the ground truth of the observation is the
 *     consensus majority. For a claim with external grounding the oracle's
 *     verdict goes to the log beside it (Curie A2.3, PHASE_4_PLAN.md §4.1).
 *   - Best effort: a failure to persist never aborts the caller.
 */
import type { ReliabilityRepository } from "@prd-gen/core";
import type { ConcludeOptions } from "@prd-gen/verification";
/** What the verification orchestrator hands to an observation hook. */
export type FlushedObservation = Parameters<NonNullable<ConcludeOptions["onObservation"]>>[0];
/**
 * precondition:  `repo` is the server's open reliability repository; `obs`
 *                is an observation the orchestrator flushed for run `runId`.
 * postcondition: the observation is recorded in `repo`, then one line is
 *                appended to the observation log, with `oracle_resolved_truth`
 *                when the oracle resolved the claim. The repository write is
 *                done before this returns; the log line is written before it
 *                returns too unless the claim carries external grounding, in
 *                which case it follows the oracle's answer.
 * invariant:     a persistence error never reaches the caller.
 */
export declare function writeObservation(repo: Pick<ReliabilityRepository, "recordObservation">, obs: FlushedObservation, runId: string | undefined): void;
//# sourceMappingURL=observation-writer.d.ts.map