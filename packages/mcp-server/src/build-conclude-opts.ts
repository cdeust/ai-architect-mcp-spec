/**
 * `buildConcludeOpts` — extracted from pipeline-tools.ts in the Wave D
 * code-reviewer remediation (2026-04-28) to keep pipeline-tools.ts under
 * the §4.1 500-LOC cap.
 *
 * Encapsulates four concerns of the `conclude_verification` MCP tool's
 * call-site preparation:
 *
 *   1. Reliability-repo lookup + provider hookup (D2 wiring).
 *   2. Curie A3 loud-warn when `claim_types` is omitted (one-sided
 *      censoring guard).
 *   3. CC-3 observation flusher (B4 control-arm write semantics, B5
 *      claim_id threading, annotator-circularity ground-truth path).
 *   4. ConsensusConfig wiring (strategy, runId, claimTypes).
 *
 * source: Wave D code-reviewer extraction; coding-standards.md §4.1.
 */

import type { Claim } from "@prd-gen/core";
import { appendObservationLog } from "@prd-gen/benchmark";
import {
  invokeOracle,
  OracleUnavailableError,
  type OracleInput,
} from "@prd-gen/benchmark/calibration";
import {
  type ConcludeOptions,
} from "@prd-gen/verification";
import {
  getReliabilityRepo,
  getConsensusReliabilityProvider,
} from "./reliability-wiring.js";
import { OBSERVATION_LOG_PATH } from "./observation-log-path.js";

// B3 / B1: one-shot per-process warn flag so we don't flood logs when an
// oracle is unavailable. Set to the oracle type that triggered the first warn.
// source: Popper AP-4, Wave E B3 remediation.
let _unavailableOracleWarnFired: string | null = null;

export interface BuildConcludeOptsInput {
  readonly consensus_strategy: ConcludeOptions["strategy"];
  readonly run_id?: string;
  readonly claim_types?: Record<string, string>;
  /**
   * OPTIONAL. Pass the Claim objects from the corresponding
   * plan_section_verification / plan_document_verification response if you want
   * oracle-based ground truth (breaks Curie A2 annotator-circularity for
   * grounded claims). Claims that carry `external_grounding` will have their
   * truth resolved by the appropriate oracle; claims without it fall back to
   * consensus-majority (back-compat preserved).
   *
   * Precondition: each Claim in the map is keyed by its claim_id.
   * Postcondition: the returned ConcludeOptions.claims is populated, enabling
   *   the orchestrator's concludeFromVerdicts to propagate external_grounding
   *   into ClaimObservationFlushed events and thence into the oracle pipeline.
   *
   * source: Curie A2.3, PHASE_4_PLAN.md §4.1 Wave F closure; Wave D A7 /
   *   Wave E A2.3 triple-pattern (type-level seam → orchestrator propagation →
   *   MCP-tool-API parameter). This field closes the MCP-tool-API leg.
   */
  readonly claims?: ReadonlyMap<string, Claim>;
}

export function buildConcludeOpts(input: BuildConcludeOptsInput): ConcludeOptions {
  const { consensus_strategy, run_id, claim_types, claims } = input;
  const reliabilityRepo = getReliabilityRepo();
  const reliabilityProvider = getConsensusReliabilityProvider();

  // B5 — Loud diagnostic when claim_types omitted (Curie A3).
  // FAILS_ON: claim_types undefined AND reliabilityRepo open — observations
  //   are silently dropped (claimTypesMap=undefined disables onObservation).
  //   This produces one-sided censoring: runs without claim_types appear to
  //   have no ground-truth signal in the calibration repository even though
  //   the run completed. Warn loudly so operators can fix the caller.
  if (claim_types === undefined && reliabilityRepo !== null) {
    console.warn(
      "[reliability] WARNING: conclude_verification called without claim_types" +
      " — observations will NOT be flushed to the calibration repository for" +
      " this batch. This may produce one-sided censoring across runs.",
    );
  }

  const claimTypesMap = claim_types !== undefined
    ? new Map(Object.entries(claim_types) as [string, string][])
    : undefined;

  // CC-3 control-arm semantics:
  // - getReliabilityForRun returns null on control-arm runs (read-side break).
  // - onObservation fires on ALL runs, INCLUDING control-arm runs (write-side
  //   contributes prior-weighted ground-truth observations to the calibration
  //   pool). This asymmetry is by design: the control arm produces unbiased
  //   training signal that the treatment arm cannot.
  // source: Curie cross-audit Wave D, A1 anomaly resolution.
  const onObservation = reliabilityRepo !== null && claimTypesMap !== undefined
    ? (obs: Parameters<NonNullable<ConcludeOptions["onObservation"]>>[0]) => {
        // Precondition: obs is a ClaimObservationFlushed from the orchestrator.
        // Postcondition: one JSONL entry written with oracle_resolved_truth when
        //   external_grounding is present and the oracle resolves successfully;
        //   entry written without oracle_resolved_truth otherwise (circularity path).
        // Invariant: observation persistence errors never abort the pipeline.
        void (async () => {
          try {
            reliabilityRepo.recordObservation(
              obs.judge,
              obs.claimType,
              obs.observation,
            );

            // judge_verdict = true ↔ judge's verdict is PASS-class.
            // When gt=PASS: judgeWasCorrect=true ↔ judge said PASS.
            // When gt=FAIL: judgeWasCorrect=true ↔ judge said FAIL.
            const judgeVerdictIsPass = !obs.observation.groundTruthIsFail
              ? obs.observation.judgeWasCorrect
              : !obs.observation.judgeWasCorrect;

            // B1: attempt oracle resolution when external_grounding is present.
            // source: Curie A2.3, PHASE_4_PLAN.md §4.1.
            let oracle_resolved_truth: boolean | undefined;
            let oracle_evidence: string | undefined;

            if (obs.external_grounding !== undefined) {
              try {
                // Justification for cast: external_grounding.payload is typed as
                // `unknown` in ClaimObservationFlushed because the verification
                // package cannot import oracle-specific payload types (layer rule §2.2).
                // The caller populating external_grounding is responsible for
                // providing the correct payload shape; the oracle validates defensively.
                const oracleInput: OracleInput = {
                  id: obs.claim_id,
                  type: obs.external_grounding.type,
                  payload: obs.external_grounding.payload as OracleInput["payload"],
                };
                const oracleResult = await invokeOracle(oracleInput);
                oracle_resolved_truth = oracleResult.truth;
                oracle_evidence = oracleResult.oracle_evidence;
              } catch (oracleErr) {
                if (oracleErr instanceof OracleUnavailableError) {
                  // B3: oracle unavailable — skip resolution, log once per process.
                  if (_unavailableOracleWarnFired !== oracleErr.oracleType) {
                    _unavailableOracleWarnFired = oracleErr.oracleType;
                    console.warn(
                      `[oracle] ${oracleErr.oracleType} oracle unavailable: ${oracleErr.message}. ` +
                      `Claims requiring this oracle will be excluded from the calibrated arm. ` +
                      `See PHASE_4_PLAN.md §4.1.`,
                    );
                  }
                  // oracle_resolved_truth remains undefined → circularity fallback.
                } else {
                  // Unexpected oracle error — log but don't rethrow.
                  console.warn(
                    `[oracle] unexpected error resolving claim "${obs.claim_id}": ` +
                    String(oracleErr),
                  );
                }
              }
            }

            appendObservationLog(
              {
                run_id: run_id ?? "unknown",
                judge_id: { kind: obs.judge.kind, name: obs.judge.name },
                claim_id: obs.claim_id,
                claim_type: obs.claimType,
                judge_verdict: judgeVerdictIsPass,
                judge_confidence: 0,
                ground_truth: obs.observation.groundTruthIsFail,
                oracle_resolved_truth,
                oracle_evidence,
              },
              OBSERVATION_LOG_PATH,
            );
          } catch {
            // Best-effort: observation persistence must not break the pipeline.
          }
        })();
      }
    : undefined;

  return {
    strategy: consensus_strategy,
    reliabilityProvider: reliabilityProvider ?? undefined,
    runId: run_id,
    claimTypes: claimTypesMap as
      | ReadonlyMap<string, Claim["claim_type"]>
      | undefined,
    claims,
    onObservation,
  };
}
