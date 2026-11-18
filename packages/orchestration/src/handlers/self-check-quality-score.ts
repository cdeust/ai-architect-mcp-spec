/**
 * The quality score a concluded self-check queues for the evidence store
 * (#121). The composition root (mcp-server) drains the queue into
 * `EvidenceRepository.recordQualityScore`; nothing called it before, so
 * `get_quality_history` could never return data (audit of 2026-10-10).
 */
import { REQUEST_SIZE_DEFAULT } from "@prd-gen/core";
import { runRequestSize } from "../section-plan.js";
import type { validateDocument } from "@prd-gen/validation";
import type { PipelineState, QualityScoreRecord } from "../types/state.js";

/**
 * precondition:  `report` is validateDocument() of the sections the
 *                self-check concludes on.
 * postcondition: the queue of `state` plus one record carrying the figures
 *                of `report`; the queue unchanged for a run that has no PRD
 *                context, which has nothing to file a score under (none
 *                reaches self-check in the pipeline, where the context is
 *                set before the sections).
 */
export function withDocumentScore(
  state: PipelineState,
  report: ReturnType<typeof validateDocument>,
): QualityScoreRecord[] {
  if (state.prd_context === null) return state.quality_scores;
  // The history of a kind compares documents of that kind. A run held to
  // the plan of a size has other sections: its score would not be one of
  // that series, so it is not filed under the kind (#119).
  if (runRequestSize(state) !== REQUEST_SIZE_DEFAULT) return state.quality_scores;
  return [
    ...state.quality_scores,
    {
      prd_context: state.prd_context,
      rules_checked: report.rulesChecked.length,
      rules_passed: report.rulesPassed.length,
      critical_violations: report.violations.filter((v) => v.isCritical).length,
      total_score: report.totalScore,
    },
  ];
}
