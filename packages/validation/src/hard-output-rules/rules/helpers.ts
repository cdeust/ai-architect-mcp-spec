import type {
  HardOutputRule,
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { isCriticalRule, scorePenalty } from "@prd-gen/core";

/**
 * Find all matches of a pattern and return a violation for each.
 * Ported from HardOutputRulesValidator+Evaluation.swift findPatternViolations.
 */
export function findPatternViolations(
  pattern: RegExp,
  content: string,
  rule: HardOutputRule,
  sectionType: SectionType,
  message: string,
): HardOutputRuleViolation[] {
  const matches = content.match(pattern);
  if (!matches) return [];

  return matches.map((match) => ({
    rule,
    sectionType,
    message,
    offendingContent: match.length > 0 ? match.substring(0, 120) : null,
    location: null,
    isCritical: isCriticalRule(rule),
    scorePenalty: scorePenalty(rule),
  }));
}

/**
 * Check that content contains enough signals from a keyword list.
 * Returns a violation if the signal count is below the threshold.
 */
export function findAbsenceViolation(
  content: string,
  signals: readonly string[],
  threshold: number,
  rule: HardOutputRule,
  sectionType: SectionType,
  message: string,
): HardOutputRuleViolation[] {
  const lowered = content.toLowerCase();
  const signalCount = signals.filter((s) => lowered.includes(s)).length;

  if (signalCount < threshold) {
    return [makeAdvisoryViolation(rule, sectionType, message)];
  }

  return [];
}

/**
 * Create an advisory violation: the content lacks the vocabulary a lexicon
 * expects for a topic. A lexicon cannot tell whether the topic applies to the
 * feature (a client-side copy button has no rate limiting to specify), so the
 * finding is reported as a prompt to the author and never blocks: no penalty,
 * not critical, no retry.
 *
 * Use this for every finding that fires on the ABSENCE of words. A finding
 * that fires on the PRESENCE of a defect (a weak algorithm, an interpolated
 * SQL query, a duplicate identifier) uses makeViolation and stays blocking.
 *
 * source: issue #117 — a correct client-side PRD scored 0.00 with 52
 *   critical violations, all from lexicon thresholds.
 */
export function makeAdvisoryViolation(
  rule: HardOutputRule,
  sectionType: SectionType | null,
  message: string,
): HardOutputRuleViolation {
  return {
    rule,
    sectionType,
    message,
    offendingContent: null,
    location: null,
    isCritical: false,
    scorePenalty: 0,
    isAdvisory: true,
  };
}

/**
 * Create a single violation object.
 */
export function makeViolation(
  rule: HardOutputRule,
  sectionType: SectionType | null,
  message: string,
  offendingContent: string | null = null,
): HardOutputRuleViolation {
  return {
    rule,
    sectionType,
    message,
    offendingContent,
    location: null,
    isCritical: isCriticalRule(rule),
    scorePenalty: scorePenalty(rule),
  };
}

/**
 * Extract code blocks from markdown content.
 * Returns the inner content of each ```...``` block.
 */
export function extractCodeBlocks(content: string): string[] {
  // `\s*\n` is ambiguous: `\s` ALREADY matches `\n`, so the engine can split a
  // run of newlines between the two in many ways, which is the polynomial
  // backtracking CodeQL flags (js/polynomial-redos). The intent is "optional
  // language tag, then the rest of the fence line, then the newline", so the
  // horizontal-whitespace class says exactly that and is unambiguous.
  //
  // Blank lines between the fence and the first line of code must still be
  // eaten (the original `\s*\n` ate them, and an equivalence check showed the
  // rules see a different block without that). They are NOT eaten in the
  // pattern, though: an in-pattern `(?:[ \t]*\r?\n)*` sitting in front of the
  // lazy body capture is ambiguous — every blank line can belong either to
  // that run or to the capture — and with an UNTERMINATED fence the engine
  // re-splits the run for each failed scan to end-of-input. Measured O(n²):
  // 1000 blank lines 0.4 ms, 2000 1.1 ms, 4000 4.1 ms, 8000 16.3 ms.
  //
  // Stripping them from the captured text instead is exactly equivalent
  // (same characters removed, same order) and cannot backtrack: LEADING_BLANK
  // is ^-anchored, applied once, to an already-extracted string.
  const pattern = /```(?:\w+)?[ \t]*\r?\n([\s\S]*?)```/g;
  const LEADING_BLANK = /^(?:[ \t]*\r?\n)+/;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    blocks.push(match[1].replace(LEADING_BLANK, ""));
  }
  return blocks;
}

/**
 * Extract a type name from a line containing a type declaration.
 * Ported from CodeQualityRules extractTypeName.
 */
export function extractTypeName(line: string): string {
  const typeKeywords = [
    "struct",
    "class",
    "enum",
    "interface",
    "object",
    "record",
  ];
  const words = line.split(/\s+/).filter((w) => w.length > 0);

  for (let i = 0; i < words.length; i++) {
    const clean = words[i].toLowerCase().replace(/[^\w]/g, "");
    if (typeKeywords.includes(clean) && i + 1 < words.length) {
      return words[i + 1].replace(/[^\w]/g, "");
    }
  }

  return "Unknown";
}
