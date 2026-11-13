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
 *
 * A judge alone on a claim is not queued. The outcome retained for a claim
 * is the consensus of its verdicts, so a lone judge is compared with its own
 * verdict: it is "correct" by construction, and recording that raises its
 * estimate with no information. The default budget sends one judge per claim
 * (self-check-verify-budget.ts), so without this rule most observations of a
 * run would be of that kind (review 1 of #245). `conclude_verification`
 * keeps its own rule: what a host sends it is flushed as before.
 */
import type { Claim, JudgeVerdict } from "@prd-gen/core";
import { concludeDocument, type VerificationReport } from "@prd-gen/verification";
import type { ReliabilityObservationRecord } from "../types/state.js";

/** A judge is set against the others on a claim only when there are others. */
const FEWEST_JUDGES_COMPARED = 2;

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
 *                holds one record per verdict the orchestrator flushes on a
 *                claim of `judgedClaims` for which it flushes at least two,
 *                in the orchestrator's order; none for a claim that is not
 *                among them, so a rule-tier verdict yields none, and none for
 *                a claim one judge alone ruled on.
 */
export function concludeWithObservations(
  verdicts: readonly JudgeVerdict[],
  judgedClaims: readonly Claim[],
): ConcludedDocument {
  if (judgedClaims.length === 0) return { report: concludeDocument(verdicts), observations: [] };
  const claims = new Map(judgedClaims.map((claim) => [claim.claim_id, claim]));
  const claimTypes = new Map(judgedClaims.map((claim) => [claim.claim_id, claim.claim_type]));
  const byClaim = new Map<string, ReliabilityObservationRecord[]>();
  const report = concludeDocument(verdicts, {
    claims,
    claimTypes,
    onObservation: (flushed) => {
      const grounding = flushed.external_grounding;
      const ofClaim = byClaim.get(flushed.claim_id) ?? [];
      byClaim.set(flushed.claim_id, ofClaim);
      ofClaim.push({
        claim_id: flushed.claim_id,
        judge: flushed.judge,
        claim_type: flushed.claimType,
        ground_truth_is_fail: flushed.observation.groundTruthIsFail,
        judge_was_correct: flushed.observation.judgeWasCorrect,
        ...(grounding === undefined ? {} : { external_grounding: { type: grounding.type, payload: grounding.payload } }),
      });
    },
  });
  const observations = [...byClaim.values()].filter((ofClaim) => ofClaim.length >= FEWEST_JUDGES_COMPARED).flat();
  return { report, observations };
}
