import type {
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { makeViolation } from "./helpers.js";

// Rule 2: No Self-Referencing Dependencies
//
// A row/sentence "references itself" only when the SAME identifier appears
// twice within ONE row (markdown table) or ONE prose sentence — not across
// row or paragraph boundaries.
//
// source: bug found 2026-04-26 during the wiki-grooming PRD run. The prior
// regex used `[^|]*` between the two `\1` anchors, which still matches
// newlines — so any FR-NNN appearing in column 1 of one row AND in
// "Depends On" of any LATER row falsely flagged the first row as a
// self-reference. Two fixes below:
//
//   1. Anchor the table-pattern to a single line. Use `[^|\n]*` (excludes
//      both pipes and newlines) so the regex stops at row end and cannot
//      walk forward into another row's cells.
//   2. Anchor the prose pattern to a single sentence/line. Same swap to
//      `[^|\n]*` plus a small bound on cross-clause distance so the regex
//      cannot spuriously match an identifier that appears far away in a
//      different paragraph.
export function checkNoSelfReferencingDeps(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const violations: HardOutputRuleViolation[] = [];

  // Prose pattern: <ID> ... (depends on|blocked by|requires) ... <SAME ID>,
  // all within one line (no `\n` allowed between the two occurrences).
  const pattern =
    /((?:STORY|US|EPIC|FR)-\d+)[^|\n]{0,200}?(?:depends\s+on|blocked\s+by|requires)[^|\n]{0,200}?\1/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const storyId = match[1];
    const matchText = match[0].substring(0, 120);
    violations.push(
      makeViolation(
        "no_self_referencing_deps",
        sectionType,
        `${storyId} references itself in dependencies`,
        matchText,
      ),
    );
  }

  // Markdown-table pattern: | <ID> | ... | <SAME ID> | ... |, all on one
  // physical line. `[^|\n]*` cannot walk past a row boundary because every
  // row ends with a `\n` immediately followed by `|` of the next row.
  const tablePattern =
    /^\s*\|\s*((?:STORY|US|EPIC|FR)-\d+)\s*\|(?:[^|\n]*\|)*[^|\n]*\1[^|\n]*\|/gm;
  while ((match = tablePattern.exec(content)) !== null) {
    const storyId = match[1];
    const alreadyReported = violations.some(
      (v) => v.offendingContent?.includes(storyId) === true,
    );
    if (!alreadyReported) {
      violations.push(
        makeViolation(
          "no_self_referencing_deps",
          sectionType,
          `${storyId} appears to reference itself in table row`,
          storyId,
        ),
      );
    }
  }

  return violations;
}

// Rule 10: Metrics Disclaimer
export function checkMetricsDisclaimer(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const lowered = content.toLowerCase();

  const hasMetrics =
    lowered.includes("reasoning") && lowered.includes("metric");
  if (!hasMetrics) return [];

  const hasDisclaimer =
    lowered.includes("model-projected") ||
    lowered.includes("projected") ||
    lowered.includes("not independent") ||
    lowered.includes("disclaimer");

  if (!hasDisclaimer) {
    return [
      makeViolation(
        "metrics_disclaimer",
        sectionType,
        "Verification metrics found without 'model-projected' disclaimer",
      ),
    ];
  }

  return [];
}

// Rule 15: Honest Verification Verdicts
export function checkHonestVerificationVerdicts(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  // The old class was `[:<≤<=]`, which CodeQL flagged for the repeated `<`
  // (js/regex/duplicate-in-character-class). The duplicate was the fossil of a
  // real bug, not a typo to dedupe: a character class is a SET of single
  // characters, so writing `<=` inside one asks for `<` (again) and `=`, never
  // the two-character operator. `p95 <= 200` — the ordinary way to write a
  // latency NFR — therefore never matched, and this whole rule silently
  // stopped applying to the documents that need it most. Spelling the operator
  // as an alternation matches what was meant: `:`, `≤`, `=`, `<`, and `<=`.
  const nfrPattern =
    /NFR-\d+|(?:p95|p99|latency|throughput|response\s+time)\s*(?:[:≤=]|<=?)\s*\d+/gi;
  if (!nfrPattern.test(content)) return [];

  // Verdicts are canonical upper-case tokens. The pattern used to carry the
  // `i` flag, which counted the English verb ("requests pass through the
  // gateway") as a PASS verdict; with that noise in the count, the rule needed
  // at least two verdicts before firing, and a single PASS on a latency claim
  // escaped it (#118). Matching the tokens case-sensitively removes the noise,
  // so one unmeasured PASS is flagged like two.
  const verdictPattern =
    /\b(?:PASS|SPEC-COMPLETE|NEEDS-RUNTIME|INCONCLUSIVE|FAIL)\b/g;
  const verdicts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = verdictPattern.exec(content)) !== null) {
    verdicts.push(match[0].toUpperCase());
  }

  if (verdicts.length === 0) return [];

  const hasOnlyPass = verdicts.every((v) => v === "PASS");
  if (hasOnlyPass) {
    return [
      makeViolation(
        "honest_verification_verdicts",
        sectionType,
        `All ${verdicts.length} verdicts are PASS despite NFR performance claims that require runtime measurement — use SPEC-COMPLETE or NEEDS-RUNTIME for unverified metrics`,
        `Verdicts: ${verdicts.length}x PASS, 0x SPEC-COMPLETE/NEEDS-RUNTIME`,
      ),
    ];
  }

  return [];
}

// Document-Level Rule 15: Cross-Section Verdict Honesty
export function checkDocumentVerificationVerdicts(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  const perfSections = sections.filter(
    (s) => s.type === "performance_requirements",
  );
  const testSections = sections.filter((s) => s.type === "testing");

  if (perfSections.length === 0) return [];

  const perfContent = perfSections.map((s) => s.content).join("\n\n");
  const testContent = testSections.map((s) => s.content).join("\n\n");
  const combinedContent = perfContent + "\n\n" + testContent;

  return checkHonestVerificationVerdicts(
    combinedContent,
    "performance_requirements",
  );
}

// Rule 23: Risk Mitigation Completeness
export function checkRiskMitigationCompleteness(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  // Header detection is a per-line substring question, so ask it that way.
  // The previous regex chained three `[^\n]*` runs, which backtrack against
  // each other and made match time polynomial in line length
  // (js/polynomial-redos). This input is LLM-generated PRD text, so a
  // pathological line stalls the validation pipeline rather than merely being
  // slow. Splitting on lines and testing membership is linear and reads as
  // what the rule actually means.
  const RISK_WORDS = ["risk", "threat"];
  const ACTION_WORDS = ["mitigation", "response", "action"];
  const hasRiskHeader = content.split("\n").some((line) => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("|")) return false;
    const lower = trimmed.toLowerCase();
    return (
      RISK_WORDS.some((w) => lower.includes(w)) &&
      ACTION_WORDS.some((w) => lower.includes(w))
    );
  });
  if (!hasRiskHeader) return [];

  const rowPattern = /^\s*\|(?!\s*[-:]+\s*\|)(.+)\|/gm;
  const violations: HardOutputRuleViolation[] = [];
  // `^\s*(...)?\s*$` puts two unbounded `\s*` runs either side of an optional
  // group: on a whitespace-only cell the engine can split the run at every
  // position, which is the ' ' repetition CodeQL flagged. A trim plus a set
  // membership test is linear, and states the rule plainly: the cell is empty
  // or one of the placeholder tokens.
  const PLACEHOLDER_MITIGATIONS = new Set(["", "-", "n/a", "na", "tbd", "todo", "none"]);
  const isPlaceholderMitigation = (cell: string): boolean =>
    PLACEHOLDER_MITIGATIONS.has(cell.trim().toLowerCase());

  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(content)) !== null) {
    index++;
    if (index === 1) continue; // skip header

    const rowText = match[1];
    const cells = rowText.split("|").map((c) => c.trim());

    const isSeparator = cells.every((cell) =>
      [...cell].every((ch) => ch === "-" || ch === ":" || ch === " "),
    );
    if (isSeparator) continue;

    const lastCell = cells[cells.length - 1];
    if (lastCell === undefined) continue;

    if (isPlaceholderMitigation(lastCell)) {
      const riskDescription = cells[0] ?? "Unknown";
      violations.push(
        makeViolation(
          "risk_mitigation_completeness",
          sectionType,
          `Risk '${riskDescription.substring(0, 60)}' has empty or placeholder mitigation`,
          `Mitigation: ${lastCell.length === 0 ? "(empty)" : lastCell}`,
        ),
      );
    }
  }

  return violations;
}

// Rule 24: Deployment Rollback Plan
export function checkDeploymentRollbackPlan(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const lowered = content.toLowerCase();
  const rollbackKeywords = [
    "rollback",
    "roll back",
    "undo",
    "revert",
    "restore",
    "fallback",
  ];

  const hasRollbackPlan = rollbackKeywords.some((k) => lowered.includes(k));

  if (!hasRollbackPlan) {
    return [
      makeViolation(
        "deployment_rollback_plan",
        sectionType,
        "Deployment section lacks a rollback/restore strategy — every deployment must have a recovery plan",
      ),
    ];
  }

  return [];
}
