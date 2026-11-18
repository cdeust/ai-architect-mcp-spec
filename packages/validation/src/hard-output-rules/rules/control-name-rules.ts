import type {
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { makeViolation } from "./helpers.js";
import { listedIds } from "./listed-ids.js";
import { LEXICON } from "./lexicon.js";
import { requirementDefinitions } from "./requirement-definitions.js";
import { quoted } from "./contradictory-requirement-rules.js";

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
// inconsistent with, and nothing is reported. Code spans are not read. In a
// criterion, a name that opens a sentence is not checked: its capital may be
// the sentence's ("External links open in a new tab"). Determiners, the RFC
// 2119 keywords and number words are not names. A finding quotes at most 24
// characters of the control, as contradictory_requirements does.
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
  // The requirement keywords of RFC 2119, written in capitals before a verb:
  // in "The File menu MUST list Save" the French pattern read "menu MUST" as
  // a control named "MUST". And number words, which count controls ("Two
  // buttons", "deux boutons") rather than name one.
  // source: review 1 of #345, note 2.
  "must",
  "shall",
  "should",
  "may",
  "required",
  "recommended",
  "optional",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "deux",
  "trois",
  "quatre",
  "cinq",
  "sept",
  "huit",
  "neuf",
  "dix",
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

/**
 * The text with its code spans blanked. A code span opens on a run of
 * backticks and closes on the next run of the same length, as in CommonMark
 * (``Clone button`` is one span), and may go over a line end; a run with no
 * closer is literal. One scan lists the runs, and the closer of each length is
 * looked for from a pointer that only moves forward, so the scan is linear: a
 * pattern with a back-reference rescanned the rest of the text from each
 * unclosed run.
 * source: Codex review of #345 (P2, a double-backtick span was read).
 */
export function withoutCodeSpans(text: string): string {
  const runs: { start: number; length: number }[] = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && text[j] === "`") j++;
    runs.push({ start: i, length: j - i });
    i = j;
  }
  const byLength = new Map<number, number[]>();
  runs.forEach((run, k) => {
    const list = byLength.get(run.length);
    if (list === undefined) byLength.set(run.length, [k]);
    else list.push(k);
  });
  const next = new Map<number, number>();
  let out = "";
  let kept = 0;
  for (let k = 0; k < runs.length; ) {
    const open = runs[k]!;
    const list = byLength.get(open.length)!;
    let p = next.get(open.length) ?? 0;
    while (p < list.length && list[p]! <= k) p++;
    next.set(open.length, p);
    if (p === list.length) {
      k++;
      continue;
    }
    const close = runs[list[p]!]!;
    out += text.slice(kept, open.start) + " ";
    kept = close.start + close.length;
    k = list[p]! + 1;
  }
  return out + text.slice(kept);
}

/** A named control: its name, lowercase for the comparison, and the words as written. */
interface NamedControl {
  readonly key: string;
  readonly written: string;
  /**
   * Whether the name opens a sentence (English pattern only: in French the
   * name follows the noun). A capital there is the sentence's, so the word
   * may be an ordinary one ("External links open in a new tab", "Access
   * control rejects…"): such a name is defined by a requirement, but not
   * checked in a criterion. source: review 1 of #345, note 2.
   */
  readonly opensSentence: boolean;
}

/** Marks that end a sentence or open a statement: what comes after them is capitalized for that reason. */
const SENTENCE_BOUNDARY = new Set([".", "!", "?", ":", ";", "|", "\n"]);

/** Whether the text before `at`, spaces, tabs and opening quotes left out, is empty or ends a sentence. */
function opensSentence(text: string, at: number): boolean {
  let k = at - 1;
  while (k >= 0 && " \t\"“‘'«".includes(text[k]!)) k--;
  return k < 0 || SENTENCE_BOUNDARY.has(text[k]!);
}

/** The named controls of a definition text, in order, code spans left out. */
export function namedControlsIn(text: string): NamedControl[] {
  const read = withoutCodeSpans(text);
  const out: { at: number; control: NamedControl }[] = [];
  for (const pattern of [EN_CONTROL, FR_CONTROL]) {
    for (const match of read.matchAll(pattern)) {
      const name = match[1]!;
      const key = name.normalize("NFC").toLowerCase();
      if (NOT_A_NAME.has(key)) continue;
      const first = pattern === EN_CONTROL && opensSentence(read, match.index);
      out.push({ at: match.index, control: { key, written: match[0], opensSentence: first } });
    }
  }
  return out.sort((a, b) => a.at - b.at).map((m) => m.control);
}

/** Requirement definitions name the controls; acceptance-criterion definitions are checked against them. */
const DEFINITION_PREFIXES = ["FR", "NFR", "AC"] as const;

export function checkDocumentConsistentControlNames(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  const defined = new Set<string>();
  const criteria: { id: string; controls: NamedControl[] }[] = [];
  for (const section of sections) {
    // Each section is parsed on its own, as the other document rules read it.
    // One pass reads the three prefixes, so that a criterion ends the text of
    // the requirement above it: read with FR and NFR only, the body of
    // "### FR-001: …" ran on into "- AC-001: … Clone button.", and the
    // criterion's name counted as the requirement's (Codex review of #345).
    for (const { id, text } of requirementDefinitions(section.content, DEFINITION_PREFIXES)) {
      const controls = namedControlsIn(text);
      if (id.startsWith("AC-")) criteria.push({ id, controls });
      else for (const control of controls) defined.add(control.key);
    }
  }
  if (defined.size === 0) return [];
  const flagged = new Set<string>();
  const listed: string[] = [];
  for (const { id, controls } of criteria) {
    const unknown = controls.find((c) => !c.opensSentence && !defined.has(c.key));
    if (unknown === undefined || flagged.has(id)) continue;
    flagged.add(id);
    listed.push(`${id} ("${quoted(unknown.written)}")`);
  }
  if (flagged.size === 0) return [];
  const names = listedIds(listed);
  return [
    makeViolation(
      "consistent_control_names",
      null,
      `${flagged.size} acceptance criterion(s) name a control no requirement names: ${names}`,
      `Inconsistent control names: ${names}`,
    ),
  ];
}
