import type {
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { makeViolation } from "./helpers.js";
import { listedIds } from "./listed-ids.js";
import { phrases } from "./lexicon.js";
import { requirementDefinitions } from "./requirement-definitions.js";

// Document-Level Rule: Contradictory Requirements
//
// Two requirements that state the same thing with a different quantity
// ("the button reads "Copied" for two seconds" and "… for five seconds")
// cannot both hold: the set of requirements is not consistent
// (ISO/IEC/IEEE 29148:2018 §5.2.6, a set of requirements contains no
// conflicts). No test of the product can pass both.
//
// The rule reads each requirement definition (FR-n, NFR-n) with the block
// tree of requirement-definitions.ts and keeps its statement: the first cell
// of a table row, or the text of a list item, heading or bold line. It cuts
// the statement into words, numbers and marks, and puts a placeholder where
// each number stands (digits, or a number word of NUMBER_VALUES). Two
// statements contradict each other when their cut forms are the same, their
// numbers differ, and every number that differs is a quantity: followed by a
// unit of the `quantityUnits` lexicon concept (seconds, MB, %, times…; EN
// and FR). A number that names rather than measures ("Tier 1", "Step 2",
// `FR-001`) is not followed by a unit, so two statements that differ there
// are about two different things and are not reported. Two spellings of the
// same value ("two" and "2") are the same number.
//
// It fires on the presence of a defect, so it is blocking, but not critical:
// it sees only a contradiction of identical wording, and the unit list is a
// heuristic. A finding costs the non-critical penalty and triggers no
// critical retry. A requirement is compared with the first requirement of
// its cut form only, so the cost grows with the number of requirements, not
// with its square: a third statement that differs from the second but agrees
// with the first is not reported.
//
// source: issue #118, seeded defect `contradiction` (FR-004 keeps the
// confirmation for five seconds, against FR-003's two), which the document
// check did not diagnose.

/**
 * The value of each number word: two spellings of one value are one number.
 * "one", "un" and "une" are read here, unlike in measurable-requirement-rules.ts:
 * a number is compared with the number at the same place in an otherwise
 * identical statement, so an article is compared with an article.
 */
const NUMBER_VALUES: ReadonlyMap<string, number> = new Map([
  // EN
  ["zero", 0], ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5],
  ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10], ["eleven", 11],
  ["twelve", 12], ["thirteen", 13], ["fourteen", 14], ["fifteen", 15], ["sixteen", 16],
  ["seventeen", 17], ["eighteen", 18], ["nineteen", 19], ["twenty", 20], ["thirty", 30],
  ["forty", 40], ["fifty", 50], ["sixty", 60], ["seventy", 70], ["eighty", 80],
  ["ninety", 90], ["hundred", 100], ["thousand", 1000], ["million", 1e6], ["billion", 1e9],
  // FR
  ["zéro", 0], ["un", 1], ["une", 1], ["deux", 2], ["trois", 3], ["quatre", 4], ["cinq", 5],
  ["sept", 7], ["huit", 8], ["neuf", 9], ["dix", 10], ["onze", 11], ["douze", 12],
  ["treize", 13], ["quatorze", 14], ["quinze", 15], ["seize", 16], ["vingt", 20],
  ["trente", 30], ["quarante", 40], ["cinquante", 50], ["soixante", 60], ["cent", 100],
  ["mille", 1000],
]);

/**
 * A number in digits (`2`, `1.5`, `1,5`), a run of letters, or any other
 * character but a space. Each alternative is a single possessive-like run
 * with no nested quantifier, so the scan is linear.
 */
const TOKEN = /\p{N}+(?:[.,]\p{N}+)*|\p{L}+|[^\s\p{L}\p{N}]/gu;

const DIGITS = /^\p{N}/u;

/** The units of the `quantityUnits` concept, lowercase. */
const UNITS: ReadonlySet<string> = new Set(phrases("quantityUnits"));

/** Marks a number in a cut form; not a character a statement can hold as a token. */
const NUMBER_SLOT = "\u0000";

/**
 * The unit a token names, in its singular form, else null. A unit is listed
 * in the singular; a plural is read by its final "s" removed ("seconds",
 * "secondes"), unless the token is itself listed ("ms", "mois", "fois").
 */
export function unitOf(token: string): string | null {
  const word = token.toLowerCase();
  if (UNITS.has(word)) return word;
  if (word.length > 2 && word.endsWith("s") && UNITS.has(word.slice(0, -1))) return word.slice(0, -1);
  return null;
}

/** The value a number token stands for, as a string: `2` and `two` give "2". */
function valueOf(token: string): string | null {
  if (DIGITS.test(token)) return String(Number(token.replace(",", ".")));
  const word = NUMBER_VALUES.get(token.toLowerCase());
  return word === undefined ? null : String(word);
}

/** A statement cut into its form, with a slot for each number, and the numbers. */
export interface CutStatement {
  /** The words and marks, lowercase, with NUMBER_SLOT for each number and units in the singular. */
  readonly form: string;
  /** The value of each number, in order. */
  readonly values: readonly string[];
  /** The spelling of each number, in order, as the statement writes it. */
  readonly spellings: readonly string[];
  /** For each number, whether a unit follows it. */
  readonly measured: readonly boolean[];
}

/**
 * The statement of a definition text: the first cell of a table row (the
 * other cells are joined after " | "), without the colon or dash that
 * follows the identifier of a list item or a heading.
 */
function statementOf(text: string): string {
  return text.split(" | ")[0]!.replace(/^[\s:–—-]+/u, "");
}

/** precondition: none. postcondition: the cut form of the statement of `text`, linear in its length. */
export function cutStatement(text: string): CutStatement {
  const tokens = statementOf(text).match(TOKEN) ?? [];
  const form: string[] = [];
  const values: string[] = [];
  const spellings: string[] = [];
  const measured: boolean[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const value = valueOf(token);
    if (value === null) {
      form.push(unitOf(token) ?? token.toLowerCase());
      continue;
    }
    form.push(NUMBER_SLOT);
    values.push(value);
    spellings.push(token);
    const next = tokens[i + 1];
    measured.push(next !== undefined && unitOf(next) !== null);
  }
  return { form: form.join(" "), values, spellings, measured };
}

/**
 * The index of the first number at which `a` and `b`, of one cut form,
 * contradict each other, else -1: their values differ somewhere, and every
 * number that differs is followed by a unit.
 */
export function contradictionAt(a: CutStatement, b: CutStatement): number {
  let first = -1;
  for (let i = 0; i < a.values.length; i++) {
    if (a.values[i] === b.values[i]) continue;
    if (!a.measured[i]) return -1;
    if (first === -1) first = i;
  }
  return first;
}

interface FormGroup {
  /** The first requirement stated in this form: every later one is compared with it. */
  readonly first: { readonly id: string; readonly cut: CutStatement };
  /** The lists of values already met in this form, joined by a space. */
  readonly seen: Set<string>;
}

export function checkDocumentContradictoryRequirements(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  const byForm = new Map<string, FormGroup>();
  const flagged = new Set<string>();
  const quoted: string[] = [];
  for (const section of sections) {
    // Each section is parsed on its own, as the other document rules read it.
    for (const { id, text } of requirementDefinitions(section.content)) {
      const cut = cutStatement(text);
      if (cut.values.length === 0) continue;
      const key = cut.values.join(" ");
      const group = byForm.get(cut.form);
      if (group === undefined) {
        byForm.set(cut.form, { first: { id, cut }, seen: new Set([key]) });
        continue;
      }
      if (group.seen.has(key)) continue;
      group.seen.add(key);
      // A reused identifier is duplicate_requirement_ids' finding, not a contradiction.
      if (group.first.id === id || flagged.has(id)) continue;
      const at = contradictionAt(cut, group.first.cut);
      if (at === -1) continue;
      flagged.add(id);
      quoted.push(`${id} ("${cut.spellings[at]}", against ${group.first.id}: "${group.first.cut.spellings[at]}")`);
    }
  }
  if (flagged.size === 0) return [];
  const names = listedIds(quoted);
  return [
    makeViolation(
      "contradictory_requirements",
      null,
      `${flagged.size} requirement(s) state a quantity an earlier requirement states differently: ${names}`,
      `Contradictory: ${names}`,
    ),
  ];
}
