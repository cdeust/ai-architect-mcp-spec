import { appendObservationLog } from "@prd-gen/benchmark";
import { invokeOracle, OracleUnavailableError, } from "@prd-gen/benchmark/calibration";
import { OBSERVATION_LOG_PATH } from "./observation-log-path.js";
// B3 / B1: one-shot per-process warn flag so we don't flood logs when an
// oracle is unavailable. Set to the oracle type that triggered the first warn.
// source: Popper AP-4, Wave E B3 remediation.
let _unavailableOracleWarnFired = null;
const UNRESOLVED = { truth: undefined, evidence: undefined };
/**
 * precondition:  `grounding` is the external grounding of claim `claimId`.
 * postcondition: the oracle's verdict and evidence when the oracle resolves
 *                the claim; UNRESOLVED when it is unavailable or fails,
 *                which is the circularity fallback. Never throws: an
 *                unavailable oracle is said once per process and per oracle
 *                type, any other error each time.
 */
async function resolveOracle(claimId, grounding) {
    try {
        // Justification for cast: external_grounding.payload is typed as
        // `unknown` in ClaimObservationFlushed because the verification
        // package cannot import oracle-specific payload types (layer rule §2.2).
        // The caller populating external_grounding is responsible for
        // providing the correct payload shape; the oracle validates defensively.
        const oracleInput = {
            id: claimId,
            type: grounding.type,
            payload: grounding.payload,
        };
        const oracleResult = await invokeOracle(oracleInput);
        return { truth: oracleResult.truth, evidence: oracleResult.oracle_evidence };
    }
    catch (oracleErr) {
        if (oracleErr instanceof OracleUnavailableError) {
            // B3: oracle unavailable — skip resolution, log once per process.
            if (_unavailableOracleWarnFired !== oracleErr.oracleType) {
                _unavailableOracleWarnFired = oracleErr.oracleType;
                console.warn(`[oracle] ${oracleErr.oracleType} oracle unavailable: ${oracleErr.message}. ` +
                    `Claims requiring this oracle will be excluded from the calibrated arm. ` +
                    `See PHASE_4_PLAN.md §4.1.`);
            }
        }
        else {
            // Unexpected oracle error — log but don't rethrow.
            console.warn(`[oracle] unexpected error resolving claim "${claimId}": ` + String(oracleErr));
        }
        return UNRESOLVED;
    }
}
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
export function writeObservation(repo, obs, runId) {
    void (async () => {
        try {
            repo.recordObservation(obs.judge, obs.claimType, obs.observation);
            // judge_verdict = true ↔ judge's verdict is PASS-class.
            // When gt=PASS: judgeWasCorrect=true ↔ judge said PASS.
            // When gt=FAIL: judgeWasCorrect=true ↔ judge said FAIL.
            const judgeVerdictIsPass = !obs.observation.groundTruthIsFail
                ? obs.observation.judgeWasCorrect
                : !obs.observation.judgeWasCorrect;
            // B1: attempt oracle resolution when external_grounding is present.
            // source: Curie A2.3, PHASE_4_PLAN.md §4.1.
            const oracle = obs.external_grounding === undefined
                ? UNRESOLVED
                : await resolveOracle(obs.claim_id, obs.external_grounding);
            appendObservationLog({
                run_id: runId ?? "unknown",
                judge_id: { kind: obs.judge.kind, name: obs.judge.name },
                claim_id: obs.claim_id,
                claim_type: obs.claimType,
                judge_verdict: judgeVerdictIsPass,
                judge_confidence: 0,
                ground_truth: obs.observation.groundTruthIsFail,
                oracle_resolved_truth: oracle.truth,
                oracle_evidence: oracle.evidence,
            }, OBSERVATION_LOG_PATH);
        }
        catch {
            // Best-effort: observation persistence must not break the pipeline.
        }
    })();
}
//# sourceMappingURL=observation-writer.js.map