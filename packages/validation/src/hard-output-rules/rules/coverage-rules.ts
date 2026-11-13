import type {
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { makeViolation } from "./helpers.js";
import { listedIds } from "./listed-ids.js";

// Document-Level Rule 19: FR-to-AC Coverage
export function checkDocumentFRToACCoverage(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  const reqSections = sections.filter((s) => s.type === "requirements");
  const acSections = sections.filter((s) => s.type === "acceptance_criteria");

  if (reqSections.length === 0) return [];

  const reqContent = reqSections.map((s) => s.content).join("\n\n");
  const frPattern = /^\s*\|\s*(FR-\d+)\s*\|/gm;

  const definedFRs = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = frPattern.exec(reqContent)) !== null) {
    definedFRs.add(match[1]);
  }

  if (definedFRs.size === 0) return [];

  const acContent = acSections.map((s) => s.content).join("\n\n");
  const frRefPattern = /(FR-\d+)/g;

  const referencedFRs = new Set<string>();
  while ((match = frRefPattern.exec(acContent)) !== null) {
    referencedFRs.add(match[1]);
  }

  const uncoveredFRs = [...definedFRs]
    .filter((fr) => !referencedFRs.has(fr))
    .sort();

  if (uncoveredFRs.length > 0) {
    return [
      makeViolation(
        "fr_to_ac_coverage",
        null,
        `${uncoveredFRs.length} FR(s) have no acceptance criteria: ${listedIds(uncoveredFRs)}`,
        `Uncovered: ${listedIds(uncoveredFRs)}`,
      ),
    ];
  }

  return [];
}

// Document-Level Rule 20: AC-to-Test Coverage
export function checkDocumentACToTestCoverage(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  const acSections = sections.filter((s) => s.type === "acceptance_criteria");
  const testSections = sections.filter((s) => s.type === "testing");

  if (acSections.length === 0) return [];

  const acContent = acSections.map((s) => s.content).join("\n\n");
  const acPattern = /(AC-\d+)/g;

  const definedACs = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = acPattern.exec(acContent)) !== null) {
    definedACs.add(match[1]);
  }

  if (definedACs.size === 0) return [];

  const testContent = testSections.map((s) => s.content).join("\n\n");
  const acRefPattern = /(AC-\d+)/g;

  const referencedACs = new Set<string>();
  while ((match = acRefPattern.exec(testContent)) !== null) {
    referencedACs.add(match[1]);
  }

  const uncoveredACs = [...definedACs]
    .filter((ac) => !referencedACs.has(ac))
    .sort();

  if (uncoveredACs.length > 0) {
    return [
      makeViolation(
        "ac_to_test_coverage",
        null,
        `${uncoveredACs.length} AC(s) have no test coverage: ${listedIds(uncoveredACs)}`,
        `Uncovered: ${listedIds(uncoveredACs)}`,
      ),
    ];
  }

  return [];
}
