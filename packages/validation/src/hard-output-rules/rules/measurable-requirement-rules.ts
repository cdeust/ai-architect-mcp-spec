import type {
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { makeViolation } from "./helpers.js";
import { listedIds } from "./listed-ids.js";
import { LINE_BREAK, linesOutsideFences } from "./fenced-blocks.js";
import { phrases } from "./lexicon.js";

// Document-Level Rule: Measurable Requirements
//
// A requirement that asks for an unbounded quality ("fast", "user-friendly",
// "seamless") and gives no number cannot be verified: no test can decide
// whether it holds. ISO/IEC/IEEE 29148:2018 §5.2.7 lists such terms
// (superlatives, subjective language, ambiguous adjectives and adverbs,
// loopholes such as "if possible") as terms a requirement statement must
// avoid or bound.
//
// The rule reads each requirement definition (FR-n, NFR-n) and reports the
// ones whose text holds such a term and no number. A number, in digits or in
// words, is read as the bound the term needs; the rule does not check that
// the number belongs to the term. It fires on the presence of a defect, so
// it is blocking, but not critical: the term list is a heuristic, and a
// finding costs the non-critical penalty and triggers no critical retry.
//
// source: issue #118, seeded defect `unmeasurable_requirement` ("Copying must
// be fast and user-friendly."), which the document check did not diagnose.

/** A requirement identifier, bounded to nine digits like dependency-target-rules.ts. */
const REQ_ID_SOURCE = String.raw`\b(?:FR|NFR)-\d{1,9}\b`;

/** A table row whose first cell is one requirement identifier (optionally bold or code). */
const TABLE_DEFINITION = new RegExp(
  String.raw`^[ \t]*\|[ \t]*(?:\*\*|\x60)?(${REQ_ID_SOURCE})(?:\*\*|\x60)?[ \t]*\|(.*)$`,
);

/** A list item, heading or bold line that opens with a requirement identifier. */
const LIST_DEFINITION = new RegExp(
  String.raw`^[ \t]*(?:(?:[-*+]|\d{1,9}[.)]|#{1,6})[ \t]+(?:\*\*|\x60)?|\*\*)(${REQ_ID_SOURCE})(?:\*\*|\x60)?(.*)$`,
);

/** A letter, a digit or a hyphen: a term must not touch one on either side. */
const WORD_CHAR = String.raw`[\p{L}\p{N}-]`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every unbounded term (EN + FR) as one alternation, longest first so that
 * `user friendly` wins over a shorter overlapping phrase. Within a phrase a
 * space matches any run of spaces or tabs.
 */
const UNBOUNDED_TERM = new RegExp(
  String.raw`(?<!${WORD_CHAR})(?:` +
    [...new Set(phrases("unboundedQualityTerms"))]
      .sort((a, b) => b.length - a.length)
      .map((p) => escapeRegExp(p).replace(/ /g, "[ \\t]+"))
      .join("|") +
    String.raw`)(?!${WORD_CHAR})`,
  "iu",
);

/**
 * A number in digits, or a number word from two up: "one" and the French
 * "un" are left out because they are also articles and pronouns.
 */
const NUMBER = new RegExp(
  String.raw`\p{N}|(?<!\p{L})(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|hundred|thousand|million|deux|trois|quatre|cinq|sept|huit|neuf|dix|onze|douze|quinze|vingt|trente|quarante|cinquante|soixante|cent|mille)(?!\p{L})`,
  "iu",
);

/**
 * Quoted text and code spans name things (a "Fast mode" label, a `quickSort`
 * symbol) rather than state a quality, so they are removed before the term
 * search. Each pattern is bounded to one line, and the body of a quote
 * excludes its opening mark as well as its closing one: otherwise a line of
 * `“` (or `«`) with no closing mark is rescanned to its end from every
 * opening mark, which is quadratic (CodeQL js/polynomial-redos, PR #275).
 */
const NAMED_TEXT = /"[^"\n]*"|“[^“”\n]*”|«[^«»\n]*»|`[^`\n]*`/g;

interface RequirementDefinition {
  readonly id: string;
  readonly text: string;
}

function definitionsIn(content: string): RequirementDefinition[] {
  const out: RequirementDefinition[] = [];
  for (const line of content.split(LINE_BREAK)) {
    const match = TABLE_DEFINITION.exec(line) ?? LIST_DEFINITION.exec(line);
    if (match) out.push({ id: match[1]!, text: match[2] ?? "" });
  }
  return out;
}

/**
 * The first unbounded term of a requirement text when the text holds no
 * number, else null.
 */
export function unboundedTermIn(text: string): string | null {
  const stated = text.replace(NAMED_TEXT, " ");
  if (NUMBER.test(stated)) return null;
  return UNBOUNDED_TERM.exec(stated)?.[0] ?? null;
}

export function checkDocumentMeasurableRequirements(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  const flagged = new Set<string>();
  const quoted: string[] = [];
  for (const section of sections) {
    // Fences are removed per section, as in dependency-target-rules.ts.
    const content = linesOutsideFences(section.content).join("\n");
    for (const { id, text } of definitionsIn(content)) {
      const term = unboundedTermIn(text);
      if (term === null || flagged.has(id)) continue;
      flagged.add(id);
      quoted.push(`${id} ("${term.toLowerCase()}")`);
    }
  }
  if (flagged.size === 0) return [];
  const names = listedIds(quoted);
  return [
    makeViolation(
      "measurable_requirements",
      null,
      `${flagged.size} requirement(s) state an unbounded quality with no number: ${names}`,
      `Unmeasurable: ${names}`,
    ),
  ];
}
