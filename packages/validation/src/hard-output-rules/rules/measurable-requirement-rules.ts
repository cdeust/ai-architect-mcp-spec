import type {
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { makeViolation } from "./helpers.js";
import { listedIds } from "./listed-ids.js";
import { phrases } from "./lexicon.js";
import { requirementDefinitions } from "./requirement-definitions.js";

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
// words, is read as the bound the term needs, except where it cannot be a
// quantity: a code span, an identifier (`FR-2`), a priority code (`P1`), the
// marker of a numbered list item, and a metadata column of a table or a
// metadata row of a key-value table (`Priority`, `Story Points`). The rule does not check that the number
// belongs to the term, and quoted text is read for the number (a quote may
// state the bound), so a quoted label that carries a number silences it
// (`The "Top 10" page must load fast.`): a missed finding, chosen over a
// blocking one on a quoted bound. It fires on the presence of a defect, so
// it is blocking, but not critical: the term list is a heuristic, and a
// finding costs the non-critical penalty and triggers no critical retry.
//
// source: issue #118, seeded defect `unmeasurable_requirement` ("Copying must
// be fast and user-friendly."), which the document check did not diagnose.

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
const UNBOUNDED_TERM = wholeWordTerms(phrases("unboundedQualityTerms"));

/**
 * A number in digits, or a number word other than "one": "one" and the
 * French "un" are left out because they are also articles and pronouns.
 * Compounds are read by their parts (`twenty-five`, `dix-sept`,
 * `quatre-vingts`), since a hyphen is not a letter.
 */
const NUMBER_WORDS = [
  // EN
  "zero", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
  "eighty", "ninety", "hundred", "hundreds", "thousand", "thousands", "million",
  "millions", "billion", "billions", "dozen", "dozens",
  // FR
  "zéro", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix",
  "onze", "douze", "treize", "quatorze", "quinze", "seize", "vingt", "vingts",
  "trente", "quarante", "cinquante", "soixante", "septante", "huitante", "octante",
  "nonante", "cent", "cents", "mille", "milliers", "milliard", "milliards", "douzaine",
  "douzaines",
] as const;

const NUMBER = new RegExp(
  String.raw`\p{N}|(?<!\p{L})(?:${[...new Set(NUMBER_WORDS)].join("|")})(?!\p{L})`,
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

/** A code span: a symbol, never a bound. Bounded to one line like NAMED_TEXT. */
const CODE_SPAN = /`[^`\n]*`/g;

/**
 * Tokens that carry a digit but are not a quantity, so they cannot bound a
 * term: an identifier (`FR-001`, `STORY-2`, `UTF-8`) with its sub-identifier
 * suffixes that start with a letter (`FR-001-AC1`, not the `-500` of
 * `NFR-002-500`; PR #302 review, note 2), a priority code (`P1`).
 * An identifier that opens a line and is followed by a colon names that line
 * (`FR-001-1: Results are listed.`), so its digit-only suffixes are part of
 * it there: in running text they stay a number, the choice of PR #302
 * (PR #303 review, note 2).
 * The patterns are bounded. source: PR #275 review, notes 1 and 4. The
 * marker of a list item is not text in the block tree (requirement-definitions.ts).
 */
const NOT_A_QUANTITY = [
  /^([ \t]*)(?:\*\*|\x60)?[A-Z][A-Z0-9]{0,9}-\d{1,9}(?:-[A-Z0-9]{1,10}){0,5}(?:\*\*|\x60)?(?=[ \t]*:)/gm,
  /\b[A-Z][A-Z0-9]{0,9}-\d{1,9}(?:-[A-Z][A-Z0-9]{0,9}){0,5}\b/g,
  /\bP\d\b/g,
] as const;

/**
 * An ordered list marker that numbers a statement right after its
 * identifier (`| FR-001 | 2. Search must be fast. |`): it opens the
 * statement, it bounds nothing (PR #278 review, note 3).
 */
const LEADING_MARKER = /^[ \t]*\d{1,9}[.)](?=[ \t]+\S)/;

/**
 * The text in which a bound is looked for: code spans, the marker that
 * numbers the first line and the tokens that are not a quantity are removed,
 * but quoted text is kept, since a quote may state the bound (`"p95 under 2
 * s"`; PR #275 review, note 2).
 */
function quantitiesOf(text: string): string {
  let out = text.replace(LEADING_MARKER, " ").replace(CODE_SPAN, " ");
  for (const pattern of NOT_A_QUANTITY) out = out.replace(pattern, (_, indent: unknown) => `${typeof indent === "string" ? indent : ""} `);
  return out;
}

/**
 * The first unbounded term of a requirement text when the text holds no
 * number, else null. The term is looked for outside quoted text and code
 * spans; the number anywhere but in a code span, an identifier, a priority
 * code or the marker that numbers the first line.
 */
export function unboundedTermIn(text: string): string | null {
  if (NUMBER.test(quantitiesOf(text))) return null;
  return UNBOUNDED_TERM.exec(withoutNamedText(text))?.[0] ?? null;
}

/** The text with its quoted text and code spans blanked: what it states, not what it names. */
export function withoutNamedText(text: string): string {
  return text.replace(NAMED_TEXT, " ");
}

/**
 * Every phrase of `terms` as one whole-word alternation, case-insensitive,
 * longest first so that a phrase wins over a shorter overlapping one. Within
 * a phrase a space matches any run of spaces or tabs; a term must not touch
 * a letter, a digit or a hyphen on either side.
 */
export function wholeWordTerms(terms: readonly string[]): RegExp {
  return new RegExp(
    String.raw`(?<!${WORD_CHAR})(?:` +
      [...new Set(terms)]
        .sort((a, b) => b.length - a.length)
        .map((p) => escapeRegExp(p).replace(/ /g, "[ \\t]+"))
        .join("|") +
      String.raw`)(?!${WORD_CHAR})`,
    "iu",
  );
}

export function checkDocumentMeasurableRequirements(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  const flagged = new Set<string>();
  const quoted: string[] = [];
  for (const section of sections) {
    // Each section is parsed on its own, as the other document rules read it.
    for (const { id, text } of requirementDefinitions(section.content)) {
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
