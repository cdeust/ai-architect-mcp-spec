import { newPipelineState, type PipelineState, type SectionStatus } from "../index.js";

function section(
  section_type: SectionStatus["section_type"],
  content: string,
): SectionStatus {
  return {
    section_type,
    status: "passed",
    attempt: 1,
    violation_count: 0,
    last_violations: [],
    content,
    attempt_log: [],
  };
}

/** N synthetic FR-### requirement lines — one fr_traceability claim each. */
function requirementsContent(n: number): string {
  const lines = Array.from(
    { length: n },
    (_, i) => `- FR-${(i + 1).toString().padStart(3, "0")}: The system does thing number ${i + 1}.`,
  );
  return ["## requirements", "", ...lines].join("\n");
}

/**
 * Exactly ONE architecture claim — matches ONLY ARCH_PATTERNS' "hexagonal"
 * entry. (A phrase like "ports and adapters" would ALSO match the
 * ports-and-adapters pattern, yielding two architecture claims instead of
 * one — avoided here so fr_count/architecture-claim arithmetic in the tests
 * below stays exact.)
 */
const TECHNICAL_SPEC_CONTENT = [
  "## technical_specification",
  "",
  "We use a hexagonal design with a clear boundary around the domain core.",
].join("\n");

/**
 * Build a self_check-entry PipelineState with `fr_count` FR requirement
 * claims plus (optionally) exactly one architecture claim.
 */
export function selfCheckState(
  fr_count: number,
  includeArchitecture: boolean,
  overrides: Partial<PipelineState> = {},
): PipelineState {
  const base = newPipelineState({
    run_id: `self-check-budget-test-${fr_count}-${includeArchitecture}`,
    feature_description: "budget gate test",
    skip_preflight: true,
  });
  const sections: SectionStatus[] = [
    section("requirements", requirementsContent(fr_count)),
  ];
  if (includeArchitecture) {
    sections.push(section("technical_specification", TECHNICAL_SPEC_CONTENT));
  }
  return {
    ...base,
    current_step: "self_check",
    sections,
    ...overrides,
  };
}
