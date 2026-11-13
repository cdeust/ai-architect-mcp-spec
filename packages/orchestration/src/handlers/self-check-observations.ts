/**
 * The reliability observations of a self-check that concludes on judge
 * verdicts (#121).
 *
 * The verification orchestrator flushes one observation per judge verdict
 * when it is given the types of the claims and a hook. The pipeline gave it
 * neither, so a run flushed nothing; `conclude_verification` called with
 * `claim_types` was the only path that did, and the repository calls a
 * conclusion without a flush one-sided censoring (build-conclude-opts.ts).
 *
 * The hook here only collects: the reducer does no I/O. The composition root
 * (mcp-server) writes what the run state queues.
 */
import type { Claim, JudgeVerdict } from "@prd-gen/core";
import { concludeDocument, type VerificationReport } from "@prd-gen/verification";
import type { ReliabilityObservationRecord } from "../types/state.js";

export interface ConcludedDocument {
  readonly report: VerificationReport;
  readonly observations: readonly ReliabilityObservationRecord[];
}

/**
 * precondition:  `judgedClaims` are the claims the self-check sent to
 *                judges, each with its type; `verdicts` are every verdict of
 *                the conclusion, rule-tier ones included.
 * postcondition: `report` is `concludeDocument(verdicts)`: no reliability is
 *                read, so the types given change no consensus. `observations`
 *                holds one record per verdict on a claim of `judgedClaims`,
 *                in the orchestrator's order; none for a claim that is not
 *                among them, so a rule-tier verdict yields none.
 */
export function concludeWithObservations(
  verdicts: readonly JudgeVerdict[],
  judgedClaims: readonly Claim[],
): ConcludedDocument {
  if (judgedClaims.length === 0) return { report: concludeDocument(verdicts), observations: [] };
  const claims = new Map(judgedClaims.map((claim) => [claim.claim_id, claim]));
  const claimTypes = new Map(judgedClaims.map((claim) => [claim.claim_id, claim.claim_type]));
  const observations: ReliabilityObservationRecord[] = [];
  const report = concludeDocument(verdicts, {
    claims,
    claimTypes,
    onObservation: (flushed) => {
      const grounding = flushed.external_grounding;
      observations.push({
        claim_id: flushed.claim_id,
        judge: flushed.judge,
        claim_type: flushed.claimType,
        ground_truth_is_fail: flushed.observation.groundTruthIsFail,
        judge_was_correct: flushed.observation.judgeWasCorrect,
        ...(grounding === undefined ? {} : { external_grounding: { type: grounding.type, payload: grounding.payload } }),
      });
    },
  });
  return { report, observations };
}
