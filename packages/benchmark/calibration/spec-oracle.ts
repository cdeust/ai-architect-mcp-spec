/**
 * specOracle — Hard Output Rules validation via @prd-gen/validation.
 *
 * Precondition:  payload.markdown is a non-empty string; payload.section_type
 *                is a valid SectionType; payload.expected_passes is the claim.
 * Postcondition: truth = ((blocking violations === 0) === expected_passes).
 *                oracle_evidence is non-empty, human-readable, and contains
 *                the caveat about internal grounding.
 * Invariant:     No LLM calls are made. validateSection() is pure regex/parsing.
 *
 * !! IMPORTANT — INTERNAL GROUNDING CAVEAT !!
 * This oracle is "weakly external" because @prd-gen/validation is maintained
 * by the same team as the annotators it grounds. Rule changes to the validator
 * silently shift ground truth. See docs/PHASE_4_PLAN.md §4.1 for the full
 * discussion. The evidence string ALWAYS includes this caveat so downstream
 * consumers can weight it appropriately.
 *
 * Layer: benchmark/calibration. Depends on @prd-gen/validation (inner
 *   workspace package — acceptable; benchmark is in the same monorepo and
 *   depends on validation per package.json).
 */

import { validateSection } from "@prd-gen/validation";
import { isBlockingViolation, type SectionType } from "@prd-gen/core";
import type { SpecPayload, OracleResult } from "./oracle-types.js";

/** Maximum number of violated rule_ids to include in evidence. */
const MAX_VIOLATION_IDS_IN_EVIDENCE = 5;

/**
 * Validate a markdown section against Hard Output Rules and compare the
 * pass/fail result to the caller's claim (expected_passes).
 *
 * Precondition:  section_type is a valid SectionType string.
 * Postcondition: truth = ((blocking violations === 0) === expected_passes).
 */
export async function specOracle(payload: SpecPayload): Promise<OracleResult> {
  const { markdown, section_type, expected_passes } = payload;

  // Runtime guard: section_type must be a SectionType string.
  // We do not import SectionTypeSchema here to avoid a runtime Zod dependency;
  // validateSection() will throw or return empty for unknown types, which we
  // surface in the evidence string.
  const sectionTypeCoerced = section_type as SectionType;

  let report: ReturnType<typeof validateSection>;
  try {
    report = validateSection(markdown, sectionTypeCoerced);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const evidence =
      `specOracle[INTERNAL]: section_type="${section_type}"; ` +
      `validateSection() threw: ${msg}; ` +
      `truth=false (cannot verify claim). ` +
      CAVEAT;
    return { truth: false, oracle_evidence: evidence };
  }

  // A section passes when it has no blocking violation, the same test the
  // pipeline applies (validate-and-advance.ts); advisory findings do not
  // fail it (#117).
  const blocking = report.violations.filter(isBlockingViolation);
  const violationCount = blocking.length;
  const actuallyPasses = violationCount === 0;
  const truth = actuallyPasses === expected_passes;

  const violationIds = blocking
    .slice(0, MAX_VIOLATION_IDS_IN_EVIDENCE)
    .map((v) => v.rule);
  const violationIdsStr =
    violationIds.length > 0
      ? `[${violationIds.join(", ")}${blocking.length > MAX_VIOLATION_IDS_IN_EVIDENCE ? ", ..." : ""}]`
      : "[]";

  const evidence =
    `specOracle[INTERNAL]: section_type="${section_type}"; ` +
    `violations=${violationCount}; ` +
    `violated_rule_ids=${violationIdsStr}; ` +
    `actually_passes=${String(actuallyPasses)}; ` +
    `expected_passes=${String(expected_passes)}; ` +
    `truth=${String(truth)}. ` +
    CAVEAT;

  return { truth, oracle_evidence: evidence };
}

/**
 * Caveat appended to every specOracle evidence string.
 * source: docs/PHASE_4_PLAN.md §4.1 "Externally-grounded held-out subset".
 */
const CAVEAT =
  "specOracle is internally-grounded; ground truth shifts when @prd-gen/validation " +
  "rules change. See docs/PHASE_4_PLAN.md §4.1.";
