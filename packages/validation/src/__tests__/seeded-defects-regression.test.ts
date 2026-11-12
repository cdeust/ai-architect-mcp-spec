/**
 * Regression fixture for issue #118: what the deterministic document check
 * diagnoses on the ten seeded defects of the audit.
 *
 * The audit found the deterministic tools diagnose few of the ten seeded
 * defects. The fixture (seeded-defects.fixture.ts) rebuilds the ten as single
 * mutations of a clean control. This test pins, for each defect, the blocking
 * rules `validateDocument` (the `validate_prd_document` tool) reports beyond
 * the control's, as measured on this commit. An empty list is a defect the
 * structural checks do not catch: a change that teaches them one must update
 * its row here, and a change that loses a diagnosis fails.
 */
import { describe, it, expect } from "vitest";
import { isBlockingViolation, type HardOutputRuleViolation } from "@prd-gen/core";
import { validateDocument } from "../index.js";
import {
  CLEAN_CONTROL,
  SEEDED_DEFECTS,
  type DefectCategory,
  type Section,
} from "./seeded-defects.fixture.js";

/**
 * Blocking findings reported on the seeded document beyond the control's, as
 * `rule: message`, measured on this commit. The message names the identifier
 * at fault, so a rule that flags the wrong one fails here.
 */
const EXPECTED_DIAGNOSES: Readonly<Record<DefectCategory, readonly string[]>> = {
  contradiction: [],
  missing_acceptance_criteria: ["fr_to_ac_coverage: 1 FR(s) have no acceptance criteria: FR-003"],
  unmeasurable_requirement: [],
  wrong_number: [],
  hallucinated_dependency: [],
  duplicate_requirement: [
    "duplicate_requirement_ids: Requirement ID 'FR-002' appears 2 times — each ID must be unique",
  ],
  scope_creep: [],
  missing_edge_case: [],
  inconsistent_terminology: [],
  untestable_statement: [],
};

const signature = (v: HardOutputRuleViolation): string =>
  `${isBlockingViolation(v) ? "blocking" : "advisory"}:${v.rule}:${v.message}`;

function blockingFindingsBeyondControl(sections: readonly Section[]): string[] {
  const control = new Set(validateDocument(CLEAN_CONTROL).violations.map(signature));
  return validateDocument(sections)
    .violations.filter((v) => isBlockingViolation(v) && !control.has(signature(v)))
    .map((v) => `${v.rule}: ${v.message}`)
    .sort();
}

describe("seeded-defect regression fixture (#118)", () => {
  it("the clean control draws no blocking finding and a full score", () => {
    const report = validateDocument(CLEAN_CONTROL);
    expect(report.violations.filter(isBlockingViolation).map((v) => v.rule)).toEqual([]);
    expect(report.hasCriticalViolations).toBe(false);
    expect(report.totalScore).toBe(1);
  });

  it("the control's only findings are seven advisory findings of six testing-lexicon rules", () => {
    // The audit counted 7 of its 12 violations as boilerplate that also fired
    // on the clean control. On the rebuilt control they are seven absence
    // findings of six testing-lexicon rules (`mandatory_test_coverage` fires
    // twice, once for test types and once for coverage targets): advisory since #117, so they
    // cost no score and trigger no retry, but they are still reported.
    const report = validateDocument(CLEAN_CONTROL);
    for (const v of report.violations) expect(v.isAdvisory, v.rule).toBe(true);
    expect([...new Set(report.violations.map((v) => v.rule))].sort()).toEqual([
      "edge_case_negative_tests",
      "mandatory_test_coverage",
      "no_production_data_in_tests",
      "performance_testing_required",
      "security_testing_required",
      "test_isolation",
    ]);
    expect(report.violations.length).toBe(7);
  });

  it("covers the ten categories of the audit, one seeded document each", () => {
    expect(SEEDED_DEFECTS.map((d) => d.category).sort()).toEqual(
      Object.keys(EXPECTED_DIAGNOSES).sort(),
    );
  });

  it.each(SEEDED_DEFECTS.map((d) => [d.category, d] as const))(
    "%s: the document check reports the pinned diagnosis",
    (category, defect) => {
      expect(blockingFindingsBeyondControl(defect.sections), defect.seed).toEqual(
        EXPECTED_DIAGNOSES[category],
      );
    },
  );

  it("a seeded document scores below the control exactly when it is diagnosed", () => {
    for (const defect of SEEDED_DEFECTS) {
      const diagnosed = EXPECTED_DIAGNOSES[defect.category].length > 0;
      expect(validateDocument(defect.sections).totalScore < 1, defect.category).toBe(diagnosed);
    }
  });

  it("recall on the rebuilt set, computed from the validator, is 2 of 10", () => {
    // Counted from validateDocument, not from EXPECTED_DIAGNOSES, so a rule
    // that starts or stops diagnosing a seed fails here as well.
    const caught = SEEDED_DEFECTS.filter(
      (d) => blockingFindingsBeyondControl(d.sections).length > 0,
    ).map((d) => d.category);
    expect(caught.sort()).toEqual(["duplicate_requirement", "missing_acceptance_criteria"]);
  });

  it("the wrong total is caught only as a `| Total |` row of a timeline table", () => {
    // sp_arithmetic reads table rows of the timeline, deployment and
    // requirements sections; the prose total of the seed above is not read.
    const withTimeline = (total: string): readonly Section[] => [
      ...CLEAN_CONTROL,
      {
        type: "timeline",
        content: `## Timeline\n\n| Story | SP |\n|-------|----|\n| STORY-1 | 2 |\n| STORY-2 | 1 |\n| Total | ${total} |`,
      },
    ];
    expect(blockingFindingsBeyondControl(withTimeline("3"))).toEqual([]);
    // Reported twice, measured: once by the timeline section's own pass and
    // once by the document-level pass over the timeline, deployment and
    // requirements tables (checkDocumentSPArithmetic).
    expect(blockingFindingsBeyondControl(withTimeline("5"))).toEqual([
      "sp_arithmetic: SP total row shows 5 but individual rows sum to 3",
      "sp_arithmetic: SP total row shows 5 but individual rows sum to 3",
    ]);
  });
});
