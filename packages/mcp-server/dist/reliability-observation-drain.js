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
export function drainReliabilityObservations(state, repo) {
    if (repo !== null) {
        for (const queued of state.reliability_observations) {
            writeObservation(repo, {
                claim_id: queued.claim_id,
                judge: queued.judge,
                claimType: queued.claim_type,
                observation: {
                    groundTruthIsFail: queued.ground_truth_is_fail,
                    judgeWasCorrect: queued.judge_was_correct,
                },
                external_grounding: queued.external_grounding,
            }, state.run_id);
        }
    }
    return { ...state, reliability_observations: [] };
}
//# sourceMappingURL=reliability-observation-drain.js.map