/**
 * precondition:  `repo` is the server's evidence repository, or null when
 *                better-sqlite3 is unavailable or the database cannot be
 *                opened.
 * postcondition: every queued score was offered once to `repo`, filed under
 *                the run id, with `auditFlagsRaised` null (the pipeline runs
 *                no audit-flag pass); the returned state has an empty queue,
 *                repository or not, so the queue cannot grow from step to
 *                step.
 *
 * A write that fails does not stop the run: the score is feedback, not a
 * gate. It is said on stderr, once per score, so that a store that refuses
 * writes is not taken for one that has nothing to show.
 */
export function drainQualityScores(state, repo) {
    if (repo !== null) {
        for (const score of state.quality_scores) {
            try {
                repo.recordQualityScore({
                    prdId: state.run_id,
                    prdContext: score.prd_context,
                    rulesChecked: score.rules_checked,
                    rulesPassed: score.rules_passed,
                    criticalViolations: score.critical_violations,
                    totalScore: score.total_score,
                    auditFlagsRaised: null,
                });
            }
            catch (error) {
                console.error(`[prd-gen] quality score of ${state.run_id} not recorded: ${String(error)}`);
            }
        }
    }
    return { ...state, quality_scores: [] };
}
//# sourceMappingURL=quality-score-drain.js.map