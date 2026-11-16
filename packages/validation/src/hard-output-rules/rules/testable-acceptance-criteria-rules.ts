import type {
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { makeViolation } from "./helpers.js";
import { listedIds } from "./listed-ids.js";
import { phrases } from "./lexicon.js";
import { wholeWordTerms, withoutNamedText } from "./measurable-requirement-rules.js";
import { requirementDefinitions } from "./requirement-definitions.js";

// Document-Level Rule: Testable Acceptance Criteria
//
// An acceptance criterion is the check a test runs. One that states how a
// person feels about the product ("Readers love the confirmation.") names no
// behaviour a test can observe, so no test can pass or fail it: it is not
// verifiable (ISO/IEC/IEEE 29148:2018 §5.2.5), and its wording is the
// subjective language §5.2.7 asks a statement to avoid.
//
// The rule reads each acceptance-criterion definition (AC-n as the first
// cell of a table row, or opening a list item, heading or bold line), with
// the block tree of requirement-definitions.ts, and reports the ones whose
// text, quoted text and code spans removed, holds a term of the
// `untestableOutcomeTerms` lexicon concept (love, enjoy, delighted,
// appreciate…; EN and FR). It fires on the presence of a defect, so it is
// blocking, but not critical: the term list is a heuristic, and a finding
// costs the non-critical penalty and triggers no critical retry.
//
// source: issue #118, seeded defect `untestable_statement` ("Readers love the
// confirmation."), which the document check did not diagnose.

const OUTCOME_TERM = wholeWordTerms(phrases("untestableOutcomeTerms"));

/**
 * A French word elided after the first-person "j'" ("J'aime", "j’adore").
 * The apostrophe is not a word character of `wholeWordTerms`, so without this
 * "J'aime" would read as the term "aime". In a criterion it is the name of the
 * French "Like" reaction ("Le bouton J'aime incrémente le compteur de 1."),
 * not a statement of how someone feels: a criterion does not state its
 * writer's own feeling. It is left out for the reason "like" is left out in
 * English. Other elisions stay read: "Les lecteurs l'adorent" states a
 * feeling. Linear: a fixed prefix then one letter class.
 * source: review 1 of #315, note 3.
 */
const FIRST_PERSON_ELISION = /(?<![\p{L}\p{N}-])j['’]\p{L}+/giu;

/** The first term of an acceptance-criterion text that states a feeling, outside quoted text, code spans and first-person elisions, else null. */
export function untestableTermIn(text: string): string | null {
  const stated = withoutNamedText(text).replace(FIRST_PERSON_ELISION, " ");
  return OUTCOME_TERM.exec(stated)?.[0] ?? null;
}

export function checkDocumentTestableAcceptanceCriteria(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  const flagged = new Set<string>();
  const quoted: string[] = [];
  for (const section of sections) {
    // Each section is parsed on its own, as the other document rules read it.
    for (const { id, text } of requirementDefinitions(section.content, ["AC"])) {
      const term = untestableTermIn(text);
      if (term === null || flagged.has(id)) continue;
      flagged.add(id);
      quoted.push(`${id} ("${term.toLowerCase()}")`);
    }
  }
  if (flagged.size === 0) return [];
  const names = listedIds(quoted);
  return [
    makeViolation(
      "testable_acceptance_criteria",
      null,
      `${flagged.size} acceptance criterion(s) state how a person feels, which no test can observe: ${names}`,
      `Untestable: ${names}`,
    ),
  ];
}
