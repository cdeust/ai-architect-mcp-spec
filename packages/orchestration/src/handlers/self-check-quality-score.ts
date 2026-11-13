/**
 * The quality score a concluded self-check queues for the evidence store
 * (#121). The composition root (mcp-server) drains the queue into
 * `EvidenceRepository.recordQualityScore`; nothing called it before, so
 * `get_quality_history` could never return data (audit of 2026-10-10).
 */
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
