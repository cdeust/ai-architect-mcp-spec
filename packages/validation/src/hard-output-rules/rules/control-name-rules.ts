import type {
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { makeViolation } from "./helpers.js";
import { listedIds } from "./listed-ids.js";
import { LEXICON } from "./lexicon.js";
import { requirementDefinitions } from "./requirement-definitions.js";

// Document-Level Rule: Consistent Control Names
//
// A requirement names the control a reader acts on ("Each code block shows a
// Copy button"); its acceptance criterion is the check a test runs on that
// control. A criterion that calls it by another name ("has exactly one Clone
// control") checks a control no requirement defines: the two statements use
// different terms for one thing, against the "consistent" characteristic of a
// set of requirements in ISO/IEC/IEEE 29148:2018 (terms used consistently).
//
// The rule reads the named controls of the requirement definitions (FR-n,
// NFR-n) and of the acceptance-criterion definitions (AC-n), with the block
// tree of requirement-definitions.ts. A named control is a capitalized word
// next to a noun of the `controlNouns` lexicon concept: before it in English
// ("Copy button", "\"Copy\" button"), after it in French ("bouton Copier",
// "bouton « Copier »"). A criterion is reported when it names a control whose
// name no requirement uses. Names are compared case-insensitively; the noun
// is not compared, so "Copy control" in a criterion matches "Copy button" in
// a requirement. When no requirement names a control there is no term to be
// inconsistent with, and nothing is reported. Code spans are not read.
//
// The finding is blocking but not critical: what is a name is a heuristic (a
// capitalized word next to a control noun), so a finding costs the
// non-critical penalty and triggers no critical retry.
//
// source: issue #118, seeded defect `inconsistent_terminology` (the
// acceptance criteria call the Copy button the "Clone control"), which the
// document check did not diagnose.

/** Words that open a noun phrase without naming anything ("The button", "Each link"). */
const NOT_A_NAME: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "each",
  "every",
  "any",
  "all",
  "both",
  "either",
  "neither",
  "no",
  "one",
  "this",
  "that",
  "these",
  "those",
  "its",
  "their",
  "his",
  "her",
  "our",
  "your",
  "my",
  "same",
  "another",
  "other",
  "which",
  "what",
  "whose",
  // French determiners: "Le menu Fichier" opens on "Le menu", which the
  // English pattern would read as a control named "Le".
  "le",
  "la",
  "les",
  "l",
  "un",
  "une",
  "des",
  "du",
  "de",
  "ce",
  "cet",
  "cette",
  "ces",
  "chaque",
  "tout",
  "toute",
  "tous",
  "toutes",
  "son",
  "sa",
  "ses",
  "leur",
  "leurs",
  "notre",
  "nos",
  "votre",
  "vos",
  "mon",
  "ma",
  "mes",
  "aucun",
  "aucune",
]);

/** A noun as written lowercase or capitalized ("button", "Button"), as one alternation. */
function nounAlternation(nouns: readonly string[]): string {
  const forms = new Set<string>();
  for (const noun of nouns) {
    forms.add(noun);
    forms.add(noun.charAt(0).toUpperCase() + noun.slice(1));
  }
  return [...forms].sort((a, b) => b.length - a.length).join("|");
}

const NOT_WORD_BEFORE = String.raw`(?<![\p{L}\p{N}-])`;
const NOT_WORD_AFTER = String.raw`(?![\p{L}\p{N}-])`;
/** A capitalized word: the name. One loop over letters and digits, so linear from each word start. */
const NAME = String.raw`(\p{Lu}[\p{L}\p{N}]*)`;

/** English: the name, optionally quoted, then the noun ("Copy button", "\"Copy\" button"). */
const EN_CONTROL = new RegExp(
  `${NOT_WORD_BEFORE}["“‘']?${NAME}["”’']?[ \\t]+(?:${nounAlternation(LEXICON.controlNouns.en)})${NOT_WORD_AFTER}`,
  "gu",
);

/** French: the noun, then the name, optionally quoted ("bouton Copier", "bouton « Copier »"). */
const FR_CONTROL = new RegExp(
  `${NOT_WORD_BEFORE}(?:${nounAlternation(LEXICON.controlNouns.fr)})[ \\t]+(?:«[ \\t\\u00a0\\u202f]?|["“‘'])?${NAME}${NOT_WORD_AFTER}`,
  "gu",
);

const CODE_SPAN = /`[^`\n]*`/g;

/** A named control: its name, lowercase for the comparison, and the words as written. */
interface NamedControl {
  readonly key: string;
  readonly written: string;
}

/** The named controls of a definition text, in order, code spans left out. */
export function namedControlsIn(text: string): NamedControl[] {
  const read = text.replace(CODE_SPAN, " ");
  const out: { at: number; control: NamedControl }[] = [];
  for (const pattern of [EN_CONTROL, FR_CONTROL]) {
    for (const match of read.matchAll(pattern)) {
      const name = match[1]!;
      const key = name.normalize("NFC").toLowerCase();
      if (NOT_A_NAME.has(key)) continue;
      out.push({ at: match.index, control: { key, written: match[0] } });
    }
  }
  return out.sort((a, b) => a.at - b.at).map((m) => m.control);
}

export function checkDocumentConsistentControlNames(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  const defined = new Set<string>();
  const criteria: { id: string; controls: NamedControl[] }[] = [];
  for (const section of sections) {
    // Each section is parsed on its own, as the other document rules read it.
    for (const { text } of requirementDefinitions(section.content)) {
      for (const control of namedControlsIn(text)) defined.add(control.key);
    }
    for (const { id, text } of requirementDefinitions(section.content, ["AC"])) {
      criteria.push({ id, controls: namedControlsIn(text) });
    }
  }
  if (defined.size === 0) return [];
  const flagged = new Set<string>();
  const quoted: string[] = [];
  for (const { id, controls } of criteria) {
    const unknown = controls.find((c) => !defined.has(c.key));
    if (unknown === undefined || flagged.has(id)) continue;
    flagged.add(id);
    quoted.push(`${id} ("${unknown.written}")`);
  }
  if (flagged.size === 0) return [];
  const names = listedIds(quoted);
  return [
    makeViolation(
      "consistent_control_names",
      null,
      `${flagged.size} acceptance criterion(s) name a control no requirement names: ${names}`,
      `Inconsistent control names: ${names}`,
    ),
  ];
}
