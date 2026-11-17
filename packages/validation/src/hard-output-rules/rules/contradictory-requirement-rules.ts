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
// unit of measure of the `quantityUnits` lexicon concept (seconds, MB, %,
// fois…; EN and FR). A number that names rather than measures ("Tier 1",
// "Step 2", `FR-001`) is not followed by such a unit, so two statements that
// differ there are about two different things and are not reported; a count
// noun ("users", "files") is not a unit, since it follows a naming number as
// often ("Tier 1 users"). Two spellings of the same value ("two" and "2",
// "1,000" and "1000") are the same number.
//
// It fires on the presence of a defect, so it is blocking, but not critical:
// it sees only a contradiction of identical wording, and the unit list is a
// heuristic. A finding costs the non-critical penalty and triggers no
// critical retry. A requirement is compared with the first requirement of
// its cut form only, so the cost grows with the number of requirements, not
// with its square: a third statement that differs from the second but agrees
// with the first is not reported. Every later requirement is compared, so a
// second one that states the same value as a reported one is reported too.
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
 * A number in digits (`2`, `1.5`, `1,5`) with the letters and digits glued
 * after it (`10MB`, `1b`, `2h30`), a word that starts with a letter and may
 * hold digits (`B2B`, `v2`, `H264`), or any other character but a space. A
 * word is one token, so the digit inside `B2B` is not a number and its `B` is
 * not a unit; a glued run is split by `splitGlued`. Each alternative ends
 * where its character class ends and none can fail after it started, so the
 * scan is linear.
 * source: review 1 of #319, note 3 (`Tier 1 B2B customers` read 1 as a
 * quantity of bytes).
 */
const TOKEN = /\p{N}+(?:[.,]\p{N}+)*[\p{L}\p{N}]*|\p{L}[\p{L}\p{N}]*|[^\s\p{L}\p{N}]/gu;

const DIGITS = /^\p{N}/u;

/**
 * The runs of a token that starts with a digit: its leading number, then
 * letters and digits by turns (`2h30` is `2`, `h`, `30`). The token holds no
 * separator after its first letter, so the runs alternate.
 */
const GLUED_RUNS = /\p{N}+(?:[.,]\p{N}+)*|\p{L}+/gu;

/**
 * The units read glued to a number although they are one letter: `5s`, `3h`.
 * A glued `b` is left out: `Phase 1b`, `Step 2b` name a sub-step more often
 * than `1b` writes a byte or a bit, which a PRD writes `1 B` or `1 KB`.
 * Glued units of two letters or more (`10MB`, `200ms`) are all read.
 * source: review 1 of #319, note 3.
 */
const GLUED_ONE_LETTER_UNITS: ReadonlySet<string> = new Set(["s", "h"]);

/** A token that starts with a digit, read as its numbers and what is glued after each. */
export interface GluedToken {
  /** The numbers, in order, as the token writes them. */
  readonly numbers: readonly string[];
  /**
   * What is glued after each number: a unit in its singular form, another
   * word lowercase (only after a later number: `1h30m`), null when nothing is.
   */
  readonly after: readonly (string | null)[];
}

/**
 * The units of an hour, singular, that a number of minutes can follow
 * (`2h30`, `2 h 30`, `2 heures 30`).
 */
const HOUR_UNITS: ReadonlySet<string> = new Set(["h", "hr", "hour", "heure"]);

/** The minutes of a glued hour-and-minute duration: two digits (`2h30`, `2h05`). */
const GLUED_MINUTES = /^\p{N}{2}$/u;

/** What may follow the minutes of a glued duration: nothing, `m`, or a unit of a minute. */
function isGluedMinuteUnit(letters: string): boolean {
  const unit = unitOf(letters);
  return letters.toLowerCase() === "m" || unit === "min" || unit === "minute";
}

/**
 * precondition: `token` starts with a digit.
 * postcondition: the numbers of the token and what is glued after each when
 * the token is a number alone (`7`), a number and a unit (`10MB`, `5s`), or a
 * duration in hours and minutes: a unit of an hour, then two digits, then
 * nothing, `m` or a unit of a minute (`2h30`, `10h30`, `1h30m`, `1h30min`);
 * null otherwise, so the token is a word and names something: letters that
 * are not a unit (`1a`, `2nd`, `3D`), a one-letter unit not read glued
 * (`1b`, see GLUED_ONE_LETTER_UNITS), or a later number that is not the
 * minutes of an hour (`2024H1`, `2025S1`, `4s2p`, `1b30`, `2h5`). The `m`
 * after the minutes is kept lowercase: the lexicon does not list it as a
 * unit. Linear in the length of the token.
 * source: review 1 of #320, note 2 (`2h30` read as a word since #320);
 * review 1 of #321, note 2 (any later number was read, so `2024H1` against
 * `2024H2` was reported, where it had been a word).
 */
export function splitGlued(token: string): GluedToken | null {
  const runs = token.match(GLUED_RUNS)!;
  if (runs.length === 1) return { numbers: [runs[0]!], after: [null] };
  const unit = unitOf(runs[1]!);
  if (unit === null || (unit.length === 1 && !GLUED_ONE_LETTER_UNITS.has(unit))) return null;
  if (runs.length === 2) return { numbers: [runs[0]!], after: [unit] };
  if (!HOUR_UNITS.has(unit) || runs.length > 4 || !GLUED_MINUTES.test(runs[2]!)) return null;
  const minuteUnit = runs[3];
  if (minuteUnit === undefined) return { numbers: [runs[0]!, runs[2]!], after: [unit, null] };
  if (!isGluedMinuteUnit(minuteUnit)) return null;
  return { numbers: [runs[0]!, runs[2]!], after: [unit, unitOf(minuteUnit) ?? minuteUnit.toLowerCase()] };
}

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

/**
 * The value of a number written in digits, as a string. A separator followed
 * by exactly three digits, when every separator is the same character and is
 * followed by three digits, groups thousands: `1,000`, `1,000,000`,
 * `1.000.000`. With two kinds of separator, the last one is the decimal mark
 * (`1,000.5`, `1.000,5`). Any other separator is the decimal mark (`1,5`,
 * `1.5`, `2.25`). A group of thousands never follows a leading `0`, so
 * `0,250` and `0,001` read as decimals (0.25, 0.001), and a form with two
 * kinds of separator after a leading `0` (`0,250.5`, `0.250,5`), whose first
 * separator could only group thousands, does not read as a number. A form
 * that does not read as a number (`1.2.3`) is its own value, its digits as
 * written, so two different forms never read as equal. `1,500` stays 1500: it may be a
 * French 1.5, which the statement's language does not settle.
 * source: review 1 of #318, note 1 (only the first comma was replaced, so
 * `1,000` read as 1 and `1,000,000` as NaN, equal to any other NaN); review 1
 * of #319, note 2 (`0,250` read as 250); review 1 of #320, note 1 (`0,250.5`
 * read as 250.5).
 */
export function digitsValue(token: string): string {
  const separators = token.match(/[.,]/gu) ?? [];
  const groups = token.split(/[.,]/u);
  const kinds = new Set(separators);
  const leadingZero = groups[0]!.startsWith("0");
  let normalized: string;
  if (kinds.size === 2) {
    if (leadingZero) return token;
    const decimal = separators[separators.length - 1]!;
    const at = token.lastIndexOf(decimal);
    normalized = `${token.slice(0, at).replace(/[.,]/gu, "")}.${token.slice(at + 1)}`;
  } else if (separators.length > 0 && !leadingZero && groups.slice(1).every((g) => g.length === 3) && (separators.length > 1 || separators[0] === ",")) {
    normalized = groups.join("");
  } else if (separators.length === 1) {
    normalized = groups.join(".");
  } else {
    normalized = token;
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? String(value) : token;
}

/** The longest spelling a finding quotes; a longer one is cut and ends with "…". */
const MAX_QUOTED_CHARS = 24;

function quoted(spelling: string): string {
  return spelling.length > MAX_QUOTED_CHARS ? `${spelling.slice(0, MAX_QUOTED_CHARS)}…` : spelling;
}

/** A statement cut into its form, with a slot for each number, and the numbers. */
export interface CutStatement {
  /** The words and marks, lowercase, with NUMBER_SLOT for each number and units in the singular. */
  readonly form: string;
  /** The value of each number, in order. */
  readonly values: readonly string[];
  /** The spelling of each number, in order, as the statement writes it. */
  readonly spellings: readonly string[];
  /** For each number, whether it is a quantity (`isMeasured`). */
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

/**
 * Whether the number at `slot` of a cut form is a quantity: a unit follows
 * it (`5 s`, `10 mb`), or it follows a number and a unit of an hour, so it
 * counts the minutes of that hour (`2 h 30`, `2h30`, `1h30m`). It reads the
 * form only, so two statements of one form measure the same numbers, whether
 * they write the duration glued or spaced and in whichever order they come.
 * source: review 1 of #321, note 1 (`2 h 30` then `2h45` was reported, but
 * `2h30` then `2 h 45` was not: only the glued form measured its minutes, and
 * only the later statement's measures were read).
 */
function isMeasured(form: readonly string[], slot: number): boolean {
  const next = form[slot + 1];
  if (next !== undefined && UNITS.has(next)) return true;
  return slot >= 2 && HOUR_UNITS.has(form[slot - 1]!) && form[slot - 2] === NUMBER_SLOT;
}

/** precondition: none. postcondition: the cut form of the statement of `text`, linear in its length. */
export function cutStatement(text: string): CutStatement {
  const tokens = statementOf(text).match(TOKEN) ?? [];
  const form: string[] = [];
  const values: string[] = [];
  const spellings: string[] = [];
  const slots: number[] = [];
  for (const token of tokens) {
    if (DIGITS.test(token)) {
      const glued = splitGlued(token);
      if (glued === null) {
        form.push(token.toLowerCase());
        continue;
      }
      for (let k = 0; k < glued.numbers.length; k++) {
        slots.push(form.length);
        form.push(NUMBER_SLOT);
        values.push(digitsValue(glued.numbers[k]!));
        spellings.push(glued.numbers[k]!);
        const after = glued.after[k] ?? null;
        // `10MB` and `10 MB`, `2h30` and `2 h 30`, are one form.
        if (after !== null) form.push(after);
      }
      continue;
    }
    const word = NUMBER_VALUES.get(token.toLowerCase());
    if (word === undefined) {
      form.push(unitOf(token) ?? token.toLowerCase());
      continue;
    }
    slots.push(form.length);
    form.push(NUMBER_SLOT);
    values.push(String(word));
    spellings.push(token);
  }
  const measured = slots.map((slot) => isMeasured(form, slot));
  return { form: form.join(" "), values, spellings, measured };
}

/**
 * The index of the first number at which `a` and `b`, of one cut form,
 * contradict each other, else -1: their values differ somewhere, and every
 * number that differs is a quantity (`isMeasured`). Both statements have one
 * form, so they measure the same numbers and the result does not depend on
 * which one comes first.
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

/** The first requirement stated in a cut form: every later one is compared with it. */
interface FirstOfForm {
  readonly id: string;
  readonly cut: CutStatement;
}

export function checkDocumentContradictoryRequirements(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  const byForm = new Map<string, FirstOfForm>();
  const flagged = new Set<string>();
  const named: string[] = [];
  for (const section of sections) {
    // Each section is parsed on its own, as the other document rules read it.
    for (const { id, text } of requirementDefinitions(section.content)) {
      const cut = cutStatement(text);
      if (cut.values.length === 0) continue;
      const first = byForm.get(cut.form);
      if (first === undefined) {
        byForm.set(cut.form, { id, cut });
        continue;
      }
      // A reused identifier is duplicate_requirement_ids' finding, not a contradiction.
      if (first.id === id || flagged.has(id)) continue;
      const at = contradictionAt(cut, first.cut);
      if (at === -1) continue;
      flagged.add(id);
      named.push(`${id} ("${quoted(cut.spellings[at]!)}", against ${first.id}: "${quoted(first.cut.spellings[at]!)}")`);
    }
  }
  if (flagged.size === 0) return [];
  const names = listedIds(named);
  return [
    makeViolation(
      "contradictory_requirements",
      null,
      `${flagged.size} requirement(s) state a quantity an earlier requirement states differently: ${names}`,
      `Contradictory: ${names}`,
    ),
  ];
}
