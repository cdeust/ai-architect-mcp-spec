import type {
  HardOutputRule,
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { makeViolation } from "./helpers.js";
import { listedIds, missingNumbers } from "./listed-ids.js";

/** `PREFIX-n` for each number, the form the findings name identifiers in. */
function idsOf(prefix: string, numbers: readonly number[]): string[] {
  return numbers.map((n) => `${prefix}-${n}`);
}

// Rule 3: AC Numbering
export function checkACNumbering(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const acPattern = /AC-(\d+)/g;
  const acNumbers: number[] = [];

  let match: RegExpExecArray | null;
  while ((match = acPattern.exec(content)) !== null) {
    acNumbers.push(parseInt(match[1], 10));
  }

  if (acNumbers.length === 0) return [];

  const sorted = [...new Set(acNumbers)].sort((a, b) => a - b);
  const gaps = missingNumbers(sorted);

  if (gaps.count > 0) {
    return [
      makeViolation(
        "ac_numbering",
        sectionType,
        `AC numbering has gaps: missing ${listedIds(idsOf("AC", gaps.first), gaps.count)}`,
        `Found: ${listedIds(idsOf("AC", sorted))}`,
      ),
    ];
  }

  return [];
}

// Rule 11: FR Traceability
export function checkFRTraceability(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  // Both header probes previously chained three `[^\n]*` runs, which backtrack
  // against one another and made match time polynomial in line length
  // (js/polynomial-redos) on LLM-generated PRD text. Asked per line instead:
  // a header row is a table row that mentions ID and the other column word.
  // `\bID\b` is kept as a word-boundary regex so "GRID"/"IDENTIFIER" still do
  // not count as an ID column; only the unbounded `[^\n]*` runs are gone.
  const ID_WORD = /\bID\b/i;
  const isTableRow = (line: string): boolean => line.trimStart().startsWith("|");
  const hasHeaderWith = (words: readonly string[]): boolean =>
    content.split("\n").some((line) => {
      if (!isTableRow(line) || !ID_WORD.test(line)) return false;
      const lower = line.toLowerCase();
      return words.some((w) => lower.includes(w));
    });

  if (!hasHeaderWith(["requirement", "description"])) return [];

  if (!hasHeaderWith(["source"])) {
    return [
      makeViolation(
        "fr_traceability",
        sectionType,
        "FR table exists but lacks a Source/Traceability column — every FR must trace to its origin",
      ),
    ];
  }

  return [];
}

// Rule 18: Duplicate Requirement IDs
export function checkDuplicateRequirementIds(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const idPattern = /^\s*\|\s*((FR|NFR)-\d+)\s*\|/gm;

  const seenIds = new Map<string, number>();
  let match: RegExpExecArray | null;
  while ((match = idPattern.exec(content)) !== null) {
    const id = match[1];
    seenIds.set(id, (seenIds.get(id) ?? 0) + 1);
  }

  const violations: HardOutputRuleViolation[] = [];
  for (const [id, count] of seenIds) {
    if (count > 1) {
      violations.push(
        makeViolation(
          "duplicate_requirement_ids",
          sectionType,
          `Requirement ID '${id}' appears ${count} times — each ID must be unique`,
          id,
        ),
      );
    }
  }

  return violations;
}

// Rule 22: FR Numbering Gaps
export function checkFRNumberingGaps(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return [
    ...checkIdNumberingGaps(content, "FR", "fr_numbering_gaps", sectionType),
    ...checkIdNumberingGaps(content, "NFR", "fr_numbering_gaps", sectionType),
  ];
}

function checkIdNumberingGaps(
  content: string,
  prefix: string,
  rule: HardOutputRule,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const pattern = new RegExp(`${prefix}-(\\d+)`, "g");
  const numbers: number[] = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    numbers.push(parseInt(match[1], 10));
  }

  if (numbers.length === 0) return [];

  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const gaps = missingNumbers(sorted);

  if (gaps.count > 0) {
    return [
      makeViolation(
        rule,
        sectionType,
        `${prefix} numbering has gaps: missing ${listedIds(idsOf(prefix, gaps.first), gaps.count)}`,
        `Found: ${listedIds(idsOf(prefix, sorted))}`,
      ),
    ];
  }

  return [];
}

// Document-Level AC Consistency
export function checkDocumentACConsistency(
  content: string,
): HardOutputRuleViolation[] {
  const acPattern = /AC-(\d+)/g;
  const acNumbers: number[] = [];

  let match: RegExpExecArray | null;
  while ((match = acPattern.exec(content)) !== null) {
    acNumbers.push(parseInt(match[1], 10));
  }

  if (acNumbers.length <= 1) return [];

  const sorted = [...new Set(acNumbers)].sort((a, b) => a - b);
  const gaps = missingNumbers(sorted);

  if (gaps.count > 0) {
    return [
      makeViolation(
        "ac_numbering",
        null,
        `Document-level AC numbering has gaps: missing ${listedIds(idsOf("AC", gaps.first), gaps.count)}`,
        `Found across document: ${listedIds(idsOf("AC", sorted))}`,
      ),
    ];
  }

  return [];
}
